// Command metadata + handlers. Handlers return a render result; the router
// owns authorization, confirmations, queues and Telegram delivery.

import {
  agentResult,
  alertsResult,
  autoActionResult,
  autoKeyboard,
  baseKeyboard,
  confirmationResult,
  formatAutoStatus,
  formatBoard,
  formatHealth,
  formatPositions,
  formatPnlToday,
  formatStatus,
  formatVersion,
  helpResult,
  idResult,
  menuResult,
  pingResult,
  signalKeyboard,
  startResult,
  weeklyResult,
} from './format.mjs';

export const COMMANDS = [
  { command: 'status', description: 'Server + auto-trade + P&L dashboard' },
  { command: 'signals', description: 'MTF dual-timeframe signals board' },
  { command: 'scan', description: 'Fresh full market scan (20-90s)' },
  { command: 'positions', description: 'Open journal and paper positions' },
  { command: 'pnl', description: 'Measured P&L: today or week' },
  { command: 'auto', description: 'Auto-trade state / arm / disarm' },
  { command: 'health', description: 'Deep server health' },
  { command: 'alerts', description: 'Instant-push delivery health' },
  { command: 'weekly', description: 'Weekly performance review' },
  { command: 'crypto', description: 'Ask the crypto desk agent' },
  { command: 'india', description: 'Ask the India desk agent' },
  { command: 'ping', description: 'Server latency' },
  { command: 'menu', description: 'Quick actions menu' },
  { command: 'id', description: 'Owner access check (ids masked)' },
  { command: 'version', description: 'Bot and server versions' },
  { command: 'reset', description: 'Clear this chat AI context' },
  { command: 'help', description: 'Command help' },
  { command: 'start', description: 'Start the bot' },
];

const ALIASES = {
  s: 'status',
  mtf: 'signals',
  portfolio: 'positions',
  autotrade: 'auto',
  deepmonitor: 'auto',
  push: 'alerts',
  ask: 'agent',
  aaj: 'pnl',
};

const MARKET_ALIASES = {
  crypto: 'CRYPTO',
  btc: 'CRYPTO',
  india: 'INDIA',
  nse: 'INDIA',
  stocks: 'INDIA',
  metals: 'METALS',
  metal: 'METALS',
  gold: 'METALS',
  silver: 'METALS',
  xau: 'METALS',
  xag: 'METALS',
  futures: 'FUTURES',
  fut: 'FUTURES',
  global: 'GLOBALFUTURES',
  globalfutures: 'GLOBALFUTURES',
  equity: 'GLOBALFUTURES',
  equitysim: 'GLOBALFUTURES',
  us: 'GLOBALFUTURES',
};

export function parseCommand(text, botUsername = null) {
  const m = String(text ?? '').trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== String(botUsername).toLowerCase()) return null;
  return {
    name: m[1].toLowerCase(),
    args: String(m[3] || '').trim(),
    mentioned: Boolean(m[2]),
  };
}

export function resolveCommand(name, args = '') {
  const raw = String(name || '').toLowerCase();
  if (raw === 'gold' || raw === 'silver') return { name: 'signals', args: 'metals' };
  const mapped = ALIASES[raw] || raw;
  return { name: mapped, args: String(args || '').trim() };
}

export function marketFromArgs(value, fallback = 'CRYPTO') {
  const key = String(value || '').trim().toLowerCase();
  return MARKET_ALIASES[key] || fallback;
}

export function isMarketArg(value) {
  const key = String(value || '').trim().toLowerCase();
  return !key || Boolean(MARKET_ALIASES[key]);
}

export function inferDesk(text) {
  const s = String(text || '');
  if (/\.(?:ns|bo)\b/i.test(s)) return 'india';
  if (/\b(nifty|banknifty|bank nifty|sensex|nse|bse|india|indian|stock|equity|groww|dhan|reliance|tcs|hdfc|icici|infy|sbin|axis|itc|airtel|bharti|maruti|sunpharma|drreddy|cipla|wipro|hcl|techm|tata|adani|mahindra|bajaj|kotak|ongc|ntpc|powergrid|coalindia|vedanta|jsw|hindalco|ultracemco|asianpaint|nestle|britannia|dabur|godrej|pidilite|titan|zomato|paytm|nykaa|dmart)\b/i.test(s)) {
    return 'india';
  }
  if (/\b(btc|eth|sol|bnb|xrp|doge|ada|avax|dot|matic|link|uni|shib|trx|ltc|bch|near|atom|apt|arb|op|sui|pepe|wif|fil|etc|xlm|hbar|inj|tia|sei|rndr|fet|gala|sand|mana|axs|aave|mkr|crv|ldo|dydx|jup|pyth|ena|ton|bonk|floki|crypto|coin|coindcx|futures|perp|usdt|gold|silver|xau|xag)\b/i.test(s)) {
    return 'crypto';
  }
  return null;
}

const settled = (result, label) => {
  if (result.status === 'fulfilled') return { value: result.value, error: null };
  const reason = result.reason;
  return { value: null, error: `${label}: ${reason?.userMessage || reason?.message || 'failed'}` };
};

const timed = async (fn, clock) => {
  const started = clock();
  const data = await fn();
  return { ...data, latencyMs: Math.max(0, clock() - started) };
};

const positionsKeyboard = () => [
  [{ text: '🔄 Refresh', callback_data: 'c:positions' }, { text: '💰 P&L', callback_data: 'c:pnl' }],
  [{ text: '📊 Status', callback_data: 'c:status' }, { text: '☰ Menu', callback_data: 'c:menu' }],
];

const pnlKeyboard = () => [
  [{ text: '📅 Today', callback_data: 'c:pnl' }, { text: '📆 Week', callback_data: 'c:pnl:week' }],
  [{ text: '🔄 Refresh', callback_data: 'c:pnl' }, { text: '☰ Menu', callback_data: 'c:menu' }],
];

const healthKeyboard = () => [
  [{ text: '🔄 Refresh', callback_data: 'c:health' }, { text: '📊 Status', callback_data: 'c:status' }],
  [{ text: '☰ Menu', callback_data: 'c:menu' }],
];

const weeklyKeyboard = () => [
  [{ text: '🔄 Refresh', callback_data: 'c:weekly' }, { text: '💰 P&L', callback_data: 'c:pnl' }],
  [{ text: '☰ Menu', callback_data: 'c:menu' }],
];

const MARKET_LABELS = {
  CRYPTO: 'CRYPTO',
  INDIA: 'INDIA',
  FUTURES: 'FUTURES',
  GLOBALFUTURES: 'GLOBAL FUTURES',
  METALS: 'GOLD / SILVER',
};

function marketTitle(market, prefix = 'MTF') {
  return `${MARKET_LABELS[market] || market} ${prefix}`;
}

function boardOptions(market, { fresh = false, now } = {}) {
  const metalsOnly = market === 'METALS';
  const fetchMarket = metalsOnly ? 'CRYPTO' : market;
  return {
    fetchMarket,
    metalsOnly,
    options: {
      title: marketTitle(market, fresh ? 'FRESH SCAN' : 'MTF SIGNALS'),
      market,
      metalsOnly,
      showMetals: fetchMarket === 'CRYPTO' && !metalsOnly,
      showEquity: fetchMarket === 'CRYPTO' && !metalsOnly,
      maxRows: fresh ? 6 : 6,
      maxMetals: 4,
      maxEquity: 4,
      fresh,
      now,
    },
  };
}

export function createCommandHandlers({ api, tg, config, clock = () => Date.now(), logger = null } = {}) {
  const histories = new Map(); // `${chatId}:${desk}` -> { messages, at }
  const lastDesk = new Map();
  const lastAgentAt = new Map();
  const lastScanAt = new Map();

  const clearHistory = (chatId) => {
    const prefix = `${chatId}:`;
    for (const key of histories.keys()) if (key.startsWith(prefix)) histories.delete(key);
  };

  const askAgent = async (ctx, forcedDesk = null) => {
    const question = String(ctx.args || '').trim();
    if (!question) {
      return {
        text: 'Usage: question bhejo, ya /crypto &lt;question&gt; / /india &lt;question&gt;.\n\nExample: <i>BTC ab long ya short?</i>',
        keyboard: baseKeyboard('c:menu'),
      };
    }
    if (question.length > config.maxAgentChars) {
      return {
        text: `⚠️ Question bahut lambi hai (${question.length} chars). Max ${config.maxAgentChars}.`,
        keyboard: baseKeyboard('c:menu'),
      };
    }
    const now = clock();
    const last = lastAgentAt.get(ctx.chatId);
    if (last && now - last < 1500) {
      return { text: '⏳ Thoda ruko — pichla AI request abhi chal raha hai.', keyboard: baseKeyboard('c:menu') };
    }
    lastAgentAt.set(ctx.chatId, now);

    const inferred = forcedDesk || inferDesk(question) || lastDesk.get(ctx.chatId) || 'crypto';
    const desk = inferred === 'india' ? 'india' : 'crypto';
    lastDesk.set(ctx.chatId, desk);

    const key = `${ctx.chatId}:${desk}`;
    const entry = histories.get(key) || { messages: [], at: 0 };
    if (now - entry.at > 2 * 60 * 60 * 1000) entry.messages = [];
    const messages = [...entry.messages, { role: 'user', content: question }].slice(-10);

    Promise.resolve(tg.typing?.(ctx.chatId)).catch(() => {});
    const data = await api.agent(desk, messages, { timeoutMs: config.agentTimeoutMs });
    const text = String(data?.text || '').trim();
    if (!text) throw new Error('Agent ne khali jawab diya');
    entry.messages = [...messages, { role: 'assistant', content: text }].slice(-10);
    entry.at = now;
    histories.set(key, entry);
    logger?.debug('agent answered', { desk, tools: Array.isArray(data?.toolsUsed) ? data.toolsUsed.length : 0 });
    return agentResult(text, {
      desk,
      engine: data?.engine,
      toolsUsed: data?.toolsUsed,
      session: data?.session,
    });
  };

  const handlers = {
    async start(ctx) {
      return startResult(config);
    },

    async menu() {
      return menuResult();
    },

    async help() {
      return helpResult();
    },

    async id(ctx) {
      return idResult(ctx.message, config);
    },

    async reset(ctx) {
      clearHistory(ctx.chatId);
      return { text: '🧹 Is chat ka AI context clear ho gaya.', keyboard: baseKeyboard('c:menu') };
    },

    async status(ctx) {
      if (ctx.refresh) api.invalidateAuto?.();
      const [healthR, autoR, posR, paperR, pushR, pingR] = await Promise.allSettled([
        api.health(),
        api.mtfAutoStatus(),
        api.positions(),
        api.paper(),
        api.pushStatus(),
        timed(() => api.ping(), clock),
      ]);
      const health = settled(healthR, 'health');
      const auto = settled(autoR, 'auto');
      const pos = settled(posR, 'positions');
      const paper = settled(paperR, 'paper');
      const push = settled(pushR, 'push');
      const ping = settled(pingR, 'ping');
      const errors = [health, auto, pos, paper, push, ping].map((x) => x.error).filter(Boolean);
      return {
        text: formatStatus({
          health: health.value,
          auto: auto.value,
          positions: pos.value,
          paper: paper.value,
          push: push.value,
          ping: ping.value,
          errors,
        }, clock()),
        keyboard: baseKeyboard('c:status'),
      };
    },

    async health(ctx) {
      const [healthR, opR, pingR] = await Promise.allSettled([
        api.health(),
        api.operationalHealth(),
        timed(() => api.ping(), clock),
      ]);
      const health = settled(healthR, 'health');
      const op = settled(opR, 'operational health');
      const ping = settled(pingR, 'ping');
      const errors = [health, op, ping].map((x) => x.error).filter(Boolean);
      return {
        text: formatHealth({
          health: health.value,
          opHealth: op.value,
          ping: ping.value,
          errors,
        }, clock()),
        keyboard: healthKeyboard(),
      };
    },

    async positions() {
      const [posR, paperR] = await Promise.allSettled([api.positions(), api.paper()]);
      const pos = settled(posR, 'positions');
      const paper = settled(paperR, 'paper');
      return {
        text: formatPositions({
          positions: pos.value,
          paper: paper.value,
          errors: [pos.error, paper.error].filter(Boolean),
        }, clock()),
        keyboard: positionsKeyboard(),
      };
    },

    async pnl(ctx) {
      const arg = String(ctx.args || '').trim().toLowerCase();
      if (['week', 'weekly', 'hafta', 'hafte'].includes(arg)) {
        const data = await api.weekly({ timeoutMs: config.weeklyTimeoutMs });
        return { ...weeklyResult(data, { title: 'P&L — WEEK', now: clock() }), keyboard: weeklyKeyboard() };
      }
      if (arg && !['today', 'aaj', 'day'].includes(arg)) {
        return { text: 'Usage: /pnl [today|week]', keyboard: pnlKeyboard() };
      }
      const [posR, paperR] = await Promise.allSettled([api.positions(), api.paper()]);
      const pos = settled(posR, 'positions');
      const paper = settled(paperR, 'paper');
      return {
        text: formatPnlToday({
          positions: pos.value,
          paper: paper.value,
          errors: [pos.error, paper.error].filter(Boolean),
        }, clock()),
        keyboard: pnlKeyboard(),
      };
    },

    async auto(ctx) {
      if (ctx.refresh) api.invalidateAuto?.();
      const status = await api.mtfAutoStatus();
      const arg = String(ctx.args || '').trim().toLowerCase();

      if (!arg || arg === 'status') {
        return { text: autoStatusText(status, clock()), keyboard: autoKeyboard(status) };
      }
      if (arg === 'off') {
        if (!status.enabled) return { text: autoStatusText(status, clock()), keyboard: autoKeyboard(status) };
        const next = await api.toggleAuto(false);
        return { ...autoActionResult('off', next), keyboard: autoKeyboard(next) };
      }
      if (arg === 'on') {
        if (status.enabled) return { text: autoStatusText(status, clock()), keyboard: autoKeyboard(status) };
        return confirmationResult('on', status, { ttlMs: config.confirmTtlMs });
      }
      if (arg === 'paper' || arg === 'live') {
        const current = String(status.executionMode || 'paper').toLowerCase();
        if (current === arg) return { text: autoStatusText(status, clock()), keyboard: autoKeyboard(status) };
        if (arg === 'paper') {
          await api.setAutoConfig({ executionMode: 'paper' });
          const next = await api.mtfAutoStatus();
          return autoActionResult('paper', next);
        }
        if (!status.coindcxConnected) {
          return {
            text: '⛔ Live mode blocked: CoinDCX credentials connected nahi hain. Pehle site par connection check karo.',
            keyboard: autoKeyboard(status),
          };
        }
        if (status.killSwitch) {
          return {
            text: '⛔ Live mode blocked: kill switch ON hai. Pehle kill switch clear karo.',
            keyboard: autoKeyboard(status),
          };
        }
        return confirmationResult('live', status, { ttlMs: config.confirmTtlMs });
      }
      return {
        text: 'Usage: /auto [status|on|off|paper|live]',
        keyboard: autoKeyboard(status),
      };
    },

    async alerts(ctx) {
      const push = await api.pushStatus();
      return alertsResult(push, clock());
    },

    async weekly() {
      const data = await api.weekly({ timeoutMs: config.weeklyTimeoutMs });
      return { ...weeklyResult(data, { title: 'WEEKLY REVIEW', now: clock() }), keyboard: weeklyKeyboard() };
    },

    async ping() {
      const data = await timed(() => api.ping(), clock);
      return pingResult({ ping: data, latencyMs: data.latencyMs, uptimeSec: process.uptime() }, clock());
    },

    async version() {
      let ping = null;
      try { ping = await timed(() => api.ping(), clock); } catch { ping = null; }
      return {
        text: formatVersion({ ping, config, uptimeSec: process.uptime(), now: clock() }),
        keyboard: baseKeyboard('c:version'),
      };
    },

    async signals(ctx) {
      const raw = String(ctx.args || '').trim();
      if (!isMarketArg(raw)) {
        return { text: 'Usage: /signals [crypto|india|metals|futures|global]', keyboard: signalKeyboard() };
      }
      const market = marketFromArgs(raw, 'CRYPTO');
      const { fetchMarket, options } = boardOptions(market, { now: clock() });
      const board = await api.mtfBoard(fetchMarket, {
        fresh: false,
        limit: 8,
        timeoutMs: config.boardTimeoutMs,
      });
      return {
        text: formatBoard(board, options),
        keyboard: signalKeyboard(),
      };
    },

    async scan(ctx) {
      const now = clock();
      const raw = String(ctx.args || '').trim();
      if (!isMarketArg(raw)) {
        return { text: 'Usage: /scan [crypto|india|metals|futures|global]', keyboard: signalKeyboard() };
      }
      const last = lastScanAt.get(ctx.chatId);
      if (last && now - last < 20000) {
        return {
          text: `⏳ Fresh scan cooldown: ${Math.ceil((20000 - (now - last)) / 1000)}s baad try karo.`,
          keyboard: signalKeyboard(),
        };
      }
      lastScanAt.set(ctx.chatId, now);
      const market = marketFromArgs(raw, 'CRYPTO');
      const { fetchMarket, options } = boardOptions(market, { fresh: true, now });
      const board = await api.mtfBoard(fetchMarket, {
        fresh: true,
        limit: 8,
        timeoutMs: config.boardTimeoutMs,
      });
      return {
        text: formatBoard(board, { ...options, title: marketTitle(market, 'FRESH SCAN') }),
        keyboard: signalKeyboard(),
      };
    },

    async crypto(ctx) {
      if (!String(ctx.args || '').trim()) return handlers.signals({ ...ctx, args: 'crypto' });
      return askAgent(ctx, 'crypto');
    },

    async india(ctx) {
      if (!String(ctx.args || '').trim()) return handlers.signals({ ...ctx, args: 'india' });
      return askAgent(ctx, 'india');
    },

    async agent(ctx) {
      return askAgent(ctx);
    },
  };

  return { handlers, clearHistory, inferDesk };
}

function autoStatusText(status, now) {
  return formatAutoStatus(status, now);
}
