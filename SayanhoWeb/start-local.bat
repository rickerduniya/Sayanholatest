@echo off
setlocal EnableDelayedExpansion
title Sayanho - Starting...

:: -------------------------------------------------------------
:: Double-click to start BOTH backend (.NET 8) + frontend (Vite)
::   Backend  -> http://localhost:5000  (Swagger: /swagger)
::   Frontend -> http://localhost:3000  (Vite proxies /api -> 5000)
:: Fix: use START /D to handle space in "Default Project" path
:: Close each window to stop that service, or run stop-local.bat
:: -------------------------------------------------------------

set "ROOT=%~dp0"
pushd "%ROOT%"

if not exist "Sayanho.Backend\Sayanho.Backend.csproj" (
    echo [ERROR] Could not find Sayanho.Backend\Sayanho.Backend.csproj under %ROOT%
    pause
    exit /b 1
)
if not exist "Sayanho.Frontend\package.json" (
    echo [ERROR] Could not find Sayanho.Frontend\package.json under %ROOT%
    pause
    exit /b 1
)

where dotnet >nul 2>nul || echo [WARN] dotnet not found on PATH - install .NET 8 SDK.
where node   >nul 2>nul || echo [WARN] node not found on PATH - install Node.js 18+.

:: ---- Free ports so a restart is one double-click ----
for %%P in (5000 3000) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R /C:":%%P .*LISTENING" 2^>nul') do (
        echo [INFO] Port %%P in use by PID %%a - killing...
        taskkill /F /PID %%a >nul 2>nul
    )
)

:: ---- Backend window ----  (use /D so space in path doesn't break cd)
echo [INFO] Starting backend (first build can take 20-30s, please wait for "Now listening on...")...
start "Sayanho Backend :5000" /D "%ROOT%Sayanho.Backend" cmd /k "echo === Sayanho Backend (http://localhost:5000  swagger: http://localhost:5000/swagger  health: http://localhost:5000/health) === && echo [TIP] Wait for "Now listening on http://..." - first build takes a moment. && set ASPNETCORE_ENVIRONMENT=Development && set PORT=5000 && dotnet run --no-launch-profile"

:: ---- Poll backend health (max 45s) before starting frontend ----
echo [INFO] Waiting for backend to become healthy (http://localhost:5000/health)...
set "BACKEND_OK=0"
for /L %%i in (1,1,45) do (
    curl.exe -s http://localhost:5000/health >nul 2>nul
    if !errorlevel! equ 0 (
        echo [OK] Backend is healthy.
        set "BACKEND_OK=1"
        goto :backend_ready
    )
    timeout /t 1 /nobreak >nul
)
:backend_ready
if "%BACKEND_OK%"=="0" (
    echo [WARN] Backend did not answer /health after 45s.
    echo        Check the "Sayanho Backend :5000" window for errors.
)

:: ---- Frontend window ---- (use /D for same reason)
echo [INFO] Starting frontend...
if not exist "Sayanho.Frontend\node_modules\" (
    echo [INFO] node_modules not found - running npm install (first run, a minute)...
    start "Sayanho Frontend :3000" /D "%ROOT%Sayanho.Frontend" cmd /k "npm install && echo. && echo [DONE] npm install finished. Starting Vite... && npm run dev"
) else (
    start "Sayanho Frontend :3000" /D "%ROOT%Sayanho.Frontend" cmd /k "echo === Sayanho Frontend (http://localhost:3000) === && npm run dev"
)

:: ---- Poll frontend then open browsers ----
echo [INFO] Waiting for frontend (http://localhost:3000)...
for /L %%i in (1,1,30) do (
    curl.exe -s http://localhost:3000 >nul 2>nul
    if !errorlevel! equ 0 goto :frontend_ready
    timeout /t 1 /nobreak >nul
)
:frontend_ready

echo.
echo [DONE] Services launched:
echo        Backend  : http://localhost:5000  ^| http://localhost:5000/swagger ^| http://localhost:5000/health
echo        Frontend : http://localhost:3000
echo.
echo Opening browsers...
start "" http://localhost:5000/swagger
timeout /t 1 /nobreak >nul
start "" http://localhost:3000

echo This window closes in 8 seconds. Service windows stay open.
timeout /t 8 >nul
exit /b 0
