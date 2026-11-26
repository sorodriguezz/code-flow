import { useEffect, useRef, useState } from "react";
import { Check, Download, Loader2, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { onPocketInstall, speechPocketInstall, speechPocketRemove, speechPocketStatus, type PocketStatus } from "../../lib/tauri/teamCallCommands";
import { speechPocketPrepare, type DownloadableVoice } from "../../lib/tauri/speechCommands";
import type { Language } from "../../lib/i18n/translations";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { useSpeechStore } from "../../state/speechStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * The natural voices (`speech::pocket`): one engine and its twenty-seven voices, installed once and
 * used by the calls, and by the reading aloud and Codi when one of them is chosen there. This is
 * what «Llamadas» and «Modelos» share: whether they are here, the install with its progress line,
 * and taking them away.
 */

/** A voice of the natural engine: it says either language, and «Automática» never picks it. */
export const isNatural = (voice: Pick<DownloadableVoice, "engine">) => voice.engine === "pocket";

export interface NaturalVoices {
  /** `null` until read. */
  engine: PocketStatus | null;
  /** The last line of an install going on, `null` when there is none. */
  installing: string | null;
  install: () => void;
  remove: () => Promise<void>;
}

/** `onChange` is told when they have just been installed or taken away. */
export function useNaturalVoices(onChange?: () => void): NaturalVoices {
  const t = useT();
  const [engine, setEngine] = useState<PocketStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    void speechPocketStatus().then(setEngine).catch(() => setEngine(null));
    // An install started before this pane was opened keeps reporting here.
    const stop = onPocketInstall((event) => {
      if (event.state === "running") {
        setInstalling(event.line ?? "");
        return;
      }
      setInstalling(null);
      if (event.state === "failed" && event.line) pushErrorToast(event.line);
      void speechPocketStatus().then(setEngine).catch(() => {});
      // The voices every picker lists come from the speech status.
      void useSpeechStore.getState().refresh();
      changed.current?.();
    });
    return () => void stop.then((off) => off());
  }, []);

  return {
    engine,
    installing,
    install: () => {
      setInstalling("");
      void speechPocketInstall().catch(() => {
        /* The reason arrives on the event, which also clears the progress. */
      });
    },
    remove: async () => {
      if (!(await confirmAction(t("teamCall.settings.naturalRemoveConfirm"), true, t("teamCall.settings.naturalRemove")))) return;
      try {
        await speechPocketRemove();
        setEngine(await speechPocketStatus());
        void useSpeechStore.getState().refresh();
        changed.current?.();
      } catch (error) {
        pushErrorToast(String(error));
      }
    },
  };
}

/** The install button, its progress while it runs, or «Instaladas» with the way out. */
export function NaturalVoicesControl({ natural }: { natural: NaturalVoices }) {
  const t = useT();
  const { engine, installing } = natural;
  if (installing !== null) {
    return (
      <span role="status" className="flex min-w-0 items-center gap-2 text-[12.5px] text-[var(--cf-text-muted)]">
        <Loader2 size={14} className="shrink-0 animate-spin text-[var(--cf-accent)]" />
        <span className="min-w-0 truncate">{installing || t("teamCall.settings.naturalInstalling")}</span>
      </span>
    );
  }
  if (engine?.installed) {
    return (
      <>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--cf-success)]">
          <Check size={14} />
          {t("teamCall.settings.naturalInstalled")}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void natural.remove()}>
          <Trash2 size={13} />
          {t("teamCall.settings.naturalRemove")}
        </Button>
      </>
    );
  }
  return (
    <Button size="sm" variant="primary" disabled={engine === null} onClick={natural.install}>
      <Download size={13} />
      {t("teamCall.settings.naturalInstall")}
    </Button>
  );
}

/**
 * Whether natural voice `id` can read `lang` yet. The install brings the model of the app's
 * language; the other one comes down the first time a voice is chosen for it, which is what this
 * asks for — and waits for, so the row can say so. `null` for a voice that is not a natural one.
 */
export function useNaturalReady(lang: Language, id: string, natural: boolean): "ready" | "preparing" | "failed" | null {
  const [state, setState] = useState<"ready" | "preparing" | "failed">("ready");
  useEffect(() => {
    if (!natural || !id) return;
    let live = true;
    // Answered at once when the language is already here: say nothing unless it takes a moment.
    const slow = window.setTimeout(() => live && setState("preparing"), 350);
    void speechPocketPrepare(lang, id)
      .then(() => live && setState("ready"))
      .catch((error: unknown) => {
        if (!live) return;
        setState("failed");
        pushErrorToast(String(error));
      })
      .finally(() => window.clearTimeout(slow));
    return () => {
      live = false;
      window.clearTimeout(slow);
      setState("ready");
    };
  }, [lang, id, natural]);
  return natural && id ? state : null;
}
