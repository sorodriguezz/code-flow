import { useUiStore } from "../../../state/uiStore";
import { CodiError, type CodiAction } from "../registry";
import { defineAction, optionalText, params, pickByName, say, showAppHere, spokenList, text, waitFor } from "./shared";

/**
 * The API client and the database client — the two sides of the API tab, each its own rail app
 * (`api:requests`, `api:database`) and so each its own island when detached.
 *
 * Sending and running go through what the views already do: the API client's send is its command
 * bus (`apiCommandStore`, the same request ⌘↵ posts), and a SQL console runs through `runConsole`,
 * which asks first about the statements nobody means by accident (an `UPDATE` with no `WHERE`, any
 * write on a connection labelled production). `db.run` is marked destructive on top of that — Codi
 * asks before it sends any SQL, and the store's own questions still follow.
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

export function apiActions(): CodiAction[] {
  return [
    defineAction({
      id: "api.send",
      title: {
        en: "Send the request open in the API client (⌘↵) and report its status.",
        es: "Envía la petición abierta en el cliente API (⌘↵) e informa su estado.",
      },
      aliases: {
        es: ["envia la peticion", "manda la peticion", "ejecuta la peticion", "lanza la peticion", "dispara la peticion", "envia el request"],
        en: ["send the request", "run the request", "fire the request", "send it to the api"],
      },
      params: params(),
      risk: "write",
      where: "app:api:requests",
      frequent: true,
      run: async () => {
        showAppHere("api:requests");
        const store = await api();
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

export function dbActions(): CodiAction[] {
  return [
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
        en: "Run SQL in the database client: the given statement in the console on screen (or a new one on the active connection), or — with none given — the console's own text. Asks the user first.",
        es: "Ejecuta SQL en el cliente de bases de datos: la sentencia dada en la consola en pantalla (o una nueva en la conexión activa), o, sin ninguna, el texto de la consola. Pide confirmación.",
      },
      aliases: {
        es: ["ejecuta la consulta", "corre la consulta", "ejecuta el sql", "lanza la consulta", "ejecuta en la base de datos", "consulta"],
        en: ["run the query", "execute the query", "run the sql", "query the database", "run this sql"],
      },
      params: params({ sql: optionalText("The statement. Left out: what the console on screen holds.") }),
      risk: "destructive",
      where: "app:api:database",
      run: async ({ sql }) => {
        showAppHere("api:database");
        const store = await db();
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
