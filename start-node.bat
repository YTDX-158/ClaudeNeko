@echo off
rem ============================================================
rem  Start ClaudeNeko backend hidden (called by run-node.vbs via
rem  ShellExecute). Logs to server\log.txt for debugging.
rem  %~dp0 resolves at runtime -> no cmd string-parse of the path,
rem  so Chinese directory names are safe.
rem ============================================================
cd /d "%~dp0"
node server/server.js >> server\log.txt 2>&1
