// ============================================================
// test/slReadBackV21280.test.ts — v21.28.0 F5 EXCHANGE SL READ-BACK
// ------------------------------------------------------------
// updateCoinDcxPositionSl pehle journal naya SL likh deta tha aur exchange
// push accept hua ya nahi / actually laga ya nahi — verify nahi hota tha.
// Ab: exchange push → read-back (2-3 attempts) → tab journal update.
// Read-back retry sirf READ karta hai; naya create_tpsl order nahi bhejta
// (CoinDCX replace-vs-stack behaviour live-verify hone tak safe).
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { slReadBackMatches } from '../server/ai/futures.js';

const SRC = fs.readFileSync(path.resolve('server/ai/futures.js'), 'utf8');

describe('v21.28.0 F5 — SL read-back match (pure)', () => {
  it('exact and sub-0.05% exchange rounding match', () => {
    expect(slReadBackMatches({ actualSl: 98.5, expectedSl: 98.5 })).toBe(true);
    expect(slReadBackMatches({ actualSl: 98.54, expectedSl: 98.5 })).toBe(true);
    expect(slReadBackMatches({ actualSl: 98.46, expectedSl: 98.5 })).toBe(true);
  });

  it('materially different / zero / invalid SL never matches', () => {
    expect(slReadBackMatches({ actualSl: 97, expectedSl: 98.5 })).toBe(false);
    expect(slReadBackMatches({ actualSl: 0, expectedSl: 98.5 })).toBe(false);
    expect(slReadBackMatches({ actualSl: null, expectedSl: 98.5 })).toBe(false);
    expect(slReadBackMatches({ actualSl: 98.5, expectedSl: 0 })).toBe(false);
  });
});

describe('v21.28.0 F5 — updateCoinDcxPositionSl ordering + telemetry pins', () => {
  it('exchange push happens before the journal write (journal-first bug gone)', () => {
    const fn = SRC.slice(SRC.indexOf('export async function updateCoinDcxPositionSl'));
    const body = fn.slice(0, fn.indexOf('\n}\n', fn.indexOf('export async function updateCoinDcxPositionSl')));
    const pushAt = body.indexOf('await createFuturesTpsl');
    const journalAt = body.indexOf('await writeJournal({\n    verified: readBack.verified');
    expect(pushAt).toBeGreaterThan(-1);
    expect(journalAt).toBeGreaterThan(pushAt);
    // The old unconditional early journal block must not return.
    expect(body).not.toMatch(/if \(jPos\) \{\s*\/\/ Journal mutations/);
  });

  it('unverified read-back is surfaced (not silently ok:true)', () => {
    expect(SRC).toContain("protectionState = readBack.verified ? 'PROTECTED' : 'UNVERIFIED'");
    expect(SRC).toContain("protectionState: 'PROTECTION_PUSH_FAILED'");
    expect(SRC).toContain('ok: readBack.verified');
    expect(SRC).toContain('retryAfterMs: readBack.verified ? 0 : 60_000');
  });

  it('read-back retries only read the position; no second create order inside it', () => {
    const fn = SRC.slice(SRC.indexOf('async function _readBackCoinDcxSl'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('listFuturesPositions');
    expect(body).not.toContain('createFuturesTpsl');
  });
});
