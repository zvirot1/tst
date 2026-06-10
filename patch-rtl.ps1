<#
.SYNOPSIS
    Claude Desktop RTL Patcher (Windows, copy-based, no scheduler)

.DESCRIPTION
    Builds an RTL-patched copy of Claude Desktop at %LOCALAPPDATA%\ClaudeRTL\
    without touching the original MSIX install (except for one file -- see below).

    Mirrors the MSIX app dir to a user-writable location, injects the RTL JS
    payload from shraga100/claude-desktop-rtl-patch into the copied app.asar,
    disables the Electron asar-integrity fuse on the copy, then swaps the
    Anthropic certificate inside cowork-svc.exe (the one MSIX file we modify)
    with a self-signed one and re-signs the copy's claude.exe so cowork-svc
    accepts it. Both apps then share the same CoworkVMService.

    No Scheduled Task / watcher: a "Rebuild Claude RTL" desktop shortcut is the
    only update mechanism. After every Claude MSIX update, click that shortcut.

.PARAMETER Auto
    Run Install-Patch directly without showing the menu (used by the rebuild shortcut).

.PARAMETER Restore
    Run Restore-Patch directly without showing the menu.

.NOTES
    The renderer + main-process injection payloads (RTL_INJECTION_CODE,
    MAIN_INJECTION_CODE) are reused verbatim from
    https://github.com/shraga100/claude-desktop-rtl-patch (patch.ps1, MIT).
    The cowork cert-swap pipeline is also adapted from that project.
#>
param(
    [switch]$Auto,
    [switch]$Restore,
    # Skip the cowork-svc.exe cert swap entirely. Use this when the cert hole
    # in cowork-svc.exe is too small for any self-signed cert (newer Claude
    # builds may shrink it). Result: RTL copy works for chat but Cowork features
    # in the copy won't authenticate; the original MSIX Claude is unaffected.
    [switch]$SkipCowork
)

# ---------------------------------------------------------------------------
# AUTO-ELEVATION
# ---------------------------------------------------------------------------
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Host "Requesting Administrator privileges..." -ForegroundColor Yellow
    $argList = @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
    if ($Auto)    { $argList += '-Auto' }
    if ($Restore) { $argList += '-Restore' }
    Start-Process -FilePath PowerShell.exe -Verb RunAs -ArgumentList $argList
    Exit
}

$ErrorActionPreference = "Stop"
Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# GLOBAL SETTINGS
# ---------------------------------------------------------------------------
$global:RtlRoot       = Join-Path $env:LOCALAPPDATA 'ClaudeRTL'
$global:RtlAppDir     = Join-Path $global:RtlRoot 'app'
$global:RtlBackupsDir = Join-Path $global:RtlRoot 'backups'
$global:RtlLogFile    = Join-Path $global:RtlRoot 'patch.log'
$global:TmpDir        = Join-Path ([System.IO.Path]::GetTempPath()) 'claude_rtl_copy_tmp'

# Pinned npm packages (same as upstream).
$script:AsarPackage  = '@electron/asar@4.2.0'
$script:FusesPackage = '@electron/fuses@2.1.1'
$script:MinNodeVersion = '22.12.0'

# Cert FriendlyName used by both Install (to add) and Restore (to remove).
$script:CertFriendlyName = 'Claude_RTL_SelfSigned'

# ---------------------------------------------------------------------------
# RTL INJECTION PAYLOADS
# Reused verbatim from shraga100/claude-desktop-rtl-patch (patch.ps1, MIT).
# Renderer payload + welcome banner (lines 76-472 upstream).
# ---------------------------------------------------------------------------
$RTL_INJECTION_CODE = @'
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

        // --- LOGICAL-MARGIN POSITION PRESERVATION ---
        //
        // Problem: many Tailwind layouts position user-message bubbles with
        // logical margins like `margin-inline-start: auto` (Tailwind `ms-auto`,
        // which renders as "stick to the END of the flex container"). When we
        // flip a descendant's `dir` to rtl, "end" maps from right to LEFT, so
        // bubbles that should hug the right edge slide to the left.
        //
        // Fix: walk UP from the dir-flipped element to ancestors that use
        // margin-inline-start/end:auto and translate those into PHYSICAL
        // margins (margin-left/right) once. The ancestor's positioning then
        // ignores direction entirely and stays where the original layout put
        // it. Marker attribute prevents re-running on subsequent passes.
        var POS_PRESERVED_FLAG = 'data-rtl-pos-fixed';
        // 6 was too shallow for Claude's bubble layout (the ms-auto container
        // sits ~10 levels above the text node). 12 covers what we've seen.
        var POS_PRESERVE_MAX_DEPTH = 12;

        function preserveLogicalPositioning(startEl) {
            var el = startEl;
            for (var depth = 0; el && depth < POS_PRESERVE_MAX_DEPTH; depth++, el = el.parentElement) {
                if (!el.style || el.hasAttribute(POS_PRESERVED_FLAG)) continue;
                var cs = window.getComputedStyle(el);
                if (!cs) continue;
                // Only act on auto-margins -- they're the layout signal we care about.
                // Numeric margin-inline values are usually fine because their physical
                // resolution stays consistent across direction changes.
                var msAuto = cs.marginInlineStart === 'auto';
                var meAuto = cs.marginInlineEnd === 'auto';
                if (!msAuto && !meAuto) continue;
                // Resolve to physical sides using the PARENT's direction (not our own,
                // since we're about to flip ours). The parent direction reflects the
                // page's intended layout.
                var parentDir = el.parentElement ?
                    window.getComputedStyle(el.parentElement).direction : 'ltr';
                var startPhysical = (parentDir === 'rtl') ? 'Right' : 'Left';
                var endPhysical   = (parentDir === 'rtl') ? 'Left'  : 'Right';
                if (msAuto) el.style['margin' + startPhysical] = 'auto';
                if (meAuto) el.style['margin' + endPhysical]   = 'auto';
                // Wipe the logical ones so they don't fight the physical override.
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

        // Global sweep for Tailwind logical-margin classes that move bubbles
        // to the wrong side once any descendant gets dir=rtl. We don't wait
        // for processText/processContainers to bubble up via
        // preserveLogicalPositioning -- we hit every ms-auto/me-auto host on
        // the page directly, once. ms-auto pins to LEFT (parent-LTR layout
        // wants the user message on the right end of an LTR row); me-auto
        // pins to RIGHT for the symmetric case.
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
                // ms-auto / ml-auto -> physical LEFT
                if (/(?:^|\s)m[sl]-auto(?:\s|$)/.test(classes)) {
                    el.style.marginLeft = 'auto';
                    el.style.marginInlineStart = '';
                }
                // me-auto / mr-auto -> physical RIGHT
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
                // Tailwind ms-auto / ml-auto are meant to push elements to the
                // RIGHT (end of LTR flex row) -- which is where Claude wants
                // the user message bubble. Once any descendant flips to dir=rtl
                // the logical "start" maps to right, so ms-auto pulls the bubble
                // LEFT instead. Lock these to physical LEFT so they always
                // resolve to the right edge regardless of descendant direction.
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
                        // New nodes likely include the just-added user/assistant
                        // bubble -- catch its ms-auto host before it visually
                        // pops to the wrong side.
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
'@

# Main-process snippet, two responsibilities:
# 1. Force Chromium UI direction to LTR (fixes title-bar / native preview window
#    placement on Hebrew/RTL OS locales).
# 2. When CLAUDE_RTL_INSTANCE=1 is set, neutralize Claude's single-instance lock
#    so the RTL copy can run side-by-side with the original MSIX install. Also
#    move userData to a separate directory so sessions/MCP/history don't clash.
#    Both gates check the env var, so an accidental injection into the original
#    install would still no-op (defense in depth).
$MAIN_INJECTION_CODE = @'
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

        // 2. RTL-copy-only behaviors. Gated on env var so the same patched asar
        //    can technically be deployed anywhere safely.
        if (process.env.CLAUDE_RTL_INSTANCE === '1' && app) {
            // Separate userData dir -- Electron uses this in the lock name on
            // some versions, AND it isolates sessions/cache/MCP state from the
            // original install (avoids two processes writing the same SQLite db).
            try {
                var path = require('path');
                var userDataDir = process.env.CLAUDE_RTL_USERDATA ||
                    path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ClaudeRTL', 'userdata');
                app.setPath('userData', userDataDir);
            } catch (e) { console.error('[Claude RTL] userData redirect failed', e); }

            // Hard bypass: Electron 41's single-instance lock is a per-app-name
            // mutex independent of userData. Wrap requestSingleInstanceLock so
            // it always reports success for the RTL copy. The original MSIX
            // Claude (no env var set) still acquires/loses the lock normally.
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
'@

# Tiny safety net injected at the top of index.js (the main bundle that actually
# *calls* requestSingleInstanceLock). The pre.js hook above already monkey-patches
# `app` -- since `app` is a singleton in Electron, the patch survives to index.js.
# This duplicate inside index.js is defense in depth in case the pre.js timing
# changes in a future Claude build. Identical guard, no DOM dependency.
$INDEX_GUARD_INJECTION_CODE = @'
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
'@

# ---------------------------------------------------------------------------
# LOGGING
# ---------------------------------------------------------------------------
function Write-LogToFile($level, $msg) {
    try {
        if (-not (Test-Path $global:RtlRoot)) {
            New-Item -ItemType Directory -Path $global:RtlRoot -Force | Out-Null
        }
        if ((Test-Path $global:RtlLogFile) -and (Get-Item $global:RtlLogFile).Length -gt 1MB) {
            Move-Item $global:RtlLogFile "$global:RtlLogFile.old" -Force
        }
        "$([DateTime]::Now.ToString('o'))  [$level] $msg" |
            Out-File -Append -FilePath $global:RtlLogFile -Encoding UTF8
    } catch {}
}
function Write-Log($msg)     { Write-Host "  [*] $msg" -ForegroundColor Cyan;    Write-LogToFile 'INFO' $msg }
function Write-Step($msg)    { Write-Host "`n> $msg" -ForegroundColor Magenta;   Write-LogToFile 'STEP' $msg }
function Write-Success($msg) { Write-Host "  [+] $msg" -ForegroundColor Green;   Write-LogToFile 'OK'   $msg }
function Write-Warn($msg)    { Write-Host "  [!] $msg" -ForegroundColor Yellow;  Write-LogToFile 'WARN' $msg }

# ---------------------------------------------------------------------------
# HELPERS (mostly adapted from upstream patch.ps1)
# ---------------------------------------------------------------------------

# Fast byte-search via ISO-8859-1 string indexing (upstream's approach).
function Find-Bytes([byte[]]$Haystack, [byte[]]$Needle, [int]$StartIndex = 0) {
    if ($null -eq $Needle -or $Needle.Length -eq 0 -or $null -eq $Haystack -or $Haystack.Length -lt $Needle.Length) { return -1 }
    if ($StartIndex -lt 0) { $StartIndex = 0 }
    if ($StartIndex -gt ($Haystack.Length - $Needle.Length)) { return -1 }
    $enc = [System.Text.Encoding]::GetEncoding(28591)
    $hayStr = $enc.GetString($Haystack)
    $needleStr = $enc.GetString($Needle)
    return $hayStr.IndexOf($needleStr, $StartIndex, [System.StringComparison]::Ordinal)
}

function Compute-AsarHash($AsarPath) {
    $fs = [System.IO.File]::OpenRead($AsarPath)
    $br = New-Object System.IO.BinaryReader($fs)
    $fs.Seek(12, [System.IO.SeekOrigin]::Begin) | Out-Null
    $jsonSize = $br.ReadUInt32()
    if ($jsonSize -le 0 -or $jsonSize -gt 10485760) {
        $fs.Close()
        throw "Abnormal ASAR header size: $jsonSize"
    }
    $jsonBytes = $br.ReadBytes($jsonSize)
    $fs.Close()
    $jsonStr = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($jsonStr))
    return [BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()
}

function Test-FileLock([string]$Path, [string]$Access = 'Write') {
    if (-not (Test-Path $Path)) { return $false }
    try {
        $fs = [System.IO.File]::Open($Path, 'Open', $Access, 'Read')
        $fs.Close()
        return $false
    } catch {
        return $true
    }
}

function Wait-FileUnlock([string]$Path, [int]$TimeoutSeconds = 20, [string]$Access = 'Write') {
    if (-not (Test-Path $Path)) { return }
    for ($w = 0; $w -lt $TimeoutSeconds; $w++) {
        if (-not (Test-FileLock $Path $Access)) { return }
        if ($w -eq 0) { Write-Log "Waiting for $(Split-Path $Path -Leaf) to unlock..." }
        Start-Sleep -Seconds 1
    }
    throw "File '$(Split-Path $Path -Leaf)' is still locked after ${TimeoutSeconds}s."
}

# Single-file ownership grant (NOT recursive over WindowsApps -- we only
# touch cowork-svc.exe inside MSIX, so we don't need /R on the whole tree).
function Take-FileOwnership($Path) {
    Write-Log "Taking ownership of $(Split-Path $Path -Leaf)..."
    cmd.exe /c "takeown /F `"$Path`" >nul 2>&1"
    cmd.exe /c "icacls `"$Path`" /grant `"*S-1-5-32-544:F`" /Q >nul 2>&1"
}

function Find-ClaudeMsixDir {
    $pkg = Get-AppxPackage | Where-Object { $_.Name -like '*Claude*' -and $_.InstallLocation -like '*WindowsApps*' } | Select-Object -First 1
    if ($pkg) { return $pkg.InstallLocation }

    $squirrelPath = Join-Path $env:LOCALAPPDATA "AnthropicClaude"
    if (Test-Path $squirrelPath) {
        Write-Warn "Legacy (Squirrel) Claude detected at: $squirrelPath"
        Write-Warn "This patch only supports the MSIX install. Reinstall from https://claude.ai/download"
        return $null
    }
    return $null
}

function Get-ClaudeMsixVersion {
    param([string]$InstallPath)
    if (-not $InstallPath) { return $null }
    $leaf = Split-Path -Leaf $InstallPath
    if ($leaf -match '^Claude_(\d+(?:\.\d+){1,3})_') {
        try { return [Version]$matches[1] } catch { return $null }
    }
    return $null
}

# Probe + install npx pinned packages. Mirrors upstream's logic but condensed.
function Assert-NpxAvailable {
    Try {
        $cmdOut = cmd.exe /c "npx --yes $($script:AsarPackage) --version 2>&1"
        if ($LASTEXITCODE -eq 0) { return }
    } Catch {}

    # Fallback: try system Node (UAC-elevated PATH may have lost a per-user shim).
    $sysNodeDir = Join-Path $env:ProgramFiles 'nodejs'
    if ((Test-Path (Join-Path $sysNodeDir 'node.exe')) -and (Test-Path (Join-Path $sysNodeDir 'npx.cmd'))) {
        $env:PATH = "$sysNodeDir;$env:PATH"
        $cmdOut = cmd.exe /c "npx --yes $($script:AsarPackage) --version 2>&1"
        if ($LASTEXITCODE -eq 0) { return }
    }

    # Diagnose whether Node is missing or just too old.
    $nodeVer = $null
    try {
        $raw = (cmd.exe /c "node --version 2>&1" | Out-String).Trim()
        if ($raw -match 'v?(\d+)\.(\d+)\.(\d+)') {
            $nodeVer = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
        }
    } catch {}

    $minVer = [version]$script:MinNodeVersion
    if ($nodeVer -and $nodeVer -lt $minVer) {
        throw "Node $nodeVer is too old. Need >= $($script:MinNodeVersion). Upgrade from https://nodejs.org and retry."
    } elseif (-not $nodeVer) {
        throw "Node.js (npx) is required. Install Node >= $($script:MinNodeVersion) from https://nodejs.org and retry."
    } else {
        throw "npx could not run $($script:AsarPackage) on Node $nodeVer. See $global:RtlLogFile."
    }
}

# ---------------------------------------------------------------------------
# FUSE FLIP (adapted from upstream)
# ---------------------------------------------------------------------------
$script:AsarFuseDisabledPattern = 'EnableEmbeddedAsarIntegrityValidation[^\r\n]*Disabled'

function Get-FuseProbeOutput([string]$ExePath) {
    $raw = cmd.exe /c "npx --yes $($script:FusesPackage) read --app `"$ExePath`" 2>&1"
    return ($raw | Out-String)
}

function Test-AsarIntegrityFuseDisabled([string]$ProbeOutput) {
    return [bool]($ProbeOutput -match $script:AsarFuseDisabledPattern)
}

function Invoke-FuseFlip([string]$ExePath) {
    if (-not (Test-Path -LiteralPath $ExePath)) {
        throw "Invoke-FuseFlip: target not found at $ExePath"
    }
    $prevWarn = $env:NODE_NO_WARNINGS
    $env:NODE_NO_WARNINGS = '1'
    try {
        $before = Get-FuseProbeOutput $ExePath
        if (Test-AsarIntegrityFuseDisabled $before) {
            Write-Success "ASAR integrity fuse already off."
            return
        }
        Write-Log "Disabling EnableEmbeddedAsarIntegrityValidation on copy's claude.exe..."
        $raw = cmd.exe /c "npx --yes $($script:FusesPackage) write --app `"$ExePath`" EnableEmbeddedAsarIntegrityValidation=off 2>&1"
        if ($LASTEXITCODE -ne 0) {
            throw "fuses write failed with exit code $LASTEXITCODE. Output: $raw"
        }
        $after = Get-FuseProbeOutput $ExePath
        if (-not (Test-AsarIntegrityFuseDisabled $after)) {
            throw "fuses write reported success but re-probe still shows fuse Enabled."
        }
        Write-Success "Fuse disabled and confirmed."
    }
    finally {
        $env:NODE_NO_WARNINGS = $prevWarn
    }
}

# ---------------------------------------------------------------------------
# PROCESS / SERVICE CONTROL
# ---------------------------------------------------------------------------

# Stop only the RTL copy's claude.exe (NOT the original MSIX one).
function Stop-RtlClaude {
    $rtlExe = Join-Path $global:RtlAppDir 'claude.exe'
    if (-not (Test-Path $rtlExe)) { return }
    $procs = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and ($_.Path -ieq $rtlExe)
    }
    if ($procs) {
        Write-Log "Stopping running RTL copy ($($procs.Count) process(es))..."
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

# Stops CoworkVMService + all cowork-svc.exe processes (system-wide -- there's
# only one). Returns the previously running state so Start-CoworkService can
# restore it.
function Stop-CoworkService {
    Write-Step "Stopping CoworkVMService (this affects original Claude's Cowork until restored)..."
    $svc = Get-Service -Name CoworkVMService -ErrorAction SilentlyContinue
    $wasRunning = $false
    if ($svc) {
        $wasRunning = ($svc.Status -eq 'Running')
        if ($wasRunning) {
            Stop-Service -Name CoworkVMService -Force -ErrorAction SilentlyContinue
            for ($w = 0; $w -lt 10; $w++) {
                if ((Get-Service CoworkVMService -ErrorAction SilentlyContinue).Status -eq 'Stopped') { break }
                Start-Sleep -Seconds 1
            }
        }
    }
    Get-Process -Name cowork-svc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Success "CoworkVMService stopped."
    return $wasRunning
}

function Start-CoworkService {
    Write-Step "Starting CoworkVMService..."
    Try {
        Start-Service -Name CoworkVMService -ErrorAction Stop
        for ($w = 0; $w -lt 15; $w++) {
            if ((Get-Service CoworkVMService).Status -eq 'Running') {
                Write-Success "CoworkVMService running."
                return
            }
            Start-Sleep -Seconds 1
        }
        Write-Warn "CoworkVMService did not reach Running state within 15s."
    } Catch {
        Write-Warn "Could not start CoworkVMService: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# STEP 1: MIRROR MSIX -> %LOCALAPPDATA%\ClaudeRTL\app
# ---------------------------------------------------------------------------
function Mirror-MsixApp {
    param([Parameter(Mandatory)][string]$MsixDir)

    Write-Step "Mirroring MSIX app dir to $global:RtlAppDir..."
    $sourceApp = Join-Path $MsixDir 'app'
    if (-not (Test-Path $sourceApp)) { throw "Source app dir not found: $sourceApp" }

    if (-not (Test-Path $global:RtlRoot))    { New-Item -ItemType Directory -Path $global:RtlRoot -Force | Out-Null }
    if (-not (Test-Path $global:RtlBackupsDir)) { New-Item -ItemType Directory -Path $global:RtlBackupsDir -Force | Out-Null }

    # robocopy /MIR makes re-runs idempotent. /COPY:DAT (no security) leaves the
    # WindowsApps DACLs behind -- we want plain user-writable files in %LOCALAPPDATA%.
    # /XJ skips junctions to avoid cycles. /R:2 /W:1 keeps retries fast.
    $rcArgs = @($sourceApp, $global:RtlAppDir, '/MIR', '/COPY:DAT', '/XJ', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy.exe @rcArgs | Out-Null
    # robocopy exit codes: 0-7 are "success" (8+ is failure).
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with exit code $LASTEXITCODE."
    }
    $copyExe = Join-Path $global:RtlAppDir 'claude.exe'
    if (-not (Test-Path $copyExe)) { throw "Mirror finished but $copyExe not found." }
    $sizeMB = [math]::Round((Get-Item $copyExe).Length / 1MB, 1)
    Write-Success "Mirrored. Copy claude.exe = $sizeMB MB."
}

# ---------------------------------------------------------------------------
# STEP 2: ASAR INJECT (operates ON THE COPY)
# ---------------------------------------------------------------------------
function Patch-CopyAsar {
    Write-Step "Injecting RTL JS into copy's app.asar..."
    $copyAsar = Join-Path $global:RtlAppDir 'resources\app.asar'
    if (-not (Test-Path $copyAsar)) { throw "Copy's app.asar not found at $copyAsar" }

    if (Test-Path $global:TmpDir) { Remove-Item $global:TmpDir -Recurse -Force }

    Write-Log "Extracting copy's app.asar..."
    cmd.exe /c "npx --yes $($script:AsarPackage) extract `"$copyAsar`" `"$global:TmpDir`""
    if ($LASTEXITCODE -ne 0) { throw "asar extract failed (exit $LASTEXITCODE)." }

    $buildDir = Join-Path $global:TmpDir '.vite\build'
    if (-not (Test-Path $buildDir)) {
        throw ".vite/build/ not found in extracted asar -- Claude internal structure may have changed."
    }

    # Resolve main entry from package.json "main"; fall back to known filename.
    $mainEntryFile = 'index.pre.js'
    $pkgJsonPath = Join-Path $global:TmpDir 'package.json'
    if (Test-Path $pkgJsonPath) {
        try {
            $pkgMain = (Get-Content $pkgJsonPath -Raw | ConvertFrom-Json).main
            if ($pkgMain) { $mainEntryFile = Split-Path $pkgMain -Leaf }
        } catch { Write-Log "package.json parse failed; defaulting main to $mainEntryFile." }
    }
    Write-Log "Main-process entry: $mainEntryFile"

    # Files with NO DOM access. Get only the index-guard (single-instance
    # bypass + userData redirect via the pre.js hook), never the renderer payload.
    $mainBundleFile = 'index.js'
    # Workers / MCP hosts: skip entirely. They don't load the main app and the
    # single-instance check doesn't run there.
    $skipEntirely = @(
        'directMcpHost.js',
        'nodeHost.js',
        'shellPathWorker.js',
        'transcriptSearchWorker.js'
    )

    $jsFiles = Get-ChildItem -Path $buildDir -Filter '*.js' -Recurse
    $injected = 0
    $mainInjected = 0
    $guardInjected = 0
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false

    foreach ($file in $jsFiles) {
        if ($skipEntirely -contains $file.Name) {
            Write-Log "Skipped non-renderer worker: $($file.Name)"
            continue
        }
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)

        if ($file.Name -eq $mainEntryFile) {
            if ($content -match 'CLAUDE RTL MAIN PATCH START') { continue }
            $strictRe = '^\s*("use strict"|''use strict'')\s*;'
            if ($content -match $strictRe) {
                $prologue = $matches[0]
                $newContent = $prologue + "`n" + $MAIN_INJECTION_CODE + "`n" + $content.Substring($prologue.Length)
            } else {
                $newContent = $MAIN_INJECTION_CODE + "`n" + $content
            }
            [System.IO.File]::WriteAllText($file.FullName, $newContent, $utf8NoBom)

            cmd.exe /c "node --check `"$($file.FullName)`""
            if ($LASTEXITCODE -ne 0) {
                throw "node --check failed on patched main entry '$($file.Name)'. Refusing to repack."
            }
            $mainInjected++
            Write-Log "Injected MAIN switch into: $($file.Name)"
            continue
        }

        if ($file.Name -eq $mainBundleFile) {
            # Main bundle: already-injected guard? skip. Otherwise prepend the guard
            # only -- never the DOM payload (no document in this bundle's context).
            if ($content -match 'CLAUDE RTL INDEX GUARD START') { continue }
            $strictRe = '^\s*("use strict"|''use strict'')\s*;'
            if ($content -match $strictRe) {
                $prologue = $matches[0]
                $newContent = $prologue + "`n" + $INDEX_GUARD_INJECTION_CODE + "`n" + $content.Substring($prologue.Length)
            } else {
                $newContent = $INDEX_GUARD_INJECTION_CODE + "`n" + $content
            }
            [System.IO.File]::WriteAllText($file.FullName, $newContent, $utf8NoBom)

            cmd.exe /c "node --check `"$($file.FullName)`""
            if ($LASTEXITCODE -ne 0) {
                throw "node --check failed on patched index.js. Refusing to repack."
            }
            $guardInjected++
            Write-Log "Injected INDEX guard into: $($file.Name)"
            continue
        }

        if ($content -match 'CLAUDE RTL PATCH START') { continue }
        $newContent = $RTL_INJECTION_CODE + "`n" + $content
        [System.IO.File]::WriteAllText($file.FullName, $newContent, $utf8NoBom)
        $injected++
        Write-Log "Injected RTL into: $($file.Name)"
    }

    if ($mainInjected -eq 0)  { Write-Warn "Main-process entry '$mainEntryFile' not found / already patched." }
    if ($guardInjected -eq 0) { Write-Warn "Index bundle '$mainBundleFile' not found / already patched." }
    if ($injected -eq 0)      { Write-Warn "No renderer files injected (already patched?)." }
    else                      { Write-Success "Injected: RTL=$injected, main switch=$mainInjected, index guard=$guardInjected." }

    $newAsar = "$copyAsar.new"
    Write-Log "Repacking app.asar..."
    cmd.exe /c "npx --yes $($script:AsarPackage) pack `"$global:TmpDir`" `"$newAsar`""
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $newAsar) { Remove-Item $newAsar -Force -ErrorAction SilentlyContinue }
        throw "asar pack failed (exit $LASTEXITCODE)."
    }
    Move-Item -Path $newAsar -Destination $copyAsar -Force
    Remove-Item $global:TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Success "Repacked copy's app.asar."
}

# ---------------------------------------------------------------------------
# STEP 3: COWORK CERT SWAP
# Modifies MSIX cowork-svc.exe (the only file we touch in MSIX). Adapted from
# upstream's Phase 2 & 3 logic.
# ---------------------------------------------------------------------------
function Patch-CoworkCert {
    param([Parameter(Mandatory)][string]$MsixDir)

    Write-Step "Swapping Anthropic cert in MSIX cowork-svc.exe..."
    $coworkSvc = Join-Path $MsixDir 'app\resources\cowork-svc.exe'
    if (-not (Test-Path $coworkSvc)) { throw "cowork-svc.exe not found at $coworkSvc" }

    Take-FileOwnership $coworkSvc

    # Backup once -- on re-runs, MSIX update may have already restored the
    # original, so we only back up if no backup exists OR the current file
    # appears to be Anthropic-signed (i.e. fresh from MSIX).
    $bakPath = Join-Path $global:RtlBackupsDir 'cowork-svc.exe.bak'
    if (-not (Test-Path $bakPath)) {
        Copy-Item -LiteralPath $coworkSvc -Destination $bakPath -Force
        Write-Success "Backed up cowork-svc.exe to $bakPath"
    } else {
        # If the current MSIX file has Anthropic's signature, refresh the backup
        # (so we don't end up with our self-signed version as the "original").
        try {
            $sig = Get-AuthenticodeSignature -FilePath $coworkSvc
            if ($sig -and $sig.SignerCertificate -and ($sig.SignerCertificate.Subject -match 'Anthropic')) {
                Copy-Item -LiteralPath $coworkSvc -Destination $bakPath -Force
                Write-Log "Refreshed backup from a clean MSIX cowork-svc.exe."
            }
        } catch {}
    }

    # Read the MSIX cowork-svc.exe, find the embedded Anthropic cert.
    $svcBytes = [System.IO.File]::ReadAllBytes($coworkSvc)
    $anchorBytes = [System.Text.Encoding]::ASCII.GetBytes('Anthropic, PBC')

    $startPos = -1
    $oldCertSize = 0
    $offset = 0
    while ($true) {
        $anchorPos = Find-Bytes -Haystack $svcBytes -Needle $anchorBytes -StartIndex $offset
        if ($anchorPos -eq -1) { break }
        $limit = [Math]::Max(0, $anchorPos - 2000)
        for ($i = $anchorPos; $i -ge $limit; $i--) {
            if ($svcBytes[$i] -eq 0x30 -and $svcBytes[$i+1] -eq 0x82) {
                $totalSize = 4 + (([int]$svcBytes[$i+2] -shl 8) -bor [int]$svcBytes[$i+3])
                if ($totalSize -gt 500 -and $totalSize -lt 4000 -and $i -lt $anchorPos -and ($i + $totalSize) -gt $anchorPos) {
                    $startPos = $i
                    $oldCertSize = $totalSize
                    break
                }
            }
        }
        if ($startPos -ne -1) { break }
        $offset = $anchorPos + 1
    }

    if ($startPos -eq -1) {
        throw "Anthropic cert pattern not found in cowork-svc.exe."
    }
    Write-Log "Cert hole at offset 0x$([Convert]::ToString($startPos, 16)) (size: $oldCertSize bytes)."

    # Generate a self-signed cert that fits in the hole.
    #
    # Subject choice: upstream patch.ps1 clones Anthropic's full Subject DN to
    # blend in -- but that DN is ~300 bytes encoded (CN, O, L, S, C, SERIAL,
    # OID.2.5.4.15, OID.1.3.6.1.4.1.311.60.2.1.2/3 etc.), and newer Claude
    # builds shrunk the cert hole to ~856 bytes. Even a 1024-bit RSA cert with
    # that DN comes out 875 bytes. We use a SHORT CN-only subject so the cert
    # fits regardless of key algorithm. cowork-svc verifies the SIGNATURE, not
    # the Subject text, so a different DN doesn't break trust.
    $certSubject = 'CN=Claude-RTL-Patcher'
    Write-Log "Self-signed subject: $certSubject (short DN to fit smaller holes)"

    $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
    $rootStore.Open('ReadWrite')

    $cert = $null
    $newCertBytes = $null
    # Algorithm choice ladder: prefer larger keys (Authenticode warns on small
    # ones), fall through to ECDSA P-256 (~340 bytes -- guaranteed to fit any
    # observed hole) if the hole is too small for RSA. Each rung re-rolls a few
    # times because cert size jitters by ~5 bytes between runs (serial number,
    # validity-period encoding).
    $algoLadder = @(
        @{ Name='RSA-2048';  Args=@{ KeyAlgorithm='RSA';   KeyLength=2048 } },
        @{ Name='RSA-1024';  Args=@{ KeyAlgorithm='RSA';   KeyLength=1024 } },
        @{ Name='ECDSA-P256';Args=@{ KeyAlgorithm='ECDSA_nistP256' } }
    )
    $perRungAttempts = 5
    foreach ($rung in $algoLadder) {
        Write-Log "Trying $($rung.Name) cert (hole = $oldCertSize bytes)..."
        # PowerShell splatting: copy hashtable into a local variable so @ binds
        # the named params correctly. @($rung.Args) is array-cast (wrong);
        # @rungArgs is splat (right).
        $rungArgs = $rung.Args
        for ($attempt = 1; $attempt -le $perRungAttempts; $attempt++) {
            $cert = New-SelfSignedCertificate -Subject $certSubject -Type CodeSigningCert `
                -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName $script:CertFriendlyName `
                @rungArgs
            $newCertBytes = $cert.RawData
            if ($newCertBytes.Length -le $oldCertSize) {
                $rootStore.Add($cert)
                Write-Success "Cert fits: $($rung.Name), $($newCertBytes.Length) of $oldCertSize bytes."
                break
            } else {
                Write-Log "  attempt ${attempt}: $($newCertBytes.Length) > $oldCertSize"
                Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Thumbprint -eq $cert.Thumbprint } |
                    Remove-Item -ErrorAction SilentlyContinue
                $cert = $null
            }
        }
        if ($cert) { break }
    }
    $rootStore.Close()
    if (-not $cert) {
        throw "Cert hole too small ($oldCertSize bytes) even for ECDSA-P256. The cowork-svc binary format may have changed substantially. Re-run with -SkipCowork to install RTL only (chat works, Cowork features won't)."
    }

    # Pad-and-overwrite the cert hole.
    $padded = New-Object byte[] $oldCertSize
    [Array]::Copy($newCertBytes, 0, $padded, 0, $newCertBytes.Length)
    [Array]::Copy($padded, 0, $svcBytes, $startPos, $oldCertSize)
    [System.IO.File]::WriteAllBytes($coworkSvc, $svcBytes)
    Write-Success "Embedded cert swapped in cowork-svc.exe."

    # Re-sign cowork-svc.exe with the new self-signed cert.
    Wait-FileUnlock $coworkSvc
    $sr = Set-AuthenticodeSignature -FilePath $coworkSvc -Certificate $cert -HashAlgorithm SHA256
    if ($sr.Status -ne 'Valid') { throw "Re-sign cowork-svc.exe failed: $($sr.Status)" }
    Write-Success "cowork-svc.exe re-signed."

    # Re-sign the COPY's claude.exe with the SAME cert. cowork-svc verifies its
    # caller against the embedded cert it now trusts -- so the copy's claude.exe
    # must present the matching signature.
    $copyExe = Join-Path $global:RtlAppDir 'claude.exe'
    Wait-FileUnlock $copyExe
    $sr2 = Set-AuthenticodeSignature -FilePath $copyExe -Certificate $cert -HashAlgorithm SHA256
    if ($sr2.Status -ne 'Valid') { throw "Re-sign copy claude.exe failed: $($sr2.Status)" }
    Write-Success "Copy's claude.exe re-signed with same cert."

    # Wipe private key. Public cert remains in Root for verification; without
    # the private key, an attacker who later gains admin can't sign new binaries.
    $myStore = $null
    Try {
        $thumb = $cert.Thumbprint
        $myStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
        $myStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $found = $myStore.Certificates | Where-Object { $_.Thumbprint -eq $thumb }
        if ($found -and $found.HasPrivateKey) {
            Try {
                $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($found)
                if ($rsa -is [System.Security.Cryptography.RSACng]) {
                    $rsa.Key.Delete()
                } elseif ($rsa -is [System.Security.Cryptography.RSACryptoServiceProvider]) {
                    $rsa.PersistKeyInCsp = $false
                    $rsa.Clear()
                }
            } Catch {
                Write-Warn "Could not delete CSP/CNG key material: $($_.Exception.Message)"
            }
            $myStore.Remove($found)
            Write-Success "Private key wiped (public cert retained in Root)."
        }
    } Catch {
        Write-Warn "Private-key wipe failed: $($_.Exception.Message)"
    } Finally {
        if ($myStore) { $myStore.Close() }
    }
}

# ---------------------------------------------------------------------------
# STEP 4: DESKTOP SHORTCUTS
# ---------------------------------------------------------------------------
function Create-Shortcuts {
    Write-Step "Creating desktop shortcuts..."
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $copyExe = Join-Path $global:RtlAppDir 'claude.exe'

    # Launcher .cmd: a Windows shortcut can't set env vars on the target's
    # process, but a tiny .cmd wrapper can. Without CLAUDE_RTL_INSTANCE=1 the
    # injected guards no-op, so the env var is the actual side-by-side switch.
    $launcherCmd = Join-Path $global:RtlRoot 'launch-rtl.cmd'
    $userDataDir = Join-Path $global:RtlRoot 'userdata'
    $launcherBody = @"
@echo off
REM Set env so the asar-injected guards activate the bypass + userData redirect.
set CLAUDE_RTL_INSTANCE=1
set CLAUDE_RTL_USERDATA=$userDataDir
start "" "$copyExe" %*
"@
    [System.IO.File]::WriteAllText($launcherCmd, $launcherBody, [System.Text.UTF8Encoding]::new($false))
    Write-Log "Wrote launcher: $launcherCmd"

    # 1) "Claude RTL" -- runs the launcher .cmd. Hidden console via WScript.Shell
    #    won't work for .cmd directly, so wrap in conhost-suppressed shortcut:
    #    cmd /C "<launcher>" with WindowStyle = Minimized.
    $launcherLnk = Join-Path $desktop 'Claude RTL.lnk'
    $sl = $shell.CreateShortcut($launcherLnk)
    $sl.TargetPath = $env:ComSpec
    $sl.Arguments = "/C `"$launcherCmd`""
    $sl.WorkingDirectory = $global:RtlAppDir
    $sl.WindowStyle = 7  # Minimized -- the brief cmd flash is visible but starts minimized
    $sl.Description = 'Claude Desktop with Hebrew/Arabic RTL support (side-by-side with original)'
    if (Test-Path $copyExe) { $sl.IconLocation = "$copyExe,0" } else { $sl.IconLocation = 'cmd.exe,0' }
    $sl.Save()
    Write-Success "Created: $launcherLnk"

    # 2) "Rebuild Claude RTL" -- re-runs this script in -Auto mode.
    $rebuild = Join-Path $desktop 'Rebuild Claude RTL.lnk'
    $sr = $shell.CreateShortcut($rebuild)
    $sr.TargetPath = 'powershell.exe'
    $sr.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Auto"
    $sr.Description = 'Rebuild the Claude RTL copy after a Claude Desktop update'
    if (Test-Path $copyExe) { $sr.IconLocation = "$copyExe,0" } else { $sr.IconLocation = 'powershell.exe,0' }
    $sr.Save()
    Write-Success "Created: $rebuild"
}

function Remove-Shortcuts {
    $desktop = [Environment]::GetFolderPath('Desktop')
    foreach ($name in @('Claude RTL.lnk', 'Rebuild Claude RTL.lnk')) {
        $p = Join-Path $desktop $name
        if (Test-Path $p) {
            Remove-Item $p -Force -ErrorAction SilentlyContinue
            Write-Log "Removed shortcut: $name"
        }
    }
}

# ---------------------------------------------------------------------------
# INSTALL / RESTORE
# ---------------------------------------------------------------------------
function Install-Patch {
    Write-Host "`n=======================================================" -ForegroundColor Cyan
    Write-Host "  CLAUDE RTL (copy-based) -- INSTALL" -ForegroundColor Cyan
    Write-Host "=======================================================`n" -ForegroundColor Cyan

    $msixDir = Find-ClaudeMsixDir
    if (-not $msixDir) { throw "Claude MSIX install not found. Install from https://claude.ai/download." }
    $msixVer = Get-ClaudeMsixVersion -InstallPath $msixDir
    Write-Success "Found Claude MSIX v$msixVer at $msixDir"

    Assert-NpxAvailable

    # Stop the RTL copy if it's running (do NOT touch original Claude).
    Stop-RtlClaude

    # Stop the cowork service before any binary modification.
    $svcWasRunning = Stop-CoworkService

    Try {
        # Step 1: mirror MSIX -> %LOCALAPPDATA%\ClaudeRTL\app
        Mirror-MsixApp -MsixDir $msixDir

        # Step 2: inject RTL into the copy's app.asar
        Patch-CopyAsar

        # Step 3: disable asar fuse on the copy (Mac-style; no hash patching)
        $copyExe = Join-Path $global:RtlAppDir 'claude.exe'
        Invoke-FuseFlip -ExePath $copyExe

        # Step 4: cowork cert swap (touches MSIX cowork-svc.exe + signs copy claude.exe).
        # When -SkipCowork: don't touch MSIX, just self-sign the copy with a
        # throwaway cert so the fuse-modified asar can run (Authenticode of the
        # copy must be internally consistent for Windows to launch it).
        if ($SkipCowork) {
            Write-Step "Skipping cowork cert swap (-SkipCowork). Self-signing copy claude.exe only..."
            $copyExe2 = Join-Path $global:RtlAppDir 'claude.exe'
            $cert = New-SelfSignedCertificate -Subject 'CN=Claude-RTL-Local' -Type CodeSigningCert `
                -CertStoreLocation 'Cert:\LocalMachine\My' -FriendlyName $script:CertFriendlyName `
                -KeyAlgorithm RSA -KeyLength 2048
            $rootStoreLocal = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
            $rootStoreLocal.Open('ReadWrite'); $rootStoreLocal.Add($cert); $rootStoreLocal.Close()
            Wait-FileUnlock $copyExe2
            $sr = Set-AuthenticodeSignature -FilePath $copyExe2 -Certificate $cert -HashAlgorithm SHA256
            if ($sr.Status -ne 'Valid') { throw "Re-sign copy claude.exe failed: $($sr.Status)" }
            # Wipe private key (same logic as in Patch-CoworkCert).
            $myStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
            $myStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $found = $myStore.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
            if ($found -and $found.HasPrivateKey) {
                try {
                    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($found)
                    if ($rsa -is [System.Security.Cryptography.RSACng]) { $rsa.Key.Delete() }
                } catch {}
                $myStore.Remove($found)
            }
            $myStore.Close()
            Write-Success "Copy claude.exe self-signed (Cowork in copy will not work)."
        } else {
            Patch-CoworkCert -MsixDir $msixDir
        }

        # Step 5: shortcuts
        Create-Shortcuts

        # Step 6: record state for the rebuild shortcut to surface on diagnostics.
        $statePath = Join-Path $global:RtlRoot 'state.json'
        @{
            installedAt = (Get-Date).ToUniversalTime().ToString('o')
            msixVersion = $msixVer.ToString()
            msixPath    = $msixDir
            copyPath    = $global:RtlAppDir
        } | ConvertTo-Json | Set-Content $statePath -Encoding UTF8

        if ($svcWasRunning) { Start-CoworkService }

        Write-Host "`n=======================================================" -ForegroundColor Green
        Write-Host "  RTL PATCH INSTALLED" -ForegroundColor Green
        Write-Host "=======================================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Launch RTL copy:     " -NoNewline; Write-Host "Desktop > 'Claude RTL'" -ForegroundColor Cyan
        Write-Host "  After Claude update: " -NoNewline; Write-Host "Desktop > 'Rebuild Claude RTL'" -ForegroundColor Cyan
        Write-Host "  Restore original:    " -NoNewline; Write-Host "$PSCommandPath -Restore" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Side-by-side:" -ForegroundColor Cyan
        Write-Host "    The original MSIX Claude (Start menu) and the RTL copy (Desktop)" -ForegroundColor White
        Write-Host "    can run AT THE SAME TIME. They have separate userData dirs:" -ForegroundColor White
        Write-Host "      Original: %APPDATA%\Claude" -ForegroundColor DarkGray
        Write-Host "      RTL copy: $global:RtlRoot\userdata" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Cowork status:" -ForegroundColor Yellow
        if ($SkipCowork) {
            Write-Host "    -SkipCowork was used. The MSIX cowork-svc.exe is UNCHANGED:" -ForegroundColor White
            Write-Host "      - Original Claude: Cowork works normally." -ForegroundColor White
            Write-Host "      - RTL copy: Cowork features won't authenticate (chat is fine)." -ForegroundColor White
        } else {
            Write-Host "    Cowork features in the ORIGINAL MSIX Claude are now broken until" -ForegroundColor White
            Write-Host "    you run -Restore (or the next Claude MSIX update replaces" -ForegroundColor White
            Write-Host "    cowork-svc.exe). Chat itself still works in both apps." -ForegroundColor White
        }
        Write-Host ""
    } Catch {
        $msg = $_.Exception.Message
        Write-Host "`n[X] INSTALL FAILED: $msg" -ForegroundColor Red
        # Best-effort: bring cowork back up so we don't leave the system worse than we found it.
        if ($svcWasRunning) {
            Write-Warn "Attempting to restart CoworkVMService after failure..."
            Start-CoworkService
        }
        throw
    }
}

function Restore-Patch {
    Write-Host "`n=======================================================" -ForegroundColor Cyan
    Write-Host "  CLAUDE RTL (copy-based) -- RESTORE" -ForegroundColor Cyan
    Write-Host "=======================================================`n" -ForegroundColor Cyan

    Stop-RtlClaude
    $svcWasRunning = Stop-CoworkService

    # Restore cowork-svc.exe from backup (if our backup exists and MSIX still has
    # the patched version). MSIX may have already auto-reverted on a Claude update.
    $msixDir = Find-ClaudeMsixDir
    if ($msixDir) {
        $coworkSvc = Join-Path $msixDir 'app\resources\cowork-svc.exe'
        $bak = Join-Path $global:RtlBackupsDir 'cowork-svc.exe.bak'
        if ((Test-Path $coworkSvc) -and (Test-Path $bak)) {
            try {
                $sig = Get-AuthenticodeSignature -FilePath $coworkSvc
                $isOurs = ($sig -and $sig.SignerCertificate -and ($sig.SignerCertificate.Subject -notmatch 'Anthropic'))
            } catch { $isOurs = $true }

            if ($isOurs) {
                Take-FileOwnership $coworkSvc
                Wait-FileUnlock $coworkSvc
                Copy-Item -LiteralPath $bak -Destination $coworkSvc -Force
                Write-Success "Restored cowork-svc.exe from backup."
            } else {
                Write-Log "MSIX cowork-svc.exe already has Anthropic's signature; no restore needed."
            }
        }
    }

    # Remove cert from Root store.
    Try {
        $removed = 0
        Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.FriendlyName -eq $script:CertFriendlyName } | ForEach-Object {
            Remove-Item -LiteralPath $_.PSPath -Force -ErrorAction SilentlyContinue
            $removed++
        }
        Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.FriendlyName -eq $script:CertFriendlyName } | ForEach-Object {
            Remove-Item -LiteralPath $_.PSPath -Force -ErrorAction SilentlyContinue
        }
        if ($removed -gt 0) { Write-Success "Removed $removed self-signed cert(s) from Root." }
    } Catch {
        Write-Warn "Cert cleanup failed: $($_.Exception.Message)"
    }

    # Remove copy + shortcuts + launcher.
    Remove-Shortcuts
    if (Test-Path $global:RtlAppDir) {
        Remove-Item $global:RtlAppDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Success "Removed $global:RtlAppDir"
    }
    $launcherCmd = Join-Path $global:RtlRoot 'launch-rtl.cmd'
    if (Test-Path $launcherCmd) { Remove-Item $launcherCmd -Force -ErrorAction SilentlyContinue }

    # userData: ASK before deleting -- it contains the user's RTL-app sessions / MCP / history.
    $userData = Join-Path $global:RtlRoot 'userdata'
    if (Test-Path $userData) {
        Write-Warn "userData dir exists at $userData (RTL copy's sessions/history)."
        Write-Warn "Restore leaves it in place. Delete manually if you want a clean wipe."
    }

    # Keep backups + log so the user can audit; remove only on a clean uninstall.
    $statePath = Join-Path $global:RtlRoot 'state.json'
    if (Test-Path $statePath) { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }

    if ($svcWasRunning) { Start-CoworkService }

    Write-Host "`n[V] RESTORE COMPLETE." -ForegroundColor Green
    Write-Host "    Original MSIX Claude is fully functional again." -ForegroundColor Green
    Write-Host "    Backups + log retained at: $global:RtlRoot" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# MENU
# ---------------------------------------------------------------------------
function Show-Menu {
    Clear-Host
    Write-Host "+--------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "|  Claude RTL Patcher (Windows, copy-based)        |" -ForegroundColor Cyan
    Write-Host "+--------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "`nSelect an action:"
    Write-Host "  1. Install (build copy at %LOCALAPPDATA%\ClaudeRTL)" -ForegroundColor White
    Write-Host "  2. Rebuild (after a Claude Desktop update)" -ForegroundColor White
    Write-Host "  3. Restore original (remove copy, restore cowork-svc.exe)" -ForegroundColor White
    Write-Host "  4. Exit" -ForegroundColor White
    $choice = Read-Host "`nEnter your choice (1-4)"
    switch ($choice) {
        '1' {
            try { Install-Patch } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
            Write-Host "`nPress Enter to exit..."; $null = Read-Host
        }
        '2' {
            try { Install-Patch } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
            Write-Host "`nPress Enter to exit..."; $null = Read-Host
        }
        '3' {
            try { Restore-Patch } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
            Write-Host "`nPress Enter to exit..."; $null = Read-Host
        }
        '4' { Exit }
        default { Show-Menu }
    }
}

# ---------------------------------------------------------------------------
# DISPATCH
# ---------------------------------------------------------------------------
if ($Restore) {
    try { Restore-Patch } catch { Write-Host $_.Exception.Message -ForegroundColor Red; Exit 1 }
    Write-Host "`nPress Enter to close..." -ForegroundColor DarkGray
    $null = Read-Host
} elseif ($Auto) {
    Write-Host "`n=======================================================" -ForegroundColor Cyan
    Write-Host "  AUTO REBUILD MODE" -ForegroundColor Cyan
    Write-Host "=======================================================`n" -ForegroundColor Cyan
    $exitCode = 0
    try { Install-Patch } catch { Write-Host $_.Exception.Message -ForegroundColor Red; $exitCode = 1 }
    Write-Host "`nPress Enter to close..." -ForegroundColor DarkGray
    $null = Read-Host
    Exit $exitCode
} else {
    Show-Menu
}
