// ============================================================
//  SUPERINTELLIGENCE ADVANCE AI PRO TRADER AUTO — BROWSER AGENT
//  v18.6 — CDP (Chrome DevTools Protocol) driver for the user's
//  already-open, logged-in browser tabs (CoinDCX + Dhan).
//
//  ZERO new npm deps: node:http + ws (already installed).
//
//  Design:
//   * User runs Start-AutoBrowser.bat once -> Chrome/Edge starts
//     with --remote-debugging-port=9222 and stays logged in to
//     coindcx.com / dhan.co (same profile, same session).
//   * This module discovers tabs via http://127.0.0.1:9222/json,
//     attaches a WebSocket CDP session per tab, and drives the
//     page DOM via Runtime.evaluate (React-safe input setter).
//   * Every action is journaled by the caller (proTraderAuto.js);
//     every placement attempt saves a screenshot to
//     server/data/protrader-shots/ for the user to verify.
//   * Selectors are STRATEGY ARRAYS with fallbacks. Live DOMs
//     change; browserHealth() probes which pieces still match so
//     the panel can tell the user exactly what is broken.
//     Custom overrides: server/data/browser-selectors.json.
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadJSON } from '../lib/store.js';

// v18.6.2: MULTI-PORT CDP discovery. Default pe 9222 (Start-AutoBrowser.bat)
// khulta hai; 9223-9225 fallback hai agar user ne manual alag port lagaya ho.
// PROTRADER_CDP_HOST / PROTRADER_CDP_PORT (single, tests) / PROTRADER_CDP_PORTS
// (comma list) env se override hota hai.
function _cdpPorts() {
  const list = String(process.env.PROTRADER_CDP_PORTS || '')
    .split(',').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
  if (list.length) return list;
  const single = Number(process.env.PROTRADER_CDP_PORT || 0);
  if (single > 0) return [single]; // explicit single port = EXACT (no fallback scan)
  return [9222, 9223, 9224, 9225];
}
const CDP_HOST = process.env.PROTRADER_CDP_HOST || '127.0.0.1';
const CDP_PORTS = _cdpPorts();
const SHOT_DIR = path.join(process.env.SMARTAI_DATA_DIR || path.join(process.cwd(), 'server', 'data'), 'protrader-shots');
const MAX_SHOTS = 12;

// ---------------- state ----------------
const state = {
  browser: null,        // { product, version, connectedAt }
  tabs: {},             // { coindcx: {id,url,title,wsUrl}, dhan: {...} }
  pages: {},            // key -> CdpPage
  host: null,           // v18.6.2: working CDP host
  port: null,           // v18.6.2: working CDP port
  lastError: null,
  lastScanAt: 0,
};

// ---------------- tiny http json helper ----------------
function cdpHttp(host, port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: urlPath, method, timeout: 4000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw || 'null') }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP http timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// v18.6.2: CDP connect failures ko HUMAN-readable banao — user ko exact
// fix batana (normal browser tabs count nahi hote, bat chahiye).
function _friendlyCdpError(e) {
  const raw = String(e?.message || e);
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|timeout/i.test(raw)) {
    return `connect fail @${CDP_HOST}:${CDP_PORTS.join('/')} (${raw}) — automation browser nahi chal raha. FIX: Start-AutoBrowser.bat chalao (ye SmartAI ka DEDICATED automation window kholta hai; NORMAL Chrome/Edge ke tabs control NAHI hote — Chrome/Edge 136+ default profile pe debug port block karta hai, isliye dedicated profile zaroori hai)`;
  }
  return raw;
}

// ---------------- CDP page session ----------------
class CdpPage {
  constructor(key, wsUrl) {
    this.key = key;
    this.wsUrl = wsUrl;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._alive = false;
  }
  async connect() {
    if (this._alive && this.ws) return true;
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, handshakeTimeout: 5000 });
      const to = setTimeout(() => { try { this.ws.terminate(); } catch { /* CDP eval best-effort — status records the error */ } reject(new Error('CDP ws handshake timeout')); }, 6000);
      this.ws.on('open', () => { clearTimeout(to); this._alive = true; resolve(true); });
      this.ws.on('message', (raw) => this._onMessage(String(raw)));
      this.ws.on('error', (e) => { if (!this._alive) { clearTimeout(to); reject(e); } });
      this.ws.on('close', () => {
        this._alive = false;
        for (const [, p] of this._pending) p.reject(new Error('CDP ws closed'));
        this._pending.clear();
      });
    });
    try { await this.send('Runtime.enable'); await this.send('Page.enable'); } catch { /* best-effort */ }
    return true;
  }
  _onMessage(str) {
    let msg; try { msg = JSON.parse(str); } catch { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message || 'error'}`));
      else p.resolve(msg.result);
    }
  }
  send(method, params = {}, { timeoutMs = 15000 } = {}) {
    if (!this._alive || !this.ws) return Promise.reject(new Error(`CDP page ${this.key} not connected`));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this._pending.delete(id); reject(e); }
      // v20.7.6 FIX: hardcoded 15s wall — evaluate(timeoutMs: 20000/30000)
      // walon ko 15s pe hi reject kar deta tha ("CDP Runtime.evaluate
      // timeout") jabki in-page waits ka budget bada tha. Ab caller apna
      // timeout pass kar sakta hai; default wahi 15s rehta hai.
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }
      }, Math.max(1000, Number(timeoutMs) || 15000)).unref();
    });
  }
  // Evaluate an async in-page expression. Returns parsed JSON value.
  async evaluate(asyncExpr, { timeoutMs = 15000 } = {}) {
    const wrapped = `(async () => { ${asyncExpr} })()`;
    const res = await this.send('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, { timeoutMs: Math.max(15000, timeoutMs + 3000) });
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page error: ${d?.exception?.description || d?.text || 'unknown'}`);
    }
    const v = res?.result?.value;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }
  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 2500));
  }
  // v20.7.4: live page URL (navigate decision + pair-page verify).
  async currentUrl() {
    try {
      const res = await this.send('Runtime.evaluate', {
        expression: 'location.href', returnByValue: true, timeout: 4000,
      });
      return String(res?.result?.value || '');
    } catch { return ''; }
  }
  async screenshot(name) {
    try {
      const res = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      if (!res?.data) return null;
      return saveShot(name, res.data);
    } catch { return null; }
  }
}

let _shotSaves = 0;
function saveShot(name, b64) {
  try {
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${Date.now()}-${String(name).replace(/[^a-z0-9_-]/gi, '_')}.jpg`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    // v20.7.4 FIX: readdirSync + sort + unlink loop HAR shot pe chal raha
    // tha — event-loop freeze ka contributor (selfheal EVENT-LOOP FREEZE
    // log). Ab prune sirf har 10ve save pe (first + every 10th).
    if (++_shotSaves % 10 === 1) {
      const all = fs.readdirSync(SHOT_DIR).filter((f) => f.endsWith('.jpg')).sort();
      while (all.length > MAX_SHOTS) { try { fs.unlinkSync(path.join(SHOT_DIR, all.shift())); } catch { /* page detach best-effort */ } }
    }
    return path.basename(file);
  } catch { return null; }
}

// ---------------- tab discovery ----------------
const TAB_MATCH = {
  coindcx: /coindcx\.com/i,
  dhan: /dhan\.co/i,
};

async function discoverTabs({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.lastScanAt < 30_000 && state.browser) return state.tabs;
  state.lastScanAt = now;
  state.lastError = null;
  // v18.6.2: har known port try karo jo pehla jude wahi yaad rakho.
  let version = null; let lastErr = null;
  for (const p of CDP_PORTS) {
    try { version = await cdpHttp(CDP_HOST, p, 'GET', '/json/version'); state.host = CDP_HOST; state.port = p; break; }
    catch (e) { lastErr = e; }
  }
  if (!version) {
    state.browser = null; state.tabs = {}; state.host = null; state.port = null;
    state.lastError = _friendlyCdpError(lastErr);
    return state.tabs;
  }
  if (!version?.body?.webSocketDebuggerUrl) { state.browser = null; state.lastError = 'browser found but no debugger url (Chrome ko --remote-debugging-port ke saath dedicated --user-data-dir se chalao)'; return {}; }
  state.browser = { product: version.body.Browser || 'Chrome', version: version.body.Browser || '', connectedAt: now };
  let list;
  try { list = await cdpHttp(CDP_HOST, state.port, 'GET', '/json/list'); } catch (e) { state.lastError = String(e?.message || e); return {}; }
  const pages = Array.isArray(list.body) ? list.body.filter((t) => t.type === 'page') : [];
  state.tabs = {};
  for (const [key, re] of Object.entries(TAB_MATCH)) {
    const hit = pages.find((t) => re.test(t.url || '')) || null;
    if (hit) state.tabs[key] = { id: hit.id, url: hit.url, title: hit.title || '', wsUrl: hit.webSocketDebuggerUrl || null };
  }
  return state.tabs;
}

// v18.6.2: connected hai par tab missing — user ko batao KAUNSA tab kahan kholna hai.
function _tabsHint() {
  if (!state.browser) return null;
  const missing = [];
  if (!state.tabs.coindcx) missing.push('coindcx.com/trade');
  if (!state.tabs.dhan) missing.push('web.dhan.co');
  if (missing.length === 0) return null;
  return `Automation browser mila (${state.browser.product}) par tab missing — AUTOMATION window me kholo: ${missing.join(' + ')} (normal browser me khule tabs count nahi hote)`;
}

async function pageFor(key, { createUrl = null } = {}) {
  await discoverTabs({});
  let tab = state.tabs[key];
  if (!tab && createUrl) {
    try {
      const created = await cdpHttp(CDP_HOST, state.port, 'PUT', `/json/new?${encodeURIComponent(createUrl)}`)
        .catch(() => cdpHttp(CDP_HOST, state.port, 'GET', `/json/new?${encodeURIComponent(createUrl)}`));
      const t = created?.body;
      if (t && (t.id || t?.targetId)) {
        tab = { id: t.id || t.targetId, url: t.url || createUrl, title: '', wsUrl: t.webSocketDebuggerUrl || null };
        state.tabs[key] = tab;
      }
    } catch { /* older chrome disabled /json/new — user opens tab manually */ }
  }
  if (!tab) throw new Error(`${key} tab not found in browser (kholo: ${createUrl || key})`);
  if (!tab.wsUrl) throw new Error(`${key} tab found but no websocket debugger url (tab needs focus once)`);
  let page = state.pages[key];
  if (!page || page.wsUrl !== tab.wsUrl) {
    // v20.7.12 [M-5]: tab band/reopen hua tha (naya wsUrl) — PURANE page ka
    // WebSocket replace se pehle CLOSE karo. Pehle state.pages[key] ko
    // seedha overwrite karte the → purana socket zombie reh jata tha (tab
    // churn pe minor fd/listener leak).
    if (page && page.ws) { try { page.ws.close(); } catch { /* already gone */ } }
    page = new CdpPage(key, tab.wsUrl);
    await page.connect();
    state.pages[key] = page;
  } else {
    await page.connect().catch(() => { throw new Error(`${key} CDP reconnect failed`); });
  }
  return page;
}

// ---------------- in-page DOM helper library (injected) ----------------
// React-safe input setter + text-based element finder + waiter.
const DOM_HELPERS = `
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const vis = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; } catch { return false; } };
  const byText = (sel, re, { root } = {}) => $$('button, div[role="button"], a, span, li, div', root)
    .filter((el) => vis(el) && re.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 40)
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  const bySelOrText = (sels, re) => { for (const s of sels) { const el = $(s); if (el && vis(el)) return el; } return re ? byText('button', re) : null; };
  const setVal = (el, value) => {
    if (!el) return false;
    // v20.7.7 HARDENING: kai modern exchange panels (CoinDCX futures
    // included, kabhi-kabhi) input ko contenteditable DIV / custom
    // element bana dete hain — wahan HTMLInputElement.prototype ka
    // value setter exist hi nahi karta (TypeError → poora order flow
    // gir jata tha). Non-input elements ke liye textContent fallback.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    try {
      if (proto) {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, String(value));
      } else {
        el.textContent = String(value);
      }
    } catch { el.textContent = String(value); }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickEl = (el) => {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch { el.click(); }
    return true;
  };
  const waitFor = async (fn, { timeout = 8000, poll = 300, label = '' } = {}) => {
    const t0 = Date.now();
    for (;;) {
      let v = null; try { v = fn(); } catch {}
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('wait timeout: ' + label);
      await new Promise((r) => setTimeout(r, poll));
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // v20.7.6 ORDER-FORM FIELD FINDER — CoinDCX futures panel inputs ke
  // paas aksar SIRF sibling label hota hai: placeholder live-price NUMBER
  // hota hai ("3.1524"), na name hota hai na aria-label. Purana finder
  // sirf placeholder/name/aria dekhta tha — "wait timeout: price input"
  // (DOT LONG entry fail) isi ka root cause tha. Ab 3 passes:
  //   1. semantic — attribute YA associated-label text
  //   2. positional — buy/sell button wale form-region ke numeric inputs
  //      (DOM order: pehla price, doosra amount — limit mode)
  //   3. market-mode — sirf 1 input bacha to wo qty hai (price nahi)
  const fieldAttrText = (el) => [el.placeholder, el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('data-testid'), (typeof el.className === 'string' ? el.className : '')].filter(Boolean).join(' ');
  const fieldLabelText = (el) => {
    try { if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => (l.textContent || '')).join(' ').trim(); } catch {}
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { try { return lb.split(/\\s+/).map((id) => ((document.getElementById(id) || {}).textContent || '')).join(' ').trim(); } catch {} }
    let node = el.parentElement;
    for (let i = 0; node && i < 3; i++, node = node.parentElement) {
      const own = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (own && own.length <= 44) return own;
    }
    return '';
  };
  const isOrderNumInput = (el) => {
    if (!el || !vis(el)) return false;
    if (el.type !== 'text' && el.type !== 'number' && el.type !== '') return false;
    return !/search|pair|symbol|scrip|email|password/i.test(fieldAttrText(el));
  };
  const findOrderField = (kind) => {
    const wantRe = kind === 'price' ? /price|entry|trigger/i : /qty|quantity|amount|size|total/i;
    const antiRe = kind === 'price' ? /qty|quantity|amount|size|total|search|pair|symbol|scrip/i : /price|entry|trigger|search|pair|symbol|scrip/i;
    const cands = $$('input').filter(isOrderNumInput);
    const hit = cands.find((el) => ((wantRe.test(fieldAttrText(el)) || wantRe.test(fieldLabelText(el))) && !antiRe.test(fieldAttrText(el))));
    if (hit) return hit;
    const btn = $$('button, div[role="button"]').filter((el) => vis(el) && /^(buy|long|sell|short)\\b/i.test((el.textContent || '').trim()))[0] || null;
    if (!btn) return null;
    let node = btn.parentElement;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      const inputs = $$('input', node).filter(isOrderNumInput);
      // v20.7.7 FIX: qty ke liye LAST input, inputs[1] nahi — 3-field
      // stop-limit forms [price, trigger, amount] me inputs[1] TRIGGER
      // nikalta tha (galat field me qty likh dete the). CoinDCX futures
      // layout me amount hamesha aakhri numeric input hota hai.
      if (inputs.length >= 2 && inputs.length <= 6) return kind === 'price' ? inputs[0] : inputs[inputs.length - 1];
      if (inputs.length > 6) return null; // form-region se bahar — poora page pakad liya, positional unsafe
    }
    return null;
  };
`;

// ---------------- CoinDCX in-page operations ----------------
const CX_OPEN_URL = 'https://coindcx.com/trade';
// v20.7.4 FIX: FUTURES desk ka official URL /futures/{PAIR} hai
// (user-verified live: https://coindcx.com/futures/B-ETH_USDT). Purana
// code /trade/{B-PAIR_USDT} spot URL kholta tha jahan na futures order
// panel hota hai na wahi search box — "select-pair: search box nahi
// mila" error ka root cause yahi tha.
export function cxPairUrl(pair, product = 'futures') {
  const p = String(pair || '').toUpperCase();
  return product === 'spot'
    ? `https://coindcx.com/trade/${p}`
    : `https://coindcx.com/futures/${p}`;
}
const CX_STYLES = {
  searchBox: [
    'input[data-testid*="search" i]',
    'input[placeholder*="search" i]',
    '[class*="Search"] input',
    '[class*="search"] input',
    '[class*="pair" i] input[type="text"]',
    '[class*="symbol" i] input[type="text"]',
    'input[type="search"]',
    'input[type="text"]', // v20.7.4 last resort: pehla visible text input (dropdown verify baad me)
  ],
  pairItem: null, // text matched
  limitBtn: null, // text "Limit"
  priceInput: ['input[name="price"]', 'input[placeholder*="price" i]', '[class*="order"] input[type="text"]', '[class*="Price"] input'],
  qtyInput: ['input[name="quantity"]', 'input[placeholder*="quantity" i]', 'input[placeholder*="amount" i]', 'input[placeholder*="total" i]'],
  marginTab: null, // text "Margin"
  buyBtn: null, sellBtn: null,
};

function selOverride(key, field) {
  const ov = _loadOverrides();
  const arr = ov?.[key]?.[field];
  return Array.isArray(arr) && arr.length ? arr : null;
}

let _ovCache = null; let _ovAt = 0;
function _loadOverrides() {
  if (_ovCache && Date.now() - _ovAt < 30_000) return _ovCache;
  _ovCache = loadJSON('browser-selectors.json', null); _ovAt = Date.now();
  return _ovCache;
}

// Health probe: which building blocks exist on the CURRENT page.
function cxHealthScript() {
  return `
    ${DOM_HELPERS}
    try {
      const search = bySelOrText(${JSON.stringify(selOverride('coindcx', 'searchBox') || CX_STYLES.searchBox)}, null);
      const limitBtn = byText('button', /limit/i);
      const marketBtn = byText('button', /market/i);
      const marginTab = byText('button, div[role="button"], div, span', /^\\s*margin\\b|margin\\s*trad/i);
      // v20.7.6: health probe bhi naye findOrderField se — futures panel
      // me label-only inputs ko purana finder miss karta tha, panel galat
      // "broken" dikha deta tha.
      const priceInput = findOrderField('price');
      const qtyInput = findOrderField('qty');
      const buyBtn = $$('button, div[role="button"]').filter((el) => vis(el) && /^(buy|long)\\b/i.test((el.textContent || '').trim()))[0] || null;
      const sellBtn = $$('button, div[role="button"]').filter((el) => vis(el) && /^(sell|short)\\b/i.test((el.textContent || '').trim()))[0] || null;
      const posTable = $$('table, [class*="position"], [class*="Position"]').filter((el) => vis(el) && (el.textContent || '').toLowerCase().includes('position'))[0] || null;
      return JSON.stringify({
        ok: true, url: location.href,
        found: {
          searchBox: !!search, limitBtn: !!limitBtn, marketBtn: !!marketBtn, marginTab: !!marginTab,
          priceInput: !!priceInput, qtyInput: !!qtyInput, buyBtn: !!buyBtn, sellBtn: !!sellBtn,
          positions: !!posTable,
        },
      });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

// Search a pair and select it in the pair picker.
// v20.7.4 FIX: pehle URL check — agar tab PEHLE SE hi us pair ke
// direct page par hai (coindcx.com/futures/B-ETH_USDT) to wahan
// koi search box hota hi nahi hai. Pair already selected hai; sirf
// order panel ka alive hone verify karo aur seedha return karo.
// Search-box flow sirf tab chalega jab URL me pair nahi mila.
function cxSelectPairScript(pair) {
  return `
    ${DOM_HELPERS}
    try {
      const want = ${JSON.stringify(pair.toUpperCase())};
      const wantTok = want.replace(/[^A-Z0-9]/g, '');
      const urlTok = (location.pathname.split('/').pop() || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      // ---- DIRECT PAIR PAGE: search box exists hi nahi — verify panel ----
      if (urlTok && wantTok && (urlTok === wantTok || urlTok.includes(wantTok) || wantTok.includes(urlTok))) {
        const panel = await waitFor(() => {
          const buy = $$('button, div[role="button"]').filter((el) => vis(el) && /^(buy|long)\\b/i.test((el.textContent || '').trim()))[0] || null;
          const sell = $$('button, div[role="button"]').filter((el) => vis(el) && /^(sell|short)\\b/i.test((el.textContent || '').trim()))[0] || null;
          const px = findOrderField('price') || findOrderField('qty') || null;
          return (buy || sell || px) || null;
        }, { timeout: 12000, poll: 600, label: 'order panel (direct pair page)' });
        return JSON.stringify({ ok: true, pair: want, picked: 'url-direct: ' + location.pathname, panelFound: true, url: location.href });
      }
      // ---- FALLBACK: search-box flow (spot/old UI) ----
      let box = bySelOrText(${JSON.stringify(selOverride('coindcx', 'searchBox') || CX_STYLES.searchBox)}, null);
      if (!box) {
        // v20.7.4: kai modern UIs me search input ek trigger (button/div)
        // peeche chhupa hota hai — pehle use kholo, phir input dhoondo.
        const trigger = $$('[class*="search" i], [class*="pair-select" i], [data-testid*="search" i]').filter(vis)[0]
          || byText('button, div, span', /^\\s*search\\b/i);
        if (trigger) { clickEl(trigger); await sleep(700); }
        box = bySelOrText(${JSON.stringify(selOverride('coindcx', 'searchBox') || CX_STYLES.searchBox)}, null);
      }
      if (!box) throw new Error('search box nahi mila — URL me pair bhi nahi tha (pair page kholo ya selectors update karo: server/data/browser-selectors.json)');
      clickEl(box); await sleep(400); box.focus();
      setVal(box, ${JSON.stringify(pair)});
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
      await sleep(700);
      const item = await waitFor(() => {
        const cands = $$('[class*="dropdown"] [class*="item"], [class*="result"], [role="option"], [class*="pair"], [class*="symbol"], [class*="suggestion"] li, [class*="suggestion"] div')
          .filter((el) => vis(el));
        return cands.find((el) => (el.textContent || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(want.replace(/[^A-Z0-9]/g, ''))) || null;
      }, { timeout: 6000, label: 'pair dropdown' });
      clickEl(item); await sleep(1800);
      return JSON.stringify({ ok: true, pair: want, picked: (item.textContent || '').trim().slice(0, 60) });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

// Place an order. side LONG|SHORT; price = limit entry; totalINR stake; leverage (margin, best-effort).
// v20.7.6 REWRITE — root cause of "place-order: wait timeout: price input"
// (DOT LONG entry fail):
//   (a) price input detect sirf placeholder/name/aria pe tha — CoinDCX
//       futures panel me placeholder LIVE PRICE NUMBER hota hai, label
//       alag element hota hai → waitFor 5s → ENTRY FAILED.
//   (b) Limit tab click bina verify ke tha — tab div/span hota hai;
//       click fail → panel Market mode me → price input EXIST hi nahi
//       karta → guaranteed timeout.
//   (c) side regex 'want|long|short' — SELL order "Long" button pe bhi
//       match ho sakta tha (wrong-side click ka latent risk).
// Fix: findOrderField (label+attr+positional), limit-tab VERIFY + retry,
// MARKET fallback (failed entry se better), side-strict regex, qty math
// guard, aur fail hone par inputs ka DOM dump error me (agla break log
// se hi diagnosable).
// v20.7.7 HARDENING (deep pro-level recheck):
//   (d) PRICE READ-BACK VERIFY — setVal ke baad React re-render value
//       normalize/revert kar sakta hai (tick-size round, min-notional
//       reset). Ab 400ms baad read-back: mismatch → ek retry (clamped
//       precision) → phir bhi mismatch → THROW. Galat limit price pe
//       order KABHI nahi.
//   (e) QTY SAFETY GATE — qty compute fail (bad math) + qty input
//       mila → pehle 'skip' karke BLIND buy click ho jata tha (form ka
//       default qty = uncontrollable size). Ab THROW — order hi nahi.
//   (f) PRE-CLICK QTY RE-VERIFY — leverage slider etc. ke re-render me
//       amount field khali ho sakti hai; buy click se theek pehle fresh
//       re-find + re-set (khaali → re-set, phir bhi khaali → THROW).
//   (g) DIRECT QTY (opts.qty) — market orders me price null hota hai,
//       total/price math impossible. Ab caller qty seedha de sakta hai.
//   (h) qty ROUND-DOWN (floor) — nearest-round se margin overshoot
//       kabhi nahi ("insufficient margin" reject se bachta hai).
function cxPlaceOrderScript({ side, price, totalINR, leverage, useMargin, qty, livePrice }) {
  return `
    ${DOM_HELPERS}
    const steps = [];
    try {
      if (${JSON.stringify(Boolean(useMargin))}) {
        const m = byText('button, div[role="button"], div, span', /^\\s*margin\\b|margin\\s*trad/i);
        if (m) { clickEl(m); steps.push('margin-tab'); await sleep(800); }
        else steps.push('margin-tab:skip');
      }
      const SIDE = ${JSON.stringify(String(side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG')};
      const PRICE_OK = Number(${Number(price)}) > 0;
      const PRICE = String(${Number(price)});
      const TOTAL = Number(${Number(totalINR)});
      // v20.7.7 (g): direct qty — market order / price-null path
      const QTY_DIRECT = Number(${Number(qty) > 0 ? Number(qty) : 0});
      // v20.7.10 (i): LIVE_PX — caller (proTraderAuto) board ka live tick
      // pass karta hai (sig.ltp). Market-fallback me fill PLAN price pe
      // nahi, current market pe hota hai — qty=TOTAL/PLAN fast-market me
      // notional ko market/plan ratio se OVERSTATE karta tha. Conservative
      // rule niche (j): divisor = max(live, plan) → notional kabhi TOTAL
      // se upar nahi. Limit path exact PLAN pe rehta hai.
      const LIVE_PX = Number(${Number(livePrice) > 0 ? Number(livePrice) : 0});
      // v20.7.6: order-type tabs (Limit/Market) futures desk pe plain
      // div/span bhi hote hain (role/button nahi) — candidates try karo
      // aur HAR click ke baad VERIFY karo ki price input aaya. Verify-gate
      // hai isliye false-positive click bhi harmless hai.
      const tabCands = (re) => $$('button, div[role="tab"], div[role="button"], span, li, a, div')
        .filter((el) => vis(el) && re.test((el.textContent || '').trim()) && (el.textContent || '').trim().length <= 14)
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      let priceInput = null;
      if (PRICE_OK) {
        for (const c of tabCands(/^\\s*limit\\b/i).slice(0, 3)) {
          clickEl(c); await sleep(600);
          priceInput = findOrderField('price');
          if (priceInput) { steps.push('limit-order'); break; }
        }
      }
      let priceSet = false;
      if (priceInput) {
        setVal(priceInput, PRICE); await sleep(400);
        // v20.7.7 (d): READ-BACK VERIFY — React normalize/revert pakdo.
        const readBack = () => String((priceInput && (priceInput.value != null ? priceInput.value : priceInput.textContent)) || '').replace(/[^0-9.]/g, '');
        const close = (a, b) => { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y > 0 && Math.abs(x - y) / y < 0.002; };
        if (close(readBack(), PRICE)) { priceSet = true; steps.push('price=' + PRICE + ':verified'); }
        else {
          // retry #1 — precision clamp (6 sig decimals) ke saath
          const clamped = String(Math.round(Number(PRICE) * 1e6) / 1e6);
          setVal(priceInput, clamped); await sleep(500);
          if (close(readBack(), PRICE)) { priceSet = true; steps.push('price=' + PRICE + ':verified(2nd)'); }
          else {
            // v20.7.7 (d): galat/purana limit price pe order KABHI nahi —
            // form ka stale default (live price) chale jaata jo entry
            // plan se alag ho sakta hai. Honest fail > wrong-price fill.
            throw new Error('price-verify-fail: set ' + PRICE + ' par form me ' + (readBack() || '(empty)') + ' — React reset/precision reject');
          }
        }
      } else {
        // v20.7.6 MARKET FALLBACK: limit UI nahi mila/mount nahi hua —
        // market order se entry lena FAILED entry se better hai (journal
        // steps me honest 'fallback:market-order' note jaata hai).
        const mkt = tabCands(/^\\s*market\\b/i)[0] || null;
        if (mkt) { clickEl(mkt); steps.push('fallback:market-order'); await sleep(600); }
        else steps.push('fallback:market:skip');
      }
      const qtyInput = findOrderField('qty');
      // SAFETY GATE 1: na price na qty — form hi nahi mila. BLIND buy
      // click KABHI nahi (default qty galat size ka order ban sakta hai).
      if (!priceInput && !qtyInput) throw new Error('order form inputs nahi mile (price/qty dono absent) — panel load ya UI change check karo');
      let qtySet = false;
      // v20.7.10 (j): market-fallback me conservative sizing divisor =
      // max(LIVE_PX, PLAN) — notional kabhi TOTAL se upar nahi (upar (i)
      // dekho). LIMIT path (priceInput set) exact PLAN price pe.
      const isMktFallback = !priceInput;
      const sizePx = isMktFallback ? Math.max(LIVE_PX, Number(PRICE) || 0) : Number(PRICE);
      if (isMktFallback && sizePx > 0) steps.push('qty-basis:max(live,plan)=' + (Math.round(sizePx * 100) / 100));
      let intendedQ = NaN;
      if (qtyInput) {
        // v20.7.7 (g)+(h): total/price math, warna direct qty; floor round.
        // Step name me source dikhta hai (journaling: direct vs derived).
        let q = NaN; let viaDirect = false;
        if (TOTAL > 0 && sizePx > 0) q = TOTAL / sizePx;
        else if (QTY_DIRECT > 0) { q = QTY_DIRECT; viaDirect = true; }
        if (Number.isFinite(q) && q > 0) {
          intendedQ = q;
          setVal(qtyInput, String(Math.floor(q * 1e6) / 1e6));
          steps.push(viaDirect ? 'qty-set:direct' : 'qty-set');
          qtySet = true;
        }
      } else steps.push('qty:missing');
      // v20.7.7 (e): SAFETY GATE 2 — qty input mila par set NAHI hua
      // (bad math, price-null market fallback bina direct qty ke) —
      // pehle blind buy click hota tha form ke default qty pe
      // (uncontrollable size!). Ab honest fail.
      if (qtyInput && !qtySet) throw new Error('qty compute fail (total=' + TOTAL + ' price=' + PRICE + ' directQty=' + QTY_DIRECT + ') — blind default-qty order block');
      ${Number(leverage) > 1 ? `
      const levControl = $$('[class*="lever"], [class*="Lever"], input[type="range"], [role="slider"]').filter(vis)[0] || null;
      if (levControl) {
        try {
          const target = Math.min(${Number(leverage)}, 10);
          if (levControl.tagName === 'INPUT') {
            const min = Number(levControl.min || 2), max = Number(levControl.max || 10);
            const ratio = (target - min) / Math.max(1, max - min);
            levControl.focus();
            for (let i = 0; i < Math.ceil(ratio * 40); i++) levControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            steps.push('leverage~' + target);
          } else { steps.push('leverage:manual'); }
        } catch { steps.push('leverage:skip'); }
      } else steps.push('leverage:skip');` : ''}
      // v20.7.7 (f) + v20.7.10 (k): PRE-CLICK QTY RE-VERIFY — leverage/
      // re-render me amount khali YA FORM-DEFAULT pe reset ho sakti hai.
      // Pehle sirf non-empty check tha — React form-default (e.g. 0.001)
      // pass ho jata tha → UNCONTROLLED size ka order! Ab EQUALITY verify
      // (price read-back jaisa): 5% tolerance (site step-rounding ke liye),
      // mismatch → ek re-set → phir bhi mismatch → THROW.
      if (qtySet && Number.isFinite(intendedQ) && intendedQ > 0) {
        await sleep(250);
        const readQ = (el) => String((el && (el.value != null ? el.value : el.textContent)) || '').replace(/[^0-9.]/g, '');
        const qOk = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 && x >= intendedQ * 0.95 && x <= intendedQ * 1.05; };
        if (!qOk(readQ(findOrderField('qty')))) {
          const reQ = (TOTAL > 0 && sizePx > 0) ? TOTAL / sizePx : QTY_DIRECT;
          const qNow = findOrderField('qty');
          if (Number.isFinite(reQ) && reQ > 0 && qNow) { setVal(qNow, String(Math.floor(reQ * 1e6) / 1e6)); await sleep(300); steps.push('qty-reset(after-re-render)'); }
          const q2 = findOrderField('qty');
          if (!q2 || !qOk(readQ(q2))) throw new Error('qty re-verify fail — form me ' + (q2 ? readQ(q2) : '(missing)') + ' chahiye tha ~' + (Math.round(intendedQ * 1e6) / 1e6) + ' (React reset/default-qty block)');
        }
      }
      // v20.7.6 FIX (CRITICAL): purana regex 'want|long|short' tha — SELL
      // order bhi "Long" se shuru hone wale button pe match ho sakta tha
      // (wrong-side click). Ab side-strict: LONG→buy|long, SHORT→sell|short.
      const want = SIDE === 'LONG' ? 'buy|long' : 'sell|short';
      const btn = await waitFor(() => $$('button, div[role="button"]')
        .filter((el) => vis(el) && new RegExp('^(' + want + ')\\\\b', 'i').test((el.textContent || '').trim()))[0] || null,
        { timeout: 6000, label: (SIDE === 'LONG' ? 'buy' : 'sell') + ' button' });
      clickEl(btn); steps.push('clicked:' + (SIDE === 'LONG' ? 'buy' : 'sell'));
      await sleep(900);
      const confirm = byText('button', /confirm|place\\s*order|submit|proceed/i);
      if (confirm) { clickEl(confirm); steps.push('confirm-modal'); await sleep(1200); }
      else steps.push('confirm:skip');
      // v20.7.10 (l): error-scan DO baar (t=2.1s + t=3.4s) — reject toasts
      // fade ho kar pehli scan miss ho sakte the (ok:!err swallow window).
      // Late-scan step me honest note jaata hai.
      const errScan = () => $$('[class*="error"], [class*="Error"], [role="alert"]').filter(vis).map((el) => (el.textContent || '').trim()).filter(Boolean)[0] || null;
      let err = errScan();
      if (!err) { await sleep(1300); err = errScan(); if (err) steps.push('error:late-scan'); }
      return JSON.stringify({ ok: !err, steps, pageError: err || null, url: location.href });
    } catch (e) {
      // v20.7.6 DIAGNOSTICS: fail par page ke visible inputs ka snapshot
      // error me pack karo — selector break hone pe log se hi pata chalega
      // ki page me ACTUALLY kya tha.
      let inputsDump = '';
      try {
        inputsDump = JSON.stringify($$('input').filter((el) => vis(el)).slice(0, 10).map((el) => ({
          t: el.type, m: el.getAttribute('inputmode') || null, ph: String(el.placeholder || '').slice(0, 18),
          n: el.name || null, id: el.id || null, a: el.getAttribute('aria-label') || null,
        })));
      } catch {}
      return JSON.stringify({ ok: false, steps, error: String(e && e.message || e), inputs: inputsDump, url: location.href });
    }
  `;
}

// Read open positions (reconciliation). Returns raw rows — conservative.
function cxReadPositionsScript() {
  return `
    ${DOM_HELPERS}
    try {
      const containers = $$('table, [class*="position" i]').filter((el) => vis(el) && /position/i.test(el.textContent || ''));
      const table = containers[0] || null;
      if (!table) return JSON.stringify({ ok: true, positions: [], note: 'positions container nahi mila' });
      const rows = $$('tr, [class*="row"]', table).filter((el) => {
        const t = (el.textContent || '').trim();
        return t.length > 20 && /\\d/.test(t) && !/pair|symbol|side|qty/i.test(t.slice(0, 12));
      }).slice(0, 30);
      const positions = rows.map((row) => {
        const cells = $$('td, [class*="cell"]', row).map((c) => (c.textContent || '').trim()).filter(Boolean);
        const text = (row.textContent || '').replace(/\\s+/g, ' ').trim();
        const nums = (text.match(/[+-]?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        return { cells: cells.slice(0, 14), text: text.slice(0, 220), nums: nums.slice(0, 12) };
      }).filter((p) => p.text.length > 20);
      return JSON.stringify({ ok: true, positions });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

// Close a position from the positions panel (best-effort: find row with
// pair text, click its exit/close button, confirm).
// v20.7.10: SIDE-AWARE row match — pehle 'side' param KABHI use nahi hota
// tha; same pair pe do rows (hedge long+short, ya manual + SAPTA trade)
// ho to FIRST match close hota tha — galat position close + CLOSE_UNKNOWN
// retry loop bhi wahi galat row pe 8 baar chalti thi. Ab pair+side wali
// row prefer; side EXACTLY 'LONG'/'SHORT' hi trusted hai — unknown/null
// side pe single-row to close hota hai (side:unknown note), MULTI-row pe
// REFUSE (galat row close karne se bhaale risk ho).
function cxClosePositionScript(pair, side) {
  return `
    ${DOM_HELPERS}
    try {
      const want = ${JSON.stringify(String(pair).toUpperCase())};
      // v20.7.10 (fix): undefined/null/'' side ko 'LONG' default MAT karo —
      // hedge (LONG+SHORT dono rows) me galat row close ho sakti thi. Sirf
      // exact 'LONG'/'SHORT' trusted; warna side-unknown safe mode.
      const SIDE_RAW = String(${JSON.stringify(String(side || ''))}).toUpperCase();
      const SIDE_WANT = (SIDE_RAW === 'LONG' || SIDE_RAW === 'SHORT') ? SIDE_RAW : null;
      const sideRe = SIDE_WANT === 'LONG' ? /\\b(long|buy)\\b/i : /\\b(short|sell)\\b/i;
      const containers = $$('table, [class*="position" i]').filter((el) => vis(el) && /position/i.test(el.textContent || ''));
      const steps = [];
      // v20.7.10 (fix3): CELL-AWARE side match — row ka textContent cells
      // ko bina space ke concat karta hai ('B-DOT_USDT'+'SHORT' =
      // 'B-DOT_USDTSHORT') jahan \b(word-boundary) regex FAIL hota hai.
      // Side_exchange tables me almost hamesha apne alag cell/badge me
      // hota hai — pehle per-cell match, phir spaced whole-row fallback.
      const sideIn = (el, re) => {
        const cells = $$('td, th, span, div, p, b, strong', el);
        if (cells.some((c) => re.test(String(c.textContent || '').trim()))) return true;
        return re.test(' ' + String(el.textContent || '').replace(/[\\s\\n\\r]+/g, ' ') + ' ');
      };
      let row = null;
      for (const c of containers) {
        const rows = $$('tr, [class*="row"]', c).filter((el) => (el.textContent || '').toUpperCase().includes(want));
        if (rows.length === 0) continue;
        // v20.7.10: side-matching row pehle (sirf trusted side pe); nahi
        // mili to hi pair-only (single-position case waise bhi same row).
        if (SIDE_WANT) {
          const m = rows.find((el) => sideIn(el, sideRe)) || null;
          if (m) { row = m; steps.push('row-found:side-match'); break; }
          // v20.7.10 (fix2): opposite-side keyword mila = ye pair ki ULAT
          // position hai — chahe SINGLE row ho, close MAT karo (wrong-side
          // close). Agla container dekho; kahin nahi → honest refuse.
          const opp = SIDE_WANT === 'LONG' ? /\\b(short|sell)\\b/i : /\\b(long|buy)\\b/i;
          if (rows.some((el) => sideIn(el, opp))) { steps.push('rows:' + rows.length + ':opposite-side-only'); continue; }
        }
        if (rows.length === 1) { row = rows[0]; steps.push('row-found:side-unknown'); break; }
        // multiple rows, koi side-match nahi — safest: close MAT karo
        // (galat row close karne se bhaale risk ho)
        steps.push('rows:' + rows.length + ':no-side-match');
      }
      if (!row) return JSON.stringify({ ok: false, error: 'position row nahi mili (pair=' + want + ' side=' + (SIDE_WANT || 'UNKNOWN') + ')', steps });
      const exitBtn = $$('button, [role="button"], a, span', row).filter(vis).find((el) => /exit|close|square\\s*off/i.test((el.textContent || '').trim())) || null;
      if (exitBtn) { clickEl(exitBtn); steps.push('exit-click'); }
      else {
        const menuBtn = $$('button, [role="button"], [class*="menu"], [class*="action"]', row).filter(vis).slice(-1)[0] || null;
        if (!menuBtn) return JSON.stringify({ ok: false, error: 'exit button nahi mila', steps });
        clickEl(menuBtn); await sleep(700); steps.push('menu-open');
        const exitAll = byText('button, li, span, div', /exit|close\\s*all|square\\s*off/i);
        if (!exitAll) return JSON.stringify({ ok: false, error: 'menu me exit option nahi mila', steps });
        clickEl(exitAll); steps.push('menu-exit');
      }
      await sleep(800);
      const confirm = byText('button', /confirm|yes|proceed|close/i);
      if (confirm) { clickEl(confirm); steps.push('confirm'); }
      await sleep(1000);
      return JSON.stringify({ ok: true, steps, closed: want });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

// ---------------- Dhan in-page operations ----------------
const DHAN_OPEN_URL = 'https://web.dhan.co';

function dhanHealthScript() {
  return `
    ${DOM_HELPERS}
    try {
      const search = $$('input').find((el) => vis(el) && /search|scrip|stock|symbol/i.test(el.placeholder || el.getAttribute('aria-label') || ''));
      const buyBtn = $$('button, div[role="button"]').filter((el) => vis(el) && /^buy\\b/i.test((el.textContent || '').trim()))[0] || null;
      const sellBtn = $$('button, div[role="button"]').filter((el) => vis(el) && /^sell\\b/i.test((el.textContent || '').trim()))[0] || null;
      const product = byText('button, div[role="button"], div', /intraday|mtf|delivery/i);
      const qtyInput = $$('input').find((el) => vis(el) && /qty|quantity/i.test(el.placeholder || el.getAttribute('aria-label') || ''));
      const priceInput = $$('input').find((el) => vis(el) && /price|limit/i.test(el.placeholder || el.getAttribute('aria-label') || ''));
      return JSON.stringify({ ok: true, url: location.href, found: {
        searchBox: !!search, buyBtn: !!buyBtn, sellBtn: !!sellBtn, productSelect: !!product, qtyInput: !!qtyInput, priceInput: !!priceInput,
      }});
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

function dhanSelectScripScript(symbol) {
  return `
    ${DOM_HELPERS}
    try {
      const box = $$('input').find((el) => vis(el) && /search|scrip|stock|symbol/i.test(el.placeholder || el.getAttribute('aria-label') || ''));
      if (!box) throw new Error('dhan search box nahi mila');
      clickEl(box); await sleep(400); box.focus();
      setVal(box, ${JSON.stringify(symbol)});
      await sleep(900);
      const want = ${JSON.stringify(String(symbol).toUpperCase())};
      const item = await waitFor(() => {
        const cands = $$('[class*="result"], [class*="dropdown"] [class*="item"], [role="option"], [class*="suggestion"] li, [class*="suggestion"] div, [class*="search"] [class*="item"]').filter(vis);
        return cands.find((el) => (el.textContent || '').toUpperCase().includes(want)) || null;
      }, { timeout: 6000, label: 'dhan scrip dropdown' });
      clickEl(item); await sleep(2000);
      return JSON.stringify({ ok: true, picked: (item.textContent || '').trim().slice(0, 80) });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

function dhanPlaceOrderScript({ side, price, quantity, product }) {
  return `
    ${DOM_HELPERS}
    try {
      const steps = [];
      if (${JSON.stringify(String(product))} !== 'MARKET') {
        const limitBtn = byText('button, div[role="button"], div', /limit/i);
        if (limitBtn) { clickEl(limitBtn); steps.push('limit'); await sleep(400); }
        else steps.push('limit:skip');
      }
      const priceInput = findOrderField('price');
      if (priceInput && ${Number(price)} > 0) { setVal(priceInput, ${JSON.stringify(String(price))}); steps.push('price'); }
      // v20.7.6: findOrderField — Dhan bhi label-only inputs use karta hai
      const qtyInput = await waitFor(() => findOrderField('qty'), { timeout: 5000, label: 'qty input' });
      setVal(qtyInput, ${JSON.stringify(String(Math.max(1, Math.floor(Number(quantity) || 1))))}); steps.push('qty');
      const prodSel = byText('button, div[role="button"], div', /intraday|mtf|delivery/i);
      if (prodSel) { clickEl(prodSel); await sleep(500); steps.push('product-menu');
        const want = byText('li, [role="option"], span, div', new RegExp(${JSON.stringify(String(product))}, 'i'));
        if (want) { clickEl(want); steps.push('product=' + ${JSON.stringify(String(product))}); await sleep(400); }
      } else steps.push('product:skip');
      const want = ${JSON.stringify(side === 'LONG' ? 'buy' : 'sell')};
      const btn = await waitFor(() => $$('button, div[role="button"]').filter((el) => vis(el) && new RegExp('^' + want, 'i').test((el.textContent || '').trim()))[0] || null, { timeout: 5000, label: want + ' button' });
      clickEl(btn); steps.push('clicked:' + want);
      await sleep(800);
      const confirm = byText('button', /confirm|place|submit|proceed/i);
      if (confirm) { clickEl(confirm); steps.push('confirm'); await sleep(1000); }
      const err = $$('[class*="error"], [role="alert"]').filter(vis).map((el) => (el.textContent || '').trim()).filter(Boolean)[0] || null;
      return JSON.stringify({ ok: !err, steps, pageError: err || null, url: location.href });
    } catch (e) { return JSON.stringify({ ok: false, steps: [], error: String(e && e.message || e) }); }
  `;
}

// v18.6.4: Dhan side CLOSE (best-effort DOM) — the EOD-squareoff /
// reversal exit path for India positions. Hunts any visible positions
// panel row mentioning the scrip, clicks its exit/close/square-off
// control, confirms. Honest failure (row nahi mila / panel closed)
// returns ok:false — the engine then keeps the trade in CLOSE_UNKNOWN
// and re-attempts (never journals a close that did not happen).
function dhanClosePositionScript(symbol, _side) {
  return `
    ${DOM_HELPERS}
    try {
      const want = ${JSON.stringify(String(symbol).toUpperCase())};
      const steps = [];
      // positions panel: Dhan web exposes a positions/holdings table
      // (bottom panel or the positions page). Hunt any visible row.
      const containers = $$('table, [class*="position" i], [class*="holding" i]').filter((el) => vis(el));
      let row = null;
      for (const c of containers) {
        row = $$('tr, [class*="row"]', c).find((el) => {
          const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          return t.toUpperCase().includes(want) && /\\d/.test(t) && t.length > 20;
        }) || null;
        if (row) break;
      }
      if (!row) return JSON.stringify({ ok: false, error: 'dhan position row nahi mila: ' + want, steps });
      steps.push('row-found');
      const exitBtn = $$('button, [role="button"], a, span', row).filter(vis).find((el) => /exit|close|square\\s*off/i.test((el.textContent || '').trim())) || null;
      if (exitBtn) { clickEl(exitBtn); steps.push('exit-click'); }
      else {
        const menuBtn = $$('button, [role="button"], [class*="menu"], [class*="action"], [class*="icon"]', row).filter(vis).slice(-1)[0] || null;
        if (!menuBtn) return JSON.stringify({ ok: false, error: 'exit button nahi mila', steps });
        clickEl(menuBtn); await sleep(700); steps.push('menu-open');
        const exitAll = byText('button, li, span, div', /exit|close|square\\s*off/i);
        if (!exitAll) return JSON.stringify({ ok: false, error: 'menu me exit option nahi mila', steps });
        clickEl(exitAll); steps.push('menu-exit');
      }
      await sleep(800);
      const confirm = byText('button', /confirm|yes|proceed|close|sell|buy/i);
      if (confirm) { clickEl(confirm); steps.push('confirm'); }
      await sleep(1000);
      const err = $$('[class*="error"], [role="alert"]').filter(vis).map((el) => (el.textContent || '').trim()).filter(Boolean)[0] || null;
      return JSON.stringify({ ok: !err, steps, closed: want, pageError: err || null, url: location.href });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
  `;
}

// ---------------- public API ----------------
export async function browserConnect({ probe = false } = {}) {
  await discoverTabs({ force: true });
  const out = {
    connected: !!state.browser, browser: state.browser,
    host: state.host || CDP_HOST, port: state.port || CDP_PORTS[0], portsTried: CDP_PORTS,
    tabs: {}, lastError: state.lastError,
  };
  for (const key of Object.keys(TAB_MATCH)) {
    const t = state.tabs[key];
    out.tabs[key] = t
      ? { found: true, url: t.url, title: t.title }
      : { found: false, hint: state.browser ? `AUTOMATION window me ${key === 'coindcx' ? 'coindcx.com/trade' : 'web.dhan.co'} tab kholo (normal browser ka tab count nahi hota)` : null };
  }
  if (probe) {
    for (const key of ['coindcx', 'dhan']) {
      if (!out.tabs[key]?.found) continue;
      try {
        const page = await pageFor(key);
        const script = key === 'coindcx' ? cxHealthScript() : dhanHealthScript();
        const r = await page.evaluate(script, { timeoutMs: 12000 });
        out.tabs[key].health = r;
      } catch (e) { out.tabs[key].health = { ok: false, error: String(e?.message || e) }; }
    }
  }
  return out;
}

export function browserStatus() {
  // v18.6.2: tabs ko SAFE projection ke saath do — frontend ko hint bhi
  // dikhe (connected hai par tab missing case me kya kholna hai).
  const tabs = {};
  for (const key of Object.keys(TAB_MATCH)) {
    const t = state.tabs[key];
    tabs[key] = t
      ? { found: true, url: t.url, title: t.title }
      : { found: false, hint: state.browser ? `AUTOMATION window me ${key === 'coindcx' ? 'coindcx.com/trade' : 'web.dhan.co'} tab kholo (normal browser ka tab count nahi hota)` : null };
  }
  return {
    connected: !!state.browser, browser: state.browser,
    host: state.host || CDP_HOST, port: state.port || CDP_PORTS[0], portsTried: CDP_PORTS,
    tabs, lastError: state.lastError,
    hint: state.browser ? _tabsHint() : 'Start-AutoBrowser.bat chalao — ye SmartAI ka DEDICATED automation window kholta hai (9222 debug port). NORMAL browser me khuli CoinDCX/Dhan tabs count NAHI hoti; Chrome/Edge 136+ default profile pe debug port block karta hai, isliye bat wala dedicated profile + ek baar login zaroori hai',
  };
}

export async function cxEnsureTradePage(pairUrlHint) {
  // v20.7.4 FIX: pageFor() createUrl sirf tab MISSING hone pe use karta
  // hai — existing CoinDCX tab jis page par chhoda gaya ho wahi rehta
  // tha (dashboard / purana spot page), phir cxSelectPair wahan search
  // box dhoondhta rehta tha. Ab live URL check karke tab ko TARGET pair
  // page par navigate karo (futures: /futures/B-PAIR_USDT).
  const page = await pageFor('coindcx', { createUrl: pairUrlHint || CX_OPEN_URL });
  const target = String(pairUrlHint || CX_OPEN_URL);
  try {
    const wantTok = String(target).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const pairTok = (target.split('/').pop() || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cur = await page.currentUrl();
    const curTok = String(cur || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // normalize kiye gaye current URL me target ka pair token na mile → navigate
    if (!(pairTok && curTok.includes(pairTok)) && curTok !== wantTok) {
      await page.navigate(target);
    }
  } catch { /* honest degrade — select-pair stage verify karega */ }
  return page;
}

export async function cxSelectPair(page, pair) {
  return page.evaluate(cxSelectPairScript(pair), { timeoutMs: 20000 });
}

export async function cxPlaceOrder(page, opts) {
  const r = await page.evaluate(cxPlaceOrderScript(opts), { timeoutMs: 30000 });
  r.shot = await page.screenshot(`cx-${opts.side}-${Date.now() % 100000}`);
  return r;
}

export async function cxReadPositions() {
  const page = await pageFor('coindcx').catch(() => null);
  if (!page) return { ok: false, error: 'coindcx tab not available' };
  return page.evaluate(cxReadPositionsScript(), { timeoutMs: 15000 });
}

export async function cxClosePosition(pair, side) {
  const page = await pageFor('coindcx');
  const r = await page.evaluate(cxClosePositionScript(pair, side), { timeoutMs: 25000 });
  r.shot = await page.screenshot(`cx-close-${pair}`);
  return r;
}

export async function dhanEnsurePage() {
  return pageFor('dhan', { createUrl: DHAN_OPEN_URL });
}

export async function dhanSelectScrip(page, symbol) {
  return page.evaluate(dhanSelectScripScript(symbol), { timeoutMs: 20000 });
}

export async function dhanPlaceOrder(page, opts) {
  const r = await page.evaluate(dhanPlaceOrderScript(opts), { timeoutMs: 30000 });
  r.shot = await page.screenshot(`dhan-${opts.side}-${Date.now() % 100000}`);
  return r;
}

// v18.6.4: close an India position in the user's logged-in Dhan tab.
export async function dhanClosePosition(symbol, side) {
  const page = await dhanEnsurePage();
  const r = await page.evaluate(dhanClosePositionScript(symbol, side), { timeoutMs: 25000 });
  try { r.shot = await page.screenshot(`dhan-close-${String(symbol).slice(0, 10)}-${Date.now() % 100000}`); } catch { /* shot optional */ }
  return r;
}

// v18.6.4: read Dhan's visible positions panel (reconciliation probe).
export async function dhanReadPositions() {
  const page = await pageFor('dhan').catch(() => null);
  if (!page) return { ok: false, error: 'dhan tab not available' };
  return page.evaluate(cxReadPositionsScript(), { timeoutMs: 15000 });
}

export function shotDir() { return SHOT_DIR; }

// v20.7.6: test-only — script builders expose karo (jsdom me evaluate
// karke order-form driver logic verify hota hai). Production paths is
// se kuch nahi lete — scripts private hi rehte hain.
export function __orderFormScriptsForTests() {
  return { DOM_HELPERS, cxPlaceOrderScript, cxHealthScript, cxSelectPairScript, dhanPlaceOrderScript, cxClosePositionScript };
}
