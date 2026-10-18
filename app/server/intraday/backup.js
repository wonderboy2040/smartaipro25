// ============================================================
// intraday/backup — durable remote backup for runtime state
// ------------------------------------------------------------
// PROBLEM: Render free plan ships an EPHEMERAL filesystem. Every
// spin-down / restart / redeploy re-checks-out the git repo, so
// server/data/paper-trades.json (runtime-written, gitignored)
// is silently wiped — the paper-trading history resets to 0.
//
// FIX: mirror the JSON state to the SAME GitHub repository on a
// dedicated branch (default: data-backup) via the Contents API.
//   • scheduleBackup() — debounced, coalesced, rate-limited push
//   • restoreBackup() — boot-time pull when local state is empty
// Pushes to a NON-deploy branch never trigger a Render auto-deploy,
// so there is no restart loop.
//
// CONFIG (all optional — module is a silent no-op without them):
//   GITHUB_BACKUP_TOKEN  — fine-grained PAT (Contents: RW)
//   GITHUB_BACKUP_REPO   — "owner/name"
//   GITHUB_BACKUP_BRANCH — default "data-backup"
// Every failure path is non-throwing: backup is best-effort and
// must never take down a trading route.
// ============================================================
const PUSH_DEBOUNCE_MS = 5000;   // coalesce bursts (watcher ticks)
const PUSH_MIN_GAP_MS = 60_000;  // GitHub abuse safety per file
// v11.3: 10s → 15s + one retry on the sha HEAD. The production log
// showed boot-time "[backup] head council-nearmiss.json failed: The
// operation was aborted due to timeout" — api.github.com's first TLS
// handshake from a cold Render container can exceed 10s. Backup is
// best-effort, but a boot-time state push failing on a transient
// handshake wastes the whole cycle (the remote copy stays a deploy
// older than it needs to be).
const FETCH_TIMEOUT_MS = 15_000;
const HEAD_RETRIES = 2;
// v11.4 recheck: a FAILED push was dropped outright — the v10.18 comment
// claimed "a failed push retried early is the correct behavior" but no
// retry path existed, so a transient network blip left rarely-written
// files (gate override, near-miss list) stale indefinitely. Bounded
// retry of the SAME payload: 3 attempts, 65s apart (just past the 60s
// success-gap), then honest give-up until the next write re-arms.
const FAIL_RETRY_MS = 65_000;
const FAIL_RETRY_MAX = 3;

const _log = (msg) => console.log(`[backup] ${msg}`);

const _pending = new Map();      // filename -> latest data object
const _lastPush = new Map();     // filename -> ts
const _inflight = new Map();     // filename -> promise
const _failTries = new Map();    // filename -> consecutive failed attempts
let _lastAttempt = 0;            // module-wide circuit breaker
let _branchEnsured = false;      // v11.4: data-backup branch exists (bootstrap cache)

export function backupConfigured() {
  const token = process.env.GITHUB_BACKUP_TOKEN;
  const repo = process.env.GITHUB_BACKUP_REPO;
  return !!(token && repo && /^[^/\s]+\/[^/\s]+$/.test(repo.trim()));
}

function _headers() {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${process.env.GITHUB_BACKUP_TOKEN}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wealthai-backup/1.0',
  };
}

function _apiBase() {
  return `https://api.github.com/repos/${process.env.GITHUB_BACKUP_REPO.trim()}`;
}

function _branch() {
  return (process.env.GITHUB_BACKUP_BRANCH || 'data-backup').trim() || 'data-backup';
}

function _filePath(filename) {
  const dir = (process.env.GITHUB_BACKUP_DIR || 'backups').replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${filename}` : filename;
}

async function _gh(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { ..._headers(), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return r;
}

/** v11.4 recheck: nothing in the repo ever CREATED the data-backup
 *  branch (docs only mention the env var). On a repo where it doesn't
 *  exist: HEAD 404 → sha null → PUT create → GitHub 422 "Reference does
 *  not exist" → the old code logged "(race), remote is fresh" and
 *  returned false — every push failed forever while the logs claimed
 *  the opposite. Bootstrap: create the branch from the default branch
 *  head (cached — one successful check lasts the process lifetime). */
async function _ensureBranch() {
  if (_branchEnsured) return true;
  try {
    const ref = await _gh(`${_apiBase()}/git/ref/heads/${encodeURIComponent(_branch())}`);
    if (ref.ok) { _branchEnsured = true; return true; }
    if (ref.status !== 404) { _log(`ensure-branch: ref -> HTTP ${ref.status}`); return false; }
    const repo = await _gh(`${_apiBase()}`);
    if (!repo.ok) { _log(`ensure-branch: repo -> HTTP ${repo.status}`); return false; }
    const def = (await repo.json())?.default_branch;
    if (!def) { _log('ensure-branch: no default_branch'); return false; }
    const defRef = await _gh(`${_apiBase()}/git/ref/heads/${encodeURIComponent(def)}`);
    if (!defRef.ok) { _log(`ensure-branch: ${def} ref -> HTTP ${defRef.status}`); return false; }
    const sha = (await defRef.json())?.object?.sha;
    if (!sha) { _log('ensure-branch: default head has no sha'); return false; }
    const create = await _gh(`${_apiBase()}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${_branch()}`, sha }),
    });
    if (create.ok || create.status === 422) {
      _log(`ensure-branch: ${_branch()} ready (from ${def}@${String(sha).slice(0, 7)})`);
      _branchEnsured = true;
      return true;
    }
    _log(`ensure-branch: create -> HTTP ${create.status}`);
    return false;
  } catch (e) {
    _log(`ensure-branch failed: ${e?.message || e}`);
    return false;
  }
}

// ------------------------------------------------------------
// PUSH — one serialized, coalesced upload per file.
// ------------------------------------------------------------
async function _doPush(filename, data) {
  const path = _filePath(filename);
  // 1) Resolve the existing blob's sha (create-on-404). v11.3: retried
  //    once — a cold-boot TLS handshake to api.github.com can blow a
  //    single 15s budget; the second attempt rides the warmed connection.
  let sha = null;
  for (let attempt = 1; attempt <= HEAD_RETRIES; attempt++) {
    try {
      const head = await _gh(`${_apiBase()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(_branch())}`);
      if (head.ok) {
        const j = await head.json();
        sha = j?.sha || null;
        break;
      } else if (head.status !== 404) {
        if (attempt < HEAD_RETRIES) { await new Promise(r => setTimeout(r, 400)); continue; }
        _log(`head ${filename} -> HTTP ${head.status}, skipping push`);
        return false;
      }
      break; // 404 — create-on-missing, no retry needed
    } catch (e) {
      if (attempt >= HEAD_RETRIES) {
        _log(`head ${filename} failed: ${e?.message || e}`);
        return false;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // 2) Create or update the blob on the branch.
  const _putBody = (bsha) => JSON.stringify({
    message: `backup: ${filename} (${new Date().toISOString()})`,
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    branch: _branch(),
    ...(bsha ? { sha: bsha } : {}),
  });
  const _put = (bsha) => _gh(`${_apiBase()}/contents/${encodeURIComponent(path)}`, { method: 'PUT', body: _putBody(bsha) });
  let put = await _put(sha);
  if (put.status === 409 || put.status === 422) {
    // v11.4 recheck: the old comment called EVERY 409/422 a lost sha
    // race with "remote is fresh" — false twice over: (a) with sha === null
    // a 422 is usually "Reference does not exist" (the branch was never
    // created — see _ensureBranch); (b) a genuine race means the remote is
    // a DIFFERENT instance's state, not "ours, fresher". Handle both:
    // bootstrap the branch on create-legs, then re-HEAD and retry once.
    if (sha == null && await _ensureBranch()) {
      put = await _put(null);
    }
    if (put.status === 409 || put.status === 422) {
      let freshSha = null;
      try {
        const head = await _gh(`${_apiBase()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(_branch())}`);
        if (head.ok) freshSha = (await head.json())?.sha || null;
      } catch { /* re-HEAD failed — try create-leg once */ }
      put = await _put(freshSha);
    }
    if (put.status === 409 || put.status === 422) {
      _log(`push ${filename} -> ${put.status} after branch-bootstrap + re-HEAD retry (lost race), remote is fresh`);
      return false;
    }
  }
  if (!put.ok) {
    _log(`push ${filename} -> HTTP ${put.status}`);
    return false;
  }
  _log(`pushed ${filename} -> ${_branch()}:${path}`);
  return true;
}

export function scheduleBackup(filename, data) {
  if (!backupConfigured()) return;
  _pending.set(filename, data);
  _queueFlush(filename);
}

/** v12.7 SHUTDOWN FLUSH — synchronously kick every pending push NOW,
 * bypassing the debounce, the per-file 60s gap, and the global 3s
 * attempt spacing exactly ONCE (the process is about to die; the GitHub
 * Contents API can absorb one final burst). Returns immediately — the
 * pushes ride their own promises inside the SIGTERM drain window
 * (best-effort by construction: anything that misses the window was
 * already pushed ≤60s ago, so the remote is at worst one minute stale).
 * Without this, the four shutdown flush functions only wrote the
 * EPHEMERAL disk — the remote backup stayed a full debounce+gap behind
 * on every deploy (recheck R3-#4). */
export function flushBackupNow() {
  try {
    for (const filename of [..._pending.keys()]) {
      if (_inflight.has(filename)) continue; // already riding a push
      const data = _pending.get(filename);
      if (!data) continue;
      _pending.delete(filename);
      _lastAttempt = Date.now();
      const p = (async () => {
        try { return await _doPush(filename, data); }
        catch (e) { _log(`shutdown push ${filename} error: ${e?.message || e}`); return false; }
        finally { _inflight.delete(filename); }
      })();
      _inflight.set(filename, p);
    }
  } catch { /* best-effort — shutdown must never throw */ }
}

function _queueFlush(filename) {
  const t = setTimeout(() => { _flush(filename); }, PUSH_DEBOUNCE_MS);
  if (typeof t.unref === 'function') t.unref();
}

async function _flush(filename) {
  if (_inflight.has(filename)) return;               // serialized
  const data = _pending.get(filename);
  if (!data) return;
  const gap = Date.now() - (_lastPush.get(filename) || 0);
  if (gap < PUSH_MIN_GAP_MS) { _queueFlush(filename); return; }
  if (Date.now() - _lastAttempt < 3000) { _queueFlush(filename); return; }

  _lastAttempt = Date.now();
  _pending.delete(filename);
  const p = (async () => {
    try { return await _doPush(filename, data); }
    catch (e) { _log(`push ${filename} error: ${e?.message || e}`); return false; }
    finally { _inflight.delete(filename); }
  })();
  _inflight.set(filename, p);
  // If another write landed mid-push, flush it after this one ends.
  // v10.18 (deep-recheck #3): _lastPush was READ for the per-file 60s
  // gap but NEVER written — PUSH_MIN_GAP_MS was dead code, so state
  // churn could hammer the GitHub Contents API ~20×/min per file and
  // trip the secondary rate limit → 403 → backups silently stop. Arm
  // the gap ONLY after a successful push (a failed push retried early
  // is the correct behavior — the remote copy is still stale).
  p.then((pushed) => {
    if (pushed) {
      _lastPush.set(filename, Date.now());
      _failTries.delete(filename);
      if (_pending.has(filename)) _queueFlush(filename);
      return;
    }
    // v11.4 recheck: FAILED pushes were dropped when no newer data waited
    // — retry the SAME payload (bounded) so a transient blip can't leave
    // rarely-written files stale forever.
    if (_pending.has(filename)) { _queueFlush(filename); return; }
    const tries = (_failTries.get(filename) || 0) + 1;
    if (tries > FAIL_RETRY_MAX) {
      _failTries.delete(filename);
      _log(`push ${filename}: giving up after ${FAIL_RETRY_MAX} retries — next write re-arms`);
      return;
    }
    _failTries.set(filename, tries);
    _pending.set(filename, data);
    const t = setTimeout(() => { _queueFlush(filename); }, FAIL_RETRY_MS);
    if (typeof t.unref === 'function') t.unref();
  }).catch(() => {});
}

// ------------------------------------------------------------
// RESTORE — fetch the last backup blob as a parsed object.
// Returns null when unconfigured / missing / corrupt.
// ------------------------------------------------------------
export async function restoreBackup(filename) {
  if (!backupConfigured()) return null;
  const path = _filePath(filename);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await _gh(`${_apiBase()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(_branch())}`);
      if (r.status === 404) return null;
      if (!r.ok) { _log(`restore ${filename} -> HTTP ${r.status}`); continue; }
      const j = await r.json();
      const raw = Buffer.from(j?.content || '', 'base64').toString('utf8');
      const parsed = JSON.parse(raw);
      _log(`restored ${filename} from ${_branch()} (${raw.length} bytes)`);
      return parsed;
    } catch (e) {
      _log(`restore ${filename} attempt ${attempt} failed: ${e?.message || e}`);
    }
  }
  return null;
}
