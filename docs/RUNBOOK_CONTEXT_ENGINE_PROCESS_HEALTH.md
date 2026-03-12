# Context Engine Process Health Runbook

This runbook covers duplicate-process checks for the context-engine MCP runtime on Windows.

## Purpose

Use `scripts/ops/check-context-engine-process-health.ps1` to detect duplicate `dist/index.js` runtime processes and optionally stop extras.

## What The Script Checks

- Finds `node.exe` processes that include this repository path and `dist/index.js` in the command line.
- Reports a `PASS`, `WARN`, or `FAIL` summary.
- Prints matching process IDs and cleanup actions.

## Exit Codes

- `0`: `PASS`
- `1`: `WARN` or `FAIL`

## Usage

Run from repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\check-context-engine-process-health.ps1
```

Run and auto-clean duplicates (keep latest process, stop older extras):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\check-context-engine-process-health.ps1 -KillDuplicates
```

Capture exit code in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\check-context-engine-process-health.ps1
$LASTEXITCODE
```

## Status Semantics

- `PASS`: exactly one matching process, or duplicates were cleaned successfully when `-KillDuplicates` is used.
- `WARN`: no matching process found, or duplicate processes found without cleanup.
- `FAIL`: cleanup attempted but one or more duplicate processes could not be stopped, or an unexpected script error occurred.

## Operational Notes

- `-KillDuplicates` always preserves the newest matching process and targets older matches for stop.
- Process matching is scoped to this repository path and `dist/index.js` to avoid cross-repo false positives.
