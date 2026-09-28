import { chooseAction } from "../../state/confirmStore";
import { translate } from "../../state/languageStore";
import type { ConflictChoice, ConflictQuestions } from "../../lib/remote/transfers";

/**
 * The overwrite questions both file browsers ask, in the app's own many-answer dialog.
 *
 * "Keep both" is listed first because `chooseAction` makes the first answer the default — Enter picks
 * it — and it is the one that loses nothing. Replace is the red one. A batch is asked once with the
 * names listed, and "Decide each" is how to answer them one at a time; Cancel, Escape or a click
 * outside call the whole transfer off, which is what `resolveTransfers` does with `null`.
 */
export const conflictQuestions: ConflictQuestions = {
  one: async (item) => {
    const answer = await chooseAction({
      message: translate(item.isDir ? "remote.conflictOneFolder" : "remote.conflictOne", { name: item.name }),
      choices: [
        { id: "keep", label: translate("remote.conflictKeep"), variant: "primary" },
        { id: "skip", label: translate("remote.conflictSkip") },
        { id: "replace", label: translate("remote.conflictReplace"), variant: "danger" },
      ],
    });
    return answer as ConflictChoice | null;
  },
  all: async (names) => {
    const answer = await chooseAction({
      message: translate("remote.conflictMany", { n: String(names.length) }),
      items: names,
      choices: [
        { id: "keep", label: translate("remote.conflictKeepAll"), variant: "primary" },
        { id: "skip", label: translate("remote.conflictSkipAll") },
        { id: "replace", label: translate("remote.conflictReplaceAll"), variant: "danger" },
        { id: "each", label: translate("remote.conflictEach") },
      ],
    });
    return answer as ConflictChoice | "each" | null;
  },
};
