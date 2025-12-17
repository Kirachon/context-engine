@echo off
setlocal enabledelayedexpansion

REM ============================================================================
REM Context Engine MCP Server Management Script
REM ============================================================================
REM Usage: manage-server.bat [start|stop|restart|status]
REM ============================================================================

set "SCRIPT_DIR=%~dp0"
set "DIST_FILE=%SCRIPT_DIR%dist\index.js"
set "PID_FILE=%SCRIPT_DIR%.server.pid"
set "LOG_FILE=%SCRIPT_DIR%.server.log"
set "WORKSPACE=%SCRIPT_DIR%."

REM Parse command line argument
set "COMMAND=%1"
if "%COMMAND%"=="" (
    echo [ERROR] No command specified
    goto :usage
)

REM Route to appropriate command
if /i "%COMMAND%"=="start" goto :start
if /i "%COMMAND%"=="stop" goto :stop
if /i "%COMMAND%"=="restart" goto :restart
if /i "%COMMAND%"=="status" goto :status
echo [ERROR] Unknown command: %COMMAND%
goto :usage

REM ============================================================================
REM START COMMAND
REM ============================================================================
:start
echo [INFO] Starting Context Engine MCP Server...

REM Check if Node.js is available
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    exit /b 1
)

REM Check if dist/index.js exists
if not exist "%DIST_FILE%" (
    echo [ERROR] Build files not found at: %DIST_FILE%
    echo [INFO] Please run 'npm run build' first
    exit /b 1
)

REM Check if server is already running
if exist "%PID_FILE%" (
    set /p EXISTING_PID=<"%PID_FILE%"
    tasklist /FI "PID eq !EXISTING_PID!" 2>nul | find "!EXISTING_PID!" >nul
    if not errorlevel 1 (
        echo [ERROR] Server is already running with PID: !EXISTING_PID!
        echo [INFO] Use 'manage-server.bat stop' to stop it first
        exit /b 1
    ) else (
        echo [WARN] Stale PID file found. Cleaning up...
        del "%PID_FILE%" 2>nul
    )
)

REM Start the server in background
echo [INFO] Workspace: %WORKSPACE%
echo [INFO] Indexing: Enabled
echo [INFO] File watching: Enabled
echo [INFO] Log file: %LOG_FILE%

start /B "" node "%DIST_FILE%" --workspace "%WORKSPACE%" --index --watch > "%LOG_FILE%" 2>&1

REM Wait a moment for the process to start
timeout /t 2 /nobreak >nul

REM Find and save the PID
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| find "PID:"') do (
    set "NODE_PID=%%a"
)

if defined NODE_PID (
    echo !NODE_PID! > "%PID_FILE%"
    echo [SUCCESS] Server started with PID: !NODE_PID!
    echo [INFO] Use 'manage-server.bat status' to check server status
    echo [INFO] Use 'manage-server.bat stop' to stop the server
) else (
    echo [ERROR] Failed to start server
    exit /b 1
)

exit /b 0

REM ============================================================================
REM STOP COMMAND
REM ============================================================================
:stop
echo [INFO] Stopping Context Engine MCP Server...

if not exist "%PID_FILE%" (
    echo [WARN] No PID file found. Server may not be running.
    goto :force_stop
)

set /p SERVER_PID=<"%PID_FILE%"

REM Check if process is actually running
tasklist /FI "PID eq %SERVER_PID%" 2>nul | find "%SERVER_PID%" >nul
if errorlevel 1 (
    echo [WARN] Process with PID %SERVER_PID% not found
    del "%PID_FILE%" 2>nul
    echo [INFO] Cleaned up stale PID file
    exit /b 0
)

REM Terminate the process
taskkill /PID %SERVER_PID% /F >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to stop server with PID: %SERVER_PID%
    exit /b 1
)

del "%PID_FILE%" 2>nul
echo [SUCCESS] Server stopped (PID: %SERVER_PID%)
exit /b 0

:force_stop
echo [INFO] Attempting to stop any running node processes for context-engine...
taskkill /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *context-engine*" /F >nul 2>&1
if errorlevel 1 (
    echo [INFO] No running server processes found
) else (
    echo [SUCCESS] Server processes stopped
)
exit /b 0

REM ============================================================================
REM RESTART COMMAND
REM ============================================================================
:restart
echo [INFO] Restarting Context Engine MCP Server...

REM Stop the server first
call :stop

REM Wait a moment before starting
timeout /t 2 /nobreak >nul

REM Start the server
call :start

exit /b 0

REM ============================================================================
REM STATUS COMMAND
REM ============================================================================
:status
echo [INFO] Checking Context Engine MCP Server status...
echo.

if not exist "%PID_FILE%" (
    echo [STATUS] Server is NOT running
    echo [INFO] No PID file found at: %PID_FILE%
    exit /b 1
)

set /p SERVER_PID=<"%PID_FILE%"

REM Check if process is actually running
tasklist /FI "PID eq %SERVER_PID%" 2>nul | find "%SERVER_PID%" >nul
if errorlevel 1 (
    echo [STATUS] Server is NOT running
    echo [WARN] Stale PID file found (PID: %SERVER_PID%)
    echo [INFO] Use 'manage-server.bat start' to start the server
    exit /b 1
)

echo [STATUS] Server is RUNNING
echo [INFO] Process ID: %SERVER_PID%
echo [INFO] Workspace: %WORKSPACE%
echo [INFO] Log file: %LOG_FILE%
echo.

REM Show last few lines of log file if it exists
if exist "%LOG_FILE%" (
    echo [INFO] Recent log entries:
    echo ----------------------------------------
    powershell -Command "Get-Content '%LOG_FILE%' -Tail 10"
    echo ----------------------------------------
) else (
    echo [WARN] Log file not found
)

exit /b 0

REM ============================================================================
REM USAGE INFORMATION
REM ============================================================================
:usage
echo.
echo ============================================================================
echo Context Engine MCP Server Management Script
echo ============================================================================
echo.
echo Usage: manage-server.bat [COMMAND]
echo.
echo Commands:
echo   start      Start the MCP server with indexing and file watching
echo   stop       Stop the running MCP server
echo   restart    Restart the MCP server (stop + start)
echo   status     Check if the MCP server is running
echo.
echo Examples:
echo   manage-server.bat start
echo   manage-server.bat status
echo   manage-server.bat restart
echo   manage-server.bat stop
echo.
echo Server Configuration:
echo   Workspace:     Current directory (.)
echo   Indexing:      Enabled (--index)
echo   File Watching: Enabled (--watch)
echo   Log File:      .server.log
echo   PID File:      .server.pid
echo.
echo ============================================================================
exit /b 1

