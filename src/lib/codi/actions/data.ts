import { useUiStore } from "../../../state/uiStore";
import { catalogDriver, rowDriverId } from "../../db/drivers";
import { CodiError, type CodiAction, type CodiOutcome } from "../registry";
import {
  answerOrTell,
  defineAction,
  optionalText,
  outOfSight,
  params,
  pickByName,
  requireWorkspace,
  say,
  showAppHere,
  showOffer,
  showParam,
  spokenDuration,
  spokenList,
  spokenReason,
  text,
  waitFor,
} from "./shared";

/**
 * The API client and the database client — the two sides of the API tab, each its own rail app
 * (`api:requests`, `api:database`) and so each its own island when detached.
 *
 * Sending and running go through what the views already do: the API client's send is its command
 * bus (`apiCommandStore`, the same request ⌘↵ posts), and a SQL console runs through `runConsole`,
 * which asks first about the statements nobody means by accident (an `UPDATE` with no `WHERE`, any
 * write on a connection labelled production). `db.run` is marked destructive on top of that — Codi
 * asks before it sends any SQL, and the store's own questions still follow.
 *
 * Out of sight (Settings › Codi › «Trabajar en segundo plano», or «sin abrir»), a saved request is
 * sent the way Flujos and `cf http` send one (`runSavedRequest`: its environment, inherited auth and
 * trusted scripts) and a statement runs on its connection through the store — neither view opens, and
 * how it went is said. What only a view can send (a request with unsaved edits) still opens it.
 */

async function api() {
  const module = await import("../../../state/apiStore");
  await module.ensureApiStoreLoaded();
  return module.useApiStore;
}

async function db() {
  const module = await import("../../../state/dbStore");
  await module.ensureDbStoreLoaded();
  return module.useDbStore;
}

/** A request's or collection's place in the tree, as said: "Collection › Request". */
function requestLabel(collection: string | undefined, name: string): string {
  return collection ? `${collection} › ${name}` : name;
}

/**
 * The saved request an order means: the one it names, or — out of sight — the one open in the API
 * client when it is saved as it stands (an edit not saved yet lives only in its builder, which is on
 * screen). `null` when there is none to send without the view.
 */
async function savedRequestFor(name: unknown, quiet: boolean): Promise<{ id: string; name: string; label: string } | null> {
  const store = await api();
  const { requests, collections, openTabs, activeTabId } = store.getState();
  const collectionName = (id: string) => collections.find((c) => c.id === id)?.name;
  const labelOf = (r: { name: string; collection_id: string }) => requestLabel(collectionName(r.collection_id), r.name);
  if (typeof name === "string" && name.trim()) {
    const row = pickByName(requests, name, labelOf, "request");
    return { id: row.id, name: row.name, label: labelOf(row) };
  }
  if (!quiet) return null;
  const tab = openTabs.find((t) => t.id === activeTabId);
  const row = tab?.requestId && !tab.dirty ? requests.find((r) => r.id === tab.requestId) : undefined;
  return row ? { id: row.id, name: row.name, label: labelOf(row) } : null;
}

/** A saved request sent without the API client on screen, and how it answered — said within the turn,
 *  or told when it lands. Something to look at (an error status, a failed test) offers to show it. */
async function sendSaved(id: string, name: string, label: string): Promise<CodiOutcome> {
  const workspace = requireWorkspace();
  const { runSavedRequest } = await import("../../api/savedRequest");
  const work = (async (): Promise<CodiOutcome> => {
    let answer;
    try {
      answer = await runSavedRequest({ workspaceId: workspace.id, requestId: id, environmentId: "", variables: {} });
    } catch (error) {
      throw new CodiError(`the request failed: ${spokenReason(error)}`, say("codi.say.requestFailedWhy", { name, reason: spokenReason(error) }));
    }
    const fine = answer.status >= 200 && answer.status < 400 && answer.testsFailed === 0 && !answer.interrupted;
    return {
      result: {
        sent: label,
        status: answer.status,
        statusText: answer.statusText,
        ms: answer.durationMs,
        bytes: answer.sizeBytes,
        ...(answer.tests.length ? { tests: answer.tests.length, failedTests: answer.testsFailed } : {}),
      },
      say: answer.testsFailed
        ? say("codi.say.requestTestsFailed", { name, status: answer.status, n: answer.testsFailed })
        : say("codi.say.requestAnsweredIn", { name, status: answer.status, time: spokenDuration(answer.durationMs) }),
      ...(fine ? {} : { offer: showOffer("api.open", { name: label }) }),
    };
  })();
  return answerOrTell(work, {
    source: `api:${id}`,
    still: { result: { sent: label, stillRunning: true }, say: say("codi.say.requestRunning", { name }) },
    failed: (error) => say("codi.say.requestFailedWhy", { name, reason: spokenReason(error) }),
  });
}

export function apiActions(): CodiAction[] {
  return [
    defineAction({
      id: "api.send",
      title: {
        en: "Send a request of the API client and say how it answered: a saved one by name, or — with no name — the one open in the API client. Works without opening the API client unless show is true.",
        es: "Envía una petición del cliente API y dice cómo respondió: una guardada por su nombre o, sin nombre, la abierta en el cliente API. Trabaja sin abrir el cliente API salvo que show sea true.",
      },
      aliases: {
        es: ["envia la peticion", "manda la peticion", "ejecuta la peticion", "lanza la peticion", "dispara la peticion", "envia el request"],
        en: ["send the request", "run the request", "fire the request", "send it to the api"],
      },
      params: params({ name: optionalText("A saved request's name, as said (\"collection request\" works too). Left out: the one open in the API client."), show: showParam }),
      risk: "write",
      where: "app:api:requests",
      frequent: true,
      run: async ({ name, show }) => {
        const quiet = await outOfSight(show);
        const saved = await savedRequestFor(name, quiet);
        if (saved && quiet) return sendSaved(saved.id, saved.name, saved.label);
        const store = await api();
        if (saved) store.getState().openRequest(saved.id);
        showAppHere("api:requests");
        const tabId = store.getState().activeTabId;
        const tab = store.getState().openTabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new CodiError("no request is open in the API client — open one (api.open)", say("codi.say.noRequestOpen"));
        const { useApiCommandStore } = await import("../../../state/apiCommandStore");
        const { useApiRuntimeStore } = await import("../../../state/apiRuntimeStore");
        // The view consumes the command; a view mounted by `showAppHere` this very tick needs one
        // render to be listening.
        await waitFor(() => useUiStore.getState().activeView === "api", 1000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!useApiCommandStore.getState().send("send")) throw new CodiError("the API client is not on screen");
        const started = await waitFor(() => useApiRuntimeStore.getState().sending[tab.id] === true, 1500, 30);
        await waitFor(() => !useApiRuntimeStore.getState().sending[tab.id], 7000);
        const response = useApiRuntimeStore.getState().responses[tab.id];
        if (!started && !response) return { result: { sent: tab.name } , say: say("codi.say.requestSent", { name: tab.name }) };
        if (useApiRuntimeStore.getState().sending[tab.id]) {
          return { result: { sent: tab.name, stillRunning: true }, say: say("codi.say.requestRunning", { name: tab.name }) };
        }
        if (!response || response.error) {
          throw new CodiError(`the request failed: ${response?.error ?? "no response"}`, say("codi.say.requestFailed", { name: tab.name }));
        }
        const failedTests = response.tests.filter((test) => !test.passed).length;
        return {
          result: {
            sent: tab.name,
            status: response.status,
            statusText: response.status_text,
            bytes: response.size_bytes,
            ...(response.tests.length ? { tests: response.tests.length, failedTests } : {}),
          },
          say: say("codi.say.requestAnswered", { name: tab.name, status: response.status }),
        };
      },
    }),
    defineAction({
      id: "api.open",
      title: {
        en: "Open a saved request (or a collection's settings) in the API client, by name — loose match, \"collection request\" works too.",
        es: "Abre una petición guardada (o los ajustes de una colección) en el cliente API, por nombre; coincidencia flexible, «colección petición» también sirve.",
      },
      aliases: {
        es: ["abre la peticion", "abre el request", "muestra la peticion", "abre la coleccion", "ve a la peticion"],
        en: ["open the request", "show the request", "open the collection", "go to the request"],
      },
      params: params({ name: text("The request's or collection's name, as said.") }, ["name"]),
      risk: "navigate",
      where: "app:api:requests",
      frequent: false,
      run: async ({ name }) => {
        showAppHere("api:requests");
        const store = await api();
        const { requests, collections } = store.getState();
        const collectionName = (id: string) => collections.find((c) => c.id === id)?.name;
        const entries = [
          ...requests.map((r) => ({ kind: "request" as const, id: r.id, label: requestLabel(collectionName(r.collection_id), r.name), name: r.name })),
          ...collections.map((c) => ({ kind: "collection" as const, id: c.id, label: c.name, name: c.name })),
        ];
        // The full label first ("pagos crear cobro"), so a name two collections share is told apart.
        const target = pickByName(entries, String(name), (entry) => entry.label, "request", (entry) => entry.kind === "request");
        if (target.kind === "request") store.getState().openRequest(target.id);
        else store.getState().openEntityTab("collection", target.id);
        return { result: { opened: target.label, kind: target.kind }, say: say("codi.say.requestOpened", { name: target.name }) };
      },
    }),
    defineAction({
      id: "api.list",
      title: {
        en: "List the API client's collections and saved requests (method and name), and which request is open.",
        es: "Lista las colecciones y peticiones guardadas del cliente API (método y nombre), y cuál está abierta.",
      },
      aliases: {
        es: ["que peticiones hay", "lista las peticiones", "que colecciones hay", "mis peticiones", "mis colecciones"],
        en: ["which requests", "list the requests", "which collections", "my requests", "my collections"],
      },
      params: params({ collection: optionalText("Only this collection's requests.") }),
      risk: "read",
      where: "app:api:requests",
      run: async ({ collection }) => {
        const store = await api();
        const { requests, collections, openTabs, activeTabId } = store.getState();
        const only = collection ? pickByName(collections, String(collection), (c) => c.name, "collection") : null;
        const listed = requests.filter((r) => !only || r.collection_id === only.id);
        const active = openTabs.find((t) => t.id === activeTabId);
        return {
          result: {
            collections: (only ? [only] : collections).map((c) => c.name),
            requests: listed.slice(0, 40).map((r) => `${r.method} ${requestLabel(collections.find((c) => c.id === r.collection_id)?.name, r.name)}`),
            total: listed.length,
            open: active?.name ?? null,
          },
          say: collections.length
            ? say("codi.say.collections", { list: spokenList(collections.map((c) => c.name)) })
            : say("codi.say.noCollections"),
        };
      },
    }),
  ];
}

/** A connection's engine as its driver names it (PostgreSQL, MongoDB…). */
function engineOf(row: Parameters<typeof rowDriverId>[0]): string {
  return catalogDriver(rowDriverId(row))?.name ?? row.kind;
}

/** The console a statement run out of sight goes to: one already on the connection, or a new one. */
async function consoleOn(connectionId: string): Promise<string> {
  const store = await db();
  const existing = store.getState().tabs.find((tab) => tab.kind === "console" && tab.connectionId === connectionId);
  if (existing) return existing.id;
  store.getState().newConsole(connectionId);
  return store.getState().activeTabId ?? "";
}

/**
 * A statement run on a connection without the database client on screen: connected if it is not, in a
 * console of that connection (the store's own run — its questions about risky statements included),
 * and its outcome said. Rows to look at offer to show them; that console is the active tab by then.
 */
async function runOutOfSight(statement: string, connection: unknown): Promise<CodiOutcome> {
  const store = await db();
  const state = store.getState();
  const row =
    typeof connection === "string" && connection.trim()
      ? pickByName(state.connections, connection, (c) => c.name, "connection")
      : state.connections.find((c) => c.id === (state.selectedConnectionId ?? state.connected[0]));
  if (!row) throw new CodiError("which connection? none is active — name one (connection)", say("codi.say.dbWhichConnection"));
  if (!store.getState().connected.includes(row.id) && !(await store.getState().connect(row.id))) {
    throw new CodiError(`could not connect to ${row.name}`, say("codi.say.dbConnectFailed", { name: row.name }));
  }
  const tabId = await consoleOn(row.id);
  if (!tabId) throw new CodiError("no console could be opened on the connection", say("codi.say.dbNoConsole"));
  const work = (async (): Promise<CodiOutcome> => {
    await store.getState().runConsole(tabId, statement);
    await waitFor(() => {
      const now = store.getState().tabs.find((candidate) => candidate.id === tabId);
      return !now || now.kind !== "console" || !now.running;
    }, 10 * 60 * 1000, 200);
    const done = store.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!done || done.kind !== "console") return { result: { ran: true } };
    const results = done.result?.results ?? [];
    if (results.length === 0) return { result: { ran: false }, say: say("codi.say.queryNotRun") };
    const failed = results.find((r) => r.error);
    if (failed) throw new CodiError(`the statement failed: ${failed.error}`, say("codi.say.queryFailedWhy", { reason: spokenReason(failed.error) }));
    const last = results[results.length - 1];
    const rows = last.columns.length ? last.rows.length : (last.rows_affected ?? 0);
    // The rows are what is worth seeing: their console is left as the client's active tab.
    if (last.columns.length && rows > 0) store.getState().setActiveTab(tabId);
    return {
      result: {
        connection: row.name,
        statements: results.length,
        ...(last.columns.length
          ? { columns: last.columns.map((c) => c.name).slice(0, 20), rows, sample: last.rows.slice(0, 3), truncated: last.truncated || undefined }
          : { affected: last.rows_affected }),
        ms: done.result?.duration_ms,
      },
      say: last.columns.length ? say("codi.say.queryRowsOn", { n: rows, name: row.name }) : say("codi.say.queryAffectedOn", { n: rows, name: row.name }),
      ...(last.columns.length && rows > 0 ? { offer: showOffer("app.open", { app: "api:database" }) } : {}),
    };
  })();
  return answerOrTell(work, {
    source: `db:${row.id}`,
    still: { result: { running: true, connection: row.name }, say: say("codi.say.queryRunning") },
    failed: (error) => say("codi.say.queryFailedWhy", { reason: spokenReason(error) }),
  });
}

export function dbActions(): CodiAction[] {
  return [
    defineAction({
      id: "db.list",
      title: {
        en: "This workspace's saved database connections: how many, their names and engines, and which are connected. Answers «how many connections do I have» from the data, never from the screen.",
        es: "Las conexiones de base de datos guardadas del workspace: cuántas hay, sus nombres y motores, y cuáles están conectadas. Responde «cuántas conexiones tengo» con los datos, nunca con la pantalla.",
      },
      aliases: {
        es: ["lista las conexiones", "mis conexiones", "dime las conexiones", "lista las bases de datos"],
        en: ["list the connections", "my connections", "list the databases"],
      },
      questions: {
        es: ["cuantas conexiones de base de datos", "cuantas conexiones", "que conexiones de base de datos", "que conexiones", "cuales conexiones", "cuantas bases de datos"],
        en: ["how many database connections", "how many connections", "which database connections", "which connections", "what connections", "how many databases"],
      },
      params: params(),
      risk: "read",
      where: "app:api:database",
      run: async () => {
        const store = await db();
        const { connections, connected } = store.getState();
        const counts = new Map<string, number>();
        for (const row of connections) counts.set(engineOf(row), (counts.get(engineOf(row)) ?? 0) + 1);
        const byEngine = [...counts].sort((a, b) => b[1] - a[1]).map(([engine, n]) => say("codi.say.dbEngineCount", { n, engine }));
        const live = connections.filter((row) => connected.includes(row.id)).map((row) => row.name);
        const sentence =
          connections.length === 0
            ? say("codi.say.noDbConnections")
            : connections.length === 1
              ? say("codi.say.dbConnectionOne", { name: connections[0].name, engine: engineOf(connections[0]) })
              : say("codi.say.dbConnections", { n: connections.length, list: spokenList(byEngine) });
        return {
          result: {
            total: connections.length,
            connections: connections.slice(0, 40).map((row) => ({
              name: row.name,
              engine: engineOf(row),
              ...(row.group_name ? { group: row.group_name } : {}),
              ...(connected.includes(row.id) ? { connected: true } : {}),
            })),
          },
          say: live.length ? `${sentence} ${say("codi.say.dbConnectedNow", { list: spokenList(live) })}` : sentence,
        };
      },
    }),
    defineAction({
      id: "db.open",
      title: {
        en: "Connect to a saved database connection by name (loose match), and open a console on it when it has none.",
        es: "Se conecta a una conexión de base de datos guardada por nombre (coincidencia flexible), y le abre una consola si no tiene.",
      },
      aliases: {
        es: ["conectate a", "conecta a la base", "abre la base de datos", "abre la conexion", "conectate a la base de datos"],
        en: ["connect to", "open the database", "open the connection", "connect to the database"],
      },
      params: params({ connection: text("The connection's name, as said.") }, ["connection"]),
      risk: "navigate",
      where: "app:api:database",
      run: async ({ connection }) => {
        showAppHere("api:database");
        const store = await db();
        const row = pickByName(store.getState().connections, String(connection), (c) => c.name, "connection");
        store.getState().selectConnection(row.id);
        if (!store.getState().connected.includes(row.id)) {
          const ok = await store.getState().connect(row.id);
          if (!ok) throw new CodiError(`could not connect to ${row.name}`, say("codi.say.dbConnectFailed", { name: row.name }));
        }
        const hasConsole = store.getState().tabs.some((tab) => tab.kind === "console" && tab.connectionId === row.id);
        if (!hasConsole) store.getState().newConsole(row.id);
        return { result: { connected: row.name, kind: row.kind }, say: say("codi.say.dbConnected", { name: row.name }) };
      },
    }),
    defineAction({
      id: "db.run",
      title: {
        en: "Run a query in the database client and say what it returned: the given statement on a connection (named, or the active one) — without opening the database client unless show is true — or, with none given, the text of the console on screen. Written in the connection's own language (db.list gives each one's engine): SQL, or for MongoDB `db.<collection>.find({}).limit(10)`, or for Redis its commands. Asks the user first.",
        es: "Ejecuta una consulta en el cliente de bases de datos y dice qué devolvió: la sentencia dada en una conexión (nombrada, o la activa) —sin abrir el cliente salvo que show sea true— o, sin sentencia, el texto de la consola en pantalla. Escrita en el lenguaje de la conexión (db.list da el motor de cada una): SQL, o en MongoDB `db.<colección>.find({}).limit(10)`, o en Redis sus comandos. Pide confirmación.",
      },
      aliases: {
        es: ["ejecuta la consulta", "corre la consulta", "ejecuta el sql", "lanza la consulta", "ejecuta en la base de datos", "consulta"],
        en: ["run the query", "execute the query", "run the sql", "query the database", "run this sql"],
      },
      params: params({
        sql: optionalText("The statement, in the connection's language (SQL; MongoDB: db.<collection>.find({}).limit(10)). Left out: what the console on screen holds."),
        connection: optionalText("The connection's name, as said. Left out: the active one."),
        show: showParam,
      }),
      risk: "destructive",
      where: "app:api:database",
      run: async ({ sql, connection, show }) => {
        if (sql && (await outOfSight(show))) return runOutOfSight(String(sql), connection);
        showAppHere("api:database");
        const store = await db();
        if (connection) {
          const row = pickByName(store.getState().connections, String(connection), (c) => c.name, "connection");
          if (!store.getState().connected.includes(row.id) && !(await store.getState().connect(row.id))) {
            throw new CodiError(`could not connect to ${row.name}`, say("codi.say.dbConnectFailed", { name: row.name }));
          }
          store.getState().selectConnection(row.id);
          store.getState().setActiveTab(await consoleOn(row.id));
        }
        const state = store.getState();
        let tab = state.tabs.find((candidate) => candidate.id === state.activeTabId && candidate.kind === "console");
        if (!tab && sql) {
          const connectionId = state.selectedConnectionId ?? state.connected[0] ?? null;
          if (!connectionId) throw new CodiError("no connection is open — connect first (db.open)", say("codi.say.dbNoConnection"));
          store.getState().newConsole(connectionId);
          const id = store.getState().activeTabId;
          tab = store.getState().tabs.find((candidate) => candidate.id === id && candidate.kind === "console");
        }
        if (!tab || tab.kind !== "console") throw new CodiError("no SQL console is on screen — open a connection first (db.open)", say("codi.say.dbNoConsole"));
        const tabId = tab.id;
        const statement = sql ? String(sql) : undefined;
        if (!statement && !tab.body.trim()) throw new CodiError("the console is empty — give the SQL to run");
        await store.getState().runConsole(tabId, statement);
        await waitFor(() => {
          const now = store.getState().tabs.find((candidate) => candidate.id === tabId);
          return !now || now.kind !== "console" || !now.running;
        }, 7000);
        const done = store.getState().tabs.find((candidate) => candidate.id === tabId);
        if (!done || done.kind !== "console") return { result: { ran: true } };
        if (done.running) return { result: { running: true }, say: say("codi.say.queryRunning") };
        const results = done.result?.results ?? [];
        if (results.length === 0) return { result: { ran: false }, say: say("codi.say.queryNotRun") };
        const failed = results.find((r) => r.error);
        if (failed) throw new CodiError(`the statement failed: ${failed.error}`, say("codi.say.queryFailed"));
        const last = results[results.length - 1];
        const rows = last.columns.length ? last.rows.length : (last.rows_affected ?? 0);
        return {
          result: {
            statements: results.length,
            ...(last.columns.length
              ? { columns: last.columns.map((c) => c.name).slice(0, 20), rows: last.rows.length, sample: last.rows.slice(0, 3), truncated: last.truncated || undefined }
              : { affected: last.rows_affected }),
            ms: done.result?.duration_ms,
          },
          say: last.columns.length ? say("codi.say.queryRows", { n: rows }) : say("codi.say.queryAffected", { n: rows }),
        };
      },
    }),
    defineAction({
      id: "db.refresh",
      title: { en: "Refresh the database tree and the open table (⌘⌥R).", es: "Actualiza el árbol de la base de datos y la tabla abierta (⌘⌥R)." },
      aliases: {
        es: ["actualiza la base de datos", "refresca la base de datos", "recarga las tablas", "refresca"],
        en: ["refresh the database", "reload the tables", "refresh"],
      },
      params: params(),
      risk: "navigate",
      where: "app:api:database",
      run: async () => {
        showAppHere("api:database");
        await db();
        const { useDbCommandStore } = await import("../../../state/dbCommandStore");
        useDbCommandStore.getState().send("refresh");
        return { result: { refreshed: true }, say: say("codi.say.dbRefreshed") };
      },
    }),
  ];
}
