import { useEffect, useState } from "react";
import { providerCapabilities } from "./aiProviders";
import { chatModelReadsImages } from "./tauri/chatCommands";

/** Answers already given, per `provider\0model` — a model's eyesight does not change while the app
 *  runs, and the composer asks again on every mount. */
const known = new Map<string, boolean>();

/**
 * Whether `model`, run through `provider`, looks at an attached image.
 *
 * Two questions, cheapest first: the provider's capability (`acceptsImages`) rules out the four
 * CLIs that cannot hand a model an image at all, with no IPC; for the other two the backend answers
 * per model — Codex from the catalog it keeps for itself, so a text-only model released later loses
 * the attach button without an app release. Until that answer arrives a capable provider reads as
 * yes, the same convention as the reasoning dial: a control that blinks out on every engine switch
 * is worse than one that very occasionally lingers for a frame.
 */
export function useModelReadsImages(provider: string, model: string): boolean {
  const capable = providerCapabilities(provider).acceptsImages;
  const key = `${provider}\u0000${model}`;
  const [answer, setAnswer] = useState<boolean | undefined>(() => known.get(key));

  useEffect(() => {
    if (!capable) return;
    if (known.has(key)) {
      setAnswer(known.get(key));
      return;
    }
    setAnswer(undefined);
    let live = true;
    void chatModelReadsImages(provider, model)
      .then((sees) => {
        known.set(key, sees);
        if (live) setAnswer(sees);
      })
      // Unrecorded on failure: unknown already reads as yes, and storing a failed probe as "no"
      // would take the button away for the rest of the session over one bad call.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [capable, key, provider, model]);

  return capable && (answer ?? true);
}
