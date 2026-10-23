import { useUiStore } from "../../../state/uiStore";
import { useTourStore } from "../../../state/tourStore";
import { translate } from "../../../state/languageStore";
import { APP_TOURS, TOURS, appTourFor, type TourId } from "../../tour/steps";
import { CodiError, type CodiAction } from "../registry";
import type { TranslationKey } from "../../i18n/translations";
import { appVocabulary, literal, namesFor, viewVocabulary, type Spoken, type Vocabulary } from "../vocabulary";
import { defineAction, flag, oneOf, params, say } from "./shared";

/**
 * The guided tours, driven by voice: «Codi, ¿cómo funciona el cliente API?» opens its tour and Codi
 * explains it aloud, step by step, turning the page itself (`useTourNarration`); «siguiente»,
 * «atrás», «repite», «pausa», «sigue» and «termina el tour» drive it from there (user, 2026-10-22:
 * «esto es muy útil e interactivo para usuarios nuevos»).
 *
 * `tour.start` is one of the few actions that answers a *question* by acting (`questions`): the
 * router takes «¿cómo funciona flujos?» without a model, and only when every word of it names the
 * tour — «¿qué es un commit?» is still the model's.
 *
 * The step actions answer `say: ""`: the narration is the answer, and nothing is said over it.
 */

/** The tours the catalogue offers: what is on screen, then each tour by its id. */
const CURRENT = "current";
const TOUR_IDS = Object.keys(TOURS) as TourId[];

/** The rail app each tour belongs to, for its spoken names. */
const TOUR_APP: Partial<Record<TourId, string>> = {
  api: "api:requests",
  db: "api:database",
  agents: "agents",
  stories: "stories",
  remote: "remote",
  notes: "notes",
  diagrams: "diagrams",
  vault: "vault",
  chat: "chat",
  flows: "flows",
  architecture: "architecture",
};

/** Names a person reaches for beyond the app's own. */
const TOUR_EXTRA: Partial<Record<TourId | typeof CURRENT, Partial<Spoken>>> = {
  [CURRENT]: {
    es: ["esto", "eso", "esta app", "esta aplicacion", "esta pantalla", "esta vista", "esta seccion", "aqui", "lo que estoy viendo"],
    en: ["this", "that", "this app", "this screen", "this view", "here", "what i am looking at"],
  },
  main: {
    es: ["codeflow", "code flow", "lo basico", "tour principal", "tour general", "la ventana principal", "la app en general"],
    en: ["codeflow", "code flow", "the basics", "main tour", "general tour", "the main window", "the app in general"],
  },
  api: { es: ["api client", "api cliente", "cliente de api", "cliente de apis", "cliente api"], en: ["api client"] },
  db: { es: ["base de datos", "bases de datos", "cliente de base de datos"], en: ["database client"] },
  // Codi's own (user, 2026-10-22): «¿cómo funciona Codi?» is its tour, narrated by itself.
  codi: { es: ["codi", "cody", "el asistente de voz", "asistente de voz", "tu", "ti"], en: ["codi", "cody", "the voice assistant", "voice assistant", "you"] },
};

function tourVocabulary(): Vocabulary {
  const apps = appVocabulary();
  const views = viewVocabulary(["pipelines"]);
  const merge = (a: Spoken | undefined, b: Spoken): Spoken => ({ es: [...new Set([...(a?.es ?? []), ...b.es])], en: [...new Set([...(a?.en ?? []), ...b.en])] });
  const out: Vocabulary = { [CURRENT]: literal({ [CURRENT]: TOUR_EXTRA[CURRENT] ?? {} })[CURRENT] };
  for (const id of TOUR_IDS) {
    const own = TOUR_APP[id] ? apps[TOUR_APP[id] as string] : id === "pipelines" ? views.pipelines : undefined;
    out[id] = merge(own, namesFor(null, TOUR_EXTRA[id] ?? {}));
  }
  return out;
}

/** A tour's name as the UI says it: its app's, or CodeFlow for the window's own. */
export function tourName(id: TourId): string {
  if (id === "codi") return "Codi";
  const app = APP_TOURS.find((entry) => entry.tour === id);
  return app ? translate(app.labelKey) : "CodeFlow";
}

/** The tour of what is on screen — what the rail's graduation cap starts. */
function currentTour(): TourId {
  const { activeView, apiWorkspace } = useUiStore.getState();
  return appTourFor(activeView, apiWorkspace)?.tour ?? "main";
}

function requireTour() {
  const tour = useTourStore.getState();
  if (!tour.active) throw new CodiError("no tour is open — start one with tour.start", say("codi.say.noTour"));
  return tour;
}

/** Back or forward a step in the tour on screen, when there is one — what «atrás» and «siguiente»
 *  mean while a tour is up (`nav.back` / `nav.forward` hand over to it). */
export function stepTour(direction: "back" | "next"): boolean {
  const tour = useTourStore.getState();
  if (!tour.active) return false;
  if (direction === "back") tour.back();
  else tour.next();
  return true;
}

const quiet = (result: unknown) => ({ result, say: "" });

/**
 * The parts of the app with no tour of their own — the dock's panels, the assistant — said in a
 * sentence or two, and offered open (user, 2026-10-22: «detecté que codi no
 * sabe qué es el panel de contenedores siendo que sí existe»).
 */
const ABOUT: Record<string, { say: TranslationKey; open?: { action: string; params: Record<string, unknown> } }> = {
  containers: { say: "codi.about.containers", open: { action: "dock.show", params: { view: "containers" } } },
  services: { say: "codi.about.services", open: { action: "dock.show", params: { view: "services" } } },
  terminal: { say: "codi.about.terminal", open: { action: "dock.show", params: { view: "terminal" } } },
  aiPanel: { say: "codi.about.aiPanel", open: { action: "panel.ai", params: { state: "open" } } },
};

const ABOUT_NAMES = literal({
  containers: { es: ["contenedores", "el panel de contenedores", "docker", "kubernetes"], en: ["containers", "the containers panel", "docker", "kubernetes"] },
  services: { es: ["servicios", "el panel de servicios"], en: ["services", "the services panel"] },
  terminal: { es: ["terminal", "terminales", "la terminal", "consola"], en: ["terminal", "terminals", "the terminal", "console"] },
  aiPanel: { es: ["panel de ia", "el panel de ia", "panel del asistente", "el asistente", "panel de chat", "el panel de chat"], en: ["ai panel", "the ai panel", "the assistant", "the assistant panel", "chat panel"] },
});

export function tourActions(): CodiAction[] {
  return [
    defineAction({
      id: "app.about",
      title: {
        en: "Say what a part of the app with no tour is for — the containers, services or terminal panels, the AI panel — and offer to open it. For «what is X?» when X has no tour.",
        es: "Dice para qué sirve una parte de la app que no tiene tour —los paneles de contenedores, servicios o terminal, el panel de IA— y ofrece abrirla. Para «¿qué es X?» cuando X no tiene tour.",
      },
      questions: {
        es: ["que es", "que son", "para que sirve", "para que sirven", "como funciona", "como funcionan", "que hace", "que puedo hacer con"],
        en: ["what is", "what are", "what is the", "what does", "how does", "what can i do with"],
      },
      aliases: { es: ["explicame el panel de", "explicame la app de"], en: ["explain the panel", "explain the app"] },
      get vocabulary() {
        return { topic: ABOUT_NAMES };
      },
      params: params({ topic: oneOf(Object.keys(ABOUT), "Which part of the app.") }, ["topic"]),
      risk: "read",
      where: "main",
      run: async ({ topic }) => {
        const about = ABOUT[String(topic)];
        return {
          result: { topic },
          say: say(about.say),
          ...(about.open ? { offer: { ...about.open, question: say("codi.say.offerOpen") } } : {}),
        };
      },
    }),
    defineAction({
      id: "tour.start",
      title: {
        en: "Start a guided tour of an app and have Codi explain it aloud, step by step, moving on by itself. The answer to «how does X work?», «what is X for?», «explain X», «open X's tour». `tour`: the app's tour, `codi` for Codi itself, `current` for what is on screen, `main` for the window as a whole.",
        es: "Abre el tour guiado de una app y Codi lo explica en voz alta, paso a paso, avanzando solo. Es la respuesta a «¿cómo funciona X?», «¿para qué sirve X?», «explícame X», «abre el tour de X». `tour`: el de la app, `codi` para el propio Codi, `current` para lo que está en pantalla, `main` para la ventana en general.",
      },
      aliases: {
        es: [
          "abre el tour", "abre el tour de", "inicia el tour", "empieza el tour", "comienza el tour", "pon el tour", "muestrame el tour", "tour de", "tour del",
          "el tour de", "tour guiado", "recorrido de", "recorrido por", "explicame", "explicame como funciona", "explicame como se usa", "ensename",
          "ensename como funciona", "ensename a usar", "guiame por", "dame un tour", "hazme un tour", "quiero aprender a usar",
        ],
        en: ["start the tour", "open the tour", "tour of", "the tour of", "guided tour", "show me the tour", "walk me through", "explain", "teach me", "show me how", "give me a tour", "show me around"],
      },
      questions: {
        es: ["como funciona", "como funcionan", "como se usa", "como se usan", "como uso", "como utilizo", "que es", "que son", "para que sirve", "para que sirven", "que hace", "que puedo hacer en", "que puedo hacer con"],
        en: ["how does", "how do", "how do i use", "how to use", "what is", "what are", "what does", "what can i do with", "what can i do in"],
      },
      get vocabulary() {
        return { tour: tourVocabulary() };
      },
      params: params({
        tour: oneOf([CURRENT, ...TOUR_IDS], "Which tour; `current` (the default) is the one of what is on screen."),
        narrate: flag("Codi explains it aloud and moves on by itself (the default); false only opens it."),
      }),
      risk: "navigate",
      where: "main",
      frequent: true,
      run: async ({ tour, narrate }) => {
        const id = !tour || tour === CURRENT ? currentTour() : (tour as TourId);
        const aloud = narrate !== false;
        useTourStore.getState().start({ tour: id, narrate: aloud });
        const name = tourName(id);
        return { result: { tour: id, steps: TOURS[id].length, narrated: aloud }, say: say(aloud ? "codi.say.tourStarted" : "codi.say.tourOpened", { name }) };
      },
    }),

    defineAction({
      id: "tour.next",
      title: { en: "Show the tour's next step (on the last one, finish it).", es: "Pasa al siguiente paso del tour (en el último, lo termina)." },
      aliases: { es: ["siguiente paso", "paso siguiente", "el siguiente paso", "pasa al siguiente paso", "sigue al siguiente paso"], en: ["next step", "the next step", "go to the next step"] },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        requireTour().next();
        return quiet({ step: useTourStore.getState().index + 1 });
      },
    }),

    defineAction({
      id: "tour.back",
      title: { en: "Show the tour's previous step.", es: "Vuelve al paso anterior del tour." },
      aliases: { es: ["paso anterior", "el paso anterior", "vuelve al paso anterior", "regresa al paso anterior"], en: ["previous step", "the previous step", "step back", "go to the previous step"] },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        requireTour().back();
        return quiet({ step: useTourStore.getState().index + 1 });
      },
    }),

    defineAction({
      id: "tour.repeat",
      title: { en: "Say the tour's current step again.", es: "Vuelve a explicar el paso actual del tour." },
      aliases: { es: ["repite", "repitelo", "repite eso", "repite el paso", "otra vez", "de nuevo", "vuelve a explicar", "vuelve a explicarlo", "no entendi"], en: ["repeat", "repeat that", "say it again", "again", "one more time", "explain it again"] },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        requireTour().resumeNarration();
        return quiet({ step: useTourStore.getState().index + 1 });
      },
    }),

    defineAction({
      id: "tour.pause",
      title: { en: "Hold the tour on this step and stop explaining.", es: "Deja el tour en este paso y deja de explicar." },
      aliases: { es: ["pausa", "pausa el tour", "pon pausa", "pausalo", "espera", "un momento", "detente"], en: ["pause", "pause the tour", "hold on", "wait"] },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        requireTour().pauseNarration();
        return quiet({ paused: true });
      },
    }),

    defineAction({
      id: "tour.resume",
      title: { en: "Go on explaining the tour from this step.", es: "Sigue explicando el tour desde este paso." },
      aliases: { es: ["sigue", "continua", "sigue explicando", "continua el tour", "sigue con el tour", "continua explicando"], en: ["continue", "go on", "keep going", "resume", "carry on", "resume the tour"] },
      params: params(),
      risk: "read",
      where: "main",
      run: async () => {
        requireTour().resumeNarration();
        return quiet({ step: useTourStore.getState().index + 1 });
      },
    }),

    defineAction({
      id: "tour.stop",
      title: { en: "Close the tour, putting the app back as it was.", es: "Cierra el tour y deja la app como estaba." },
      aliases: { es: ["termina el tour", "sal del tour", "cierra el tour", "salir del tour", "fin del tour", "deten el tour", "para el tour", "acaba el tour", "omite el tour"], en: ["end the tour", "exit the tour", "close the tour", "stop the tour", "skip the tour", "quit the tour", "finish the tour"] },
      params: params(),
      risk: "navigate",
      where: "main",
      run: async () => {
        requireTour().skip();
        return quiet({ closed: true });
      },
    }),
  ];
}
