# CodeFlow shell integration for fish.
#
# CodeFlow starts fish with `--init-command 'source <this file>'`, which fish runs after the user's
# config.fish and before the first prompt, so their configuration is read exactly as it always is
# and nothing in their home is written.
#
# The hooks print OSC escape sequences the terminal pane reads and never draws:
#
#   ESC ] 133 ; A BEL             a prompt is about to be drawn
#   ESC ] 633 ; E ; <b64> BEL     the command line about to run, base64 of its UTF-8
#   ESC ] 133 ; C BEL             the command's output starts
#   ESC ] 133 ; D ; <code> BEL    a command finished, with its exit status
#   ESC ] 7 ; file://<host><path> BEL   the working directory
#
# Per prompt the order is D (only when a command actually ran), then 7, then A: fish_postexec
# fires before fish_prompt. Event handlers cannot change the $status the prompt sees.

if not set -q __codeflow_fish_loaded
    set -g __codeflow_fish_loaded 1
    set -g __codeflow_ran 0

    function __codeflow_preexec --on-event fish_preexec
        # Older fish fires this for an empty line too; that is not a command running.
        set -l typed (string trim -- "$argv[1]")
        if test -z "$typed"
            return
        end
        if command -sq base64; and command -sq tr
            printf '\e]633;E;'
            printf '%s' "$argv[1]" | command base64 | command tr -d '\n'
            printf '\a'
        end
        printf '\e]133;C\a'
        set -g __codeflow_ran 1
    end

    function __codeflow_postexec --on-event fish_postexec
        set -l code $status
        if test "$__codeflow_ran" = 1
            set -g __codeflow_ran 0
            printf '\e]133;D;%s\a' $code
        end
    end

    function __codeflow_prompt --on-event fish_prompt
        # %, space, # and ? would break the URL; everything else travels as raw UTF-8.
        set -l p (string replace -a '%' '%25' -- $PWD | string replace -a ' ' '%20' | string replace -a '#' '%23' | string replace -a '?' '%3F')
        set -l host ''
        if set -q hostname
            set host $hostname
        end
        printf '\e]7;file://%s%s\a' "$host" "$p"
        printf '\e]133;A\a'
    end
end
