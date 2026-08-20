' Entry point for the neko:// custom protocol.
' Runs start-web.bat with the window hidden (no black cmd flash).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run """" & dir & "\start-web.bat""", 0, False
