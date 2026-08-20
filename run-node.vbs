' Run ClaudeNeko backend fully hidden (no console window).
' Called from start-web.bat. Logs to server\log.txt for debugging.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "cmd /c cd /d """ & dir & """ && node server/server.js >> server\log.txt 2>&1", 0, False
