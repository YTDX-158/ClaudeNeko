' Run ClaudeNeko idempotent starter fully hidden (no console window).
' Called by Task Scheduler (onlogon + repeat every N minutes).
' NOTE: Run the .bat by full path via ShellExecute (NOT "cmd /c cd ..." string),
' because Chinese chars in the path get corrupted when string-parsed by cmd.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & dir & "\start-server.bat""", 0, False
