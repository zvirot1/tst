# Instructions for Claude — Install Claude Desktop RTL Patch

You are running on a Windows machine and your task is to install the Claude RTL patch from this folder. Read this whole document before doing anything.

## What this patch does

Creates a side-by-side copy of Claude Desktop with Hebrew/Arabic RTL support. The original MSIX install stays untouched (except `cowork-svc.exe` — see below). All chat sessions, MCP config, Cowork sessions, and Bedrock credentials are **shared** with the original via a shared `userData` directory.

## Constraints — DO NOT skip these

1. **Admin (UAC) is required** — the patch modifies a file inside `C:\Program Files\WindowsApps\` which needs admin to write.
2. **Node.js 22.12 or later** must be on PATH (`npx --yes @electron/asar@4.2.0 --version` should return a version number). If Node is missing or older, install from https://nodejs.org and retry.
3. **Original MSIX Claude must be installed first** — `Get-AppxPackage *Claude*` should return a package with `InstallLocation` under `WindowsApps`. If user has the legacy Squirrel install (`%LOCALAPPDATA%\AnthropicClaude`), this patch is not supported — tell the user to upgrade.
4. **Do not run RTL copy and original MSIX at the same time** — they share `userData` and Chromium's leveldb locks (Local Storage / IndexedDB / `claude-code/`) cannot be shared between processes. Database corruption WILL happen.

## Install procedure

```powershell
# From the directory containing patch-rtl.ps1, Install.cmd, etc.
# Right-click Install.cmd -> Run as administrator
# OR from an elevated PowerShell:
Unblock-File .\patch-rtl.ps1
.\patch-rtl.ps1 -Auto
```

The `-Auto` flag skips the interactive menu (which doesn't work in PowerShell ISE because of how `Read-Host` is handled there).

## Five gotchas we hit during development — verify each one

### 1. PowerShell ExecutionPolicy / Mark-of-the-Web blocks the script

**Symptom:** `File ... cannot be loaded. The file ... is not digitally signed. ... PSSecurityException: UnauthorizedAccess`.

**Cause:** Files copied from another machine arrive with Mark-of-the-Web; ExecutionPolicy of `Restricted` or `AllSigned` then blocks them.

**Fix:** Already handled by `Install.cmd` — it calls `Unblock-File` and then `powershell -ExecutionPolicy Bypass -File patch-rtl.ps1 -Auto`. If running manually, do `Unblock-File .\patch-rtl.ps1` first.

### 2. Cert hole in `cowork-svc.exe` is too small for normal certs

**Symptom:** `Cert too large (1136 > 856); retrying...` over and over until `Cert hole too small (856 bytes) for any RSA cert`.

**Cause:** Newer Claude builds shrunk the embedded Anthropic-cert hole from ~1457 bytes to ~856 bytes. A standard 2048-bit RSA cert with the cloned Anthropic Subject DN is 1136 bytes.

**Fix:** Already in the script. We use a SHORT subject (`CN=Claude-RTL-Patcher`) and a fallback ladder: `RSA-2048 (~782 bytes) → RSA-1024 → ECDSA-P256 (~340 bytes)`. The cert that fits gets picked automatically.

**If you see this error on a future Claude version:** the hole shrunk again. Solutions in order of preference:
- Skip cowork: re-run as `.\patch-rtl.ps1 -Auto -SkipCowork` (chat works, Cowork in copy doesn't)
- Use ECDSA-P256 explicitly (already in the ladder, should auto-fall-through)

### 3. Anthropic anchor disappears after first install

**Symptom on RE-run:** `[X] INSTALL FAILED: Anthropic cert pattern not found in cowork-svc.exe.`

**Cause:** First install replaced the embedded `"Anthropic, PBC"` string in `cowork-svc.exe` with our cert. Re-running tries to find it and fails.

**Fix:** Already handled. `Patch-CoworkCert` always reads from `cowork-svc.exe.bak` (which we keep pristine — it's the original MSIX `cowork-svc.exe`). Look for log line `Scanning cowork-svc.exe.bak for cert hole...` to confirm.

### 4. **"Cowork requires a newer installation" banner appears even after cert swap** ← BIG ONE

**Symptom:** Patch reports success. RTL works. But the Cowork tab shows "Cowork requires a newer installation. Reinstall the desktop app to access Cowork".

**Cause:** Claude Desktop's renderer detects MSIX with this code:
```javascript
function q6e() {
    return process.execPath.split(/[\\/]/).some(e => e.toLowerCase() === "windowsapps")
}
```
If the path doesn't contain a segment named `windowsapps`, Cowork is disabled — regardless of cert validity.

**Fix:** Already in the script. The copy is installed to `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app\claude.exe` — the `WindowsApps` segment satisfies the heuristic. After install, verify with:
```powershell
Test-Path "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"   # must be True
Get-Process -Name claude | Where-Object { $_.Path -like '*ClaudeRTL\WindowsApps*' } | Select-Object Path
```

**If you see "Cowork requires..." despite the path being correct:** check the cowork-service log:
```powershell
Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 30
```
Look for `[Server] Created new VM session for ...` — this is success. If you see `Client connected` followed by an immediate disconnect, the cert chain is broken — restart `CoworkVMService`.

### 5. **User-message bubbles slide to the LEFT instead of right** when typing Hebrew

**Symptom:** You type a Hebrew message. The text is RTL but the BUBBLE (the rounded background) hugs the left edge of the chat instead of the right.

**Cause:** Claude uses Tailwind `margin-inline-start: auto` (`ms-auto`) to pin user-message bubbles to the END of a flex container. When we flip `dir="rtl"` on a descendant, "end" maps from right to LEFT, so bubbles slide.

**Fix:** Already in the renderer payload (`RTL_INJECTION_CODE`). The `preserveLogicalPositioning` function walks up to 12 ancestors from each dir-flipped element and translates `margin-inline-start/end: auto` into physical `margin-left/right`. Marker attribute `data-rtl-pos-fixed` prevents re-running.

**If bubbles still slide left:** the layout structure changed. In DevTools (Ctrl+Alt+I in dev_settings, or via `--enable-logging`), inspect a bubble — look for `ms-auto` / `me-auto` Tailwind classes on a parent within 12 levels. If it's deeper than 12, increase `POS_PRESERVE_MAX_DEPTH` in the payload.

## Verifying RTL works — including chats that started in LTR

**The user wants chats that were created BEFORE the RTL patch (in plain MSIX Claude) to display correctly in RTL after the patch.** Here's how to verify:

### Step 1 — confirm shared `userData`
```powershell
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\launch-rtl.cmd"
# Must contain: set CLAUDE_RTL_USERDATA=%APPDATA%\Claude
# (NOT a separate userdata path!)
```

If the launcher points at a separate `userdata` path, the user won't see their old chats. The current script uses shared. If you find an older version with a separate path, regenerate by re-running the patcher.

### Step 2 — close MSIX before launching RTL
```powershell
Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps_*' } | Stop-Process -Force
# Wait a few seconds for cleanup
Start-Sleep -Seconds 3
```

### Step 3 — launch RTL copy
Double-click `Claude RTL` desktop shortcut, or:
```powershell
Start-Process -FilePath "$env:LOCALAPPDATA\ClaudeRTL\launch-rtl.cmd" -WindowStyle Hidden
```

### Step 4 — visual checks
In the RTL copy window:
1. **Sidebar > Recents** should show ALL prior conversations (the ones from the original MSIX install, which were originally LTR-rendered).
2. Click on an old chat — it should re-render with RTL applied to Hebrew portions, LTR to code blocks. The MutationObserver in the payload re-processes existing DOM on load, so historical messages get the same treatment as new ones.
3. Type a new Hebrew message — bubble hugs RIGHT, text RTL.
4. Type a new English message — bubble hugs RIGHT (consistent with Claude's normal layout), text LTR.
5. Open a code-heavy chat — code blocks stay LTR.

### Step 5 — Cowork sanity
The Cowork tab in the sidebar should NOT show "Cowork requires a newer installation". Click it — you should see existing sessions or be able to create a new one. Verify in the service log:
```powershell
Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 5
```
Successful Cowork = a `[Server] Created new VM session for ...` line appearing soon after you opened the Cowork tab.

## Side-effects on the ORIGINAL MSIX Claude

**The patch modifies `cowork-svc.exe` inside MSIX.** That has two consequences:

1. **Original MSIX Cowork now uses our self-signed cert too.** Both apps share the patched service. Both work.
2. **The next Claude Desktop update will overwrite `cowork-svc.exe`** with a fresh Anthropic-signed copy. After that, the RTL copy's cert won't match anymore — Cowork in the RTL copy will break (chat still works). Tell the user: after every Claude update, double-click `Rebuild Claude RTL` on the desktop. This re-runs the patch on the new MSIX state.

## Failure recovery

If anything goes wrong:
```powershell
.\patch-rtl.ps1 -Restore
```
This:
- Restores `cowork-svc.exe` from `%LOCALAPPDATA%\ClaudeRTL\backups\cowork-svc.exe.bak`
- Removes the self-signed cert from `Cert:\LocalMachine\Root` (filtered by `FriendlyName == 'Claude_RTL_SelfSigned'`)
- Removes `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\` (the copy)
- Removes desktop shortcuts
- Restarts `CoworkVMService`

The user's chat history (`%APPDATA%\Claude\`) is NEVER touched by Restore — it's the original Claude userData and stays intact.

## Files in this folder

| File | Purpose |
|---|---|
| `patch-rtl.ps1` | The patcher (~1400 lines, self-contained). |
| `Install.cmd` | One-click install. Calls `patch-rtl.ps1 -Auto`. |
| `InstallSkipCowork.cmd` | Same but with `-SkipCowork` if cert hole is too small. |
| `Rebuild.cmd` | Re-run after Claude update (same as Install). |
| `Restore.cmd` | Uninstall. Calls `patch-rtl.ps1 -Restore`. |
| `README.md` | Hebrew user-facing instructions. |
| `TEST.md` | Manual QA checklist. |
| `INSTRUCTIONS-FOR-AGENT.md` | This file. |

## Diagnostic commands cheat-sheet

```powershell
# Is MSIX Claude the right version?
(Get-AppxPackage *Claude*).Version
(Get-AppxPackage *Claude*).InstallLocation

# Is the RTL copy in place at the right path?
Get-Item "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"

# Are both binaries signed by the same cert?
$svc = Get-AuthenticodeSignature "$((Get-AppxPackage *Claude*).InstallLocation)\app\resources\cowork-svc.exe"
$copy = Get-AuthenticodeSignature "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"
$svc.SignerCertificate.Thumbprint -eq $copy.SignerCertificate.Thumbprint   # must be True

# Is Cowork service alive?
Get-Service CoworkVMService | Format-List Name, Status

# Did Cowork accept a session?
Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 20

# What does the patcher itself report?
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\patch.log" -Tail 50
```

## When asking the user for input

- Don't ask "should I install?" if they already pointed you at this folder — just install.
- DO ask before `-Restore` if they hit a problem — restore is destructive (removes copy).
- If something's broken and unclear, capture the patch.log + cowork-service.log and offer them the diagnostics; don't loop the patcher.

## Done condition

You are done when ALL of these are true:
- [ ] `patch-rtl.ps1 -Auto` ran to completion with `RTL PATCH INSTALLED` in green.
- [ ] Desktop has `Claude RTL.lnk` and `Rebuild Claude RTL.lnk`.
- [ ] Launching `Claude RTL` opens a window with title "Claude".
- [ ] User's existing chats appear in the sidebar.
- [ ] Typing Hebrew goes RTL, bubble hugs right.
- [ ] Code blocks in Claude responses stay LTR.
- [ ] Cowork tab does NOT show "Cowork requires a newer installation".
- [ ] cowork-service.log shows a `Created new VM session` line within ~10 sec of opening the Cowork tab.
