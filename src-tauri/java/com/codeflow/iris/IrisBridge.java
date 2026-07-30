package com.codeflow.iris;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The JDBC half of CodeFlow's InterSystems IRIS driver.
 *
 * <p>IRIS has no pure-Rust driver and no wire protocol anyone outside InterSystems implements — its
 * only real client is the Type 4 JDBC driver, which is Java. So the Rust side spawns this program
 * once, and the two talk newline-delimited JSON over stdin/stdout: one request object per line in,
 * one response object per line out, correlated by {@code id}.
 *
 * <p>Four things about the design are deliberate.
 *
 * <ol>
 *   <li><b>One process, many sessions.</b> The explorer opens a connection per namespace, and a JVM
 *       per namespace would cost ~60&nbsp;MB each. Sessions are multiplexed here instead, keyed by
 *       the id the Rust side hands down.
 *   <li><b>One thread per session, and cancel off it.</b> A JDBC {@link Connection} is not safe to
 *       drive from two threads, so each session gets a single-thread executor and its statements
 *       queue behind each other. {@code cancel} is handled on the reader thread precisely
 *       <i>because</i> of that: queued behind the query it is meant to stop, it would never run.
 *   <li><b>Every value crosses as text</b>, via {@code getString}, which is the same invariant the
 *       Rust drivers hold. Binary columns are the one exception — hex, because {@code getString} on
 *       a byte array yields whatever the driver's default charset made of it.
 *   <li><b>No third-party jar but the driver.</b> The JSON reader and writer below are ~150 lines
 *       of this file. Pulling in Jackson to parse eight-field request objects would double what the
 *       app ships for no gain.
 * </ol>
 *
 * <p>Protocol, by example:
 *
 * <pre>
 * → {"id":1,"op":"open","session":"c1#USER","url":"jdbc:IRIS://h:1972/USER","user":"_SYSTEM",...}
 * ← {"id":1,"ok":true,"result":{"version":"IRIS 2024.1","driver":"InterSystems IRIS JDBC 3.8.4"}}
 * → {"id":2,"op":"exec","session":"c1#USER","sql":"SELECT ...","maxRows":500}
 * ← {"id":2,"ok":true,"result":{"columns":[...],"rows":[[...]],"truncated":false,...}}
 * </pre>
 */
public final class IrisBridge {

    /** The real stdout. Nothing else may write to it, or a frame would be corrupted mid-line. */
    private static PrintStream frames;

    private static final Object WRITE_LOCK = new Object();
    private static final Map<String, Session> SESSIONS = new ConcurrentHashMap<>();
    private static final ExecutorService POOL = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "iris-bridge");
        thread.setDaemon(true);
        return thread;
    });

    public static void main(String[] args) throws Exception {
        frames = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
        // The driver logs to stdout when tracing is on, and one stray line would desynchronise the
        // framing for good. Everything that isn't a frame goes to stderr, which Rust drains to the
        // app log.
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8"));

        BufferedReader in =
                new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            dispatch(line);
        }
        // stdin closed: the app is gone, so are we.
        closeAll();
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    private static void dispatch(String line) {
        Map<String, Object> request;
        try {
            request = Json.parseObject(line);
        } catch (RuntimeException e) {
            // Unparseable means we don't even know the id to answer under. Say so on stderr and
            // drop it; the Rust side times the call out rather than hanging forever.
            System.err.println("iris-bridge: unreadable request: " + e.getMessage());
            return;
        }

        long id = Json.asLong(request.get("id"), 0);
        String op = Json.asString(request.get("op"), "");
        String sessionId = Json.asString(request.get("session"), "");

        switch (op) {
            case "open" -> POOL.execute(() -> reply(id, () -> open(sessionId, request)));
            case "ping" -> reply(id, () -> "{\"pong\":true}");
            // Inline, not on the session's queue: this exists to interrupt whatever is occupying
            // that queue.
            case "cancel" -> reply(id, () -> cancel(sessionId));
            case "shutdown" -> {
                replyOk(id, "{\"stopped\":true}");
                closeAll();
                frames.flush();
                Runtime.getRuntime().halt(0);
            }
            default -> {
                Session session = SESSIONS.get(sessionId);
                if (session == null) {
                    replyError(id, "There is no open IRIS session called '" + sessionId + "'.");
                    return;
                }
                try {
                    session.worker.execute(() -> reply(id, () -> switch (op) {
                        case "exec" -> exec(session, request);
                        case "batch" -> batch(session, request);
                        case "close" -> close(sessionId);
                        default -> throw new IllegalArgumentException(
                                "'" + op + "' is not something this bridge knows how to do.");
                    }));
                } catch (java.util.concurrent.RejectedExecutionException e) {
                    replyError(id, "That IRIS session is closing.");
                }
            }
        }
    }

    /** Runs a unit of work and answers with its JSON, or with whatever it threw. */
    private static void reply(long id, Work work) {
        try {
            replyOk(id, work.run());
        } catch (Throwable e) {
            replyError(id, describe(e));
        }
    }

    private interface Work {
        /** Returns a JSON *object* as text — the `result` field of the response. */
        String run() throws Exception;
    }

    private static void replyOk(long id, String resultJson) {
        StringBuilder sb = new StringBuilder(resultJson.length() + 32);
        sb.append("{\"id\":").append(id).append(",\"ok\":true,\"result\":").append(resultJson).append('}');
        emit(sb);
    }

    private static void replyError(long id, String message) {
        StringBuilder sb = new StringBuilder(message.length() + 48);
        sb.append("{\"id\":").append(id).append(",\"ok\":false,\"error\":");
        Json.string(sb, message);
        sb.append('}');
        emit(sb);
    }

    private static void emit(StringBuilder frame) {
        synchronized (WRITE_LOCK) {
            frames.print(frame);
            frames.print('\n');
            frames.flush();
        }
    }

    /**
     * A JDBC failure as one sentence.
     *
     * <p>IRIS nests the useful part: the outer exception is often "communication link failure" and
     * the cause underneath is the reason. Both are joined rather than either being picked, because
     * which one is informative varies by failure.
     */
    private static String describe(Throwable error) {
        StringBuilder sb = new StringBuilder();
        Throwable current = error;
        int depth = 0;
        while (current != null && depth < 4) {
            String message = current.getMessage();
            if (message != null && !message.isBlank() && sb.indexOf(message.trim()) < 0) {
                if (sb.length() > 0) {
                    sb.append(": ");
                }
                sb.append(message.trim());
            }
            current = current.getCause() == current ? null : current.getCause();
            depth++;
        }
        if (sb.length() == 0) {
            sb.append(error.getClass().getSimpleName());
        }
        if (error instanceof SQLException sql && sql.getSQLState() != null) {
            sb.append(" [SQLState ").append(sql.getSQLState()).append(']');
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    private static final class Session {
        final Connection conn;
        final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "iris-session");
            thread.setDaemon(true);
            return thread;
        });
        /** What {@code cancel} would stop. Null between statements. */
        final AtomicReference<Statement> running = new AtomicReference<>();

        Session(Connection conn) {
            this.conn = conn;
        }
    }

    private static String open(String sessionId, Map<String, Object> request) throws Exception {
        if (sessionId.isEmpty()) {
            throw new IllegalArgumentException("A session id is required to open a connection.");
        }
        // The driver class is named explicitly rather than left to the ServiceLoader: when the jar
        // is missing entirely, "no suitable driver for jdbc:IRIS" is a far worse message than this.
        try {
            Class.forName("com.intersystems.jdbc.IRISDriver");
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException(
                    "The InterSystems JDBC driver isn't on this bridge's classpath. CodeFlow ships "
                            + "it alongside the bundled Java runtime — reinstalling the app restores it.");
        }

        String url = Json.asString(request.get("url"), "");
        long timeoutMs = Json.asLong(request.get("timeoutMs"), 15000);
        boolean readOnly = Json.asBoolean(request.get("readOnly"), false);

        Properties props = new Properties();
        // Driver properties the Rust side resolved from the connection's options. Applied first so
        // that the credentials below can never be overridden by one of them.
        if (request.get("properties") instanceof Map<?, ?> extra) {
            for (Map.Entry<?, ?> entry : extra.entrySet()) {
                if (entry.getValue() != null) {
                    props.setProperty(String.valueOf(entry.getKey()), String.valueOf(entry.getValue()));
                }
            }
        }
        props.setProperty("user", Json.asString(request.get("user"), ""));
        props.setProperty("password", Json.asString(request.get("password"), ""));
        // Seconds, and it must not round down to "wait forever" for a sub-second timeout.
        DriverManager.setLoginTimeout((int) Math.max(1, (timeoutMs + 999) / 1000));

        Connection conn = DriverManager.getConnection(url, props);
        if (readOnly) {
            // Advisory — IRIS may decline, and the real guard is the read-only check on the Rust
            // side. Worth asking for anyway: a driver that honours it refuses a write we missed.
            try {
                conn.setReadOnly(true);
            } catch (SQLException ignored) {
                // Not fatal, and not worth a message: nothing about the connection is wrong.
            }
        }

        Session previous = SESSIONS.put(sessionId, new Session(conn));
        if (previous != null) {
            quietly(previous);
        }

        StringBuilder sb = new StringBuilder(256);
        sb.append('{');
        var meta = conn.getMetaData();
        Json.field(sb, "version", meta.getDatabaseProductVersion(), true);
        Json.field(sb, "product", meta.getDatabaseProductName(), false);
        Json.field(sb, "driver", meta.getDriverName() + " " + meta.getDriverVersion(), false);
        Json.field(sb, "user", meta.getUserName(), false);
        Json.field(sb, "namespace", conn.getCatalog(), false);
        sb.append('}');
        return sb.toString();
    }

    private static String close(String sessionId) {
        Session session = SESSIONS.remove(sessionId);
        if (session != null) {
            // Not `shutdownNow` from inside a task the worker itself is running — that would
            // interrupt this very thread. The executor is daemon-backed and empties on its own.
            quietly(session);
        }
        return "{\"closed\":true}";
    }

    private static String cancel(String sessionId) {
        Session session = SESSIONS.get(sessionId);
        Statement running = session == null ? null : session.running.get();
        if (running == null) {
            return "{\"cancelled\":false}";
        }
        try {
            running.cancel();
            return "{\"cancelled\":true}";
        } catch (SQLException e) {
            // A statement that finished between the get and the cancel throws here; that is a race
            // the caller doesn't need to hear about as a failure.
            return "{\"cancelled\":false}";
        }
    }

    private static void closeAll() {
        for (String id : List.copyOf(SESSIONS.keySet())) {
            Session session = SESSIONS.remove(id);
            if (session != null) {
                quietly(session);
            }
        }
    }

    private static void quietly(Session session) {
        try {
            Statement running = session.running.getAndSet(null);
            if (running != null) {
                running.cancel();
            }
        } catch (SQLException ignored) {
            // Already finished, or the link is gone — either way there is nothing to stop.
        }
        try {
            session.conn.close();
        } catch (SQLException ignored) {
            // Closing a connection that the server already dropped is not a failure worth
            // reporting: the goal was for it to be gone, and it is.
        }
        session.worker.shutdown();
    }

    // -----------------------------------------------------------------------
    // Statements
    // -----------------------------------------------------------------------

    /**
     * Runs one statement, whatever kind it is.
     *
     * <p>A console doesn't know whether what the user typed projects rows, so {@link
     * Statement#execute} decides: true means there is a result set, false means there is an update
     * count. Both shapes come back in the same object, and the Rust side reads whichever is set.
     */
    private static String exec(Session session, Map<String, Object> request) throws Exception {
        String sql = Json.asString(request.get("sql"), "");
        int maxRows = (int) Json.asLong(request.get("maxRows"), 0);
        long started = System.nanoTime();

        Statement statement = session.conn.createStatement();
        session.running.set(statement);
        try {
            if (maxRows > 0) {
                // One over the limit, so "there is more" is observed rather than assumed.
                statement.setMaxRows(maxRows + 1);
            }
            boolean hasResultSet = statement.execute(sql);

            StringBuilder sb = new StringBuilder(1024);
            sb.append('{');
            if (hasResultSet) {
                try (ResultSet rs = statement.getResultSet()) {
                    writeResultSet(sb, rs, maxRows);
                }
            } else {
                sb.append("\"columns\":[],\"rows\":[],\"truncated\":false,\"rowsAffected\":")
                        .append(statement.getUpdateCount());
            }
            sb.append(",\"durationMs\":").append((System.nanoTime() - started) / 1_000_000);
            writeWarnings(sb, statement);
            sb.append('}');
            return sb.toString();
        } finally {
            session.running.compareAndSet(statement, null);
            try {
                statement.close();
            } catch (SQLException ignored) {
                // A cancelled statement often refuses to close cleanly; the connection survives,
                // which is all the next statement needs.
            }
        }
    }

    /**
     * Runs several statements as one unit.
     *
     * <p>This is what the data editor's "Apply" becomes. With {@code transactional} it is
     * all-or-nothing — the thing the REST driver this replaced could not offer, because a stateless
     * request has no session to hold a transaction open in.
     */
    private static String batch(Session session, Map<String, Object> request) throws Exception {
        List<Object> statements = Json.asList(request.get("statements"));
        boolean transactional = Json.asBoolean(request.get("transactional"), true);

        boolean restoreAutoCommit = false;
        if (transactional && session.conn.getAutoCommit()) {
            session.conn.setAutoCommit(false);
            restoreAutoCommit = true;
        }

        int applied = 0;
        String failure = null;
        String failedStatement = null;
        try {
            for (Object entry : statements) {
                String sql = Json.asString(entry, "");
                if (sql.isBlank()) {
                    continue;
                }
                try (Statement statement = session.conn.createStatement()) {
                    session.running.set(statement);
                    statement.execute(sql);
                    applied++;
                } catch (SQLException e) {
                    failure = describe(e);
                    failedStatement = sql;
                    break;
                } finally {
                    session.running.set(null);
                }
            }
            if (transactional) {
                if (failure == null) {
                    session.conn.commit();
                } else {
                    session.conn.rollback();
                    // The rollback undid them, so reporting a count would be a lie.
                    applied = 0;
                }
            }
        } finally {
            if (restoreAutoCommit) {
                try {
                    session.conn.setAutoCommit(true);
                } catch (SQLException ignored) {
                    // The next statement re-establishes it; a failure here is not the caller's.
                }
            }
        }

        StringBuilder sb = new StringBuilder(128);
        sb.append("{\"applied\":").append(applied);
        sb.append(",\"transactional\":").append(transactional);
        if (failure != null) {
            sb.append(",\"error\":");
            Json.string(sb, failure);
            sb.append(",\"failedStatement\":");
            Json.string(sb, failedStatement == null ? "" : failedStatement);
        }
        sb.append('}');
        return sb.toString();
    }

    private static void writeResultSet(StringBuilder sb, ResultSet rs, int maxRows)
            throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        int count = meta.getColumnCount();
        boolean[] binary = new boolean[count + 1];

        sb.append("\"columns\":[");
        for (int i = 1; i <= count; i++) {
            binary[i] = isBinary(meta.getColumnType(i));
            if (i > 1) {
                sb.append(',');
            }
            sb.append("{\"name\":");
            // `getColumnLabel`, not `getColumnName`: an aliased column should read as its alias,
            // which is what the user wrote and what the grid header should say.
            Json.string(sb, meta.getColumnLabel(i));
            sb.append(",\"type\":");
            Json.string(sb, meta.getColumnTypeName(i));
            sb.append('}');
        }
        sb.append("],\"rows\":[");

        int written = 0;
        boolean truncated = false;
        while (rs.next()) {
            if (maxRows > 0 && written >= maxRows) {
                truncated = true;
                break;
            }
            if (written > 0) {
                sb.append(',');
            }
            sb.append('[');
            for (int i = 1; i <= count; i++) {
                if (i > 1) {
                    sb.append(',');
                }
                writeCell(sb, rs, i, binary[i]);
            }
            sb.append(']');
            written++;
        }
        sb.append("],\"truncated\":").append(truncated).append(",\"rowsAffected\":null");
    }

    private static void writeCell(StringBuilder sb, ResultSet rs, int index, boolean binary)
            throws SQLException {
        if (binary) {
            byte[] bytes = rs.getBytes(index);
            if (bytes == null || rs.wasNull()) {
                sb.append("null");
                return;
            }
            // The same shape the SQL Server driver renders binary in, and the same one IRIS accepts
            // back in a literal — so a cell the user edits round-trips.
            StringBuilder hex = new StringBuilder(2 + bytes.length * 2);
            hex.append("0x");
            for (byte b : bytes) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            Json.string(sb, hex.toString());
            return;
        }
        String value = rs.getString(index);
        if (value == null || rs.wasNull()) {
            sb.append("null");
        } else {
            Json.string(sb, value);
        }
    }

    private static boolean isBinary(int sqlType) {
        return sqlType == Types.BINARY
                || sqlType == Types.VARBINARY
                || sqlType == Types.LONGVARBINARY
                || sqlType == Types.BLOB;
    }

    /**
     * Server chatter that isn't a result. Losing these makes a stored procedure that printed its
     * progress look like it did nothing at all.
     */
    private static void writeWarnings(StringBuilder sb, Statement statement) {
        List<String> messages = new ArrayList<>();
        try {
            SQLWarning warning = statement.getWarnings();
            int guard = 0;
            while (warning != null && guard < 100) {
                if (warning.getMessage() != null && !warning.getMessage().isBlank()) {
                    messages.add(warning.getMessage().trim());
                }
                warning = warning.getNextWarning();
                guard++;
            }
        } catch (SQLException ignored) {
            // A cancelled statement can refuse to hand over its warnings. The result itself is
            // still worth returning.
        }
        sb.append(",\"messages\":[");
        for (int i = 0; i < messages.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            Json.string(sb, messages.get(i));
        }
        sb.append(']');
    }

    // -----------------------------------------------------------------------
    // JSON
    // -----------------------------------------------------------------------

    /**
     * Just enough JSON for this protocol, so the only jar the app ships is the driver itself.
     *
     * <p>Reading is generic (the request objects are small); writing is not — result sets go
     * straight into a {@link StringBuilder} rather than through an intermediate object tree,
     * because a 500-row grid would otherwise allocate a map per row for nothing.
     */
    static final class Json {
        private final String src;
        private int pos;

        private Json(String src) {
            this.src = src;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> parseObject(String text) {
            Json parser = new Json(text);
            parser.skipWhitespace();
            Object value = parser.value();
            if (!(value instanceof Map)) {
                throw new IllegalArgumentException("expected a JSON object");
            }
            return (Map<String, Object>) value;
        }

        private Object value() {
            skipWhitespace();
            if (pos >= src.length()) {
                throw new IllegalArgumentException("unexpected end of input");
            }
            char c = src.charAt(pos);
            return switch (c) {
                case '{' -> object();
                case '[' -> array();
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> number();
            };
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // '{'
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                String key = string();
                skipWhitespace();
                expect(':');
                map.put(key, value());
                skipWhitespace();
                char c = next();
                if (c == '}') {
                    return map;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected ',' or '}' at " + pos);
                }
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            pos++; // '['
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return list;
            }
            while (true) {
                list.add(value());
                skipWhitespace();
                char c = next();
                if (c == ']') {
                    return list;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected ',' or ']' at " + pos);
                }
            }
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') {
                    return sb.toString();
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char escape = next();
                switch (escape) {
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                        pos += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape \\" + escape);
                }
            }
        }

        private Object number() {
            int start = pos;
            while (pos < src.length() && "+-0123456789.eE".indexOf(src.charAt(pos)) >= 0) {
                pos++;
            }
            String text = src.substring(start, pos);
            if (text.isEmpty()) {
                throw new IllegalArgumentException("expected a value at " + start);
            }
            if (text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0) {
                return Long.parseLong(text);
            }
            return Double.parseDouble(text);
        }

        private Object literal(String word, Object value) {
            if (!src.startsWith(word, pos)) {
                throw new IllegalArgumentException("expected " + word + " at " + pos);
            }
            pos += word.length();
            return value;
        }

        private void skipWhitespace() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
                pos++;
            }
        }

        private char peek() {
            return pos < src.length() ? src.charAt(pos) : '\0';
        }

        private char next() {
            if (pos >= src.length()) {
                throw new IllegalArgumentException("unexpected end of input");
            }
            return src.charAt(pos++);
        }

        private void expect(char c) {
            if (next() != c) {
                throw new IllegalArgumentException("expected '" + c + "' at " + (pos - 1));
            }
        }

        // ------------------------------------------------------------- writing

        /**
         * Appends a JSON string literal.
         *
         * <p>Unpaired surrogates are escaped rather than written through: a {@code %Binary} column
         * read as text can hold one, and encoding it as UTF-8 would silently substitute {@code ?}.
         * Everything else goes out as UTF-8, so ordinary accented text stays one character.
         */
        static void string(StringBuilder sb, String value) {
            sb.append('"');
            int length = value.length();
            for (int i = 0; i < length; i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    case '\b' -> sb.append("\\b");
                    case '\f' -> sb.append("\\f");
                    default -> {
                        if (c < 0x20 || isLoneSurrogate(value, i, length)) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                    }
                }
            }
            sb.append('"');
        }

        private static boolean isLoneSurrogate(String value, int i, int length) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                return i + 1 >= length || !Character.isLowSurrogate(value.charAt(i + 1));
            }
            if (Character.isLowSurrogate(c)) {
                return i == 0 || !Character.isHighSurrogate(value.charAt(i - 1));
            }
            return false;
        }

        static void field(StringBuilder sb, String name, String value, boolean first) {
            if (!first) {
                sb.append(',');
            }
            string(sb, name);
            sb.append(':');
            if (value == null) {
                sb.append("null");
            } else {
                string(sb, value);
            }
        }

        // ------------------------------------------------------------ reading

        static String asString(Object value, String fallback) {
            return value instanceof String text ? text : fallback;
        }

        static long asLong(Object value, long fallback) {
            if (value instanceof Long number) {
                return number;
            }
            if (value instanceof Double number) {
                return number.longValue();
            }
            return fallback;
        }

        static boolean asBoolean(Object value, boolean fallback) {
            return value instanceof Boolean flag ? flag : fallback;
        }

        static List<Object> asList(Object value) {
            return value instanceof List<?> list ? List.copyOf(list) : List.of();
        }
    }

    private IrisBridge() {}
}
