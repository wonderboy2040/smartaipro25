"""
SMARTAI EXPERT MODE — local-AI trading superintelligence (v18.4)
================================================================

"Advance Pro Trading AI Expert Mode" — high-accuracy, strong trade signals
from 100% LOCAL Hugging Face models (zero API cost, zero data leakage):

  Pillar 1  TECHNICAL CONFLUENCE   EMA9/21/50/200 stack + RSI + MACD +
                                    Bollinger + ADX + Stoch + volume, scored
                                    across 15m/1h/4h/1d and TF-weighted
                                    (higher TF = higher weight).
  Pillar 2  MOMENTUM               rate-of-change + MACD histogram slope +
                                    RSI regime + Stochastic cross.
  Pillar 3  AI FORECAST (Chronos)  autogluon/chronos-t5-mini quantile
                                    forecast on the 1h closes — direction,
                                    expected move %, band width -> confidence.
  Pillar 4  NEWS SENTIMENT (FinBERT) ProsusAI/finbert (110M, finance-tuned)
                                    per-headline sentiment -> net score.
  Pillar 5  RISK / VOLATILITY      ATR-normalized stop distance, ADX trend
                                    quality, band-width squeeze/expansion.

Weighted ensemble -> score -100..+100 -> verdict STRONG_BUY..STRONG_SELL,
confidence = pillar AGREEMENT x data quality (a 60% score where all pillars
agree is FAR more trustworthy than 70% where they fight), grade A+..C,
ATR-anchored trade plan (entry / SL / TP1-3 / R:R / position size) and a
confluence walk-forward hit-rate measured on the passed candles.

Degradation contract: Chronos/FinBERT are OPTIONAL. A missing model
renormalizes the weights (never 0x pillars silently) and the response
carries `degraded: ["chronos"]` etc. The endpoint ALWAYS answers.

Model manager: POST /expert/models/download pulls FinBERT into HF_HOME in
a background thread (progress visible on GET /expert/status). warm-ai.bat /
the UI's Download button both hit this — after it completes, the package
is 100% offline.
"""

import os
import time
import logging
import threading
from typing import Dict, List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("ml-service.expert")

router = APIRouter()

_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TF_ORDER = ["15m", "1h", "4h", "1d"]
TF_WEIGHTS = {"15m": 0.10, "1h": 0.25, "4h": 0.30, "1d": 0.35}

# pillar weights — renormalized at runtime if a pillar is unavailable
PILLAR_WEIGHTS = {
    "technical": 0.30,
    "momentum": 0.15,
    "forecast": 0.30,
    "sentiment": 0.15,
    "risk": 0.10,
}

MIN_CANDLES = 30          # per TF to score it at all
MAX_CANDLES = 600         # per TF hard cap
FORECAST_HORIZON = 24     # 1h bars -> 24h ahead when 1h candles are passed

EXPERT_VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# Model download manager (FinBERT + optional chronos-t5-small)
# ---------------------------------------------------------------------------
_DOWNLOADABLE = {
    "finbert": {
        "repo": "ProsusAI/finbert",
        "desc": "FinBERT financial sentiment (110M params, ~440MB)",
    },
    "chronos-small": {
        "repo": "autogluon/chronos-t5-small",
        "desc": "Chronos-T5-Small forecaster (better accuracy than mini, ~200MB)",
    },
}
_dl_state: Dict[str, dict] = {}   # model -> {status, progress, error, startedAt, doneAt}
_dl_lock = threading.Lock()


def _hf_home_hub() -> str:
    """Folder where huggingface_hub (>=0.26) resolves the cache: HF_HOME/hub."""
    hf = os.environ.get("HF_HOME", "").strip()
    if hf:
        return os.path.join(hf, "hub")
    return os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")


def _model_cached(repo_id: str) -> bool:
    """A hub snapshot is 'cached' when a snapshot dir with refs exists."""
    try:
        snap = os.path.join(_hf_home_hub(), "models--" + repo_id.replace("/", "--"), "snapshots")
        if not os.path.isdir(snap):
            return False
        return any(os.path.isdir(os.path.join(snap, d)) for d in os.listdir(snap))
    except Exception:  # noqa: BLE001
        return False


def _download_worker(model_key: str, repo_id: str) -> None:
    with _dl_lock:
        _dl_state[model_key] = {
            "status": "downloading", "progress": 0.0, "error": None,
            "startedAt": time.time(), "doneAt": None,
        }
    st = _dl_state[model_key]
    try:
        from huggingface_hub import snapshot_download
        # huggingface_hub >=0.26: cache_dir must be the HF_HOME ROOT; the lib
        # appends /hub itself. When HF_HOME is unset we use the default cache.
        hf_root = os.environ.get("HF_HOME", "").strip() or None
        snapshot_download(
            repo_id=repo_id,
            cache_dir=hf_root,
            allow_patterns=["*.json", "*.txt", "*.bin", "*.safetensors",
                            "*.model", "*.msgpack"],
            max_workers=2,
        )
        with _dl_lock:
            st["progress"] = 100.0
            st["status"] = "done"
            st["doneAt"] = time.time()
        logger.info("expert] downloaded %s -> %s", repo_id, _hf_home_hub())
    except Exception as e:  # noqa: BLE001
        with _dl_lock:
            st["status"] = "error"
            st["error"] = f"{type(e).__name__}: {e}"
        logger.warning("expert] download %s failed — %s", repo_id, st["error"])


# ---------------------------------------------------------------------------
# Indicator toolbox (numpy only — no pandas, no TA-Lib)
# ---------------------------------------------------------------------------

def ema(values: np.ndarray, period: int) -> Optional[float]:
    n = len(values)
    if n < period or period <= 0:
        return None
    alpha = 2.0 / (period + 1.0)
    out = float(np.mean(values[:period]))
    for v in values[period:]:
        out = float(v) * alpha + out * (1.0 - alpha)
    return out


def rsi(closes: np.ndarray, period: int = 14) -> Optional[float]:
    n = len(closes)
    if n < period + 1:
        return None
    diffs = np.diff(closes[-(period + 1):].astype(float))
    gains = np.clip(diffs, 0, None)
    losses = np.clip(-diffs, 0, None)
    avg_g = float(np.mean(gains))
    avg_l = float(np.mean(losses))
    if avg_l <= 0:
        return 100.0 if avg_g > 0 else 50.0
    rs = avg_g / avg_l
    return 100.0 - 100.0 / (1.0 + rs)


def macd(closes: np.ndarray):
    """Returns (line, signal, histogram) at the last bar, or Nones."""
    n = len(closes)
    if n < 35:
        return None, None, None
    a12, a26 = 2.0 / 13.0, 2.0 / 27.0
    e12 = float(np.mean(closes[:12]))
    e26 = float(np.mean(closes[:26]))
    line = []
    for i, v in enumerate(closes):
        v = float(v)
        if i >= 12:
            e12 = v * a12 + e12 * (1 - a12)
        if i >= 26:
            e26 = v * a26 + e26 * (1 - a26)
            line.append(e12 - e26)
    if len(line) < 9:
        return None, None, None
    a9 = 2.0 / 10.0
    sig = float(np.mean(line[:9]))
    for v in line[9:]:
        sig = v * a9 + sig * (1 - a9)
    hist = line[-1] - sig
    return line[-1], sig, hist


def atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> Optional[float]:
    n = len(closes)
    if n < period + 1:
        return None
    trs = []
    for i in range(n - period, n):
        tr = max(
            float(highs[i]) - float(lows[i]),
            abs(float(highs[i]) - float(closes[i - 1])),
            abs(float(lows[i]) - float(closes[i - 1])),
        )
        trs.append(tr)
    return float(np.mean(trs))


def adx(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> Optional[float]:
    n = len(closes)
    if n < 2 * period:
        return None
    plus, minus, trs = [], [], []
    for i in range(1, n):
        up = float(highs[i]) - float(highs[i - 1])
        dn = float(lows[i - 1]) - float(lows[i])
        plus.append(up if (up > dn and up > 0) else 0.0)
        minus.append(dn if (dn > up and dn > 0) else 0.0)
        trs.append(max(
            float(highs[i]) - float(lows[i]),
            abs(float(highs[i]) - float(closes[i - 1])),
            abs(float(lows[i]) - float(closes[i - 1])),
        ))
    # Wilder smoothing over the last `period` windows
    dxs = []
    for off in range(0, period):
        s = slice(len(trs) - period - off, len(trs) - off) if off else slice(len(trs) - period, len(trs))
        if s.stop - s.start < period:
            continue
        a2 = float(np.sum(trs[s])) or 1e-9
        p2 = 100.0 * float(np.sum(plus[s])) / a2
        m2 = 100.0 * float(np.sum(minus[s])) / a2
        dxs.append(100.0 * abs(p2 - m2) / (p2 + m2 or 1e-9))
    return float(np.mean(dxs)) if dxs else None


def bollinger(closes: np.ndarray, period: int = 20, k: float = 2.0):
    n = len(closes)
    if n < period:
        return None
    win = closes[-period:].astype(float)
    mid = float(np.mean(win))
    sd = float(np.std(win))
    if sd <= 0:
        return None
    last = float(closes[-1])
    return {
        "mid": mid, "upper": mid + k * sd, "lower": mid - k * sd,
        "bandwidth": (4.0 * sd) / mid * 100.0,
        "pct_b": (last - (mid - k * sd)) / (2.0 * k * sd),
    }


def stochastic(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14):
    n = len(closes)
    if n < period:
        return None
    hh = float(np.max(highs[-period:]))
    ll = float(np.min(lows[-period:]))
    if hh - ll <= 0:
        return None
    k = 100.0 * (float(closes[-1]) - ll) / (hh - ll)
    return k


def _parse_candles(raw: List) -> Optional[Dict[str, np.ndarray]]:
    """Accept {t,time,o,open,h,high,l,low,c,close,v,volume} dicts or [t,o,h,l,c,v] arrays."""
    if not raw or not isinstance(raw, list):
        return None
    o, h, l, c, v = [], [], [], [], []
    for x in raw:
        try:
            if isinstance(x, dict):
                cc = float(x.get("close", x.get("c", 0)) or 0)
                oo = float(x.get("open", x.get("o", cc)) or cc)
                hh = float(x.get("high", x.get("h", cc)) or cc)
                ll = float(x.get("low", x.get("l", cc)) or cc)
                vv = float(x.get("volume", x.get("v", 0)) or 0)
            elif isinstance(x, (list, tuple)) and len(x) >= 5:
                oo, hh, ll, cc = (float(x[1]), float(x[2]), float(x[3]), float(x[4]))
                vv = float(x[5]) if len(x) > 5 else 0.0
            else:
                continue
        except (TypeError, ValueError):
            continue
        if cc > 0 and hh >= ll > 0:
            o.append(oo); h.append(hh); l.append(ll); c.append(cc); v.append(vv)
    if len(c) < MIN_CANDLES:
        return None
    if len(c) > MAX_CANDLES:
        o, h, l, c, v = o[-MAX_CANDLES:], h[-MAX_CANDLES:], l[-MAX_CANDLES:], c[-MAX_CANDLES:], v[-MAX_CANDLES:]
    return {
        "open": np.array(o, dtype=float),
        "high": np.array(h, dtype=float),
        "low": np.array(l, dtype=float),
        "close": np.array(c, dtype=float),
        "volume": np.array(v, dtype=float),
    }


# ---------------------------------------------------------------------------
# Pillar 1 + 2: technical confluence & momentum per timeframe
# ---------------------------------------------------------------------------

def _technical_tf(cd: Dict[str, np.ndarray]) -> Optional[dict]:
    """Score one timeframe: -100..+100 plus a readable breakdown."""
    closes, highs, lows, vols = cd["close"], cd["high"], cd["low"], cd["volume"]
    last = float(closes[-1])

    ema9 = ema(closes, 9)
    ema21 = ema(closes, 21)
    ema50 = ema(closes, 50)
    ema200 = ema(closes, 200)
    r = rsi(closes, 14)
    m_line, m_sig, m_hist = macd(closes)
    bb = bollinger(closes, 20)
    adx_v = adx(highs, lows, closes, 14)
    stoch_k = stochastic(highs, lows, closes, 14)
    atr_v = atr(highs, lows, closes, 14)

    parts = []
    score = 0.0
    # 1. EMA stack alignment (strongest single trend signal)
    if ema9 and ema21 and ema50:
        if ema9 > ema21 > ema50:
            parts.append("EMA stack fully bullish (9>21>50)")
            score += 30
        elif ema9 < ema21 < ema50:
            parts.append("EMA stack fully bearish (9<21<50)")
            score -= 30
        else:
            score += 6 if ema9 > ema21 else -6
            parts.append("EMA stack mixed")
        if ema200:
            if last > ema200 and ema50 and ema50 > ema200:
                parts.append("price above rising 200EMA — macro uptrend")
                score += 12
            elif last < ema200 and ema50 and ema50 < ema200:
                parts.append("price below falling 200EMA — macro downtrend")
                score -= 12
    # 2. RSI regime
    if r is not None:
        if r >= 70:
            parts.append(f"RSI {r:.0f} overbought — extension risk")
            score -= 8
        elif r >= 55:
            parts.append(f"RSI {r:.0f} bullish momentum zone")
            score += 14
        elif r <= 30:
            parts.append(f"RSI {r:.0f} oversold — bounce risk")
            score += 8
        elif r <= 45:
            parts.append(f"RSI {r:.0f} bearish momentum zone")
            score -= 14
        else:
            parts.append(f"RSI {r:.0f} neutral")
    # 3. MACD
    if m_hist is not None:
        if m_line > m_sig and m_hist > 0:
            parts.append("MACD above signal (bullish)")
            score += 14
        elif m_line < m_sig and m_hist < 0:
            parts.append("MACD below signal (bearish)")
            score -= 14
        else:
            score += 4 if m_line > m_sig else -4
    # 4. Bollinger position
    if bb:
        if bb["pct_b"] > 1.0:
            parts.append("price above upper Bollinger — stretched")
            score -= 6
        elif bb["pct_b"] < 0.0:
            parts.append("price below lower Bollinger — stretched")
            score += 6
        elif bb["pct_b"] > 0.6:
            score += 8
            parts.append("upper half of Bollinger channel")
        elif bb["pct_b"] < 0.4:
            score -= 8
            parts.append("lower half of Bollinger channel")
    # 5. Stochastic
    if stoch_k is not None:
        if stoch_k > 80:
            score -= 4
        elif stoch_k < 20:
            score += 4
    # 6. volume confirmation
    if len(vols) >= 20:
        v_recent = float(np.mean(vols[-5:]))
        v_base = float(np.mean(vols[-20:])) or 1e-9
        if v_recent > 1.3 * v_base:
            parts.append("volume expanding with the move")
            score += 6 if score >= 0 else -6
        elif v_recent < 0.6 * v_base:
            parts.append("volume drying up — weak conviction")
            score *= 0.85
    # 7. ADX quality
    trend_quality = 0.0
    if adx_v is not None:
        trend_quality = min(adx_v / 50.0, 1.0)
        parts.append(f"ADX {adx_v:.0f} — {'strong' if adx_v >= 25 else 'weak' if adx_v < 20 else 'building'} trend")

    return {
        "score": float(max(min(score, 100.0), -100.0)),
        "trend_quality": trend_quality,
        "rsi": round(r, 1) if r is not None else None,
        "adx": round(adx_v, 1) if adx_v is not None else None,
        "macd_hist": round(m_hist, 6) if m_hist is not None else None,
        "bb_pct_b": round(bb["pct_b"], 3) if bb else None,
        "bb_bandwidth": round(bb["bandwidth"], 2) if bb else None,
        "stoch_k": round(stoch_k, 1) if stoch_k is not None else None,
        "atr": round(atr_v, 6) if atr_v is not None else None,
        "ema": {"9": round(ema9, 6) if ema9 else None, "21": round(ema21, 6) if ema21 else None,
                "50": round(ema50, 6) if ema50 else None, "200": round(ema200, 6) if ema200 else None},
        "notes": parts,
    }


def _momentum_tf(cd: Dict[str, np.ndarray]) -> Optional[dict]:
    closes = cd["close"]
    n = len(closes)
    if n < 30:
        return None
    roc = (float(closes[-1]) / float(closes[-10]) - 1.0) * 100.0
    roc20 = (float(closes[-1]) / float(closes[-20]) - 1.0) * 100.0 if n >= 21 else 0.0
    _, _, h1 = macd(closes)
    _, _, h2 = macd(closes[:-3])
    accel = 0.0
    if h1 is not None and h2 is not None:
        accel = 1 if h1 > h2 else (-1 if h1 < h2 else 0)
    score = 0.0
    score += max(min(roc * 8.0, 40.0), -40.0)
    score += max(min(roc20 * 4.0, 20.0), -20.0)
    score += accel * 12.0
    r = rsi(closes, 14)
    if r is not None:
        if 55 <= r <= 68:
            score += 10
        elif 32 <= r <= 45:
            score -= 10
    return {
        "score": float(max(min(score, 100.0), -100.0)),
        "roc10": round(roc, 2),
        "roc20": round(roc20, 2),
        "accelerating": accel > 0,
    }


# ---------------------------------------------------------------------------
# Pillar 3: Chronos forecast (in-process, reuses hf_models singleton)
# ---------------------------------------------------------------------------

def _chronos_pillar(closes: np.ndarray) -> dict:
    out = {"available": False, "score": 0.0, "detail": None}
    try:
        from app import hf_models  # noqa: PLC0415 — module attr access: the
        # singletons are rebound INSIDE _load_chronos(), so binding them by
        # value here (`from hf_models import _chronos`) snapshots None at
        # import time — the pillar would forever report "not installed".
        hf_models._load_chronos()
        _chronos = hf_models._chronos
        if _chronos is None:
            out["detail"] = f"chronos unavailable — {hf_models._chronos_err or 'not installed'}"
            return out
        import torch
        # fixed seed: Chronos samples forecast paths stochastically — without
        # this the SAME candles can flip a verdict between two calls (observed
        # BUY -> NEUTRAL in E2E). Deterministic per request.
        torch.manual_seed(42)
        ctx = torch.tensor(closes[-512:].astype(np.float32).tolist(), dtype=torch.float32)
        qs, _mean = _chronos.predict_quantiles(
            ctx, prediction_length=FORECAST_HORIZON,
            quantile_levels=[0.1, 0.5, 0.9],
        )
        med = np.array(qs[0, :, 1], dtype=float)
        low = np.array(qs[0, :, 0], dtype=float)
        high = np.array(qs[0, :, 2], dtype=float)
        last = float(closes[-1])
        exp = float(med[-1])
        move_pct = (exp / last - 1.0) * 100.0 if last else 0.0
        band = float(np.mean(high - low) / last * 100.0) if last else 0.0
        # direction from the FULL median path (not just endpoint — smoother)
        path_slope = (float(med[-1]) - float(med[0])) / (abs(float(med[0])) or 1e-9) * 100.0
        mid_move = (move_pct + path_slope) / 2.0
        # score: move magnitude vs band (signal-to-noise)
        snr = mid_move / (band or 1e-9)
        score = max(min(mid_move * 12.0, 55.0), -55.0) + max(min(snr * 25.0, 30.0), -30.0)
        certainty = max(0.0, 1.0 - abs(mid_move) / (band or 1e-9) * 0.5) if band > 0 else 0.5
        out.update({
            "available": True,
            "score": float(max(min(score, 100.0), -100.0)),
            "detail": {
                "expected_move_pct": round(mid_move, 3),
                "band_pct": round(band, 3),
                "snr": round(snr, 2),
                "median_end": round(exp, 6),
                "low_end": round(float(low[-1]), 6),
                "high_end": round(float(high[-1]), 6),
                "horizon_bars": FORECAST_HORIZON,
                "certainty": round(certainty, 3),
            },
        })
    except Exception as e:  # noqa: BLE001
        out["detail"] = f"{type(e).__name__}: {e}"
    return out


# ---------------------------------------------------------------------------
# Pillar 4: FinBERT sentiment (in-process, reuses hf_models singleton)
# ---------------------------------------------------------------------------

def _finbert_pillar(headlines: List[str]) -> dict:
    out = {"available": False, "score": 0.0, "detail": None}
    if not headlines:
        out["detail"] = "no headlines supplied"
        return out
    try:
        from app import hf_models  # noqa: PLC0415 — same snapshot trap as chronos
        hf_models._load_finbert()
        _finbert = hf_models._finbert
        if _finbert is None:
            out["detail"] = f"finbert unavailable — {hf_models._finbert_err or 'not installed'}"
            return out
        raw = _finbert([h.strip() for h in headlines if h and h.strip()][:50],
                       truncation=True, max_length=256)
        pos = neg = 0
        for r in raw:
            lab = str(r.get("label", "")).lower()
            if "pos" in lab:
                pos += 1
            elif "neg" in lab:
                neg += 1
        total = len(raw) or 1
        net = (pos - neg) / total
        read = "bullish" if net > 0.15 else ("bearish" if net < -0.15 else "neutral")
        conviction = (pos + neg) / total
        score = net * 100.0 * (0.6 + 0.4 * min(conviction, 1.0))
        out.update({
            "available": True,
            "score": float(max(min(score, 100.0), -100.0)),
            "detail": {
                "positive": pos, "negative": neg, "neutral": total - pos - neg,
                "net_score": round(net, 3), "read": read,
                "conviction": round(conviction, 3),
            },
        })
    except Exception as e:  # noqa: BLE001
        out["detail"] = f"{type(e).__name__}: {e}"
    return out


# ---------------------------------------------------------------------------
# Pillar 5: risk / volatility
# ---------------------------------------------------------------------------

def _risk_pillar(primary: Optional[dict]) -> dict:
    if not primary or primary.get("atr") is None:
        return {"available": False, "score": 0.0, "detail": "no ATR (short history)"}
    atr_v = primary["atr"]
    last = primary.get("last_price") or 0.0
    adx_v = primary.get("adx") or 0.0
    bb_bw = primary.get("bb_bandwidth") or 0.0
    if not last:
        return {"available": False, "score": 0.0, "detail": "no last price"}
    atr_pct = atr_v / last * 100.0
    score = 0.0
    notes = []
    if adx_v >= 25:
        score += 35.0
        notes.append(f"ADX {adx_v:.0f} — clean trending market")
    elif adx_v < 18:
        score -= 25.0
        notes.append(f"ADX {adx_v:.0f} — choppy, whipsaw risk")
    else:
        score += 10.0
    if atr_pct < 1.2:
        score += 15.0
        notes.append(f"ATR {atr_pct:.2f}% — tight risk per trade")
    elif atr_pct > 4.0:
        score -= 20.0
        notes.append(f"ATR {atr_pct:.2f}% — wide volatility, size down")
    else:
        score += 5.0
    if bb_bw and bb_bw < 2.5:
        score += 10.0
        notes.append("Bollinger squeeze — breakout pending")
    return {
        "available": True,
        "score": float(max(min(score, 100.0), -100.0)),
        "detail": {"atr_pct": round(atr_pct, 3), "adx": adx_v, "notes": notes},
    }


# ---------------------------------------------------------------------------
# Confluence walk-forward hit-rate (honesty stat on the passed candles)
# ---------------------------------------------------------------------------

def _confluence_hit_rate(cd: Optional[Dict[str, np.ndarray]], lookforward: int = 12) -> Optional[dict]:
    if cd is None:
        return None
    closes = cd["close"]
    n = len(closes)
    if n < 210 + lookforward:
        return None
    hits = 0
    signals = 0
    for i in range(200, n - lookforward, 4):   # stride 4: cheap, less overlap
        sub = {k: v[: i + 1] for k, v in cd.items()}
        t = _technical_tf(sub)
        if t is None or abs(t["score"]) < 20:
            continue  # only count ACTIONABLE confluence (>20 magnitude)
        fwd = float(closes[min(i + lookforward, n - 1)]) / float(closes[i]) - 1.0
        if (t["score"] > 0 and fwd > 0) or (t["score"] < 0 and fwd < 0):
            hits += 1
        signals += 1
    if signals < 8:
        return None
    return {
        "signals": signals,
        "hit_rate": round(hits / signals * 100.0, 1),
        "lookforward_bars": lookforward,
        "note": "walk-forward on the SAME candles you passed — honest in-sample "
                "confluence accuracy, not a promise",
    }


# ---------------------------------------------------------------------------
# Trade plan (ATR + structure anchored)
# ---------------------------------------------------------------------------

def _trade_plan(side: str, primary: dict, last: float, atr_v: float, capital: float, risk_pct: float) -> dict:
    if side == "NEUTRAL" or not last or not atr_v:
        return {"active": False, "reason": "no actionable verdict — stand aside"}
    long = side in ("STRONG_BUY", "BUY")
    ema21 = (primary.get("ema") or {}).get("21")
    entry = last
    if ema21 and abs(last - ema21) / last < 0.012:
        entry = (last + ema21) / 2.0
    sl_dist = max(1.6 * atr_v, last * 0.006)
    if long:
        sl = entry - sl_dist
        tp1, tp2, tp3 = entry + sl_dist * 1.0, entry + sl_dist * 2.0, entry + sl_dist * 3.0
    else:
        sl = entry + sl_dist
        tp1, tp2, tp3 = entry - sl_dist * 1.0, entry - sl_dist * 2.0, entry - sl_dist * 3.0
    risk_amount = capital * risk_pct / 100.0 if capital > 0 else 0.0
    qty = (risk_amount / sl_dist) if (sl_dist > 0 and capital > 0) else 0.0
    rr = abs(tp2 - entry) / sl_dist if sl_dist else 0.0
    return {
        "active": True,
        "side": "LONG" if long else "SHORT",
        "entry": round(entry, 6),
        "stop_loss": round(sl, 6),
        "tp1": round(tp1, 6),
        "tp2": round(tp2, 6),
        "tp3": round(tp3, 6),
        "risk_reward": round(rr, 2),
        "atr": round(atr_v, 6),
        "sl_distance_pct": round(sl_dist / entry * 100.0, 2) if entry else None,
        "position_size": round(qty, 6) if qty else None,
        "risk_amount": round(risk_amount, 2) if capital > 0 else None,
        "notes": [
            f"SL = 1.6x ATR ({sl_dist / entry * 100.0:.2f}% of price) — vol-adjusted",
            "TP1 = 1R (take 40% off, SL to breakeven), TP2 = 2R, TP3 = runner",
            f"size {risk_pct}% of capital so a SL hit = -{risk_pct}% account",
        ],
    }


# ---------------------------------------------------------------------------
# Ensemble
# ---------------------------------------------------------------------------

class ExpertRequest(BaseModel):
    symbol: str
    market: str = "IN"
    currency: str = ""
    candles: Dict[str, List] = {}
    headlines: List[str] = []
    risk: dict = {}


def _ensemble(pillars: Dict[str, dict]) -> dict:
    active = {k: v for k, v in pillars.items() if v.get("available")}
    if not active:
        return {"score": 0.0, "confidence": 0.0, "grade": "D", "degraded": list(pillars.keys())}
    total_w = sum(PILLAR_WEIGHTS.get(k, 0.0) for k in active) or 1.0
    score = sum(PILLAR_WEIGHTS.get(k, 0.0) * v["score"] for k, v in active.items()) / total_w
    dirs = []
    for k, v in active.items():
        s = v["score"]
        if abs(s) >= 8:
            dirs.append(1 if s > 0 else -1)
    lead = 1 if score >= 0 else -1
    agreement = (sum(1 for d in dirs if d == lead) / len(dirs)) if dirs else 0.5
    magnitude = min(abs(score) / 55.0, 1.0)
    confidence = round(max(0.0, min(99.0, 35.0 + 40.0 * agreement + 24.0 * magnitude)), 1)
    grade = ("A+" if confidence >= 85 else "A" if confidence >= 72 else
             "B" if confidence >= 55 else "C" if confidence >= 40 else "D")
    return {
        "score": round(float(score), 1),
        "confidence": confidence,
        "agreement": round(agreement, 3),
        "grade": grade,
        "degraded": [k for k, v in pillars.items() if not v.get("available")],
        "active_pillars": list(active.keys()),
    }


def _verdict(score: float) -> str:
    if score >= 55:
        return "STRONG_BUY"
    if score >= 25:
        return "BUY"
    if score <= -55:
        return "STRONG_SELL"
    if score <= -25:
        return "SELL"
    return "NEUTRAL"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
def expert_status():
    from app import hf_models  # noqa: PLC0415
    chronos_state = "loaded" if hf_models._chronos is not None else ("error: " + hf_models._chronos_err if hf_models._chronos_err else "not-loaded")
    finbert_state = "loaded" if hf_models._finbert is not None else ("error: " + hf_models._finbert_err if hf_models._finbert_err else "not-loaded")
    with _dl_lock:
        downloads = {k: dict(v) for k, v in _dl_state.items()}
    return {
        "ok": True,
        "expert_version": EXPERT_VERSION,
        "models": {
            "chronos": {
                "repo": "autogluon/chronos-t5-mini",
                "state": chronos_state,
                "cached_offline": _model_cached("autogluon/chronos-t5-mini"),
            },
            "finbert": {
                "repo": "ProsusAI/finbert",
                "state": finbert_state,
                "cached_offline": _model_cached("ProsusAI/finbert"),
                "size_hint": "~440MB first download",
            },
            "chronos_small_optional": {
                "repo": "autogluon/chronos-t5-small",
                "state": "optional upgrade",
                "cached_offline": _model_cached("autogluon/chronos-t5-small"),
            },
        },
        "downloads": downloads,
        "hf_home": os.environ.get("HF_HOME", "") or "(default user cache)",
        "pillars": PILLAR_WEIGHTS,
        "hint": "POST /expert/analyze {symbol, market, candles{15m|1h|4h|1d}, headlines[]}",
    }


@router.post("/models/download")
def expert_download(body: dict = None):
    body = body or {}
    which = str((body or {}).get("model", "finbert")).lower()
    if which not in _DOWNLOADABLE:
        raise HTTPException(status_code=400, detail=f"unknown model '{which}' — one of {list(_DOWNLOADABLE)}")
    spec = _DOWNLOADABLE[which]
    if _model_cached(spec["repo"]):
        return {"ok": True, "model": which, "status": "already-cached",
                "hint": "POST /expert/models/warm to load it into memory"}
    with _dl_lock:
        cur = _dl_state.get(which)
        if cur and cur.get("status") == "downloading":
            return {"ok": True, "model": which, "status": "downloading", "progress": cur.get("progress")}
    th = threading.Thread(target=_download_worker, args=(which, spec["repo"]), daemon=True)
    th.start()
    return {"ok": True, "model": which, "status": "started", "desc": spec["desc"],
            "hint": "poll GET /expert/status -> downloads.finbert.progress"}


@router.post("/models/warm")
def expert_warm():
    """Force-load both models into memory (first real call can take 10-40s)."""
    from app import hf_models  # noqa: PLC0415
    hf_models._load_chronos()
    hf_models._load_finbert()
    return {"ok": True, "loaded": {"chronos": hf_models._chronos is not None, "finbert": hf_models._finbert is not None}}


@router.post("/analyze")
def expert_analyze(req: ExpertRequest):
    t0 = time.time()
    # ---- parse candles per TF -------------------------------------------
    tf_data: Dict[str, dict] = {}
    for tf in TF_ORDER:
        raw = (req.candles or {}).get(tf)
        if raw:
            parsed = _parse_candles(raw)
            if parsed:
                tf_data[tf] = parsed
    if not tf_data:
        raise HTTPException(
            status_code=400,
            detail=f"no usable candles — pass at least one TF of >= {MIN_CANDLES} candles (15m/1h/4h/1d)",
        )

    # ---- pillars ---------------------------------------------------------
    tech_scores = {}
    tech_details = {}
    for tf, cd in tf_data.items():
        t = _technical_tf(cd)
        if t:
            tech_scores[tf] = t["score"] * TF_WEIGHTS.get(tf, 0.25)
            tech_details[tf] = t
    if not tech_scores:
        raise HTTPException(status_code=400, detail="candles too short for technical scoring (need >= 35 bars)")

    technical_score = sum(tech_scores.values()) / sum(TF_WEIGHTS.get(tf, 0.25) for tf in tech_scores)
    tf_align = {}
    for tf in TF_ORDER:
        if tf in tech_details:
            s = tech_details[tf]["score"]
            tf_align[tf] = "bullish" if s >= 20 else ("bearish" if s <= -20 else "neutral")

    mom_src = tf_data.get("1h") or tf_data.get("4h") or tf_data.get("15m")
    momentum = _momentum_tf(mom_src) if mom_src is not None else None

    fc_src = tf_data.get("1h") or tf_data.get("4h") or tf_data.get("1d")
    forecast = _chronos_pillar(fc_src["close"]) if fc_src is not None else {"available": False, "score": 0.0, "detail": "no forecast source"}
    sentiment = _finbert_pillar(req.headlines or [])

    # primary TF = highest available of 1d > 4h > 1h > 15m
    primary_tf_key = next((tf for tf in TF_ORDER[::-1] if tf in tf_data), None)
    primary_tf = tf_data.get(primary_tf_key)
    primary = tech_details.get(primary_tf_key, {})
    last_price = float(primary_tf["close"][-1]) if primary_tf is not None else 0.0
    if primary.get("atr") is None and primary_tf is not None:
        primary["atr"] = atr(primary_tf["high"], primary_tf["low"], primary_tf["close"], 14)
    primary["last_price"] = last_price
    risk = _risk_pillar(primary)

    pillars = {
        "technical": {"available": True, "score": technical_score,
                      "detail": {"per_tf": {tf: tech_details[tf]["score"] for tf in tech_details},
                                 "tf_read": tf_align}},
        "momentum": {"available": momentum is not None, "score": (momentum or {}).get("score", 0.0),
                     "detail": momentum},
        "forecast": forecast,
        "sentiment": sentiment,
        "risk": risk,
    }

    ens = _ensemble(pillars)
    verdict = _verdict(ens["score"])

    # ---- trade plan ------------------------------------------------------
    risk_cfg = req.risk or {}
    capital = float(risk_cfg.get("capital", 0) or 0)
    risk_pct = float(risk_cfg.get("risk_pct", 1.0) or 1.0)
    plan = _trade_plan(verdict, primary, last_price, primary.get("atr") or last_price * 0.01,
                       capital, max(0.25, min(risk_pct, 5.0)))

    hit = _confluence_hit_rate(tf_data.get("1h"))

    # ---- reasoning -------------------------------------------------------
    reasoning = []
    for tf in TF_ORDER:
        if tf in tech_details:
            d = tech_details[tf]
            note = "; ".join(d["notes"][:3])
            reasoning.append(f"[{tf}] score {d['score']:+.0f} — {note}")
    if forecast.get("available"):
        fd = forecast["detail"]
        reasoning.append(
            f"[Chronos-T5] expects {fd['expected_move_pct']:+.2f}% over {fd['horizon_bars']}h "
            f"(90% band ±{fd['band_pct']:.2f}%, SNR {fd['snr']}) — local AI forecast"
        )
    else:
        reasoning.append(f"[Chronos-T5] offline: {forecast.get('detail')}")
    if sentiment.get("available"):
        sd = sentiment["detail"]
        reasoning.append(
            f"[FinBERT] news {sd['read']} (net {sd['net_score']:+.2f}, {sd['positive']}pos/"
            f"{sd['negative']}neg/{sd['neutral']}neu) — local finance-tuned NLP"
        )
    else:
        reasoning.append(f"[FinBERT] offline: {sentiment.get('detail')} — run Download once")
    if momentum:
        reasoning.append(
            f"[Momentum] 10-bar {momentum['roc10']:+.2f}%, 20-bar {momentum['roc20']:+.2f}%, "
            f"{'accelerating' if momentum['accelerating'] else 'fading'}"
        )
    if ens.get("agreement") is not None:
        reasoning.append(
            f"[Ensemble] pillar agreement {ens['agreement'] * 100:.0f}% — confidence "
            f"{ens['confidence']}% (grade {ens['grade']})"
            + (f", DEGRADED (missing: {', '.join(ens['degraded'])})" if ens.get("degraded") else "")
        )
    if hit:
        reasoning.append(f"[Backtest] same-candle confluence hit-rate {hit['hit_rate']}% over {hit['signals']} signals")

    tf_table = {}
    for tf in TF_ORDER:
        if tf in tech_details:
            d = tech_details[tf]
            tf_table[tf] = {
                "score": round(d["score"], 1),
                "read": tf_align.get(tf, "neutral"),
                "rsi": d.get("rsi"), "adx": d.get("adx"),
                "macd_hist": d.get("macd_hist"), "bb_pct_b": d.get("bb_pct_b"),
                "stoch_k": d.get("stoch_k"),
            }

    return {
        "ok": True,
        "expert_version": EXPERT_VERSION,
        "symbol": req.symbol,
        "market": req.market,
        "currency": req.currency or ("INR" if req.market == "IN" else "USD"),
        "last_price": round(last_price, 6),
        "verdict": verdict,
        "score": ens["score"],
        "confidence": ens["confidence"],
        "grade": ens["grade"],
        "agreement": ens.get("agreement"),
        "degraded": ens.get("degraded", []),
        "pillars": {
            "technical": round(technical_score, 1),
            "momentum": round((momentum or {}).get("score", 0.0), 1),
            "forecast": round(forecast.get("score", 0.0), 1) if forecast.get("available") else None,
            "sentiment": round(sentiment.get("score", 0.0), 1) if sentiment.get("available") else None,
            "risk": round(risk.get("score", 0.0), 1) if risk.get("available") else None,
        },
        "models_used": {
            "chronos": forecast.get("available"),
            "finbert": sentiment.get("available"),
            "local": True,
            "api_cost": "0.00 — 100% local inference",
        },
        "forecast_detail": forecast.get("detail"),
        "sentiment_detail": sentiment.get("detail"),
        "timeframes": tf_table,
        "trade_plan": plan,
        "confluence_backtest": hit,
        "reasoning": reasoning,
        "elapsed_s": round(time.time() - t0, 2),
    }
