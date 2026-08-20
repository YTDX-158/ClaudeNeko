@echo off
title ClaudeNeko Web
cd /d "%~dp0"

rem Already running? skip start, just open browser.
curl -s --max-time 2 http://127.0.0.1:4000/api/health >nul 2>&1
if %errorlevel%==0 goto ready

rem Rebuild when dist missing OR any web\src file is newer than dist (covers source edits).
set NEEDBUILD=0
for /f %%i in ('powershell -NoProfile -Command "$s=Get-ChildItem ''web\src'' -Recurse -File -EA SilentlyContinue|Sort-Object LastWriteTime -Descending|Select-Object -First 1;if(!$s){''0'';exit};$d=Get-Item ''web\dist\index.html'' -EA SilentlyContinue;if(!$d){''1'';exit};if($s.LastWriteTime -gt $d.LastWriteTime){''1''}else{''0''}"') do set NEEDBUILD=%%i
if not exist "web\dist\index.html" set NEEDBUILD=1
if "%NEEDBUILD%"=="1" (
  call npm run build
)

rem Start backend fully hidden via vbs (no console window at all).
wscript //nologo "%~dp0run-node.vbs"

rem Wait for health check, then open browser.
set tries=0
:wait
curl -s --max-time 1 http://127.0.0.1:4000/api/health >nul 2>&1
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% geq 30 goto done
timeout /t 1 /nobreak >nul
goto wait

:ready
rem Open browser (Edge preferred).
set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if defined EDGE (
    start "" "%EDGE%" "http://localhost:4000"
) else (
    start "" "http://localhost:4000"
)
:done
exit /b 0
