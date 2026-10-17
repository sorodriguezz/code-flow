# CodeFlow shell integration for zsh — interactive shells: the user's .zshrc, then the hooks.
#
# The hooks print OSC escape sequences the terminal pane reads and never draws:
#
#   ESC ] 133 ; A BEL             a prompt is about to be drawn
#   ESC ] 633 ; E ; <b64> BEL     the command line about to run, base64 of its UTF-8
#   ESC ] 133 ; C BEL             the command's output starts
#   ESC ] 133 ; D ; <code> BEL    a command finished, with its exit status
#   ESC ] 7 ; file://<host><path> BEL   the working directory
#
# Per prompt the order is D (only when a command actually ran), then 7, then A. They are appended
# *last* to precmd_functions / preexec_functions, so A lands after every other precmd hook has
# had its say and right before the prompt is drawn.
if [[ -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
  __codeflow_zdotdir="$ZDOTDIR"
  # /etc/zshrc (macOS) set HISTFILE from ${ZDOTDIR:-$HOME} while ZDOTDIR was ours. History belongs
  # in the user's folder, and their own .zshrc may still move it.
  if [[ "${HISTFILE-}" == "$__codeflow_zdotdir"/* ]]; then
    HISTFILE="$CODEFLOW_USER_ZDOTDIR/.zsh_history"
  fi
  ZDOTDIR="$CODEFLOW_USER_ZDOTDIR"
  if [[ "$ZDOTDIR" != "$__codeflow_zdotdir" && -r "$ZDOTDIR/.zshrc" ]]; then
    builtin source "$ZDOTDIR/.zshrc"
  fi
  CODEFLOW_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$__codeflow_zdotdir"
fi

# Puts ZDOTDIR back to what the user had — unset if they had none — and drops the variables that
# only existed to carry it here. Called from whichever of our files zsh reads last.
__codeflow_restore_zdotdir() {
  if [[ -n "${CODEFLOW_ZDOTDIR_UNSET-}" && "${CODEFLOW_USER_ZDOTDIR-}" == "$HOME" ]]; then
    builtin unset ZDOTDIR
  elif [[ -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
    builtin export ZDOTDIR="$CODEFLOW_USER_ZDOTDIR"
  fi
  builtin unset CODEFLOW_USER_ZDOTDIR CODEFLOW_ZDOTDIR_UNSET __codeflow_zdotdir
}

if [[ -z "${__codeflow_hooked-}" ]]; then
  typeset -g __codeflow_hooked=1
  typeset -g __codeflow_ran=

  # The working directory as a file URL. Percent-encodes what would break the URL (%, space, #, ?);
  # everything else, non-ASCII included, travels as its raw UTF-8.
  __codeflow_cwd() {
    emulate -L zsh
    local p="${PWD//\%/%25}"
    p="${p// /%20}"
    p="${p//\#/%23}"
    p="${p//\?/%3F}"
    builtin printf '\033]7;file://%s%s\007' "${HOST-}" "$p"
  }

  __codeflow_precmd() {
    # First, before anything can overwrite it: the status of the command that just ran.
    local ret=$?
    emulate -L zsh
    if [[ -n "$__codeflow_ran" ]]; then
      __codeflow_ran=
      builtin printf '\033]133;D;%s\007' "$ret"
    fi
    __codeflow_cwd
    builtin printf '\033]133;A\007'
    return $ret
  }

  # Not called for an empty Enter, which is exactly why D is gated on it.
  __codeflow_preexec() {
    emulate -L zsh
    if (( $+commands[base64] && $+commands[tr] )); then
      builtin printf '\033]633;E;'
      builtin printf '%s' "$1" | command base64 | command tr -d '\n'
      builtin printf '\007'
    fi
    builtin printf '\033]133;C\007'
    __codeflow_ran=1
  }

  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(__codeflow_precmd)
  preexec_functions+=(__codeflow_preexec)
fi

# A non-login shell reads no .zlogin, so this is its last file.
if [[ ! -o login && -n "${CODEFLOW_USER_ZDOTDIR-}" ]]; then
  __codeflow_restore_zdotdir
fi
