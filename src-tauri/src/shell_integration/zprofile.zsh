# CodeFlow shell integration for zsh — login shells only: reads the user's .zprofile, where
# Homebrew, nvm, pnpm and asdf put their PATH entries. See .zshenv for the ZDOTDIR dance.
if [[ -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
  __codeflow_zdotdir="$ZDOTDIR"
  ZDOTDIR="$CODEFLOW_USER_ZDOTDIR"
  if [[ "$ZDOTDIR" != "$__codeflow_zdotdir" && -r "$ZDOTDIR/.zprofile" ]]; then
    builtin source "$ZDOTDIR/.zprofile"
  fi
  CODEFLOW_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__codeflow_zdotdir"
fi
