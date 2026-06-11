# Instructions for Claude — Install Claude Desktop RTL Patch (offline-complete)

You are running on a Windows machine. **The target machine may have NO internet access.** This document contains every piece of information you need — JS payloads embedded verbatim, package versions pinned, cert hole offsets known, all error modes documented inline. Do not assume you can reach github.com, npmjs.org, or claude.ai/download.

Read everything before doing anything.

> ## ⚠ Version compatibility — read first
>
> This patch was developed and tested against **Claude Desktop 1.11847.5.0** (Electron 41.6.1, MSIX x64). The patcher is **partially version-resilient** — it auto-discovers offsets via byte-search where possible. But Claude updates can break specific components.
>
> **Before installing, check the version on the target:**
> ```powershell
> (Get-AppxPackage *Claude*).Version
> ```
>
> | Target version | Expected outcome |
> |---|---|
> | `1.11847.x.x` (same minor) | Should work as-is. Patch-level changes don't affect anything we touch. |
> | `1.x.x` other minor | Most pieces work. Watch for new renderer files (Part D6), shrunk cert hole (D2), or sub-12 layout depth changes (D5). |
> | `2.x.x` (next major) | Likely needs adaptation. Run **Part G — Diagnostic flow for new Claude versions** before doing anything. |
> | Electron version changed (was 41.x, now 42.x+) | Test the fuse step first — `@electron/fuses` may need a version bump. |
>
> **Skip ahead to Part G if you suspect the target is on a different version than 1.11847.5.0** and want to know what to verify before installing.

## Quick orientation

| Question | Answer |
|---|---|
| What is this? | A side-by-side patched copy of Claude Desktop with Hebrew/Arabic RTL. Original MSIX install stays untouched (except `cowork-svc.exe` cert). |
| What are you (the agent) here to do? | Install + verify, OR rebuild the patcher from source if `patch-rtl.ps1` isn't present. |
| Who is the user? | They speak Hebrew. They want their existing chat history (currently in plain LTR Claude) to display correctly in the RTL copy. |
| What can fail? | 5 known gotchas — all documented in **Part D** with their fixes. |

## Document layout

- **Part A** — Offline prerequisites: how to make sure Node + npm packages are present without internet.
- **Part B** — Install procedure (the common case — `patch-rtl.ps1` exists).
- **Part C** — Verification (including: old chats render RTL).
- **Part D** — Five known gotchas + their already-applied fixes.
- **Part E** — Restore (uninstall).
- **Part F** — Build the patcher from scratch (architectural reference + all three JS payloads embedded).
- **Part G** — Version-compatibility map + diagnostic flow when Claude updates and something breaks.

---

# Part A — Offline prerequisites

## What must be present on the target machine before running the patcher

| Requirement | How to verify |
|---|---|
| Windows 10 or 11 | `[Environment]::OSVersion.Version` |
| Claude Desktop MSIX installed | `Get-AppxPackage *Claude*` returns `InstallLocation` under `WindowsApps`. NOT a Squirrel install (`%LOCALAPPDATA%\AnthropicClaude`). |
| Node.js ≥ 22.12 on PATH | `node --version` |
| `@electron/[email protected]` available | `npx --yes @electron/asar@4.2.0 --version` (returns version OR fails with download error if offline) |
| `@electron/[email protected]` available | `npx --yes @electron/fuses@2.1.1 --version` |

## How to pre-stage prerequisites for an offline target

If you have a second machine with internet, do this on that machine:

```powershell
# 1. Download Node MSI (latest 22.x):
#    Browse to nodejs.org, download node-v22.x.x-x64.msi
#    (Or use any earlier 22.x ≥ 22.12.0 you already have)

# 2. Pre-pack the two pinned npm packages as .tgz:
mkdir C:\offline-claude-rtl
cd C:\offline-claude-rtl
npm pack @electron/[email protected]      # creates electron-asar-4.2.0.tgz
npm pack @electron/[email protected]     # creates electron-fuses-2.1.1.tgz
```

Now copy these to the offline target along with the dist/ folder:
```
USB / file share contents:
├── node-v22.x.x-x64.msi
├── electron-asar-4.2.0.tgz
├── electron-fuses-2.1.1.tgz
└── dist/                            (this folder)
    ├── patch-rtl.ps1
    ├── Install.cmd
    ├── ...
    └── INSTRUCTIONS-FOR-AGENT.md   (this file)
```

On the offline target:

```powershell
# 1. Install Node from the MSI (double-click, or):
msiexec /i "C:\path\to\node-v22.x.x-x64.msi" /qn

# 2. Verify Node + reload PATH in current session:
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
node --version    # should print v22.x.x

# 3. Install the two npm packages globally from local .tgz files:
npm install -g "C:\path\to\electron-asar-4.2.0.tgz"
npm install -g "C:\path\to\electron-fuses-4.2.0.tgz"

# 4. Verify they're callable:
asar --version
electron-fuses --version

# 5. Verify npx can find them WITHOUT going to the registry:
$env:NPM_CONFIG_OFFLINE = 'true'
npx --yes @electron/asar@4.2.0 --version   # should succeed (uses global install)
$env:NPM_CONFIG_OFFLINE = $null
```

The patcher uses `npx --yes <pkg>@<version>`. When the package is already installed at exactly that version globally, npx skips the network and uses it directly. The `--yes` only suppresses the "okay to install?" prompt — it does NOT force a download if the package is present.

**If `npx` still tries to hit the network on the offline machine**, the symptom is a network-error stack trace from `cmd.exe /c "npx --yes ..."`. Workaround:

Edit `patch-rtl.ps1` and replace the two `npx --yes @electron/asar@4.2.0` invocations with `asar`, and the two `npx --yes @electron/fuses@2.1.1` invocations with `electron-fuses`. Specifically: the four call sites are inside `Patch-CopyAsar` (extract + pack) and `Invoke-FuseFlip` (read + write) and the early `Assert-NpxAvailable` probe. Keep the same arguments after the package name.

## Disk space

The patcher needs ~500 MB free on `C:\`:
- `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app\` ≈ 220 MB (Claude copy)
- `%LOCALAPPDATA%\ClaudeRTL\backups\` ≈ 13 MB (`cowork-svc.exe.bak`)
- temp dir during asar extract ≈ 70 MB

---

# Part B — Install procedure

## Constraints — DO NOT skip these

1. **Admin (UAC) is required.** The patcher modifies `cowork-svc.exe` inside `C:\Program Files\WindowsApps\` which TrustedInstaller owns. `Install.cmd` auto-elevates.
2. **Original MSIX Claude must be installed first.** The patcher mirrors its files. If MSIX isn't installed, install Claude Desktop first (from claude.ai/download — pre-staged MSIX file if offline).
3. **Do NOT run RTL copy and original MSIX at the same time.** They share `userData` (intentionally, so old chats are visible) and Chromium's leveldb file locks (Local Storage / IndexedDB / `claude-code/`) cannot be shared between processes. Database corruption WILL happen if both are open. The user accepted this trade-off in exchange for keeping their history.
4. **Run from File Explorer or elevated console.** Do NOT run from PowerShell ISE — `Read-Host` doesn't work properly there, the script will hang at the menu. (Mitigated by `-Auto`, which `Install.cmd` always passes.)

## Install commands

```powershell
# Easiest: right-click Install.cmd in File Explorer -> Run as administrator
# OR from an already-elevated PowerShell:
cd <path-to-dist-folder>
Unblock-File .\patch-rtl.ps1     # remove Mark-of-the-Web if file came over network
.\patch-rtl.ps1 -Auto
```

Expected output (key lines):
```
[+] Found Claude MSIX v1.11847.5.0 at C:\Program Files\WindowsApps\Claude_1.11847.5.0_x64__pzs8sxrjxfjjc
> Mirroring MSIX app dir to C:\Users\<user>\AppData\Local\ClaudeRTL\WindowsApps\app...
[+] Mirrored. Copy claude.exe = 212.8 MB.
> Injecting RTL JS into copy's app.asar...
[+] Injected: RTL=8, main switch=1, index guard=1.
[+] Repacked copy's app.asar.
[+] Fuse disabled and confirmed.
> Swapping Anthropic cert in MSIX cowork-svc.exe...
[*] Scanning cowork-svc.exe.bak for cert hole...
[*] Cert hole at offset 0xc0b499 (size: 856 bytes).
[+] Cert fits: RSA-2048, 782 of 856 bytes.
[+] Embedded cert swapped in cowork-svc.exe.
[+] cowork-svc.exe re-signed.
[+] Copy's claude.exe re-signed with same cert.
[+] CoworkVMService running.
=======================================================
  RTL PATCH INSTALLED
=======================================================
```

Total time: 60-90 seconds (mostly the robocopy of 220 MB).

If you see something different, check **Part D** — five known failure modes.

---

# Part C — Verification

## Done when ALL of these are true

- [ ] `patch-rtl.ps1 -Auto` ran to completion with green `RTL PATCH INSTALLED` banner.
- [ ] Desktop has shortcuts `Claude RTL.lnk` and `Rebuild Claude RTL.lnk`.
- [ ] `Test-Path "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"` returns True. Note the **`WindowsApps`** segment — it's mandatory for the MSIX detection bypass.
- [ ] Launching `Claude RTL` opens a window titled "Claude".
- [ ] **The user's existing chats appear in the sidebar** (the ones they used in the original LTR Claude before the patch). This is the proof that `userData` sharing works.
- [ ] Clicking on an old chat re-renders historical Hebrew messages with RTL applied — code blocks within them stay LTR. (The renderer payload's MutationObserver re-processes the DOM on chat-load, so old content gets the same treatment as new streaming content.)
- [ ] Typing a NEW Hebrew message: text aligns RTL, **the bubble hugs the RIGHT edge** of the chat. (If it slides LEFT, it's gotcha #5 — see Part D.)
- [ ] Typing English: text LTR, bubble on right (consistent with Claude's normal layout).
- [ ] Code blocks in Claude responses stay LTR.
- [ ] Cowork tab does NOT show "Cowork requires a newer installation". The tab is functional.
- [ ] `Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 5` shows a `Created new VM session for ...` line within ~10 seconds of opening the Cowork tab.

## Verifying old chats render correctly in RTL

This is the user's main quality-bar. Steps:

```powershell
# 1. Confirm the launcher points at SHARED userData (not a separate one):
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\launch-rtl.cmd"
# Must contain: set CLAUDE_RTL_USERDATA=C:\Users\<user>\AppData\Roaming\Claude
# If it points at $env:LOCALAPPDATA\ClaudeRTL\userdata instead, the version is OLD —
# regenerate by re-running patch-rtl.ps1 -Auto.

# 2. Make sure original MSIX is closed (shared userData = one app at a time):
Get-Process -Name claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*WindowsApps_*' } |
    Stop-Process -Force
Start-Sleep -Seconds 3

# 3. Launch RTL copy (NOT the MSIX original):
Start-Process -FilePath "$env:LOCALAPPDATA\ClaudeRTL\launch-rtl.cmd" -WindowStyle Hidden
```

In the RTL window:
1. Sidebar > Recents — should show ALL the chats the user had before the patch.
2. Click an old Hebrew chat — every Hebrew paragraph renders with `dir="rtl"`, code blocks stay LTR.
3. The MutationObserver-based RTL detection runs on the loaded DOM, not just streaming responses, so historical messages get the same processing.

If old chats are missing: the `userData` redirect didn't apply. Diagnose:
```powershell
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\patch.log" -Tail 30
# Look for: launch-rtl.cmd contents and CLAUDE_RTL_USERDATA value
```

If old chats are visible but DON'T render RTL when you scroll back: the renderer payload didn't load. Diagnose:
```powershell
# Open DevTools in the running RTL copy:
# 1. ~/.claude or wherever, set developer_settings.json: { "devtools": true }
# 2. In RTL window: Ctrl+Alt+I
# 3. Console > paste:    document.getElementById('claude-rtl-styles')
#    Should return a <style> element. If null, payload didn't inject.
```

---

# Part D — Five known gotchas + their already-applied fixes

These were all hit during development on Claude 1.11847.5.0. Each fix is already in `patch-rtl.ps1`. If you see one of these symptoms anyway, the fix didn't take effect — investigate why.

## D1. PowerShell ExecutionPolicy / Mark-of-the-Web blocks the script

**Symptom:**
```
.\patch-rtl.ps1 : File ... cannot be loaded. The file ... is not digitally signed. ...
PSSecurityException: UnauthorizedAccess
```

**Cause:** Files copied from another machine arrive with Mark-of-the-Web. ExecutionPolicy of `Restricted` or `AllSigned` blocks them.

**Fix (already applied):** `Install.cmd` calls `Unblock-File` then `powershell -ExecutionPolicy Bypass -File patch-rtl.ps1 -Auto`. If running manually:
```powershell
Unblock-File .\patch-rtl.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\patch-rtl.ps1 -Auto
```

## D2. Cert hole in `cowork-svc.exe` is too small

**Symptom:**
```
Cert too large (1136 > 856); retrying...   (repeats)
[X] INSTALL FAILED: Cert hole too small (856 bytes) for any RSA cert
```

**Cause:** Newer Claude builds shrunk the embedded Anthropic-cert hole from ~1457 bytes (older versions) to **856 bytes** (1.11847.5.0). A standard 2048-bit RSA cert with a long Subject DN is 1136 bytes — doesn't fit.

**Fix (already applied):**
- Use SHORT subject (`CN=Claude-RTL-Patcher`) instead of cloning the long Anthropic DN (~300 bytes saved).
- Algorithm ladder: try RSA-2048 (~782 bytes) → RSA-1024 → ECDSA-P256 (~340 bytes — guaranteed fit).
- Each rung re-rolls 5 times because cert size jitters ~5 bytes per call (serial number, validity period encoding).

**If you see this on a future Claude version where the hole is even smaller**: try `.\patch-rtl.ps1 -Auto -SkipCowork`. RTL works, Cowork in copy doesn't authenticate (chat is fine).

## D3. "Anthropic cert pattern not found" on re-runs

**Symptom on RE-run after a successful first install:**
```
[X] INSTALL FAILED: Anthropic cert pattern not found in cowork-svc.exe.
```

**Cause:** First install replaced the embedded `"Anthropic, PBC"` ASCII string in `cowork-svc.exe` with our `"Claude-RTL-Patcher"` cert. Re-runs try to find the old anchor and fail.

**Fix (already applied):** `Patch-CoworkCert` always reads bytes from `%LOCALAPPDATA%\ClaudeRTL\backups\cowork-svc.exe.bak` (kept pristine — refreshed only when MSIX has Anthropic's signature). Look for:
```
[*] Scanning cowork-svc.exe.bak for cert hole...
```
in the patcher output. If it's scanning the live file (`cowork-svc.exe` not `.bak`), the bak is missing — possibly an MSIX update wiped the directory. The script handles this by re-creating the bak from the (still-Anthropic-signed) post-update cowork-svc.exe.

## D4. **"Cowork requires a newer installation" banner** ← BIG ONE

**Symptom:** Patch reports success. RTL works. But the Cowork tab in the sidebar shows:
> ⓘ **Cowork requires a newer installation**
> Reinstall the desktop app to access Cowork and start handing off longer tasks.
> [ Reinstall ]

**Cause:** Claude Desktop's renderer detects MSIX context with this code (in `app.asar` → `.vite/build/index.js`):
```javascript
function q6e(){
    return process.execPath.split(/[\\/]/).some(e => e.toLowerCase() === "windowsapps")
}
function _c(){
    return Eo
        ? i2 !== void 0 ? i2
            : process.windowsStore ? (i2=true, true)
                : q6e() ? (i2=true, true)
                    : (i2=false, false)
        : false
}
```
- `process.windowsStore` is only `true` under genuine MSIX activation (we can't fake that from outside MSIX).
- `q6e()` is pure path string-matching: it returns `true` iff `process.execPath` (e.g. `C:\...\claude.exe`) has any path segment named `windowsapps` (case-insensitive).

If neither is true, `_c()` returns false → Cowork is disabled → "Cowork requires a newer installation" banner.

**Fix (already applied):** The copy is installed at `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app\claude.exe`. The `WindowsApps` segment satisfies `q6e()`. The OS doesn't care — it's a regular user-writable directory, only the JS check matters.

**Verify:**
```powershell
$copyExe = "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"
($copyExe -split '\\') | ForEach-Object { $_.ToLower() } | Where-Object { $_ -eq 'windowsapps' }
# Must print 'windowsapps' at least once.
```

**If you see "Cowork requires..." anyway:**
- Check the path actually contains `WindowsApps`. If launching from a different path, Cowork will reject.
- Check `cowork-service.log`:
```powershell
Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 30
```
Look for `[Server] Created new VM session for ...` after you open the Cowork tab. If you see "Client connected" followed by an immediate disconnect, the cert chain is broken — restart `CoworkVMService` (`Restart-Service CoworkVMService`) and try again.

## D5. **User-message bubbles slide LEFT instead of right when typing Hebrew**

**Symptom:** You type a Hebrew message. The text is RTL, but the BUBBLE (the rounded gray background) hugs the LEFT edge of the chat. User messages should always be on the right (in both LTR and RTL Claude).

**Cause:** Claude uses Tailwind's `margin-inline-start: auto` (class `ms-auto`) to pin user-message bubbles to the END of a flex container. In LTR, "end" = right. When we flip `dir="rtl"` on a descendant, the inline-direction reverses, "end" maps to LEFT, and the `ms-auto` ancestor's bubble slides left.

**Fix (already applied — in the renderer payload):**
1. Function `preserveLogicalPositioning(startEl)` walks up to **12 ancestors** (the `ms-auto` container in Claude's layout sits ~10 levels above the text node). For each ancestor with `marginInlineStart: auto` or `marginInlineEnd: auto`, it computes the parent's direction and rewrites to physical `marginLeft` / `marginRight`. Marker attribute `data-rtl-pos-fixed` prevents re-running.
2. Function `fixGlobalAutoMargins()` does a global sweep on every observer tick: any element with class `ms-auto`/`ml-auto` gets `style.marginLeft = 'auto'`; any with `me-auto`/`mr-auto` gets `style.marginRight = 'auto'`. Catches the bubble before it visually pops to the wrong side.
3. CSS rules in `injectStyles()`:
```css
[class*="ms-auto"],[class*="ml-auto"]{margin-left:auto!important;margin-inline-start:0!important}
[class*="me-auto"],[class*="mr-auto"]{margin-right:auto!important;margin-inline-end:0!important}
```

**If bubbles still slide left:** Claude's layout structure changed and the `ms-auto` container is now deeper than 12 levels. In the running copy, open DevTools, inspect a misplaced bubble, find the highest ancestor with `ms-auto` class. Increase `POS_PRESERVE_MAX_DEPTH` in the payload accordingly (or add a layer-specific selector).

---

# Part E — Restore (uninstall)

```powershell
.\patch-rtl.ps1 -Restore
# OR right-click Restore.cmd -> Run as administrator
```

What it does:
1. Stops `CoworkVMService`.
2. If MSIX `cowork-svc.exe` is signed by us (Subject doesn't contain "Anthropic"), restores it from `%LOCALAPPDATA%\ClaudeRTL\backups\cowork-svc.exe.bak`. (If MSIX update already auto-reverted it to Anthropic signature, the patcher detects this and skips.)
3. Removes self-signed certs from `Cert:\LocalMachine\Root` filtered by `FriendlyName == 'Claude_RTL_SelfSigned'`.
4. Removes `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\` (the copy).
5. Removes the legacy `%LOCALAPPDATA%\ClaudeRTL\app\` if it exists from older installer versions.
6. Removes both desktop shortcuts and `launch-rtl.cmd`.
7. Restarts `CoworkVMService`.

Restore **NEVER** touches `%APPDATA%\Claude\` — that's the user's chat history (owned by the original MSIX Claude). After Restore, the original MSIX Claude works fully again, including Cowork (its embedded cert is back to Anthropic).

`%LOCALAPPDATA%\ClaudeRTL\backups\` and `patch.log` are kept on Restore (for auditability). The user can delete them manually for a clean wipe.

---

# Part F — Build the patcher from scratch (offline architectural reference)

Use this if `patch-rtl.ps1` doesn't exist OR a future Claude version broke it and you need to rebuild. Everything you need is below — **no external resources required**.

## Background — what the patcher does and why

Claude Desktop on Windows ships as an MSIX package at `C:\Program Files\WindowsApps\Claude_<version>_x64__pzs8sxrjxfjjc\app\`. The UI is an Electron app whose JavaScript lives in an asar archive at `app\resources\app.asar`. The MSIX install is read-only (TrustedInstaller-owned). MSIX updates wipe and replace the entire `Claude_<version>` directory, so any in-place patch is ephemeral.

This patcher is **copy-based**: mirror the MSIX `app\` to user-writable space, modify the copy, leave the original untouched (except `cowork-svc.exe` cert — see step 4).

## Architecture decisions to NOT revisit

- **Fuse-disable, NOT byte-level hash patching of `claude.exe`.** Simpler, robust against Electron internal changes. We don't need to preserve Anthropic Authenticode on the copy.
- **Per-machine cert generation, NOT a baked-in shared cert.** Cert-hole size varies between Claude versions, and a shared org-wide private key is a security risk.
- **Shared `userData` with MSIX (NOT separate).** User accepts not running both apps simultaneously in exchange for keeping their chat history.
- **Manual rebuild after Claude updates** (not Scheduled Task watcher).
- **Self-contained PowerShell**, no GitHub fetches, no auto-update infrastructure.

## The seven things the patcher does, in order

### 1. Mirror the MSIX `app\` directory to user space — at the right path

```
robocopy "<MSIX>\app" "%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app" /MIR /COPY:DAT /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
```
- `/MIR` makes it idempotent on re-runs.
- `/COPY:DAT` — data + attrs + timestamps. NOT security/owner.
- `/XJ` — skip junctions.
- robocopy exit codes 0–7 = success, 8+ = failure.

**Path is critical.** It MUST contain a segment named `WindowsApps` (case-insensitive) — required by the MSIX detection bypass (step 6). Use `%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app\`.

### 2. Inject RTL JS into the copy's `app.asar`

Pipeline:
```powershell
npx --yes @electron/asar@4.2.0 extract <copyAsar> <tmpDir>
# modify .vite/build/*.js as below
npx --yes @electron/asar@4.2.0 pack <tmpDir> <copyAsar>.new
Move-Item <copyAsar>.new <copyAsar>
```

Three injections, three different targets:

| Target | Payload | Purpose |
|---|---|---|
| All renderer files | `RTL_INJECTION_CODE` | DOM-level RTL detection |
| `index.pre.js` (resolved from `package.json` "main") | `MAIN_INJECTION_CODE` | UI direction switch + single-instance bypass + userData redirect |
| `index.js` (main bundle) | `INDEX_GUARD_INJECTION_CODE` | Defense-in-depth single-instance bypass |

Renderer file list (current 1.11847.5.0):
- `aboutWindow.js`, `buddy.js`, `computerUseTeach.js`, `coworkArtifact.js`, `findInPage.js`, `mainView.js`, `mainWindow.js`, `quickWindow.js`

Files to **skip entirely** (no DOM, would break things):
- `index.js` (gets only the INDEX_GUARD)
- `index.pre.js` (gets only the MAIN_INJECTION)
- `directMcpHost.js`, `nodeHost.js` (under `mcp-runtime/`)
- `shellPathWorker.js` (under `shell-path-worker/`)
- `transcriptSearchWorker.js` (under `transcript-search-worker/`)

After injection, run `node --check <patched-file>` on `index.pre.js` and `index.js`. A syntax error there would prevent Claude from starting at all.

For both `index.pre.js` and `index.js`, insert the payload AFTER the leading `"use strict";` directive (preserve strict mode):
```powershell
$strictRe = '^\s*("use strict"|''use strict'')\s*;'
if ($content -match $strictRe) {
    $prologue = $matches[0]
    $newContent = $prologue + "`n" + $PAYLOAD + "`n" + $content.Substring($prologue.Length)
} else {
    $newContent = $PAYLOAD + "`n" + $content
}
```

Skip already-patched files: check for `'CLAUDE RTL PATCH START'`, `'CLAUDE RTL MAIN PATCH START'`, or `'CLAUDE RTL INDEX GUARD START'` markers.

The three payloads are embedded **verbatim** at the end of this document (see **Appendix: JS Payloads**).

### 3. Disable Electron's asar-integrity fuse on the copy

```powershell
npx --yes @electron/fuses@2.1.1 write --app "<copyExe>" EnableEmbeddedAsarIntegrityValidation=off
# Re-probe to verify:
npx --yes @electron/fuses@2.1.1 read --app "<copyExe>"
# Must show: EnableEmbeddedAsarIntegrityValidation ... Disabled
```

Re-probe is mandatory — some `fuses` versions print "Fuses written" without persisting.

### 4. Cert-swap inside MSIX `cowork-svc.exe`

This is the only file in the MSIX we modify. `cowork-svc.exe` has an embedded cert that it uses for some validation purpose. We replace it with a self-signed cert and sign the copy's `claude.exe` with the same cert.

For Claude 1.11847.5.0 specifically:
- Anchor `"Anthropic, PBC"` ASCII string at offset `0xC0CFE3` (and 3 more matches; first one is what we want).
- Cert hole at offset `0xC0B499`, size 856 bytes.
- These offsets vary between Claude versions — use the byte-search algorithm below, do NOT hardcode.

Algorithm:

```powershell
# Read bytes from .bak (always Anthropic-signed by construction, even if live file
# is already patched from a prior run).
$svcBytes = [System.IO.File]::ReadAllBytes($bakPath)

# Find "Anthropic, PBC" anchor. Walk back up to 2000 bytes looking for an ASN.1
# DER SEQUENCE (0x30 0x82 hi lo) that ENCLOSES the anchor and is between 500-4000 bytes.
$anchorBytes = [System.Text.Encoding]::ASCII.GetBytes('Anthropic, PBC')
# (use Find-Bytes via ISO-8859-1 string IndexOf — fast)
# ...
$startPos = $i  # SEQUENCE start
$oldCertSize = 4 + (([int]$svcBytes[$i+2] -shl 8) -bor [int]$svcBytes[$i+3])

# Generate self-signed cert with SHORT subject. Newer Claude has hole=856 bytes,
# 2048-bit RSA with long Anthropic DN clones is ~1136 bytes (doesn't fit).
# Try a ladder: RSA-2048 (~782 with short subj) -> RSA-1024 -> ECDSA-P256 (~340).
$certSubject = 'CN=Claude-RTL-Patcher'
foreach ($algo in @{KeyAlgorithm='RSA';KeyLength=2048}, @{KeyAlgorithm='RSA';KeyLength=1024}, @{KeyAlgorithm='ECDSA_nistP256'}) {
    for ($attempt=1; $attempt -le 5; $attempt++) {
        $cert = New-SelfSignedCertificate -Subject $certSubject -Type CodeSigningCert `
            -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName 'Claude_RTL_SelfSigned' @algo
        if ($cert.RawData.Length -le $oldCertSize) {
            # Add to trusted root store so Authenticode validation passes
            $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine')
            $rootStore.Open('ReadWrite'); $rootStore.Add($cert); $rootStore.Close()
            break  # found a fitting cert
        }
        Get-ChildItem Cert:\LocalMachine\My | ? {$_.Thumbprint -eq $cert.Thumbprint} | Remove-Item
    }
    if ($cert.RawData.Length -le $oldCertSize) { break }
}

# Pad cert to oldCertSize, splice into svcBytes at $startPos, write
$padded = New-Object byte[] $oldCertSize
[Array]::Copy($cert.RawData, 0, $padded, 0, $cert.RawData.Length)
[Array]::Copy($padded, 0, $svcBytes, $startPos, $oldCertSize)
[System.IO.File]::WriteAllBytes($coworkSvc, $svcBytes)

# Re-sign cowork-svc.exe AND copy claude.exe with the SAME cert
Set-AuthenticodeSignature -FilePath $coworkSvc -Certificate $cert -HashAlgorithm SHA256
Set-AuthenticodeSignature -FilePath $copyClaudeExe -Certificate $cert -HashAlgorithm SHA256

# Wipe private key (public cert stays in Root for verification).
$myStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','LocalMachine')
$myStore.Open('ReadWrite')
$found = $myStore.Certificates | ? {$_.Thumbprint -eq $cert.Thumbprint}
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($found)
if ($rsa -is [System.Security.Cryptography.RSACng]) { $rsa.Key.Delete() }
$myStore.Remove($found); $myStore.Close()
```

To get write access to MSIX file:
```powershell
takeown /F "<MSIX>\app\resources\cowork-svc.exe"
icacls "<MSIX>\app\resources\cowork-svc.exe" /grant "*S-1-5-32-544:F" /Q
```

Stop service before write, start after:
```powershell
Stop-Service CoworkVMService -Force
Stop-Process -Name cowork-svc -Force -ErrorAction SilentlyContinue
# ... do cert swap ...
Start-Service CoworkVMService
```

### 5. Backup management for `cowork-svc.exe`

Keep `%LOCALAPPDATA%\ClaudeRTL\backups\cowork-svc.exe.bak` as the pristine Anthropic-signed copy. Refresh it whenever the live MSIX file has Anthropic's signature (`Get-AuthenticodeSignature` Subject contains "Anthropic"). This handles the case where MSIX update reverted our patch — next install rebuilds correctly from a fresh bak.

### 6. MSIX detection bypass — covered by the path choice

Already covered by step 1's path choice (`%LOCALAPPDATA%\ClaudeRTL\WindowsApps\app\`). No code injection needed for this.

### 7. Launcher + shortcuts

A `.lnk` shortcut can't set environment variables. Write a `.cmd` wrapper at `%LOCALAPPDATA%\ClaudeRTL\launch-rtl.cmd`:
```cmd
@echo off
REM userData is shared with the original MSIX Claude -- DO NOT run both apps
REM simultaneously, leveldb locks will corrupt the database.
set CLAUDE_RTL_INSTANCE=1
set CLAUDE_RTL_USERDATA=C:\Users\<user>\AppData\Roaming\Claude
start "" "C:\Users\<user>\AppData\Local\ClaudeRTL\WindowsApps\app\claude.exe" %*
```

`CLAUDE_RTL_INSTANCE=1` activates the guards in `MAIN_INJECTION_CODE` (single-instance bypass + userData redirect). Without this env var the guards no-op (defense in depth — same patched asar deployed elsewhere wouldn't accidentally bypass anything).

`CLAUDE_RTL_USERDATA=%APPDATA%\Claude` shares with original. The path needs to be expanded at .cmd-write time (PowerShell's `Join-Path $env:APPDATA 'Claude'`).

Two desktop shortcuts via `WScript.Shell`:
- `Claude RTL.lnk` → TargetPath = `%ComSpec%`, Arguments = `/C "<launcher.cmd>"`, WindowStyle = 7 (Minimized), Icon = copy `claude.exe,0`
- `Rebuild Claude RTL.lnk` → TargetPath = `powershell.exe`, Arguments = `-NoProfile -ExecutionPolicy Bypass -File "<patch-rtl.ps1>" -Auto`

## Restore (the inverse)

1. Stop `CoworkVMService`.
2. If MSIX `cowork-svc.exe` is signed by us (Subject doesn't match Anthropic), copy from bak.
3. Remove certs from Root store: `Get-ChildItem Cert:\LocalMachine\Root | Where-Object FriendlyName -eq 'Claude_RTL_SelfSigned' | Remove-Item`
4. Remove copy dir, shortcuts, launch-rtl.cmd.
5. Start `CoworkVMService`.
6. Never touch `%APPDATA%\Claude\`.

---

# Appendix: JS Payloads (verbatim)

These are the exact contents of the three injected payloads. When building from scratch, paste these into here-strings in the PowerShell script (`@'` ... `'@` — single-quoted here-strings preserve `$` literally).

## `RTL_INJECTION_CODE` (renderer)

Inject at the TOP of every renderer file in `.vite/build/*.js` (NOT into `index.js`, `index.pre.js`, or any worker file).

```javascript
// --- CLAUDE RTL PATCH START ---
;(function() {
    'use strict';
    if (typeof document === 'undefined') return;
    try {
        var WRITING_SEL = '[data-testid="chat-input"]';

        function isRTL(c) {
            var code = c.charCodeAt(0);
            return (code >= 0x0590 && code <= 0x05FF) ||
                   (code >= 0x0600 && code <= 0x06FF) ||
                   (code >= 0x0750 && code <= 0x077F) ||
                   (code >= 0x08A0 && code <= 0x08FF);
        }

        function hasRTL(text) {
            if (!text) return false;
            for (var i = 0; i < text.length; i++) { if (isRTL(text[i])) return true; }
            return false;
        }

        function firstStrong(text) {
            if (!text) return null;
            for (var i = 0; i < text.length; i++) {
                if (isRTL(text[i])) return 'rtl';
                if (/[a-zA-Z]/.test(text[i])) return 'ltr';
            }
            return null;
        }

        function textWithoutCode(el) {
            var out = '';
            var nodes = el.childNodes;
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.nodeType === 3) { out += n.textContent; }
                else if (n.nodeType === 1 && n.tagName !== 'CODE' && n.tagName !== 'PRE') {
                    out += textWithoutCode(n);
                }
            }
            return out;
        }

        function stripLeadingLTR(text) {
            return text
                .replace(/^[\s]*(?:[\w.\-]+\.[\w]{1,5})\s*/g, '')
                .replace(/https?:\/\/\S+/g, '')
                .replace(/[\w.\-]+[\/\\][\w.\-\/\\]+/g, '')
                .replace(/`[^`]+`/g, '');
        }

        var RTL_SPLIT_FLAG = 'data-rtl-split';
        var BR_OR_NL_SPLIT = /(<br\s*\/?>|\n)/i;

        function hasMultiScriptLines(el) {
            var src = el.textContent;
            if (!src) return false;
            if (!/[a-zA-Z]{2,}/.test(src)) return false;
            if (!hasRTL(src)) return false;
            return BR_OR_NL_SPLIT.test(el.innerHTML) || src.indexOf('\n') !== -1;
        }

        function splitToDirectionalSpans(el) {
            if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
            el.setAttribute(RTL_SPLIT_FLAG, '1');
            if (el.hasAttribute('dir')) el.removeAttribute('dir');
            el.style.direction = '';
            el.style.textAlign = 'start';
            el.style.unicodeBidi = 'plaintext';
        }

        function resetDirOrPinLTR(el) {
            if (window.getComputedStyle(el).direction === 'rtl') {
                el.dir = 'ltr';
                el.style.direction = 'ltr';
                return;
            }
            if (el.hasAttribute('dir')) el.removeAttribute('dir');
            el.style.direction = '';
        }

        var POS_PRESERVED_FLAG = 'data-rtl-pos-fixed';
        var POS_PRESERVE_MAX_DEPTH = 12;

        function preserveLogicalPositioning(startEl) {
            var el = startEl;
            for (var depth = 0; el && depth < POS_PRESERVE_MAX_DEPTH; depth++, el = el.parentElement) {
                if (!el.style || el.hasAttribute(POS_PRESERVED_FLAG)) continue;
                var cs = window.getComputedStyle(el);
                if (!cs) continue;
                var msAuto = cs.marginInlineStart === 'auto';
                var meAuto = cs.marginInlineEnd === 'auto';
                if (!msAuto && !meAuto) continue;
                var parentDir = el.parentElement ?
                    window.getComputedStyle(el.parentElement).direction : 'ltr';
                var startPhysical = (parentDir === 'rtl') ? 'Right' : 'Left';
                var endPhysical   = (parentDir === 'rtl') ? 'Left'  : 'Right';
                if (msAuto) el.style['margin' + startPhysical] = 'auto';
                if (meAuto) el.style['margin' + endPhysical]   = 'auto';
                el.style.marginInlineStart = '';
                el.style.marginInlineEnd = '';
                el.setAttribute(POS_PRESERVED_FLAG, '1');
            }
        }

        function detectElDir(el) {
            var full = el.textContent || '';
            if (!hasRTL(full)) return null;
            var noCode = textWithoutCode(el);
            var d = firstStrong(noCode);
            if (d === 'rtl') return 'rtl';
            var stripped = stripLeadingLTR(noCode);
            d = firstStrong(stripped);
            if (d === 'rtl') return 'rtl';
            return 'rtl';
        }

        function detectTextDir(text) {
            if (!text || !text.trim()) return null;
            var d = firstStrong(text);
            if (d === 'rtl') return 'rtl';
            if (!hasRTL(text)) return 'ltr';
            var stripped = stripLeadingLTR(text);
            d = firstStrong(stripped);
            if (d === 'rtl') return 'rtl';
            return 'rtl';
        }

        function qsa(root, sel) {
            var base = root.querySelectorAll ? root : document;
            var els = Array.from(base.querySelectorAll(sel));
            if (root.matches && root.matches(sel)) els.unshift(root);
            return els;
        }

        function forceCodeLTR(root) {
            qsa(root, 'pre, .code-block__code, .relative.group\\/copy').forEach(function(b) {
                b.dir = 'ltr'; b.style.textAlign = 'left'; b.style.unicodeBidi = 'embed';
            });
            qsa(root, 'code').forEach(function(c) {
                if (!c.closest('pre') && !c.closest('.code-block__code')) c.dir = 'ltr';
            });
        }

        function processText(root) {
            qsa(root, 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, summary, label, dt, dd').forEach(function(el) {
                if (el.closest(WRITING_SEL) || el.closest('pre') || el.closest('.code-block__code')) return;
                if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
                var dir = detectElDir(el);
                if (dir) {
                    if (dir === 'rtl' && hasMultiScriptLines(el)) {
                        splitToDirectionalSpans(el);
                        return;
                    }
                    if (dir === 'rtl') preserveLogicalPositioning(el);
                    el.dir = dir;
                    el.style.direction = dir;
                    if (el.tagName === 'LI') {
                        el.style.listStylePosition = (dir === 'rtl') ? 'inside' : '';
                        var parentList = el.closest('ul, ol');
                        if (parentList && dir === 'rtl' && !parentList.hasAttribute('dir')) {
                            parentList.dir = 'rtl';
                            parentList.style.direction = 'rtl';
                            var pl = getComputedStyle(parentList).paddingLeft;
                            if (parseFloat(pl) > 0) { parentList.style.paddingRight = pl; parentList.style.paddingLeft = '0'; }
                        }
                    }
                } else {
                    resetDirOrPinLTR(el);
                    if (el.tagName === 'LI') el.style.listStylePosition = '';
                }
            });
            qsa(root, 'ul, ol').forEach(function(el) {
                if (el.closest(WRITING_SEL) || el.closest('pre')) return;
                var dir = detectElDir(el);
                if (dir === 'rtl') {
                    preserveLogicalPositioning(el);
                    el.dir = 'rtl';
                    el.style.direction = 'rtl';
                    var pl = getComputedStyle(el).paddingLeft;
                    if (parseFloat(pl) > 0) { el.style.paddingRight = pl; el.style.paddingLeft = '0'; }
                } else {
                    resetDirOrPinLTR(el);
                    el.style.paddingRight = ''; el.style.paddingLeft = '';
                }
            });
        }

        function processContainers(root) {
            qsa(root, 'div, span, button, a, label').forEach(function(el) {
                if (el.closest('pre') || el.closest('code') || el.closest(WRITING_SEL)) return;
                if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
                var parent = el.parentElement;
                if (parent && parent.hasAttribute(RTL_SPLIT_FLAG)) return;
                if (el.querySelector('p, div, ul, ol, h1, h2, h3, h4, h5, h6, pre, table')) return;
                if (/^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|UL|OL)$/.test(el.tagName)) return;
                var text = (el.textContent || '').trim();
                if (text.length < 2) return;
                if (hasRTL(text)) {
                    if (hasMultiScriptLines(el)) {
                        splitToDirectionalSpans(el);
                    } else {
                        preserveLogicalPositioning(el);
                        el.dir = detectTextDir(text) || 'rtl';
                        el.style.textAlign = 'start';
                    }
                } else if (el.hasAttribute('dir')) {
                    el.removeAttribute('dir');
                    el.style.textAlign = '';
                }
            });
        }

        function processInput() {
            document.querySelectorAll(WRITING_SEL).forEach(function(input) {
                var text = input.textContent || input.innerText || '';
                var dir = detectTextDir(text);
                if (dir === 'rtl') {
                    input.style.direction = 'rtl'; input.style.textAlign = 'right'; input.style.paddingRight = '25px';
                } else {
                    input.style.direction = 'ltr'; input.style.textAlign = 'left'; input.style.paddingRight = '';
                }
            });
        }

        function fixGlobalAutoMargins() {
            var hosts = document.querySelectorAll(
                '[class*="ms-auto"],[class*="me-auto"],' +
                '[class*="ml-auto"],[class*="mr-auto"]'
            );
            for (var i = 0; i < hosts.length; i++) {
                var el = hosts[i];
                if (el.hasAttribute(POS_PRESERVED_FLAG)) continue;
                var classes = el.className || '';
                if (typeof classes !== 'string') continue;
                if (/(?:^|\s)m[sl]-auto(?:\s|$)/.test(classes)) {
                    el.style.marginLeft = 'auto';
                    el.style.marginInlineStart = '';
                }
                if (/(?:^|\s)m[er]-auto(?:\s|$)/.test(classes)) {
                    el.style.marginRight = 'auto';
                    el.style.marginInlineEnd = '';
                }
                el.setAttribute(POS_PRESERVED_FLAG, '1');
            }
        }

        function processAll() {
            processText(document);
            processContainers(document.body);
            processInput();
            forceCodeLTR(document.body);
            fixGlobalAutoMargins();
        }

        function injectStyles() {
            if (document.getElementById('claude-rtl-styles')) return;
            var s = document.createElement('style');
            s.id = 'claude-rtl-styles';
            s.textContent = [
                'p:not([dir]),li:not([dir]),h1:not([dir]),h2:not([dir]),h3:not([dir]),h4:not([dir]),h5:not([dir]),h6:not([dir]),blockquote:not([dir]),td:not([dir]),th:not([dir]),summary:not([dir]),label:not([dir]),legend:not([dir]),dt:not([dir]),dd:not([dir]),figcaption:not([dir]),caption:not([dir]){unicode-bidi:plaintext!important;text-align:start!important}',
                '[class*="ms-auto"],[class*="ml-auto"]{margin-left:auto!important;margin-inline-start:0!important}',
                '[class*="me-auto"],[class*="mr-auto"]{margin-right:auto!important;margin-inline-end:0!important}',
                'pre,.code-block__code,.relative.group\\/copy{unicode-bidi:embed!important;direction:ltr!important;text-align:left!important}',
                'code{unicode-bidi:isolate!important;direction:ltr!important}',
                '[dir]{text-align:start!important}[dir="rtl"]{direction:rtl!important}[dir="ltr"]{direction:ltr!important}',
                '[dir]>*:not([dir]):not(pre):not(code):not(.code-block__code){unicode-bidi:plaintext;text-align:start}',
                '[dir="rtl"][class*="mask-image:linear-gradient(to_right"]{-webkit-mask-image:linear-gradient(to left,hsl(var(--always-black)) 85%,transparent 99%)!important;mask-image:linear-gradient(to left,hsl(var(--always-black)) 85%,transparent 99%)!important}',
                '.group:hover [dir="rtl"][class*="mask-image:linear-gradient(to_right"],.group:focus-within [dir="rtl"][class*="mask-image:linear-gradient(to_right"],[data-menu-open="true"] [dir="rtl"][class*="mask-image:linear-gradient(to_right"]{-webkit-mask-image:linear-gradient(to left,hsl(var(--always-black)) 60%,transparent 78%)!important;mask-image:linear-gradient(to left,hsl(var(--always-black)) 60%,transparent 78%)!important}'
            ].join('');
            document.head.appendChild(s);
        }

        function init() {
            injectStyles();
            processAll();

            document.addEventListener('input', function(e) {
                var t = e.target;
                if (!t || !(t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
                var text = t.textContent || t.innerText || t.value || '';
                var dir = detectTextDir(text);
                if (dir === 'rtl') {
                    t.style.direction = 'rtl'; t.style.textAlign = 'right'; t.style.paddingRight = '25px';
                } else {
                    t.style.direction = 'ltr'; t.style.textAlign = 'left'; t.style.paddingRight = '';
                }
            }, true);

            var pendingMuts = [];
            var obs = new MutationObserver(function(muts) {
                var dominated = false;
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].addedNodes.length > 0 || muts[i].type === 'characterData') { dominated = true; break; }
                }
                if (!dominated) return;
                for (var j = 0; j < muts.length; j++) pendingMuts.push(muts[j]);
                if (window._rtlT) return;
                window._rtlT = setTimeout(function() {
                    window._rtlT = null;
                    var toProcess = pendingMuts;
                    pendingMuts = [];
                    var roots = new Set();
                    toProcess.forEach(function(m) {
                        m.addedNodes.forEach(function(n) { if (n.nodeType === 1) roots.add(n); });
                        if (m.type === 'characterData' && m.target.parentElement) roots.add(m.target.parentElement);
                    });
                    var expanded = new Set(roots);
                    roots.forEach(function(r) {
                        if (!r.closest) return;
                        var txt = r.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, summary, label, dt, dd');
                        if (txt) expanded.add(txt);
                        var list = r.closest('ul, ol');
                        if (list) expanded.add(list);
                    });
                    roots = expanded;
                    if (roots.size > 0 && roots.size <= 30) {
                        roots.forEach(function(r) {
                            processText(r);
                            processContainers(r);
                            forceCodeLTR(r);
                        });
                        processInput();
                        fixGlobalAutoMargins();
                    } else {
                        processAll();
                    }
                }, 50);
            });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else { init(); }
    } catch(e) { console.error('[Claude RTL]', e); }
})();
// --- CLAUDE RTL PATCH END ---
```

## `MAIN_INJECTION_CODE` (main process — `index.pre.js` only)

```javascript
// --- CLAUDE RTL MAIN PATCH START ---
;(function(){
    try {
        if (global.__claudeRtlMainPatched) return;
        global.__claudeRtlMainPatched = true;
        var electron = require('electron');
        var app = electron.app;

        // 1. UI direction switch (always applied -- harmless for LTR locales).
        if (app && app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
            app.commandLine.appendSwitch('force-ui-direction', 'ltr');
        }

        // 2. RTL-copy-only behaviors. Gated on env var.
        if (process.env.CLAUDE_RTL_INSTANCE === '1' && app) {
            try {
                var path = require('path');
                var userDataDir = process.env.CLAUDE_RTL_USERDATA ||
                    path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ClaudeRTL', 'userdata');
                app.setPath('userData', userDataDir);
            } catch (e) { console.error('[Claude RTL] userData redirect failed', e); }

            try {
                var origReq = app.requestSingleInstanceLock.bind(app);
                app.requestSingleInstanceLock = function() {
                    try { origReq(); } catch (_) {}
                    return true;
                };
                app.hasSingleInstanceLock = function() { return true; };
            } catch (e) { console.error('[Claude RTL] single-instance bypass failed', e); }
        }
    } catch (e) { try { console.error('[Claude RTL Main]', e); } catch (_) {} }
})();
// --- CLAUDE RTL MAIN PATCH END ---
```

## `INDEX_GUARD_INJECTION_CODE` (main bundle — `index.js` only)

Defense-in-depth duplicate of the single-instance bypass, in case `index.pre.js` doesn't reach `requestSingleInstanceLock` first.

```javascript
// --- CLAUDE RTL INDEX GUARD START ---
;(function(){
    try {
        if (global.__claudeRtlIndexGuarded) return;
        global.__claudeRtlIndexGuarded = true;
        if (process.env.CLAUDE_RTL_INSTANCE !== '1') return;
        var app = require('electron').app;
        if (!app) return;
        var origReq = app.requestSingleInstanceLock.bind(app);
        app.requestSingleInstanceLock = function() {
            try { origReq(); } catch (_) {}
            return true;
        };
        app.hasSingleInstanceLock = function() { return true; };
    } catch (e) { try { console.error('[Claude RTL Index Guard]', e); } catch (_) {} }
})();
// --- CLAUDE RTL INDEX GUARD END ---
```

---

# Appendix: .cmd wrapper templates

## `Install.cmd`

```cmd
@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Claude RTL -- Install
echo ==========================================
echo.
echo Unblocking script (in case of Mark-of-the-Web)...
PowerShell.exe -NoProfile -Command "Unblock-File '%~dp0patch-rtl.ps1'"

echo Launching patcher (UAC will prompt)...
echo.
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-rtl.ps1" -Auto

echo.
pause
```

## `Rebuild.cmd`

```cmd
@echo off
setlocal
cd /d "%~dp0"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-rtl.ps1" -Auto
pause
```

## `Restore.cmd`

```cmd
@echo off
setlocal
cd /d "%~dp0"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-rtl.ps1" -Restore
pause
```

## `InstallSkipCowork.cmd`

```cmd
@echo off
setlocal
cd /d "%~dp0"
PowerShell.exe -NoProfile -Command "Unblock-File '%~dp0patch-rtl.ps1'"
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-rtl.ps1" -Auto -SkipCowork
pause
```

---

# Part G — Version compatibility map + adaptation flow

The patch was authored for **Claude Desktop 1.11847.5.0 / Electron 41.6.1**. Claude updates frequently. Some components are robust to updates; others are not.

## Stability map — what survives Claude updates and what doesn't

### Stable (low risk — should keep working across most updates)

| Component | What makes it stable |
|---|---|
| **MSIX → user-space mirror** (`robocopy /MIR`) | File-copy operation. Independent of Claude internals. |
| **Per-user copy at `WindowsApps`-named path** | Pure path string trick. Won't break unless Anthropic replaces `q6e()` with a real MSIX-context API call (e.g. `process.windowsStore` only). |
| **Single-instance bypass** (monkey-patch `app.requestSingleInstanceLock`) | Electron public API. Stable across many Electron versions. |
| **Shared `userData` env var** (`CLAUDE_RTL_USERDATA`) | Standard Electron `app.setPath('userData', ...)`. |
| **Cert byte-search** (anchor `"Anthropic, PBC"` + ASN.1 `0x30 0x82` SEQUENCE) | Algorithmic — auto-discovers offsets. Won't break unless cert format changes. |
| **fuse disable** (`@electron/fuses` write `EnableEmbeddedAsarIntegrityValidation=off`) | Electron-level mechanism. Stable across Claude updates that stay on same Electron major. |

### Fragile (medium-high risk — likely to break in specific update scenarios)

| Component | What can break it | Symptom |
|---|---|---|
| **Renderer file list** (`mainView.js`, `mainWindow.js`, `aboutWindow.js`, etc.) | Anthropic adds new renderer files OR renames existing ones | Some UI areas don't get RTL (e.g. a new dialog stays LTR). Partial-failure mode — RTL works in chat, not in a new feature |
| **Skip list** (`directMcpHost.js`, `nodeHost.js`, `shellPathWorker.js`, `transcriptSearchWorker.js`) | New non-DOM worker added; gets injected accidentally | Worker crashes on startup with `document is undefined`. Some feature fails silently |
| **`q6e()` MSIX detection** | Anthropic replaces path-string check with a real MSIX-context API | "Cowork requires a newer installation" returns. Path trick stops working |
| **Cert hole offset/size** | Anthropic changes ASN.1 layout, removes embedded cert, or shrinks hole below 340 bytes | Either "Anthropic cert pattern not found" OR "Cert hole too small even for ECDSA-P256" |
| **DOM selectors** (`[data-testid="chat-input"]`, `.code-block__code`, `pre`, `code`) | Anthropic restructures their CSS classes / data-testid | Input box doesn't switch direction. Code blocks slip out of LTR |
| **Tailwind class names for bubbles** (`ms-auto`, `me-auto`, `ml-auto`, `mr-auto`) | Anthropic adopts a different layout strategy (e.g. `justify-end` instead of margin-auto) | User bubbles slide left despite the fix |
| **`POS_PRESERVE_MAX_DEPTH = 12`** | Layout becomes deeper than 12 levels between text node and `ms-auto` host | User bubbles slide left intermittently for some message types |
| **`@electron/asar` / `@electron/fuses` package versions** | Electron major bumps (41 → 42, etc.) | Package incompatibility errors during extract/pack/fuse-write |
| **`index.pre.js` as main entry** (resolved via `package.json` "main") | Anthropic renames or restructures the main entry | MAIN injection misses; single-instance bypass fails; `q6e()` fix may still work via path trick |

### Hardcoded version assumption (will need update)

| Constant | Current value | Where in script |
|---|---|---|
| `$script:AsarPackage` | `@electron/asar@4.2.0` | Top of `patch-rtl.ps1` |
| `$script:FusesPackage` | `@electron/fuses@2.1.1` | Top of `patch-rtl.ps1` |
| `$script:MinNodeVersion` | `22.12.0` | Top of `patch-rtl.ps1` |

These are pinned for reproducibility. If a new Electron major requires a newer `@electron/fuses`, bump the version after testing the upstream changelog.

## Diagnostic flow when target is on a different Claude version

Run these checks IN ORDER. Stop at the first one that fails — that tells you what to fix.

### Step 1 — confirm version + Electron major

```powershell
$pkg = Get-AppxPackage *Claude*
$pkg | Format-List Name, Version, InstallLocation
$electronVer = Get-Content (Join-Path $pkg.InstallLocation 'app\version') -ErrorAction SilentlyContinue
"Electron version: $electronVer"
```

Expected: Version `1.11847.5.0`, Electron `41.6.1`.
- If Version differs but minor (`1.11847.x`) — proceed. Almost certainly fine.
- If minor differs (`1.12000.x`) — proceed but expect renderer file list / DOM selector drift. Watch Step 4.
- If major differs (`2.x.x`) or Electron jumped — pause. Read this whole section first.

### Step 2 — verify the asar still has `.vite/build/` structure

```powershell
$asar = Join-Path $pkg.InstallLocation 'app\resources\app.asar'
$tmp = Join-Path $env:TEMP 'rtl-asar-probe'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
npx --yes @electron/asar@4.2.0 extract $asar $tmp
Get-ChildItem (Join-Path $tmp '.vite\build') -Filter '*.js' | Select-Object Name, Length | Format-Table -AutoSize
Get-Content (Join-Path $tmp 'package.json') -Raw | ConvertFrom-Json | Select-Object name, version, main
Remove-Item $tmp -Recurse -Force
```

Expected output (1.11847.5.0):
- `package.json.main` = `.vite/build/index.pre.js`
- 8 renderer files: `aboutWindow.js`, `buddy.js`, `computerUseTeach.js`, `coworkArtifact.js`, `findInPage.js`, `mainView.js`, `mainWindow.js`, `quickWindow.js`
- 1 main bundle: `index.js` (~13 MB)
- 1 main entry: `index.pre.js` (~850 KB)
- 4 workers: `mcp-runtime/directMcpHost.js`, `mcp-runtime/nodeHost.js`, `shell-path-worker/shellPathWorker.js`, `transcript-search-worker/transcriptSearchWorker.js`

If the structure is different:
- **Different main entry name** → update `$mainEntryFile` in `Patch-CopyAsar` (it's auto-resolved from `package.json.main`, so usually fine).
- **New renderer files** → patcher will inject them automatically (uses `Get-ChildItem -Recurse`). No code change needed unless the new file is a worker that should be in `$skipEntirely`.
- **New worker file** → ADD it to `$skipEntirely` in `Patch-CopyAsar` to prevent crash.
- **No `.vite/build/`** → bigger restructure. Adapt manually.

### Step 3 — verify the cert hole is still there

```powershell
$svc = Join-Path $pkg.InstallLocation 'app\resources\cowork-svc.exe'
$bytes = [System.IO.File]::ReadAllBytes($svc)
$enc = [System.Text.Encoding]::GetEncoding(28591)
$hay = $enc.GetString($bytes)
$pos = 0; $count = 0
while (($i = $hay.IndexOf('Anthropic, PBC', $pos, [System.StringComparison]::Ordinal)) -ge 0) {
    $count++; $pos = $i + 14
}
"Anthropic anchor count: $count"
# Expected: at least 1 (we saw 4 on 1.11847.5.0)
```

If 0 — Anthropic stopped embedding the cert in the binary. The cert-swap approach won't work; user gets no Cowork. Use `-SkipCowork`.

If ≥ 1 — proceed. The byte-search algorithm will find the SEQUENCE.

### Step 4 — verify `q6e()` is still the MSIX detection function

```powershell
# Read .vite/build/index.js, look for the path heuristic
# (the asar must be re-extracted; do this if Step 2 was destructive)
Select-String -Path (Join-Path $tmp '.vite\build\index.js') -Pattern 'windowsapps|process\.windowsStore' -SimpleMatch:$false |
    Select-Object -First 5 LineNumber, Line
```

If you see a string-match pattern with `"windowsapps"` — the path trick works. Proceed.

If `process.windowsStore` is the ONLY check — path trick won't help. Need to inject a stub for `process.windowsStore = true`. Add to `MAIN_INJECTION_CODE` BEFORE Electron initializes:
```javascript
try { Object.defineProperty(process, 'windowsStore', { value: true, configurable: true }); } catch(_) {}
```

If neither — Anthropic moved the check elsewhere. Find it: `Select-String -Pattern 'msix_required|isMsix|isCowork' -SimpleMatch -Path '.vite/build/*.js'`.

### Step 5 — verify the bubble layout still uses `ms-auto`

In a running Claude (after install), open DevTools (Ctrl+Alt+I, requires `developer_settings.json` with `{"devtools": true}`):

1. Type a Hebrew message.
2. Inspect the bubble.
3. Walk up the DOM looking for `class="...ms-auto..."` or `class="...justify-end..."`.

If `ms-auto` is present — fix #5 should work.
If a new strategy (e.g. `justify-end` on flex parent) — add corresponding handling to `fixGlobalAutoMargins()` in the renderer payload.
If `ms-auto` is deeper than 12 ancestors — bump `POS_PRESERVE_MAX_DEPTH` in the payload.

### Step 6 — verify chat input selector

```powershell
# In running Claude DevTools console:
document.querySelector('[data-testid="chat-input"]')
# Should return an element. If null, the selector changed.
```

If the testid is gone, find the replacement and update `WRITING_SEL` in `RTL_INJECTION_CODE`.

## Adaptation playbook (when something in steps 1-6 fails)

| What failed | What to do |
|---|---|
| Step 1: Major version jump | Read full Part F (build from scratch). Don't try to patch incrementally. |
| Step 2: New worker, no DOM | Add filename to `$skipEntirely` |
| Step 2: Main entry renamed | Patcher auto-resolves from `package.json.main` — usually no change needed |
| Step 3: 0 Anthropic anchor | Use `-SkipCowork`. Document in user-facing notes that Cowork won't work |
| Step 4: `process.windowsStore` only | Add the `Object.defineProperty` stub to `MAIN_INJECTION_CODE` |
| Step 5: New layout strategy | Extend `fixGlobalAutoMargins()` with new selectors |
| Step 5: deeper than 12 levels | Bump `POS_PRESERVE_MAX_DEPTH` |
| Step 6: testid changed | Update `WRITING_SEL` in renderer payload |

## When you're truly stuck

If steps 1-6 don't reveal an actionable issue and the patch still fails on the new version, fall back to **`-SkipCowork` mode**:
```powershell
.\patch-rtl.ps1 -Auto -SkipCowork
```
This gives the user RTL-supported chat in the copy. Cowork doesn't work, but original Claude is unchanged. Tell the user clearly: "RTL works for chat, but Cowork features in the RTL copy are disabled until the patcher is updated for this Claude version."

This degraded mode is a viable production state for the target user — chat is the primary use case.

---

# Diagnostic commands cheat-sheet (run on the target machine)

```powershell
# Is MSIX Claude installed and what version?
Get-AppxPackage *Claude* | Format-List Name, Version, InstallLocation

# Is the RTL copy in place at the right path (must contain 'WindowsApps')?
Get-Item "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"

# Are both binaries signed by the same cert?
$svc = Get-AuthenticodeSignature "$((Get-AppxPackage *Claude*).InstallLocation)\app\resources\cowork-svc.exe"
$copy = Get-AuthenticodeSignature "$env:LOCALAPPDATA\ClaudeRTL\WindowsApps\app\claude.exe"
$svc.SignerCertificate.Thumbprint -eq $copy.SignerCertificate.Thumbprint   # must be True

# Is Cowork service alive?
Get-Service CoworkVMService | Format-List Name, Status

# Did Cowork accept a session after launching RTL copy?
Get-Content "C:\ProgramData\Claude\Logs\cowork-service.log" -Tail 20
# Look for: [Server] Created new VM session for ...

# What does the patcher log say?
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\patch.log" -Tail 50

# Is Node available?
node --version
npx --yes @electron/asar@4.2.0 --version
npx --yes @electron/fuses@2.1.1 --version

# Is the userData shared correctly?
Get-Content "$env:LOCALAPPDATA\ClaudeRTL\launch-rtl.cmd"
# Must include: set CLAUDE_RTL_USERDATA=C:\Users\<user>\AppData\Roaming\Claude
```

# When asking the user for input

- Don't ask "should I install?" if they pointed you at this folder — just install.
- DO ask before `-Restore` if they hit a problem mid-install — restore is destructive.
- If something's broken and unclear, capture both `patch.log` and `cowork-service.log` and report. Don't loop the patcher.
- If `-SkipCowork` is needed (cert hole shrunk), tell the user clearly that Cowork in the RTL copy will not authenticate, but original MSIX Claude is unaffected.

# Final notes

The reference implementation `patch-rtl.ps1` in this folder is the source of truth. If you suspect a discrepancy between this document and the script, **trust the script** — it's been tested. Update this document if you find one.

The patch was developed and tested against Claude Desktop **1.11847.5.0** on Windows 11. Cert hole at offset `0xC0B499`, size 856 bytes. If your `Get-AppxPackage *Claude*` reports a different version, the offset and size will differ — but the byte-search algorithm in step 4 finds them automatically by searching for the `"Anthropic, PBC"` ASCII anchor. Do NOT hardcode offsets.
