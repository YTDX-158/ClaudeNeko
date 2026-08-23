' Start ClaudeNeko backend fully hidden (no console window).
' Runs start-node.bat via ShellExecute (NOT cmd /c string parse) so Chinese
' chars in the path don't get corrupted (same fix as start-server.vbs).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & dir & "\start-node.bat""", 0, False
