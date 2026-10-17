# CodeFlow shell integration for zsh — the first of four files zsh reads from $ZDOTDIR.
#
# CodeFlow points ZDOTDIR at the folder holding this file, so zsh reads *these* startup files
# instead of the user's, and each of them reads the user's own straight back. The user's real
# folder arrives in CODEFLOW_USER_ZDOTDIR (their ZDOTDIR, or HOME when they set none). ZDOTDIR is
# put back to it around every user file, because a .zshenv that sources "$ZDOTDIR/aliases.zsh"
# must find *their* aliases, not ours. Nothing in the user's home is ever written.
#
# A user .zshenv that sets ZDOTDIR itself (the XDG pattern) is respected: whatever ZDOTDIR is
# after it ran becomes the folder the next three files read from.
if [[ -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
  __codeflow_zdotdir="$ZDOTDIR"
  ZDOTDIR="$CODEFLOW_USER_ZDOTDIR"
  if [[ "$ZDOTDIR" != "$__codeflow_zdotdir" && -r "$ZDOTDIR/.zshenv" ]]; then
    builtin source "$ZDOTDIR/.zshenv"
  fi
  CODEFLOW_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__codeflow_zdotdir"
fi
