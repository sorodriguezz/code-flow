/** A model's name as it fits beside its provider's mark: the mark already says whose it is. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}
