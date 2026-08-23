@echo off
rem ============================================================
rem  ClaudeNeko idempotent starter: if port 4000 is already
rem  healthy, exit; otherwise start the backend hidden via
rem  run-node.vbs, then exit. NOT a long-running loop.
rem
rem  Called by Task Scheduler (onlogon + repeat every N minutes)
rem  so a crashed backend gets revived within N minutes.
rem ============================================================
title ClaudeNeko Start
cd /d "%~dp0"

curl -s --max-time 2 http://127.0.0.1:4000/api/health >nul 2>&1
if %errorlevel%==0 exit /b 0

rem server is down: start it hidden, then exit
wscript //nologo "%~dp0run-node.vbs"
exit /b 0
