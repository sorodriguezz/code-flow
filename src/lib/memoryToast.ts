/** The toast for what a "recuerda que…" did (`ai_memory::Remembered`): a memory saved, a proposal
 *  approved, one updated or one already known — never a blanket "learned" for all four. Both chats
 *  say it the same way. */
export function learnedKey(outcome: "new" | "approved" | "updated" | "already_known" | null | undefined) {
  switch (outcome) {
    case "approved":
      return "memory.approvedExisting" as const;
    case "updated":
      return "memory.updated" as const;
    case "already_known":
      return "memory.alreadyKnown" as const;
    default:
      return "memory.learned" as const;
  }
}
