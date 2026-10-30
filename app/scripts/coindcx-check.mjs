#!/usr/bin/env node
// ============================================================
// scripts/coindcx-check.mjs — CoinDCX IP-binding + key health check
// ------------------------------------------------------------
// CoinDCX made IP binding mandatory on 28 Oct 2026. A key only works
// from the IPv4 address entered in the API Dashboard, and this server
// can have more than one egress address (IPv6/NAT64 vs IPv4). Run:
//
//   npm run coindcx:ip      → print the exact IPv4 to bind
//   npm run coindcx:check   → IPv4 + validate .env/saved keys (read-only)
//
// Secrets are NEVER printed. The balance call is a read-only
// /exchange/v1/users/balances request.
// ============================================================
import 'dotenv/config';
import { getOutboundIPv4 } from '../server/lib/outboundIp.js';
import { loadJSON } from '../server/lib/store.js';
import {
  coindcxEnvCreds,
  fetchBalancesSigned,
  normalizeBalances,
} from '../server/mcp/coindcx.js';

const ipOnly = process.argv.includes('--ip-only');

function line(text = '') { console.log(text); }
function mask(label) { return label; }

async function main() {
  const ip = await getOutboundIPv4({ refresh: true });
  line('============================================================');
  line(' CoinDCX IP-binding check');
  line('============================================================');
  line(` Server outbound IPv4 : ${ip || 'DETECT FAILED (network/proxy issue)'}`);
  line(' CoinDCX API Dashboard me YAHI IPv4 bind karein.');
  line(' CoinDCX → Profile → API Dashboard → purani key DELETE →');
  line(' Create A New One → "Bind IP Address to the API Key" → paste the IPv4.');
  line('');
  if (ipOnly) {
    if (!ip) process.exitCode = 1;
    return;
  }

  const envCreds = coindcxEnvCreds();
  const saved = loadJSON('mcp-coindcx.json', null);
  const savedCreds = saved && saved.apiKey && saved.secret
    ? { apiKey: saved.apiKey, secret: saved.secret }
    : null;

  if (!envCreds && !savedCreds) {
    line(' Koi CoinDCX key nahi mili.');
    line(' app\\.env me COINDCX_API_KEY + COINDCX_SECRET daalein, phir dobara chalayein.');
    process.exitCode = 1;
    return;
  }

  const seen = new Set();
  const candidates = [];
  if (envCreds) candidates.push({ label: 'ENV (.env)', ...envCreds });
  if (savedCreds && !seen.has(savedCreds.apiKey)) {
    seen.add(savedCreds.apiKey);
    candidates.push({ label: 'SAVED (server/data/mcp-coindcx.json)', ...savedCreds });
  }

  let anyOk = false;
  const results = [];
  for (const cand of candidates) {
    try {
      const raw = await fetchBalancesSigned(cand.apiKey, cand.secret);
      const balances = normalizeBalances(raw);
      anyOk = true;
      results.push({ ...cand, ok: true, balances: balances.length });
      line(` ${cand.label}: ✅ OK — ${balances.length} balance rows`);
    } catch (e) {
      results.push({ ...cand, ok: false, error: String(e?.message || e) });
      line(` ${cand.label}: ❌ ${String(e?.message || e).slice(0, 320)}`);
    }
  }

  line('');
  const envResult = results.find(r => r.label === 'ENV (.env)');
  if (envResult?.ok) {
    line(' ACTIVE SOURCE: .env key works. Server restart ke baad wallet LIVE connect hoga.');
  } else if (envResult && !envResult.ok && results.some(r => r.ok)) {
    line(' ⚠ .env key FAIL ho rahi hai, lekin saved key chal rahi hai.');
    line('   App boot par .env key try karega (naya pair priority) aur fail hone par');
    line('   saved key preserve karega. Best: .env me working key daalein.');
  } else if (!anyOk) {
    line(' ❌ Koi bhi key CoinDCX se authenticate nahi ho rahi.');
    line('   Iska matlab: key purani/deleted hai, secret galat hai, ya key kisi');
    line('   dusre IP se bound hai. CoinDCX par purani key DELETE karke');
    line(`   ${ip || '<server IPv4>'} bind karke NAYA key banayein, phir .env update karein.`);
  }
  line('');
  line(' Note: CoinDCX IP binding ke bagair koi bhi key kaam nahi karegi.');
  line('============================================================');
  if (!anyOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[coindcx-check] failed: ${String(e?.message || e)}`);
  process.exitCode = 1;
});
