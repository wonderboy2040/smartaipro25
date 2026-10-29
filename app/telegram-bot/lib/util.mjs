// Small, dependency-free helpers shared by the bot.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function stripControl(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Last-line defense for free-form server/transport error text. The bot never
 * prints credentials intentionally; this catches a token embedded in a
 * third-party error message before it can reach Telegram or a log line.
 */
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{25,}(?!\w)/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(token|api[_-]?key|secret|pin)=([^&\s]+)/gi, '$1=[redacted]');
}

export function htmlToPlain(value) {
  return stripControl(String(value ?? ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

export function maskId(value) {
  const s = String(value ?? '');
  if (!s) return '—';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

export function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function num(value, digits = 2) {
  const n = asNumber(value);
  if (n === null) return '—';
  const d = Math.min(6, Math.max(0, Math.round(digits)));
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function inr(value, { signed = false, digits = 2 } = {}) {
  const n = asNumber(value);
  if (n === null) return '—';
  const body = `₹${num(Math.abs(n), digits)}`;
  if (n < 0) return `-${body}`;
  return signed && n > 0 ? `+${body}` : body;
}

export function usdt(value, { signed = false, digits = 2, unit = 'USDT' } = {}) {
  const n = asNumber(value);
  if (n === null) return '—';
  const body = `${num(Math.abs(n), digits)} ${unit}`;
  if (n < 0) return `-${body}`;
  return signed && n > 0 ? `+${body}` : body;
}

export function money(value, ccy, opts = {}) {
  const c = String(ccy || 'INR').toUpperCase();
  if (c === 'INR') return inr(value, opts);
  if (c === 'USDT') return usdt(value, opts);
  if (c === 'USD' || c === 'USDC') return usdt(value, { ...opts, unit: '$' });
  return usdt(value, opts);
}

export function price(value, ccy = 'INR') {
  const n = asNumber(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : 6;
  const body = num(abs, digits);
  const c = String(ccy || 'INR').toUpperCase();
  if (c === 'INR') return `${n < 0 ? '-' : ''}₹${body}`;
  if (c === 'USD' || c === 'USDC') return `${n < 0 ? '-' : ''}$${body}`;
  return `${n < 0 ? '-' : ''}${body} ${c === 'USDT' ? 'USDT' : c}`;
}

export function pct(value, digits = 2, { signed = false } = {}) {
  const n = asNumber(value);
  if (n === null) return '—';
  const body = `${num(Math.abs(n), digits)}%`;
  if (n < 0) return `-${body}`;
  return signed && n > 0 ? `+${body}` : body;
}

export function signedNum(value, digits = 2) {
  const n = asNumber(value);
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${num(n, digits)}`;
}

export function ago(timestamp, now = Date.now()) {
  const ts = asNumber(timestamp);
  if (ts === null || ts <= 0) return '—';
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.floor(asNumber(seconds) ?? 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function istDayStart(now = Date.now()) {
  const shifted = new Date(now + IST_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - IST_OFFSET_MS;
}

export function istTime(timestamp = Date.now(), { withDate = false } = {}) {
  const ts = asNumber(timestamp);
  if (ts === null) return '—';
  const d = new Date(ts + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm} IST`;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mo} ${hh}:${mm} IST`;
}

export function truncate(value, max = 120) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitPlain(text, limit = 4000) {
  const out = [];
  let rest = stripControl(String(text ?? ''));
  const max = Math.max(200, limit);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.55)) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

const VOID_TAGS = new Set(['br', 'hr']);

/**
 * Split Telegram HTML without breaking the 4096-char limit or leaving an
 * unclosed tag. Each chunk re-opens the formatting tags from the previous
 * chunk, so long messages keep their formatting.
 */
export function splitHtml(html, limit = 3900) {
  const src = stripControl(String(html ?? ''));
  const max = Math.max(200, limit);
  if (src.length <= max) return src ? [src] : [];

  const chunks = [];
  let out = '';
  let open = [];
  let i = 0;

  const closeOpen = () => open.slice().reverse().map((t) => `</${t.tag}>`).join('');
  const reopen = () => open.map((t) => t.token).join('');
  const pushChunk = () => {
    const chunk = `${out}${closeOpen()}`;
    if (chunk.trim()) chunks.push(chunk);
    out = reopen();
  };

  while (i < src.length) {
    if (src[i] === '<') {
      const end = src.indexOf('>', i);
      if (end !== -1) {
        const token = src.slice(i, end + 1);
        const m = token.match(/^<\s*(\/)?\s*([a-zA-Z0-9-]+)/);
        if (m && !token.startsWith('<!--')) {
          const closing = Boolean(m[1]);
          const tag = m[2].toLowerCase();
          if (closing) {
            for (let k = open.length - 1; k >= 0; k -= 1) {
              if (open[k].tag === tag) { open.splice(k, 1); break; }
            }
          } else if (!token.endsWith('/>') && !VOID_TAGS.has(tag)) {
            open.push({ tag, token });
          }
        }
        out += token;
        i = end + 1;
        continue;
      }
    }

    if (out.length + 1 > max) {
      pushChunk();
      if (out.length >= max) {
        // A pathological opening-tag prefix is larger than the limit.
        out = out.slice(0, max);
        pushChunk();
      }
      continue;
    }

    out += src[i];
    i += 1;
  }

  if (out) chunks.push(`${out}${closeOpen()}`);
  return chunks.filter((c) => c.length > 0);
}

export function formatPlainBlock(text, title = null) {
  const body = esc(htmlToPlain(text));
  const head = title ? `<b>${esc(title)}</b>\n` : '';
  return `${head}<pre>${body}</pre>`;
}
