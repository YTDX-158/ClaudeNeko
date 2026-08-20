@echo off
title Register neko:// Protocol
rem Register the neko:// custom protocol for ClaudeNeko (per-user, no admin needed).
rem Portable: points to launcher.vbs in this file's own folder.
set "BASE=%~dp0"
set "CMDVAL=wscript ""%BASE%launcher.vbs"""

reg add "HKCU\Software\Classes\neko" /ve /d "URL:ClaudeNeko Protocol" /f >nul
reg add "HKCU\Software\Classes\neko\URL Protocol" /ve /d "" /f >nul
reg add "HKCU\Software\Classes\neko\shell\open\command" /ve /d "%CMDVAL%" /f >nul

echo.
echo neko:// protocol registered. neko:// links will now open ClaudeNeko.
echo Run again after moving the folder to re-point it.
pause
