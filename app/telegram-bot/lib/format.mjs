// All user-facing text lives here. Dynamic values are escaped exactly once;
// the bot never invents a number that the site API did not return.

import {
  ago,
  asNumber,
  duration,
  esc,
  formatPlainBlock,
  htmlToPlain,
  inr,
  istDayStart,
  istTime,
  maskId,
  money,
  num,
  pct,
  price,
  redactSecrets,
  signedNum,
  truncate,
} from './util.mjs';

const TIER_EMOJI = {
  ELITE: '🟣',
  STRONG: '🟢',
  ACTION: '🔵',
  WATCH: '🟡',
  NEUTRAL: '⚪',
};

const SIDE_EMOJI = { LONG: '🟢', SHORT: '🔴', WAIT: '⚪', NEUTRAL: '⚪' };

const okMark = (value) => {
  if (value === true) return '✅';
  if (value === false) return '❌';
  return '—';
};

const objectMark = (value) => {
  if (value === true) return '✅';
  if (value === false) return '❌';
  if (value && typeof value === 'object') {
    if (
      value.ok === true || value.ready === true || value.healthy === true
      || value.connected === true || value.reachable === true
      || value.status === 'healthy' || value.status === 'ok'
    ) return '✅';
    if (
      value.ok === false || value.ready === false || value.healthy === false
      || value.connected === false || value.reachable === false
      || value.status === 'error' || value.status === 'failed'
    ) return '❌';
  }
  return '—';
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Per-desk readiness may be a boolean or { crypto: { ready }, india: {...} }. */
const deskStates = (value) => {
  if (!isObject(value)) return okMark(value);
  const parts = Object.entries(value).map(([desk, state]) => {
    const mark = isObject(state) ? okMark(state.ready ?? state.armable ?? state.ok) : okMark(state);
    return `${desk.toUpperCase()} ${mark}`;
  });
  return parts.length ? parts.join(' / ') : '—';
};

const deskBlockers = (value) => {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([, state]) => isObject(state) && (state.armable === false || state.ready === false))
    .map(([desk, state]) => `${desk.toUpperCase()}: ${truncate(state.why || 'not ready', 120)}`);
};

/**
 * Feed truth: the crypto desk can be healthy on spot WS even when the
 * futures RT stream is idle (no armed futures domains). Never claim a feed
 * is down merely because the optional RT tier is asleep.
 */
const feedLine = (feeds, { detail = false } = {}) => {
  if (!feeds) return null;
  const crypto = feeds.crypto || null;
  const rt = crypto?.rt || null;
  const spot = rt?.spotWs || null;
  if (!crypto) return `📡 Feeds: crypto — · US — · IN —`;
  const cryptoUp = crypto?.up === true || crypto?.healthy === true
    || rt?.healthy === true || rt?.connected === true
    || spot?.healthy === true || spot?.connected === true;
  const inCrypto = feeds.in || null;
  const us = feeds.us || null;
  const usMark = isObject(us) && Object.keys(us).length
    ? okMark(us.up ?? us.healthy ?? us.connected)
    : okMark(us);
  const inMark = isObject(inCrypto) && Object.keys(inCrypto).length
    ? okMark(inCrypto.up ?? inCrypto.healthy ?? inCrypto.connected)
    : okMark(inCrypto);
  let cryptoText = `crypto ${okMark(cryptoUp)}`;
  if (spot?.healthy === true) {
    cryptoText += detail && spot.markets
      ? ` (spot WS ${num(spot.freshMarkets, 0)}/${num(spot.markets, 0)})`
      : ' (spot WS)';
  }
  if (rt) {
    if (rt.healthy === true) cryptoText += ' · RT ✅';
    else if (rt.connected === true) cryptoText += ' · RT ❌';
    else if (Number(rt.domains?.fut || 0) === 0 && Number(rt.domains?.glob || 0) === 0) cryptoText += ' · RT ⚪ idle';
    else cryptoText += ' · RT ❌';
  }
  return `📡 Feeds: ${cryptoText} · US ${usMark} · IN ${inMark}`;
};

const normSide = (value) => {
  const s = String(value || '').toUpperCase();
  return s === 'LONG' || s === 'SHORT' ? s : null;
};

const sideText = (value) => {
  const side = normSide(value);
  if (!side) return `⚪ ${esc(String(value || 'WAIT').toUpperCase())}`;
  return `${SIDE_EMOJI[side]} ${side}`;
};

const orderSideText = (value) => {
  const s = String(value || '').toUpperCase();
  if (!s) return null;
  if (s === 'BUY') return 'BUY';
  if (s === 'SELL') return 'SELL';
  return s;
};

const expectedOrderSide = (side) => (side === 'LONG' ? 'BUY' : side === 'SHORT' ? 'SELL' : null);

const ccys = (board) => String(board?.quoteCcy || 'INR').toUpperCase();

export function summarizePositions(data, now = Date.now()) {
  const rows = Array.isArray(data?.positions) ? data.positions : [];
  const start = istDayStart(now);
  const open = rows.filter((p) => ['OPEN', 'UNKNOWN'].includes(String(p.status || 'OPEN').toUpperCase()));
  const closed = rows.filter((p) => String(p.status || '').toUpperCase() === 'CLOSED');
  const closedToday = closed.filter((p) => (asNumber(p.closedAt) ?? 0) >= start);
  const isSim = (p) => String(p.market || '').toUpperCase() === 'GLOBALFUTURES';
  const valueOf = (p) => (asNumber(p.pnlINR) ?? 0) + (asNumber(p.bookedPnlINR) ?? 0);
  const liveClosed = closedToday.filter((p) => !isSim(p));
  const simClosed = closedToday.filter(isSim);
  const liveOpen = open.filter((p) => !isSim(p));
  const simOpen = open.filter(isSim);
  const sum = (arr, fn) => arr.reduce((acc, item) => acc + (asNumber(fn(item)) ?? 0), 0);
  const stats = data?.stats || null;
  // `stats.realizedPnlINR` is the CRYPTO-venue tally (it already includes
  // partial-TP legs that never appear as a closed position row). INDIA is a
  // different venue and is not part of that tally, so add its closed rows
  // explicitly instead of silently dropping them.
  const indiaRealized = sum(
    liveClosed.filter((p) => String(p.market || '').toUpperCase() === 'INDIA'),
    valueOf,
  );
  const cryptoRealized = asNumber(stats?.realizedPnlINR);
  const liveRealized = cryptoRealized != null
    ? cryptoRealized + indiaRealized
    : sum(liveClosed, valueOf);
  const simRealized = asNumber(stats?.simRealizedPnlINR) ?? sum(simClosed, valueOf);
  return {
    rows,
    open,
    openCount: liveOpen.length,
    totalOpenCount: open.length,
    simOpenCount: simOpen.length,
    liveOpen,
    simOpen,
    closedToday,
    liveClosed,
    simClosed,
    liveRealized,
    indiaRealized,
    simRealized,
    openUpnl: sum(liveOpen, (p) => p.unrealizedPnlINR),
    simOpenUpnl: sum(simOpen, (p) => p.unrealizedPnlINR),
    stats,
  };
}

function menuKeyboard() {
  return [
    [{ text: '📊 Status', callback_data: 'c:status' }, { text: '📡 Signals', callback_data: 'c:signals' }],
    [{ text: '💼 Positions', callback_data: 'c:positions' }, { text: '🤖 Auto', callback_data: 'c:auto' }],
    [{ text: '🩺 Health', callback_data: 'c:health' }, { text: '❓ Help', callback_data: 'c:help' }],
  ];
}

function signalKeyboard() {
  return [
    [{ text: '₿ Crypto', callback_data: 'c:sig:CRYPTO' }, { text: '🇮🇳 India', callback_data: 'c:sig:INDIA' }],
    [{ text: '🥇 Metals', callback_data: 'c:sig:METALS' }, { text: '🌍 Global', callback_data: 'c:sig:GLOBALFUTURES' }],
    [{ text: '🔄 Refresh', callback_data: 'c:signals' }, { text: '☰ Menu', callback_data: 'c:menu' }],
  ];
}

function baseKeyboard(refresh = 'c:status') {
  return [
    [{ text: '🔄 Refresh', callback_data: refresh }, { text: '☰ Menu', callback_data: 'c:menu' }],
  ];
}

export function autoKeyboard(status) {
  const enabled = status?.enabled === true;
  const mode = String(status?.executionMode || 'paper').toLowerCase();
  const rows = [];
  if (enabled) {
    rows.push([{ text: '🛑 Disarm', callback_data: 'c:auto:off' }, { text: '🔄 Refresh', callback_data: 'c:auto' }]);
  } else {
    rows.push([{ text: '🟢 Arm auto', callback_data: 'c:auto:on' }, { text: '🔄 Refresh', callback_data: 'c:auto' }]);
  }
  const modeRow = [];
  if (mode !== 'paper') modeRow.push({ text: '🧪 Paper', callback_data: 'c:auto:mode:paper' });
  if (mode !== 'live') modeRow.push({ text: '🔴 Live', callback_data: 'c:auto:mode:live' });
  modeRow.push({ text: '☰ Menu', callback_data: 'c:menu' });
  rows.push(modeRow);
  return rows;
}

export function menuText() {
  return [
    '🤖 <b>SmartAI Pro Bot</b>',
    '<i>Private control room. Site API is the single source of truth.</i>',
    '',
    'Choose an action:',
    '• <b>Status</b> — server, auto-trade and P&amp;L',
    '• <b>Signals</b> — MTF dual-timeframe board',
    '• <b>Auto</b> — live/paper engine state (arming always asks)',
    '',
    '<i>Live auto-trade arming always needs an inline Confirm tap.</i>',
  ].join('\n');
}

export function menuResult() {
  return { text: menuText(), keyboard: menuKeyboard() };
}

export function startText(config) {
  return [
    '👋 <b>SmartAI Pro Bot</b>',
    `Bot <code>v${esc(config.version)}</code> · private owner-only access`,
    '',
    'Main commands:',
    '/status — full dashboard',
    '/signals — MTF signals',
    '/positions — open positions',
    '/auto — auto-trade state',
    '/health — deep server health',
    '',
    'Ask a market question in plain English and the desk agent will answer.',
    '',
    '⚠️ <b>Safety:</b> live auto-trade arming always requires an inline confirmation tap.',
  ].join('\n');
}

export function startResult(config) {
  return { text: startText(config), keyboard: menuKeyboard() };
}

export function helpText() {
  return [
    '❓ <b>COMMANDS</b>',
    '<b>Status</b>',
    '/status — server + auto + P&amp;L dashboard',
    '/health — deep server health',
    '/ping — server latency',
    '/version — bot + server versions',
    '/id — owner access check',
    '',
    '<b>Markets</b>',
    '/signals [crypto|india|metals|futures|global] — MTF board',
    '/scan [market] — fresh full scan (20–90s)',
    '',
    '<b>Trading</b>',
    '/positions — open live/journal + paper positions',
    '/pnl [today|week] — measured P&amp;L',
    '/auto [status|on|off|paper|live] — auto-trade control',
    '/alerts — instant-push + delivery health',
    '/weekly — weekly performance review',
    '',
    '<b>AI desk</b>',
    'Type a question directly — crypto desk by default',
    '/crypto &lt;question&gt; · /india &lt;question&gt;',
    '/reset — clear this chat’s AI context',
    '',
    '<b>Other</b>',
    '/menu · /help · /cancel',
    '',
    '<i>No command can reveal API keys, PINs or tokens.</i>',
  ].join('\n');
}

export function helpResult() {
  return { text: helpText(), keyboard: menuKeyboard() };
}

export function idText(message, config) {
  const fromId = String(message?.from?.id ?? '—');
  const chatId = String(message?.chat?.id ?? '—');
  const chatType = String(message?.chat?.type || 'unknown');
  const owner = config.ownerIds.includes(fromId) || config.ownerIds.includes(chatId);
  return [
    '🪪 <b>OWNER ACCESS CHECK</b>',
    `User: <code>${esc(maskId(fromId))}</code>`,
    `Chat: <code>${esc(maskId(chatId))}</code> (${esc(chatType)})`,
    `Owner match: ${owner ? '✅ yes' : '❌ no'}`,
    '',
    '<i>Raw chat/user ids are never echoed by the bot. TG_CHAT_ID stays in app/.env.</i>',
  ].join('\n');
}

export function idResult(message, config) {
  return { text: idText(message, config), keyboard: baseKeyboard('c:menu') };
}

function serverLine(health, ping) {
  if (health?.ok) {
    return `🟢 Server: v${esc(health.version || '—')} · up ${duration(health.uptime)} · bot ${okMark(health.botAlive)}`;
  }
  if (ping?.pong) {
    return `🟢 Server: v${esc(ping.v || '—')} · up ${duration(ping.up)} · ping ${ping.latencyMs ?? '—'}ms`;
  }
  return '🔴 Server: reachable nahi';
}

function autoLine(auto) {
  if (!auto) return '🤖 Auto: — (status unavailable)';
  const mode = String(auto.executionMode || 'paper').toUpperCase();
  if (auto.enabled) {
    const dot = mode === 'LIVE' ? '🔴' : '🟢';
    return `${dot} Auto: ON · ${mode} · open ${num(auto.openCount, 0)}`;
  }
  return `⚪ Auto: OFF · ${mode}`;
}

function autoRiskLine(auto) {
  if (!auto) return null;
  const caps = auto.riskCaps || {};
  const wallet = auto.effectiveWalletINR ?? caps.walletINR ?? auto.walletAmountINR;
  const risk = caps.effectiveRiskINR ?? auto.riskPerTradeINR;
  const deploy = caps.effectiveWalletDeployPct ?? auto.effectiveWalletDeployPct;
  const lev = caps.effectiveLeverage ?? auto.activeLeverage;
  const day = `${num(auto.dayCount, 0)}/${auto.maxTradesPerDay === 0 ? '∞' : num(auto.maxTradesPerDay, 0)}`;
  return `   wallet ${inr(wallet)} · risk ${inr(risk)}/trade · ${num(deploy, 0)}% deploy · ${num(lev, 0)}x · day ${day}`;
}

export function formatStatus({ health, auto, positions, paper, push, ping, errors = [] }, now = Date.now()) {
  const pos = summarizePositions(positions, now);
  const pstat = paper?.stats || null;
  const lines = ['📊 <b>SMARTAI STATUS</b>', serverLine(health, ping)];
  if (ping?.latencyMs != null) lines.push(`🏓 API ping: ${num(ping.latencyMs, 0)} ms`);
  lines.push(autoLine(auto));
  const riskLine = autoRiskLine(auto);
  if (riskLine) lines.push(riskLine);

  if (positions) {
    lines.push(`💼 Journal: ${num(pos.openCount, 0)} open · day realized ${inr(pos.liveRealized, { signed: true })} · uPnL ${inr(pos.openUpnl, { signed: true })}`);
    if (pos.simOpen.length || pos.simRealized) {
      lines.push(`   sim equity: ${num(pos.simOpen.length, 0)} open · day ${inr(pos.simRealized, { signed: true })}`);
    }
  } else {
    lines.push('💼 Journal: — unavailable');
  }

  if (paper) {
    lines.push(`📝 Paper: ${num(pstat?.openCount, 0)} open · day net ${inr(pstat?.dayNetPnl, { signed: true })} · total net ${inr(pstat?.totalNetPnl, { signed: true })}`);
  } else {
    lines.push('📝 Paper: — unavailable');
  }

  if (push) {
    const delivery = push.delivery || {};
    lines.push(`🔔 Push: ${push.healthy ? '🟢 healthy' : '🟡 check'} · 24h ${num(delivery.sent24h, 0)} sent / ${num(delivery.failed24h, 0)} failed`);
  } else {
    lines.push('🔔 Push: — unavailable');
  }

  if (health?.feeds) {
    const feed = feedLine(health.feeds);
    if (feed) lines.push(feed);
  }

  if (errors.length) {
    lines.push('', '⚠️ <b>Partial:</b>');
    for (const e of errors.slice(0, 5)) lines.push(`• ${esc(redactSecrets(e))}`);
  }

  lines.push('', `<i>Updated ${istTime(now)}</i>`);
  return lines.join('\n');
}

export function formatPositions({ positions, paper, errors = [] }, now = Date.now()) {
  const lines = ['💼 <b>POSITIONS</b>'];
  const pos = summarizePositions(positions, now);

  lines.push('', `🔴 <b>Journal / live</b> · ${num(pos.openCount, 0)} open`);
  if (!positions) {
    lines.push('• unavailable');
  } else if (pos.liveOpen.length === 0) {
    lines.push('• no open positions');
  } else {
    pos.liveOpen.slice(0, 8).forEach((p, index) => {
      const symbol = p.pair || p.symbol || '?';
      const side = p.side;
      const lev = asNumber(p.leverage);
      const entry = asNumber(p.entryPrice);
      const ltp = asNumber(p.ltp);
      const pnl = asNumber(p.unrealizedPnlINR);
      const market = String(p.market || '').toUpperCase();
      const ccy = market === 'INDIA' ? 'INR' : 'USDT';
      const bits = [
        `${index + 1}. <b>${esc(symbol)}</b> ${sideText(side)}${lev ? ` ${num(lev, 0)}x` : ''}`,
        `${price(entry, ccy)} → ${price(ltp, ccy)}`,
        `<b>${inr(pnl, { signed: true })}</b>`,
      ];
      lines.push(bits.join(' · '));
      const meta = [market || null, p.priceSource && p.priceSource !== 'coindcx' ? `src ${esc(p.priceSource)}` : null, p.exitStage ? `stage ${esc(p.exitStage)}` : null].filter(Boolean);
      if (meta.length) lines.push(`   <i>${meta.join(' · ')}</i>`);
    });
    if (pos.liveOpen.length > 8) lines.push(`   … +${pos.liveOpen.length - 8} more`);
  }

  if (pos.simOpen.length) {
    lines.push('', `🟦 <b>Equity SIM</b> · ${num(pos.simOpen.length, 0)} open · uPnL ${inr(pos.simOpenUpnl, { signed: true })}`);
    pos.simOpen.slice(0, 4).forEach((p, index) => {
      lines.push(
        `${index + 1}. <b>${esc(p.symbol || '?')}</b> ${sideText(p.side)} · ${price(p.entryPrice, 'USD')} → ${price(p.ltp, 'USD')} · <b>${inr(p.unrealizedPnlINR, { signed: true })}</b>`,
      );
    });
    if (pos.simOpen.length > 4) lines.push(`   … +${pos.simOpen.length - 4} more`);
  }

  const pstat = paper?.stats || null;
  const paperOpen = Array.isArray(paper?.open) ? paper.open : null;
  lines.push('', `📝 <b>Paper</b> · ${num(pstat?.openCount, 0)} open · day net ${inr(pstat?.dayNetPnl, { signed: true })}`);
  if (!paper) {
    lines.push('• unavailable');
  } else if (!paperOpen || paperOpen.length === 0) {
    lines.push('• no open paper trades');
  } else {
    paperOpen.slice(0, 8).forEach((t, index) => {
      const side = t.direction;
      const ccy = t.ccy || 'INR';
      lines.push(
        `${index + 1}. <b>${esc(t.symbol || '?')}</b> ${sideText(side)} · ${price(t.entry, ccy)} → ${price(t.lastPrice, ccy)} · <b>${money(t.unrealizedPnl, ccy, { signed: true })}</b>`,
      );
      const meta = [t.market || null, t.source ? `src ${esc(t.source)}` : null, t.t1Hit ? 'T1 booked' : null].filter(Boolean);
      if (meta.length) lines.push(`   <i>${meta.join(' · ')}</i>`);
    });
    if (paperOpen.length > 8) lines.push(`   … +${paperOpen.length - 8} more`);
  }

  if (positions) {
    lines.push(
      '',
      `📅 Day: ${num(pos.liveClosed.length, 0)} live closes · realized ${inr(pos.liveRealized, { signed: true })} · open uPnL ${inr(pos.openUpnl, { signed: true })}`,
    );
  }
  if (pstat) {
    lines.push(`   paper: gross ${inr(pstat.dayRealizedPnl, { signed: true })} · costs ${inr(pstat.dayCosts)} · net ${inr(pstat.dayNetPnl, { signed: true })}`);
  }
  if (errors.length) lines.push('', `⚠️ ${esc(redactSecrets(errors.join(' · ')))}`);
  lines.push('', `<i>Updated ${istTime(now)}</i>`);
  return lines.join('\n');
}

export function formatPnlToday({ positions, paper, errors = [] }, now = Date.now()) {
  const pos = summarizePositions(positions, now);
  const pstat = paper?.stats || null;
  const live = positions ? pos.liveRealized : null;
  const paperNet = paper ? asNumber(pstat?.dayNetPnl) : null;
  const total = live != null || paperNet != null ? (live ?? 0) + (paperNet ?? 0) : null;

  const lines = ['💰 <b>P&amp;L — TODAY</b>', `<i>IST day ${esc(pstat?.day || positions?.stats?.day || istTime(now, { withDate: true }).slice(0, 5))} · measured values only</i>`, ''];
  lines.push(`🔴 <b>Journal / live</b>`);
  if (!positions) {
    lines.push('• unavailable');
  } else {
    lines.push(`• ${num(pos.liveClosed.length, 0)} closed today · realized <b>${inr(pos.liveRealized, { signed: true })}</b>`);
    lines.push(`• ${num(pos.liveOpen.length, 0)} open · uPnL <b>${inr(pos.openUpnl, { signed: true })}</b>`);
    if (pos.simClosed.length || pos.simOpen.length) {
      lines.push(`• equity sim (excluded): day ${inr(pos.simRealized, { signed: true })} · open uPnL ${inr(pos.simOpenUpnl, { signed: true })}`);
    }
  }
  lines.push('', '📝 <b>Paper</b>');
  if (!paper) {
    lines.push('• unavailable');
  } else {
    lines.push(`• ${num(pstat?.openCount, 0)} open · uPnL ${inr(pstat?.dayUnrealizedPnl, { signed: true })}`);
    lines.push(`• day gross ${inr(pstat?.dayRealizedPnl, { signed: true })} · costs ${inr(pstat?.dayCosts)} · net <b>${inr(pstat?.dayNetPnl, { signed: true })}</b>`);
    lines.push(`• all-time net ${inr(pstat?.totalNetPnl, { signed: true })} · win rate ${pstat?.winRatePct != null ? pct(pstat.winRatePct, 1) : '—'} (${num(pstat?.closedTotal, 0)} closed)`);
  }
  lines.push('', `🧮 <b>Today total</b> (live realized + paper net): <b>${inr(total, { signed: true })}</b>`);
  if (errors.length) lines.push('', `⚠️ ${esc(redactSecrets(errors.join(' · ')))}`);
  lines.push('', '<i>/pnl week for the weekly review.</i>');
  return lines.join('\n');
}

export function formatHealth({ health, opHealth, ping, errors = [] }, now = Date.now()) {
  const lines = ['🩺 <b>SERVER HEALTH</b>'];
  if (health?.ok) {
    const heal = health.selfheal || {};
    const mem = heal.memory || {};
    const lag = heal.loopLagMs || {};
    const counts = heal.counts || {};
    lines.push(`🟢 Overall OK · v${esc(health.version || '—')} · up ${duration(health.uptime)} · pid ${num(health.pid ?? ping?.pid, 0)}`);
    lines.push(`🤖 Bot child: ${okMark(health.botAlive)} · RSS ${num(mem.rssMB, 0)} MB${mem.limitsMB?.rss ? ` / ${num(mem.limitsMB.rss, 0)} MB` : ''}`);
    lines.push(`🧠 Providers: ${Array.isArray(health.providers) && health.providers.length ? esc(health.providers.join(', ')) : '—'}`);
    if (health.feeds) {
      const feed = feedLine(health.feeds, { detail: true });
      if (feed) lines.push(feed);
    }
    if (health.agents) {
      lines.push(`🤖 Agents: crypto ${okMark(health.agents.crypto?.running)} · india ${okMark(health.agents.india?.running)}`);
    }
    if (health.ml) {
      lines.push(`🧪 ML: engine ${objectMark(health.ml.engine)} · service ${objectMark(health.ml.service)}`);
    }
    if (heal.ok) {
      lines.push(`🛡️ Self-heal: ${heal.armed ? 'armed' : 'off'} · heap ${num(mem.heapUsedMB, 0)}/${num(mem.heapTotalMB, 0)} MB · loop ${num(lag.mean, 1)}/${num(lag.max30s, 1)} ms`);
      lines.push(`   uncaught ${num(counts.uncaughtExceptions, 0)} · rejections ${num(counts.unhandledRejections, 0)} · trims ${num(counts.memTrims, 0)}`);
      if (heal.lastError?.message) lines.push(`   last error: <i>${esc(truncate(redactSecrets(heal.lastError.message), 120))}</i>`);
    }
  } else if (ping?.pong) {
    lines.push(`🟢 Server alive · v${esc(ping.v || '—')} · up ${duration(ping.up)} · ping ${num(ping.latencyMs, 0)} ms`);
  } else {
    lines.push('🔴 /health reachable nahi');
  }

  if (opHealth) {
    const kills = opHealth.kills || {};
    const killActive = kills.aiDesk?.enabled === true || (kills.exec?.level || 0) > 0 || kills.botLab?.globalPause === true;
    lines.push('', `🚨 <b>Kill switches:</b> ${killActive ? '🔴 ACTIVE' : '🟢 clear'}`);
    lines.push(`• AI desk ${kills.aiDesk?.enabled ? 'ON' : 'off'} · exec L${num(kills.exec?.level, 0)} · BotLab ${kills.botLab?.globalPause ? 'PAUSED' : 'ok'}`);
    lines.push(`• data dirs writable: ${okMark(opHealth.persist?.dataDirWritable)} · exec heartbeat ${ago(opHealth.persist?.execHeartbeat?.at, now)}`);
    if (Array.isArray(opHealth.feeds?.staleSources) && opHealth.feeds.staleSources.length) {
      lines.push(`• stale feeds: ${esc(opHealth.feeds.staleSources.slice(0, 8).join(', '))}`);
    }
    if (opHealth.bots) {
      const list = Array.isArray(opHealth.bots.bots) ? opHealth.bots.bots : null;
      if (list) {
        const armed = list.filter((b) => b?.arm === true || b?.mode === 'LIVE').length;
        lines.push(`• BotLab: ${num(list.length, 0)} bot(s) · ${num(armed, 0)} armed · ${opHealth.bots.globalPause ? 'global pause' : 'scheduler ok'}`);
      }
    }
  } else {
    lines.push('', '⚙️ Operational health (/api/health): unavailable');
  }

  if (errors.length) lines.push('', `⚠️ ${esc(redactSecrets(errors.join(' · ')))}`);
  lines.push('', `<i>Updated ${istTime(now)}</i>`);
  return lines.join('\n');
}

function boardRowLines(row, ccy) {
  const symbol = row?.symbol || row?.pair || '?';
  const tier = String(row?.tier || '—').toUpperCase();
  const tierEmoji = TIER_EMOJI[tier] || '⚪';
  const score = asNumber(row?.superScore ?? row?.score);
  const side = normSide(row?.side);
  const dirOk = row?.directionCertificate?.ok !== false;
  const verified = dirOk && row?.directionVerified === true;

  if (!row?.ok) {
    return [`⚪ <b>${esc(symbol)}</b> — <i>${esc(truncate(redactSecrets(row?.error || 'unavailable'), 90))}</i>`];
  }
  if (!side) {
    const bias = row?.bias || row?.pakkaDirectionLabel || row?.directionVerdict || 'WAIT';
    const blocker = Array.isArray(row?.autoBlockers) && row.autoBlockers.length ? ` · ${truncate(row.autoBlockers[0], 70)}` : '';
    return [`⚪ <b>${esc(symbol)}</b> · ${esc(tier)}${score != null ? ` ${num(score, 0)}` : ''} · <i>${esc(String(bias))}${esc(blocker)}</i>`];
  }

  const order = orderSideText(row?.orderSide);
  const expected = expectedOrderSide(side);
  const mismatch = order && expected && order !== expected;
  const line1 = [
    `${tierEmoji} <b>${esc(symbol)}</b> ${sideText(side)}`,
    `<b>${esc(tier)}</b>${score != null ? ` ${num(score, 0)}` : ''}`,
    `${verified ? 'PAKKA ✅' : 'WAIT ⏳'}`,
    order ? `${mismatch ? '⚠️' : ''}order ${esc(order)}` : null,
  ].filter(Boolean).join(' · ');

  const plan = row?.plan || null;
  const levels = [];
  if (plan?.entry != null) levels.push(`E ${price(plan.entry, ccy)}`);
  if (plan?.stopLoss != null) levels.push(`SL ${price(plan.stopLoss, ccy)}`);
  if (plan?.t1 != null) levels.push(`T1 ${price(plan.t1, ccy)}`);
  if (plan?.t2 != null) levels.push(`T2 ${price(plan.t2, ccy)}`);
  const rr1 = asNumber(plan?.netRR?.t1);
  const rr2 = asNumber(plan?.netRR?.t2);
  if (rr1 != null || rr2 != null) levels.push(`RR ${rr1 != null ? num(rr1, 2) : '—'}/${rr2 != null ? num(rr2, 2) : '—'}`);

  const state = [
    row?.autoEligible === true ? 'AUTO ✅' : `AUTO ✗ ${truncate(row?.autoBlockers?.[0] || 'blocked', 60)}`,
    row?.triggerFired ? 'trigger ✅' : 'trigger ⏳',
    row?.counterHtf ? `HTF ${esc(row?.htfBias || 'against')} ⚠️` : null,
    mismatch ? `SIDE MISMATCH` : null,
  ].filter(Boolean).join(' · ');

  const out = [line1];
  if (levels.length) out.push(`   ${levels.join(' · ')}`);
  out.push(`   <i>${state}</i>`);
  return out;
}

function boardSection(title, rows, ccy, max) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const lines = [`<b>${esc(title)}</b>`];
  const sliced = rows.slice(0, max);
  for (const row of sliced) lines.push(...boardRowLines(row, ccy));
  if (rows.length > sliced.length) lines.push(`<i>… +${rows.length - sliced.length} more</i>`);
  return ['', ...lines];
}

export function formatBoard(board, {
  title = 'MTF SIGNALS',
  market = 'CRYPTO',
  metalsOnly = false,
  showMetals = true,
  showEquity = true,
  maxRows = 6,
  maxMetals = 4,
  maxEquity = 4,
  fresh = false,
  now = Date.now(),
} = {}) {
  if (!board || board.ok !== true) {
    const reason = board?.error?.message || board?.error || 'board unavailable';
    throw new Error(String(reason));
  }
  const ccy = ccys(board);
  const rowKey = (r) => String(r?.symbol || `${r?.market || ''}|${r?.pair || ''}`).toUpperCase();
  const uniqueRows = (rows) => {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).filter((r) => {
      const key = rowKey(r);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  // The server can publish the same metal in both `rows` and `metalsRows`.
  // Give it one home only: the dedicated GOLD/SILVER section.
  const metalsRows = uniqueRows(board.metalsRows);
  const equityRows = uniqueRows(board.equitySimRows);
  const specialKeys = new Set([...metalsRows, ...equityRows].map(rowKey).filter(Boolean));
  const mainRows = uniqueRows(board.rows).filter((r) => !specialKeys.has(rowKey(r)));
  const displayed = metalsOnly
    ? metalsRows
    : [
      ...mainRows,
      ...(showMetals ? metalsRows : []),
      ...(showEquity ? equityRows : []),
    ];
  const strongCount = displayed.filter((r) => ['STRONG', 'ELITE'].includes(String(r?.tier || '').toUpperCase())).length;
  const autoReadyCount = displayed.filter((r) => r?.autoEligible === true).length;
  const triggeredCount = displayed.filter((r) => r?.triggerFired === true).length;
  const lines = [
    `📡 <b>${esc(title)}</b>`,
    `${esc(board.modeLabel || board.mode || 'INTRADAY')} · ${esc(market)} · ${esc(ccy)} · ${num(board.scannedCount, 0)} scanned · ${ago(board.asOf, now)}`,
    `shown ${num(displayed.length, 0)} · auto-ready ${num(autoReadyCount, 0)} · strong ${num(strongCount, 0)} · triggered ${num(triggeredCount, 0)}`,
  ];
  if (board.liveFeed24x7?.cadenceMs) {
    lines.push(`<i>live feed ${num(board.liveFeed24x7.cadenceMs / 1000, 0)}s · ${fresh ? 'fresh scan' : 'server cache'}</i>`);
  }

  if (!metalsOnly) {
    lines.push(...boardSection('MAIN', mainRows, ccy, maxRows));
  }
  if (showMetals && metalsRows.length) {
    lines.push(...boardSection('GOLD / SILVER (USDT)', metalsRows, ccy, maxMetals));
  } else if (metalsOnly) {
    lines.push('', '⚪ No metals rows in the current board.');
  }
  if (showEquity && !metalsOnly && equityRows.length) {
    lines.push(...boardSection('EQUITY SIM (USD)', equityRows, 'USD', maxEquity));
  }

  if (!metalsOnly && displayed.length === 0) lines.push('', '⚪ No qualifying setups in the current scan.');

  const early = Array.isArray(board.earlyRadar) ? board.earlyRadar : [];
  if (early.length && !metalsOnly) lines.push('', `<i>👀 early radar: ${early.length} unconfirmed setup(s)</i>`);
  lines.push('', `<i>Site MTF board · signal side and executed order side shown · mismatch flagged · ${istTime(now)}</i>`);
  return lines.join('\n');
}

export function formatAutoStatus(status, now = Date.now()) {
  if (!status || status.ok === false) {
    return ['🤖 <b>AUTO-TRADE</b>', '', `⚠️ ${esc(status?.error?.message || status?.error || 'status unavailable')}`].join('\n');
  }
  const mode = String(status.executionMode || 'paper').toUpperCase();
  const state = status.enabled
    ? (mode === 'LIVE' ? '🔴 <b>LIVE ARMED</b>' : '🟢 <b>PAPER ON</b>')
    : '⚪ <b>OFF</b>';
  const caps = status.riskCaps || {};
  const wallet = status.effectiveWalletINR ?? caps.walletINR ?? status.walletAmountINR;
  const deploy = caps.effectiveWalletDeployPct ?? status.effectiveWalletDeployPct;
  const leverage = caps.effectiveLeverage ?? status.activeLeverage;
  const risk = caps.effectiveRiskINR ?? status.riskPerTradeINR;
  const desks = status.desks || {};
  const deep = status.deepMonitor || {};
  const dayLimit = status.maxTradesPerDay === 0 ? '∞' : num(status.maxTradesPerDay, 0);

  const deskReadiness = status.deskArmable != null ? status.deskArmable : status.deskReady;
  const readinessLabel = status.deskArmable != null ? 'armable' : 'desk ready';
  const lines = [
    '🤖 <b>AUTO-TRADE</b>',
    `State: ${state} · execution ${esc(mode)}`,
    `Enabled: CRYPTO ${okMark(desks.crypto)} · INDIA ${okMark(desks.india)} · mode ${esc(status.mode || '—')} · min ${num(status.minScore, 0)}`,
    '',
    `💼 Wallet ${inr(wallet)} · risk <b>${inr(risk)}</b>/trade`,
    `   ${num(deploy, 0)}% deploy · ${num(leverage, 0)}x · max ${num(status.maxOpenPositions, 0)} open · day ${num(status.dayCount, 0)}/${dayLimit}`,
    `   buying power ${inr(status.wallet95Deployment?.buyingPowerINR)} · max notional ${inr(status.maxNotionalPerTradeINR)}`,
    '',
    `🛡️ Readiness: CoinDCX ${okMark(status.coindcxConnected)} · site live ${okMark(status.siteLiveActive)} · ${readinessLabel} ${deskStates(deskReadiness)} · kill switch ${status.killSwitch ? '🔴 ON' : '✅ off'}`,
    `🔍 Deep monitor: ${num(deep.activeCount ?? status.openCount, 0)} active · ${num(deep.tp1LockedCount, 0)} TP1 locked · ${num(deep.reversalAlertCount, 0)} reversal · ${num(deep.directionBlockedCount, 0)} dir-blocked`,
  ];
  const blockers = deskBlockers(status.deskArmable);
  if (blockers.length) lines.push(`   ⛔ ${esc(blockers.join(' · '))}`);

  if (status.liveEntryPaused) {
    lines.push('', '⏸ <b>Live entries paused</b> — existing positions still managed.');
  }

  const trades = Array.isArray(deep.trades) ? deep.trades : [];
  if (trades.length) {
    lines.push('', '<b>ACTIVE AUTO TRADES</b>');
    trades.slice(0, 4).forEach((t) => {
      const side = normSide(t.side);
      const bits = [
        `<b>${esc(t.symbol || t.pair || '?')}</b>`,
        side ? sideText(side) : null,
        t.currentR != null ? `${signedNum(t.currentR, 2)}R` : null,
        t.stageLabel ? esc(t.stageLabel) : null,
        t.trendStatus ? esc(truncate(t.trendStatus, 40)) : null,
      ].filter(Boolean);
      lines.push(`• ${bits.join(' · ')}`);
    });
    if (trades.length > 4) lines.push(`• … +${trades.length - 4} more`);
  }

  lines.push('', `<i>Updated ${istTime(now)} · ${esc(status.note ? truncate(redactSecrets(status.note), 160) : '')}</i>`);
  return lines.join('\n');
}

export function autoResult(status) {
  return { text: formatAutoStatus(status), keyboard: autoKeyboard(status) };
}

export function confirmationText(action, status, { ttlMs = 90000 } = {}) {
  const mode = String(status?.executionMode || 'paper').toLowerCase();
  const caps = status?.riskCaps || {};
  const wallet = status?.effectiveWalletINR ?? caps.walletINR ?? status?.walletAmountINR;
  const risk = caps.effectiveRiskINR ?? status?.riskPerTradeINR;
  const lev = caps.effectiveLeverage ?? status?.activeLeverage;
  const deploy = caps.effectiveWalletDeployPct ?? status?.effectiveWalletDeployPct;
  const live = mode === 'live';
  const header = action === 'live'
    ? '⚠️ <b>SWITCH TO LIVE EXECUTION?</b>'
    : live
      ? '⚠️ <b>ARM LIVE AUTO-TRADE?</b>'
      : '🧪 <b>START PAPER AUTO-TRADE?</b>';

  const lines = [header, ''];
  if (action === 'live') {
    lines.push('Execution mode ab <b>LIVE</b> hoga. Agar auto engine ON hai to isi second se real orders ja sakte hain.');
  } else if (live) {
    lines.push('Ye <b>REAL CoinDCX orders</b> place kar sakta hai. Sirf tab confirm karo jab tu risk samajhta hai.');
  } else {
    lines.push('Paper mode hai — real orders nahi jayenge. Signals paper desk par execute honge.');
  }
  lines.push('');
  lines.push(`Current: engine ${status?.enabled ? 'ON' : 'OFF'} · execution ${esc(mode.toUpperCase())} · open ${num(status?.openCount, 0)}`);
  lines.push(`Wallet ${inr(wallet)} · risk ${inr(risk)}/trade · ${num(deploy, 0)}% deploy · ${num(lev, 0)}x`);
  const readiness = status?.deskArmable != null ? status.deskArmable : status?.deskReady;
  const readinessLabel = status?.deskArmable != null ? 'armable' : 'desk ready';
  lines.push(`Readiness: CoinDCX ${okMark(status?.coindcxConnected)} · site live ${okMark(status?.siteLiveActive)} · ${readinessLabel} ${deskStates(readiness)} · kill ${status?.killSwitch ? '🔴 ON' : 'off'}`);
  const blockers = deskBlockers(status?.deskArmable);
  if (blockers.length) lines.push(`⛔ ${esc(blockers.join(' · '))}`);
  if (status?.killSwitch) lines.push('', '⚠️ Kill switch ON hai — engine arm hoga par trade tab tak nahi karega jab tak kill switch clear nahi hota.');
  const ttlSec = Math.max(1, Math.round(Number(ttlMs) / 1000));
  lines.push('', `<i>Confirmation ${ttlSec} seconds me expire ho jayegi. /cancel se cancel kar sakta hai.</i>`);
  return lines.join('\n');
}

export function confirmationResult(action, status, options = {}) {
  return {
    text: confirmationText(action, status, options),
    pendingAction: { kind: 'auto', action },
  };
}

export function autoActionResult(action, status) {
  const title = action === 'on'
    ? (String(status?.executionMode || '').toLowerCase() === 'live' ? '🔴 <b>LIVE AUTO ARMED</b>' : '🟢 <b>PAPER AUTO ARMED</b>')
    : action === 'off'
      ? '🛑 <b>AUTO DISABLED</b>'
      : action === 'live'
        ? '🔴 <b>EXECUTION MODE: LIVE</b>'
        : '🧪 <b>EXECUTION MODE: PAPER</b>';
  return {
    text: `${title}\n\n${formatAutoStatus(status)}`,
    keyboard: autoKeyboard(status),
  };
}

export function formatAlerts(push, now = Date.now()) {
  if (!push) return ['🔔 <b>INSTANT PUSH</b>', '', '⚠️ status unavailable'].join('\n');
  const delivery = push.delivery || {};
  const lines = [
    '🔔 <b>INSTANT PUSH</b>',
    `Pipeline: ${push.enabled ? '🟢 enabled' : '⚪ off'} · started ${push.started ? ago(push.startedAt, now) : '—'}`,
    `Driver: ${push.healthy ? '🟢 healthy' : '🟡 check'} · last OK ${ago(push.lastOkAt, now)} · last push ${ago(push.lastPushAt, now)}`,
    `Pushes: signals ${num(push.signalPushes, 0)} · SL/TP ${num(push.slTpPushes, 0)} · paper ${num(push.paperPushes, 0)} · manual ${num(push.manualPushes, 0)}`,
    `Delivery 24h: <b>${num(delivery.sent24h, 0)}</b> sent · <b>${num(delivery.failed24h, 0)}</b> failed · ${delivery.healthy !== false ? '✅' : '❌'}`,
  ];
  if (push.lastError) lines.push(`Last error: <i>${esc(truncate(redactSecrets(push.lastError), 180))}</i>`);
  lines.push('', `<i>Updated ${istTime(now)}</i>`);
  return lines.join('\n');
}

export function alertsResult(push, now = Date.now()) {
  return { text: formatAlerts(push, now), keyboard: baseKeyboard('c:alerts') };
}

export function weeklyPlain(data, { title = 'WEEKLY REVIEW', now = Date.now() } = {}) {
  if (!data || data.ok !== true) {
    return `⚠️ ${data?.error?.message || data?.error || 'weekly review unavailable'}`;
  }
  const meta = [
    data.weekKey ? `week ${data.weekKey}` : null,
    data.engine ? `engine ${data.engine}` : 'engine —',
    data.cached ? 'cached' : null,
  ].filter(Boolean).join(' · ');
  const body = htmlToPlain(data.text || '');
  return [
    `📊 ${title}`,
    meta,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    body,
    '',
    `Generated ${istTime(now)}`,
  ].join('\n');
}

export function weeklyResult(data, opts = {}) {
  return { text: weeklyPlain(data, opts), plain: true };
}

export function formatPing({ ping, latencyMs, uptimeSec }, now = Date.now()) {
  if (!ping?.pong) return ['🏓 <b>PING</b>', '', '🔴 Server reachable nahi.'].join('\n');
  return [
    '🏓 <b>PING</b>',
    `Server: <b>${num(latencyMs, 0)} ms</b> · v${esc(ping.v || '—')} · pid ${num(ping.pid, 0)}`,
    `Uptime: ${duration(ping.up)} · bot ${duration(uptimeSec)}`,
    `<i>${istTime(now)}</i>`,
  ].join('\n');
}

export function pingResult(data, now = Date.now()) {
  return { text: formatPing(data, now), keyboard: baseKeyboard('c:ping') };
}

export function formatVersion({ ping, config, uptimeSec, now = Date.now() }) {
  const lines = [
    '🏷️ <b>VERSION</b>',
    `Bot: <code>${esc(config.version)}</code> · Node ${esc(process.version)}`,
    `Uptime: ${duration(uptimeSec)}`,
  ];
  if (ping?.pong) lines.push(`Server: <code>v${esc(ping.v || '—')}</code> · pid ${num(ping.pid, 0)} · up ${duration(ping.up)}`);
  else lines.push('Server: 🔴 unreachable');
  lines.push(`<i>${istTime(now)}</i>`);
  return lines.join('\n');
}

export function versionResult(data) {
  return { text: formatVersion(data), keyboard: baseKeyboard('c:version') };
}

export function formatAgentReply(text, { desk, engine, toolsUsed, session } = {}) {
  const deskLabel = desk === 'india' ? '🇮🇳 INDIA DESK' : '₿ CRYPTO DESK';
  const tools = Array.isArray(toolsUsed) ? toolsUsed.filter(Boolean).slice(0, 4) : [];
  const meta = [engine ? esc(engine) : null, tools.length ? `${tools.length} tools` : null]
    .filter(Boolean)
    .join(' · ');
  const lines = [`🧠 <b>${deskLabel}</b>${meta ? ` · <i>${meta}</i>` : ''}`, '━━━━━━━━━━━━━━━━━━━━━━━', esc(text)];
  if (session?.istTime || session?.utcTime) {
    lines.push('', `<i>Desk clock ${esc(session.istTime || session.utcTime)}</i>`);
  }
  return lines.join('\n');
}

export function agentResult(text, meta) {
  return { text: formatAgentReply(text, meta), disablePreview: true };
}

export function errorText(error) {
  const message = error?.userMessage || error?.message || 'Request fail hui.';
  return `⚠️ <b>Request fail</b>\n${esc(truncate(redactSecrets(message), 300))}`;
}

export function errorResult(error) {
  return { text: errorText(error), keyboard: menuKeyboard() };
}

export function plainBlockResult(text, title) {
  return { text: formatPlainBlock(text, title), keyboard: baseKeyboard('c:menu') };
}

export { menuKeyboard, signalKeyboard, baseKeyboard };
