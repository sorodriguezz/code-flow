# CodeFlow shell integration for bash — Git Bash on Windows included.
#
# CodeFlow starts bash as `bash --init-file <this file> -i`, so bash reads this *instead of*
# ~/.bashrc and this reads the user's own files straight back; nothing in their home is ever
# written. `--init-file` and `--login` cannot be combined, so a profile that asked for a login
# shell arrives with CODEFLOW_SHELL_LOGIN=1 and gets what bash itself would have read: /etc/profile
# and then the first of ~/.bash_profile, ~/.bash_login, ~/.profile.
#
# The hooks print OSC escape sequences the terminal pane reads and never draws:
#
#   ESC ] 133 ; A BEL             a prompt is about to be drawn
#   ESC ] 633 ; E ; <b64> BEL     the command line about to run, base64 of its UTF-8
#   ESC ] 133 ; C BEL             the command's output starts
#   ESC ] 133 ; D ; <code> BEL    a command finished, with its exit status
#   ESC ] 7 ; file://<host><path> BEL   the working directory
#
# Per prompt the order is D (only when a command actually ran), then 7, then A. C, E and D need
# PS0, which bash 4.4 introduced; the bash 3.2 macOS still ships as /bin/bash gets the folder and
# the prompt mark only.

if [ -z "${__codeflow_bash_loaded-}" ]; then
  __codeflow_bash_loaded=1

  # The user's own startup files, at top level so their `declare`s stay global.
  if [ -n "${CODEFLOW_SHELL_LOGIN-}" ]; then
    builtin unset CODEFLOW_SHELL_LOGIN
    if [ -r /etc/profile ]; then
      . /etc/profile
    fi
    if [ -r ~/.bash_profile ]; then
      . ~/.bash_profile
    elif [ -r ~/.bash_login ]; then
      . ~/.bash_login
    elif [ -r ~/.profile ]; then
      . ~/.profile
    fi
  else
    if [ -r ~/.bashrc ]; then
      . ~/.bashrc
    fi
  fi

  __codeflow_ran=0
  # Set and never empty: bash skips evaluating a substring's offset on an unset variable, and that
  # offset is where PS0 sets the flag below.
  __codeflow_none=x

  # The working directory as a file URL. Percent-encodes what would break the URL (%, space, #, ?);
  # everything else, non-ASCII included, travels as its raw UTF-8. Git Bash's `/c/Users/x` becomes
  # `file:///C:/Users/x` — an empty host and a drive letter, which is what a Windows path is.
  __codeflow_cwd() {
    local p="$PWD" host="${HOSTNAME-}" drive
    case "${OSTYPE-}" in
      msys* | cygwin*)
        host=
        case "$p" in
          /[a-zA-Z] | /[a-zA-Z]/*)
            drive="${p:1:1}"
            p="/${drive^^}:${p:2}"
            [ "${#p}" -gt 3 ] || p="$p/"
            ;;
          *)
            # Somewhere under the install itself (/usr/bin, /tmp): only cygpath knows where that is.
            # Rare enough that a subprocess here is not a per-prompt cost.
            drive="$(cygpath -m "$p" 2>/dev/null)" && [ -n "$drive" ] && p="/$drive"
            ;;
        esac
        ;;
    esac
    p="${p//\%/%25}"
    p="${p// /%20}"
    p="${p//\#/%23}"
    p="${p//\?/%3F}"
    builtin printf '\033]7;file://%s%s\007' "$host" "$p"
  }

  # Runs first in PROMPT_COMMAND: D for the command that just finished. Hands its status on
  # untouched, so whatever the user's PROMPT_COMMAND does with $? still works.
  __codeflow_prompt_start() {
    local s=$?
    if [ "${__codeflow_ran-0}" = 1 ]; then
      __codeflow_ran=0
      builtin printf '\033]133;D;%s\007' "$s"
    fi
    return $s
  }

  # Runs last in PROMPT_COMMAND: the folder and A, right before PS1 is drawn. Passes on the status
  # it was given, so PS1 sees exactly what it saw before this file existed.
  __codeflow_prompt_end() {
    local s=$?
    __codeflow_cwd
    builtin printf '\033]133;A\007'
    __codeflow_histcmd="${HISTCMD-}"
    return $s
  }

  # Runs inside PS0's command substitution — a subshell, so it can print but not remember. E is
  # only sent when the history really gained an entry for this line, which is when HISTCMD (passed
  # in as $1) has moved since the prompt: with HISTCONTROL=ignorespace, or a duplicate under
  # ignoredups, `history 1` is the *previous* command, and naming that would be wrong rather than
  # merely missing. A multi-line entry is sent whole.
  __codeflow_command_line() {
    [ -n "$1" ] && [ "$1" != "${__codeflow_histcmd-}" ] || return 0
    builtin command -v base64 >/dev/null 2>&1 || return 0
    builtin command -v tr >/dev/null 2>&1 || return 0
    local line num
    line="$(HISTTIMEFORMAT= builtin history 1)" || return 0
    line="${line#"${line%%[![:space:]]*}"}"
    num="${line%%[!0-9]*}"
    line="${line#"$num"}"
    line="${line#\*}"
    line="${line#"${line%%[![:space:]]*}"}"
    builtin printf '\033]633;E;'
    builtin printf '%s' "$line" | command base64 | command tr -d '\n'
    builtin printf '\007'
  }

  if [ -z "${PROMPT_COMMAND-}" ]; then
    PROMPT_COMMAND=$'__codeflow_prompt_start\n__codeflow_prompt_end'
  elif [[ "$(builtin declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    # bash 5.1+ runs every element of an array PROMPT_COMMAND.
    PROMPT_COMMAND=(__codeflow_prompt_start "${PROMPT_COMMAND[@]}" __codeflow_prompt_end)
  else
    # Newlines, not `;`: a user value ending in `;` would turn `;;` into a syntax error.
    PROMPT_COMMAND=$'__codeflow_prompt_start\n'"$PROMPT_COMMAND"$'\n__codeflow_prompt_end'
  fi

  if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
    # PS0 is expanded in this shell after a line is read and before it runs — and only for a line
    # that holds a command, so an empty Enter never sets the flag. The substring of an empty
    # variable is how the flag gets set without printing anything: its offset is an arithmetic
    # expression, evaluated here rather than in the subshell `$(…)` would be. HISTCMD is passed as
    # an argument so it is the value this shell has after reading the line.
    PS0="${PS0-}"'${__codeflow_none:__codeflow_ran=1:0}$(__codeflow_command_line "$HISTCMD")\e]133;C\a'
  fi
fi
