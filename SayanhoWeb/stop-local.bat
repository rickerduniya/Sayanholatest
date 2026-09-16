@echo off
:: Stop anything started by start-local.bat (dotnet + vite on 5000/3000)
echo Stopping Sayanho local services...
for %%P in (5000 3000) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R /C:":%%P .*LISTENING" 2^>nul') do (
        echo  - Killing PID %%a on port %%P
        taskkill /F /PID %%a >nul 2>nul
    )
)
echo Done. You can also just close the Backend/Frontend windows.
pause
