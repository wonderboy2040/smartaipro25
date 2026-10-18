// ============================================================
// server/ai/agentMemory.js — v10.8 PRO #3: LIGHTWEIGHT CHAT MEMORY
// ------------------------------------------------------------
// (Vibe-Trading memory port, right-sized). The desk chat agents
// (crypto / india / protrade) were stateless per session — the agent
// forgot "SOL ka view diya tha 3 din pehle". This module keeps a
// per-desk RING of recent Q&A turns tagged with the symbols and
// topics the user actually asked about, and renders the last few as
// a compact context block that feeds the system prompt — continuity
// without the full semantic-search hierarchy (80% of the value at a
// fraction of the cost).
//
//   • rememberChat(desk, { q, a })   — called after every answered turn
//   • memoryContextFor(desk)         — prompt block (null when empty)
//   • ring cap 60/desk, prompt uses the last 8 + topic tally
//   • durable-backed (survives restarts), best-effort everywhere —
//     a memory failure can never break a chat reply
// ============================================================
import { loadJSON, saveJSON } from '../lib/store.js';
import { durablePut } from '../mcp/durable.js';

const MEMORY_FILE = 'ai-chat-memory.json';
const DESKS = ['crypto', 'india', 'protrade'];
const RING_CAP = 60;        // entries kept per desk
const CTX_ENTRIES = 8;       // entries fed into the prompt
const Q_MAX = 220;           // stored question truncation
const A_MAX = 260;           // stored answer truncation

// Known asset universes — symbol extraction stays a whitelist match
// (no hallucinated tickers), plus the repo's own pair shapes.
const KNOWN_SYMBOLS = new Set([
  // crypto majors + CoinDCX staples
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX',
  'DOT', 'LTC', 'MATIC', 'POL', 'SHIB', 'PEPE', 'BONK', 'WIF', 'SUI', 'APT',
  'ARB', 'OP', 'NEAR', 'ATOM', 'FIL', 'ETC', 'BCH', 'UNI', 'AAVE', 'CRV',
  'INJ', 'TIA', 'SEI', 'RNDR', 'FET', 'AR', 'STX', 'IMX', 'GALA', 'SAND',
  'AXS', 'CHZ', 'EOS', 'XLM', 'HBAR', 'VET', 'ALGO', 'IOTA', 'QTUM', 'ZIL',
  // India desk
  'NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'ITC', 'LT', 'AXISBANK', 'KOTAKBANK', 'BHARTIARTL', 'ASIANPAINT',
  'MARUTI', 'TATAMOTORS', 'TATASTEEL', 'WIPRO', 'HCLTECH', 'ADANIENT',
  // global equity SIM desk
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'SPACEX',
  'MU', 'AMD', 'INTC', 'AVGO', 'QCOM', 'TXN', 'SMCI', 'PLTR', 'COIN',
  'NFLX', 'ORCL', 'ADBE', 'UBER',
]);

const TOPIC_RULES = [
  [/buy|kharid|long\b|entry/i, 'buy-call'],
  [/sell|bech|short\b/i, 'sell-call'],
  [/risk|stop|sl\b|margin|leverage/i, 'risk'],
  [/pnl|profit|loss|kitna|hisaab/i, 'pnl'],
  [/agent|auto|robot/i, 'auto-agent'],
  [/backtest|strategy|replay/i, 'backtest'],
  [/regime|trend|market kaisa|overview|briefing/i, 'regime'],
  [/funding|premium|carry/i, 'funding'],
  [/wallet|balance|capital|paisa/i, 'wallet'],
];

/** Symbols mentioned in a chat turn (whitelist + pair shapes). PURE. */
export function extractSymbols(text) {
  const t = String(text || '').toUpperCase();
  const out = new Set();
  // pair shapes: B-SOL_USDT · SOLINR · SOL-USD · SOL/USDC
  for (const m of t.matchAll(/\bB-([A-Z0-9]{2,10})_USDT\b/g)) out.add(m[1]);
  for (const m of t.matchAll(/\b([A-Z0-9]{2,10})INR\b/g)) out.add(m[1]);
  for (const m of t.matchAll(/\b([A-Z0-9]{2,10})-(?:USD|USDC|USDT)\b/g)) out.add(m[1]);
  // plain known-symbol mentions (word-boundary so TCS ≠ TC)
  for (const sym of KNOWN_SYMBOLS) {
    if (new RegExp(`\\b${sym}\\b`).test(t)) out.add(sym);
  }
  return [...out].slice(0, 6);
}

/** Topic tags for a turn (keyword rules). PURE. */
function topicsOf(text) {
  const t = String(text || '');
  const out = [];
  for (const [re, tag] of TOPIC_RULES) if (re.test(t)) out.push(tag);
  return out.slice(0, 3);
}

function loadMemory() {
  const saved = loadJSON(MEMORY_FILE, null);
  if (!saved || typeof saved !== 'object') return { desks: {} };
  const desks = {};
  for (const d of DESKS) desks[d] = Array.isArray(saved.desks?.[d]) ? saved.desks[d] : [];
  return { desks };
}

function persist(mem) {
  saveJSON(MEMORY_FILE, mem);
  try { durablePut(MEMORY_FILE, mem); } catch { /* best-effort */ }
}

/**
 * Record one answered turn. Best-effort — never throws.
 * @param {'crypto'|'india'|'protrade'} desk
 * @param {{q: string, a: string}} turn
 */
export function rememberChat(desk, { q, a }) {
  try {
    if (!DESKS.includes(desk)) return false;
    const question = String(q || '').trim();
    const answer = String(a || '').trim();
    if (!question) return false;
    const mem = loadMemory();
    mem.desks[desk] = mem.desks[desk] || [];
    mem.desks[desk].push({
      at: Date.now(),
      q: question.slice(0, Q_MAX),
      a: answer.slice(0, A_MAX),
      symbols: extractSymbols(question + ' ' + answer.slice(0, 120)),
      topics: topicsOf(question),
    });
    if (mem.desks[desk].length > RING_CAP) mem.desks[desk] = mem.desks[desk].slice(-RING_CAP);
    persist(mem);
    return true;
  } catch { return false; }
}

const ago = (ts) => {
  const h = Math.round((Date.now() - ts) / 3600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * The system-prompt context block for a desk — recent turns as
 * one-liners + the most-asked symbols/topics tally. null when the
 * desk has no history (first-time users see zero prompt bloat).
 */
export function memoryContextFor(desk) {
  try {
    if (!DESKS.includes(desk)) return null;
    const entries = (loadMemory().desks[desk] || []).slice(-CTX_ENTRIES);
    if (entries.length === 0) return null;
    const lines = entries.map(e =>
      `- ${ago(e.at)}: Q "${e.q.slice(0, 110)}"${e.symbols?.length ? ` [${e.symbols.join('/')}]` : ''} → A: ${String(e.a || '').slice(0, 90).replace(/\s+/g, ' ')}…`);
    // interest tally over the whole ring (not just the prompt window)
    const ring = (loadMemory().desks[desk] || []);
    const symCount = new Map();
    const topicCount = new Map();
    for (const e of ring) {
      for (const s of e.symbols || []) symCount.set(s, (symCount.get(s) || 0) + 1);
      for (const t of e.topics || []) topicCount.set(t, (topicCount.get(t) || 0) + 1);
    }
    const topSyms = [...symCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
    const topTopics = [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    return [
      `Recent conversations with this user (newest last):`,
      ...lines,
      topSyms.length ? `User's recurring focus: ${topSyms.join(', ')}${topTopics.length ? ` · themes: ${topTopics.join(', ')}` : ''}` : '',
      `Use this continuity naturally — reference earlier views when relevant ("pichhli baar SOL pe short view tha") without re-explaining. Never contradict what you said earlier without saying what changed.`,
    ].filter(Boolean).join('\n');
  } catch { return null; }
}

/** Memory stats (panel/debug). */
export function memoryStats(desk) {
  try {
    const ring = (loadMemory().desks[desk] || []);
    return { desk, entries: ring.length, cap: RING_CAP, promptWindow: Math.min(CTX_ENTRIES, ring.length) };
  } catch { return { desk, entries: 0, cap: RING_CAP, promptWindow: 0 }; }
}

// test hooks ------------------------------------------------
export function __resetMemoryForTests() {
  persist({ desks: {} });
}
export function __memoryRawForTests() {
  return loadMemory();
}
