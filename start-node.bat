@echo off
rem ============================================================
rem  Start ClaudeNeko backend hidden (called by run-node.vbs via
rem  ShellExecute). Logs to server\log.txt via logger.js.
rem  Prefer ClaudeNekoNode.exe so Task Manager shows the name;
rem  fall back to system node when the renamed exe is absent.
rem ============================================================
cd /d "%~dp0"
if exist "%~dp0ClaudeNekoNode.exe" (
  "%~dp0ClaudeNekoNode.exe" server/server.js
) else (
  node server/server.js
)
