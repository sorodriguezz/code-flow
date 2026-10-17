# CodeFlow shell integration for PowerShell — pwsh 7 and Windows PowerShell 5.1 alike.
#
# CodeFlow starts PowerShell with `-NoExit -Command` and reads this file into a script block rather
# than running it as a script, so the profile has already loaded, nothing in the user's home is
# written, and an execution policy of Restricted does not turn the integration into a red error.
#
# The hooks print OSC escape sequences the terminal pane reads and never draws:
#
#   ESC ] 133 ; A BEL             a prompt is about to be drawn
#   ESC ] 633 ; E ; <b64> BEL     the command line about to run, base64 of its UTF-8
#   ESC ] 133 ; C BEL             the command's output starts
#   ESC ] 133 ; D ; <code> BEL    a command finished, with its exit status
#   ESC ] 7 ; file://<host><path> BEL   the working directory (file:///C:/… on Windows)
#
# Per prompt the order is D (only when a command actually ran), then 7, then A. [char]27 and
# [char]7 rather than `e and `a, which Windows PowerShell 5.1 does not have. C and E need
# PSReadLine, which is what draws the line being typed; without it a prompt still gets D, 7 and A.

if (-not $global:__CodeFlowLoaded) {
    $global:__CodeFlowLoaded = $true
    $global:__CodeFlowEsc = [string][char]27
    $global:__CodeFlowBel = [string][char]7
    $global:__CodeFlowOriginalPrompt = $function:prompt
    $global:__CodeFlowLastHistoryId = -1
    $__codeflowLast = Get-History -Count 1
    if ($__codeflowLast) { $global:__CodeFlowLastHistoryId = $__codeflowLast.Id }
    Remove-Variable -Name __codeflowLast -ErrorAction SilentlyContinue

    function global:__CodeFlow-Cwd {
        if ($PWD.Provider.Name -ne 'FileSystem') { return '' }
        $p = $PWD.ProviderPath -replace '\\', '/'
        $hostName = ''
        if ($p -match '^//') {
            # \\server\share: the server is the URL's host.
            $p = $p.Substring(1)
        } elseif ($p -match '^[A-Za-z]:') {
            $p = '/' + $p
        } else {
            $hostName = [Environment]::MachineName
        }
        $p = $p.Replace('%', '%25').Replace(' ', '%20').Replace('#', '%23').Replace('?', '%3F')
        return "$($global:__CodeFlowEsc)]7;file://$hostName$p$($global:__CodeFlowBel)"
    }

    function global:prompt {
        # First, before anything else runs: how the last command went.
        $succeeded = $global:?
        $lastExit = $global:LASTEXITCODE
        $marks = ''
        $last = Get-History -Count 1
        if ($last -and $last.Id -ne $global:__CodeFlowLastHistoryId) {
            # A new history entry is a command that really ran; an empty Enter adds none.
            $global:__CodeFlowLastHistoryId = $last.Id
            if ($succeeded) { $code = 0 } elseif ($lastExit) { $code = $lastExit } else { $code = 1 }
            $marks += "$($global:__CodeFlowEsc)]133;D;$code$($global:__CodeFlowBel)"
        }
        $marks += __CodeFlow-Cwd
        $marks += "$($global:__CodeFlowEsc)]133;A$($global:__CodeFlowBel)"
        # The user's prompt sees what it would have seen: $LASTEXITCODE as it was, and $? false
        # again when the command failed (a silenced error is the only way to set it).
        $global:LASTEXITCODE = $lastExit
        if (-not $succeeded) { Write-Error 'failure' -ErrorAction Ignore }
        $original = if ($global:__CodeFlowOriginalPrompt) { & $global:__CodeFlowOriginalPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
        $global:LASTEXITCODE = $lastExit
        return $marks + ($original -join '')
    }

    # C and E at the moment PSReadLine hands a finished line over — after a multi-line entry is
    # complete, unlike an Enter key handler, which fires on every continuation line too.
    try {
        if ((Get-Module -Name PSReadLine) -and (Get-Command -Name PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue)) {
            $global:__CodeFlowOriginalReadLine = (Get-Command -Name PSConsoleHostReadLine -CommandType Function).ScriptBlock
            function global:PSConsoleHostReadLine {
                # PSReadLine reads $? on entry to colour an error prompt; hand it the real one.
                $succeeded = $?
                if (-not $succeeded) { Write-Error 'failure' -ErrorAction Ignore }
                $line = & $global:__CodeFlowOriginalReadLine
                if ($line -and $line.Trim()) {
                    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$line))
                    [Console]::Write("$($global:__CodeFlowEsc)]633;E;$b64$($global:__CodeFlowBel)$($global:__CodeFlowEsc)]133;C$($global:__CodeFlowBel)")
                }
                $line
            }
        }
    } catch {}
}
