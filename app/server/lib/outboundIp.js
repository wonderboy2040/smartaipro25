// ============================================================
// server/lib/outboundIp.js — what public IPv4 does CoinDCX see?
// ------------------------------------------------------------
// v21.29.1 COINDCX IP-BINDING UPDATE (28 Oct 2026):
// CoinDCX made IP binding MANDATORY for every new API key. The key
// only works from the IPv4 address entered in the CoinDCX API
// Dashboard, so the app must be able to tell the operator exactly
// which address its authenticated requests leave from.
//
// WHY IPv4 (and why native https, NOT global fetch):
//   The live incident on the user's Windows box showed the SAME
//   machine egressing from TWO different public addresses:
//     • fetch / IPv6-preferred path → 152.57.142.92
//     • IPv4-preferred path         → 152.57.132.146
//   CoinDCX's dashboard binds IPv4; binding one address while the
//   app leaves from the other produces the generic
//   "401 Invalid credentials" error. This helper therefore pins
//   family:4 and is the address the operator must bind.
//
// The check is best-effort and cached: an upstream outage must never
// block boot, connect, or a trading tick.
// ============================================================
import https from 'node:https';
import { URL } from 'node:url';

const PROVIDERS = [
  'https://api.ipify.org',
  'https://ipv4.icanhazip.com',
  'https://v4.ident.me',
];
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 4000;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

let _cachedIp = null;
let _cachedAt = 0;
let _inflight = null;
// Test seam — production always uses _httpsText.
let _fetcher = null;

/** Strict-enough IPv4 check (four octets, each 0..255). */
export function isValidIPv4(value) {
  const s = String(value || '').trim();
  if (!IPV4_RE.test(s)) return false;
  return s.split('.').every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Minimal GET(text/plain) over native https, pinned to IPv4. */
function _httpsText(urlStr) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const req = https.request({
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      family: 4,
      headers: {
        'User-Agent': 'SmartAI-Pro-Outbound-IP-Check/1.0',
        Accept: 'text/plain',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('outbound-ip timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Public IPv4 address of this server, or null when no provider answers.
 * Cached for 10 minutes; `{ refresh:true }` forces a fresh lookup.
 * Never throws.
 */
export async function getOutboundIPv4({ refresh = false, maxAgeMs = CACHE_MS } = {}) {
  const now = Date.now();
  if (!refresh && _cachedIp && now - _cachedAt < maxAgeMs) return _cachedIp;
  if (_inflight) return _inflight;
  const fetchText = _fetcher || _httpsText;
  _inflight = (async () => {
    for (const url of PROVIDERS) {
      try {
        const text = await fetchText(url);
        const ip = String(text || '').trim();
        if (isValidIPv4(ip)) {
          _cachedIp = ip;
          _cachedAt = Date.now();
          return ip;
        }
      } catch { /* try the next provider */ }
    }
    return null;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/** Cached result only — safe to call on every API error / status read. */
export function getCachedOutboundIPv4() {
  return _cachedIp && Date.now() - _cachedAt < CACHE_MS ? _cachedIp : null;
}

// ---------------- test hooks ----------------
export function __setOutboundIpFetcherForTests(fn) {
  _fetcher = typeof fn === 'function' ? fn : null;
  _cachedIp = null;
  _cachedAt = 0;
  _inflight = null;
}
export function __setCachedOutboundIpForTests(ip) {
  _cachedIp = isValidIPv4(ip) ? String(ip).trim() : null;
  _cachedAt = _cachedIp ? Date.now() : 0;
  _inflight = null;
}
export function __resetOutboundIpForTests() {
  _fetcher = null;
  _cachedIp = null;
  _cachedAt = 0;
  _inflight = null;
}
