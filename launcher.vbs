' Entry point for the neko:// custom protocol.
' Runs start-web.bat with the window hidden (no black cmd flash).
' v2.4.14: 启动前检测 Claude Code，缺失则友好提示并引导安装 ClaudeInstall
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' 检测 claude：优先 CLAUDE_BIN 环境变量，其次 npm 全局路径 / npm bin shim
Function HasClaude()
    Dim p
    p = sh.ExpandEnvironmentStrings("%CLAUDE_BIN%")
    If p <> "%CLAUDE_BIN%" Then
        If fso.FileExists(p) Then HasClaude = True : Exit Function
    End If
    p = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
    If fso.FileExists(p) Then HasClaude = True : Exit Function
    p = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\claude.cmd"
    If fso.FileExists(p) Then HasClaude = True : Exit Function
    HasClaude = False
End Function

If Not HasClaude() Then
    msg = "未检测到 Claude Code（claude）。" & vbCrLf & vbCrLf & _
          "ClaudeNeko 需要先装好 Claude Code 才能使用。" & vbCrLf & vbCrLf & _
          "点「确定」打开下载页（ClaudeInstall 一键安装器）" & vbCrLf & _
          "下载密码：YTDX666"
    If MsgBox(msg, vbOKCancel + vbExclamation, "ClaudeNeko") = vbOK Then
        sh.Run "https://wwbkn.lanzoum.com/b01giav0jc", 1, False
    End If
    WScript.Quit
End If

CreateObject("Wscript.Shell").Run """" & dir & "\start-web.bat""", 0, False
