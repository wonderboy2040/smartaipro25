// ============================================================
// SmartAI v19.2 — consoleGuard.js
// ------------------------------------------------------------
// THE WINDOWS CONSOLE FREEZE GUARD.
//
// Root cause this kills: Windows conhost "QuickEdit Mode". When
// it is ON, ANY accidental click/drag inside the console window
// puts the console into text-select mode -> conhost STOPS
// reading the process's stdout -> the OS pipe buffer fills ->
// the next console.log() in Node BLOCKS FOREVER -> the event
// loop freezes while the process is still "alive". From the
// browser the site looks "atak gaya" (hung) — health checks
// time out, pages spin, nothing recovers until someone presses
// Enter/Esc in the console. This is the classic "site works
// 5-10 min then dies" pattern on Windows portables.
//
// The programmatic fix (best-effort, silent-fail): one
// PowerShell child call at boot that flips the shared console's
// input mode — clears ENABLE_QUICK_EDIT_MODE (0x0040) and sets
// ENABLE_EXTENDED_FLAGS (0x0080) via kernel32 SetConsoleMode.
// The child PowerShell inherits our console, so the mode change
// applies to the SAME conhost our Node process writes to.
//
// Contract (strict):
//   * never throws — returns { attempted, disabled, reason }
//   * never blocks boot — caller fires it and moves on
//   * non-win32 -> { attempted:false, reason:'non-win32' }
//   * QUICKEDIT_GUARD=off -> skipped
//   * timeout 4s default -> resolves disabled:false (never rejects)
//   * status snapshot via consoleGuardStatus() for /health
// ============================================================

import { spawn } from 'node:child_process';

const _status = {
  checkedAt: null,
  attempted: false,
  disabled: false,
  reason: 'not-run',
};

// ENABLE_QUICK_EDIT_MODE = 0x0040 ; ENABLE_EXTENDED_FLAGS = 0x0080
const _PS_SCRIPT = [
  "$sig='[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr GetStdHandle(int h);",
  "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out int m);",
  "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, int m);';",
  '$t=Add-Type -MemberDefinition $sig -Name K -Namespace W -PassThru;',
  '$h=$t::GetStdHandle(-10);',
  '$m=0;',
  "if($t::GetConsoleMode($h,[ref]$m)){",
  "  if(($m -band 0x40) -ne 0){ [void]$t::SetConsoleMode($h, ($m -band (-bnot 0x40)) -bor 0x80); Write-Output 'QEDIT_OFF' }",
  "  else { Write-Output 'QEDIT_ALREADY_OFF' }",
  "} else { Write-Output 'NO_CONSOLE' }",
].join(' ');

/**
 * Best-effort programmatic QuickEdit disable for THIS console.
 * Injectable deps for tests. Never rejects. Returns
 * { attempted, disabled, reason }.
 */
export function disableQuickEditMode(opts = {}) {
  const platformFn = opts.platformFn || (() => process.platform);
  const spawnFn = opts.spawnFn || spawn;
  const env = opts.env || process.env;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;

  if (env.QUICKEDIT_GUARD === 'off') {
    _setStatus(false, false, 'disabled-by-env');
    return Promise.resolve({ attempted: false, disabled: false, reason: 'disabled-by-env' });
  }
  if (platformFn() !== 'win32') {
    _setStatus(false, false, 'non-win32');
    return Promise.resolve({ attempted: false, disabled: false, reason: 'non-win32' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      _setStatus(result.attempted, result.disabled, result.reason);
      resolve(result);
    };

    let child;
    try {
      child = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', _PS_SCRIPT,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      done({ attempted: true, disabled: false, reason: `spawn-fail: ${String(err && err.message || err).slice(0, 80)}` });
      return;
    }
    if (!child || typeof child.on !== 'function') {
      done({ attempted: true, disabled: false, reason: 'spawn-fail: no child handle' });
      return;
    }

    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ attempted: true, disabled: false, reason: `timeout-${timeoutMs}ms` });
    }, timeoutMs);

    try {
      child.stdout.on('data', (d) => { out += String(d || ''); });
      child.stderr.on('data', () => { /* powershell chatter ignored */ });
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ attempted: true, disabled: false, reason: `error: ${String(err && err.code || err).slice(0, 60)}` });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const o = out.trim();
        if (o.includes('QEDIT_OFF')) done({ attempted: true, disabled: true, reason: 'quickedit-disabled' });
        else if (o.includes('QEDIT_ALREADY_OFF')) done({ attempted: true, disabled: true, reason: 'quickedit-already-off' });
        else if (o.includes('NO_CONSOLE')) done({ attempted: true, disabled: false, reason: 'no-console-hidden-mode' });
        else done({ attempted: true, disabled: false, reason: `unexpected-output: ${o.slice(0, 60) || 'empty'}` });
      });
    } catch (err) {
      clearTimeout(timer);
      done({ attempted: true, disabled: false, reason: `wiring-fail: ${String(err && err.message || err).slice(0, 60)}` });
    }
  });
}

function _setStatus(attempted, disabled, reason) {
  _status.checkedAt = Date.now();
  _status.attempted = attempted;
  _status.disabled = disabled;
  _status.reason = reason;
}

/** Snapshot for /health — never throws. */
export function consoleGuardStatus() {
  return {
    checkedAt: _status.checkedAt,
    attempted: _status.attempted,
    disabled: _status.disabled,
    reason: _status.reason,
    platform: process.platform,
  };
}

/** Tests only. */
export function __resetConsoleGuardForTests() {
  _status.checkedAt = null;
  _status.attempted = false;
  _status.disabled = false;
  _status.reason = 'not-run';
}
