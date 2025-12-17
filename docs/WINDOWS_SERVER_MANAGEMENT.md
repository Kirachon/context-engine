# Windows Server Management Guide

This guide explains how to use the `manage-server.bat` script to manage the Context Engine MCP Server on Windows.

## Overview

The `manage-server.bat` script provides a convenient way to start, stop, restart, and check the status of the Context Engine MCP Server on Windows systems.

## Prerequisites

- **Node.js** installed and available in PATH
- **Built distribution** - Run `npm run build` before starting the server
- **Windows** operating system (Windows 7 or later)

## Commands

### Start the Server

```batch
manage-server.bat start
```

**What it does:**
- Checks if Node.js is installed
- Verifies that `dist/index.js` exists
- Checks if the server is already running
- Starts the server with:
  - Workspace: Current directory (`.`)
  - Indexing: Enabled (`--index`)
  - File watching: Enabled (`--watch`)
- Saves the process ID to `.server.pid`
- Logs output to `.server.log`

**Example output:**
```
[INFO] Starting Context Engine MCP Server...
[INFO] Workspace: D:\GitProjects\context-engine\.
[INFO] Indexing: Enabled
[INFO] File watching: Enabled
[INFO] Log file: D:\GitProjects\context-engine\.server.log
[SUCCESS] Server started with PID: 12345
[INFO] Use 'manage-server.bat status' to check server status
[INFO] Use 'manage-server.bat stop' to stop the server
```

### Stop the Server

```batch
manage-server.bat stop
```

**What it does:**
- Reads the process ID from `.server.pid`
- Checks if the process is running
- Terminates the process gracefully
- Removes the PID file
- Cleans up stale PID files if the process is not running

**Example output:**
```
[INFO] Stopping Context Engine MCP Server...
[SUCCESS] Server stopped (PID: 12345)
```

### Restart the Server

```batch
manage-server.bat restart
```

**What it does:**
- Stops the current server (if running)
- Waits 2 seconds
- Starts a new server instance

**Example output:**
```
[INFO] Restarting Context Engine MCP Server...
[INFO] Stopping Context Engine MCP Server...
[SUCCESS] Server stopped (PID: 12345)
[INFO] Starting Context Engine MCP Server...
[SUCCESS] Server started with PID: 67890
```

### Check Server Status

```batch
manage-server.bat status
```

**What it does:**
- Checks if the PID file exists
- Verifies the process is actually running
- Displays server information
- Shows the last 10 lines of the log file

**Example output (running):**
```
[INFO] Checking Context Engine MCP Server status...

[STATUS] Server is RUNNING
[INFO] Process ID: 12345
[INFO] Workspace: D:\GitProjects\context-engine\.
[INFO] Log file: D:\GitProjects\context-engine\.server.log

[INFO] Recent log entries:
----------------------------------------
[2025-12-16 10:30:15] Server started
[2025-12-16 10:30:16] Indexing workspace...
[2025-12-16 10:30:20] Index complete: 150 files
[2025-12-16 10:30:20] File watcher enabled
----------------------------------------
```

**Example output (not running):**
```
[INFO] Checking Context Engine MCP Server status...

[STATUS] Server is NOT running
[INFO] No PID file found at: D:\GitProjects\context-engine\.server.pid
```

## Files Created

The management script creates the following files:

| File | Purpose | Git Ignored |
|------|---------|-------------|
| `.server.pid` | Stores the process ID of the running server | ✅ Yes (`*.pid`) |
| `.server.log` | Contains server output and error messages | ✅ Yes (`*.log`) |

Both files are automatically excluded from version control via `.gitignore`.

## Error Handling

### Node.js Not Found

```
[ERROR] Node.js not found. Please install Node.js first.
```

**Solution:** Install Node.js from https://nodejs.org/

### Build Files Missing

```
[ERROR] Build files not found at: D:\GitProjects\context-engine\dist\index.js
[INFO] Please run 'npm run build' first
```

**Solution:** Run `npm run build` to compile the TypeScript source code.

### Server Already Running

```
[ERROR] Server is already running with PID: 12345
[INFO] Use 'manage-server.bat stop' to stop it first
```

**Solution:** Stop the existing server with `manage-server.bat stop` or use `manage-server.bat restart`.

### Stale PID File

```
[WARN] Stale PID file found. Cleaning up...
```

**What it means:** The PID file exists but the process is not running (e.g., server crashed or was killed externally).

**Action:** The script automatically cleans up the stale PID file and continues.

## Advanced Usage

### View Server Logs

```batch
type .server.log
```

Or use PowerShell for better formatting:
```powershell
Get-Content .server.log -Tail 20
```

### Monitor Logs in Real-Time

```powershell
Get-Content .server.log -Wait
```

### Manually Kill the Server

If the stop command fails, you can manually kill the process:

```batch
taskkill /PID <process_id> /F
```

Replace `<process_id>` with the PID from `.server.pid` or from `manage-server.bat status`.

## Troubleshooting

### Server Won't Start

1. **Check Node.js installation:**
   ```batch
   node --version
   ```

2. **Verify build files exist:**
   ```batch
   dir dist\index.js
   ```

3. **Check for port conflicts:**
   - The MCP server uses stdio transport, so port conflicts are unlikely
   - Check if another instance is running: `manage-server.bat status`

4. **Review the log file:**
   ```batch
   type .server.log
   ```

### Server Won't Stop

1. **Check if the process exists:**
   ```batch
   tasklist | findstr node.exe
   ```

2. **Force kill all Node.js processes (use with caution):**
   ```batch
   taskkill /IM node.exe /F
   ```

3. **Remove stale PID file:**
   ```batch
   del .server.pid
   ```

## Integration with Development Workflow

### Typical Development Session

```batch
# 1. Build the project
npm run build

# 2. Start the server
manage-server.bat start

# 3. Make code changes...

# 4. Rebuild and restart
npm run build
manage-server.bat restart

# 5. Check status
manage-server.bat status

# 6. Stop when done
manage-server.bat stop
```

### Automated Build and Restart

Create a `dev.bat` file:

```batch
@echo off
echo Building project...
call npm run build
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

echo Restarting server...
call manage-server.bat restart
```

Then use:
```batch
dev.bat
```

## See Also

- [README.md](../README.md) - Main project documentation
- [QUICKSTART.md](../QUICKSTART.md) - Quick start guide
- [CHANGELOG.md](../CHANGELOG.md) - Version history

