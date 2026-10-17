# CodeFlow shell integration for zsh — login shells only, and the last file zsh reads: the user's
# .zlogin, then ZDOTDIR goes back to the user's so a `zsh` typed at this prompt starts normally.
if [[ -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
  __codeflow_zdotdir="$ZDOTDIR"
  ZDOTDIR="$CODEFLOW_USER_ZDOTDIR"
  if [[ "$ZDOTDIR" != "$__codeflow_zdotdir" && -r "$ZDOTDIR/.zlogin" ]]; then
    builtin source "$ZDOTDIR/.zlogin"
  fi
  CODEFLOW_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__codeflow_zdotdir"
  if (( $+functions[__codeflow_restore_zdotdir] )); then
    __codeflow_restore_zdotdir
  fi
fi
