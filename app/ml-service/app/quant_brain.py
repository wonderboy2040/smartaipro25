"""
QUANT BRAIN — Deterministic Market Analysis (No LLM Required)
The real pro-trader mind. Always online. Pure math.
Produces ANALYSIS dict — LLM only narrates it.
"""

import pandas as pd
import numpy as np
from typing import Optional


def value_area_low(df: pd.DataFrame, pct: float = 0.70) -> float:
    """Volume-weighted value area low (POC-based support)."""
    if df.empty or 'close' not in df.columns:
        return 0
    if 'volume' not in df.columns:
        return float(df['close'].rolling(20).mean().iloc[-1])

    price_range = np.linspace(df['close'].min(), df['close'].max(), 50)
    vol_at_price = np.zeros(len(price_range))
    for i, p in enumerate(price_range):
        mask = (df['close'] >= p - (price_range[1] - price_range[0]) / 2) & \
               (df['close'] < p + (price_range[1] - price_range[0]) / 2)
        vol_at_price[i] = df.loc[mask, 'volume'].sum()

    total_vol = vol_at_price.sum()
    if total_vol == 0:
        return float(df['close'].iloc[-1])

    sorted_idx = np.argsort(vol_at_price)[::-1]
    cum_vol = 0
    selected = []
    for idx in sorted_idx:
        cum_vol += vol_at_price[idx]
        selected.append(price_range[idx])
        if cum_vol >= total_vol * pct:
            break

    return float(np.min(selected)) if selected else float(df['close'].iloc[-1])


def value_area_high(df: pd.DataFrame, pct: float = 0.70) -> float:
    """Volume-weighted value area high."""
    if df.empty or 'close' not in df.columns:
        return 0
    if 'volume' not in df.columns:
        return float(df['close'].rolling(20).mean().iloc[-1])

    price_range = np.linspace(df['close'].min(), df['close'].max(), 50)
    vol_at_price = np.zeros(len(price_range))
    for i, p in enumerate(price_range):
        mask = (df['close'] >= p - (price_range[1] - price_range[0]) / 2) & \
               (df['close'] < p + (price_range[1] - price_range[0]) / 2)
        vol_at_price[i] = df.loc[mask, 'volume'].sum()

    total_vol = vol_at_price.sum()
    if total_vol == 0:
        return float(df['close'].iloc[-1])

    sorted_idx = np.argsort(vol_at_price)[::-1]
    cum_vol = 0
    selected = []
    for idx in sorted_idx:
        cum_vol += vol_at_price[idx]
        selected.append(price_range[idx])
        if cum_vol >= total_vol * pct:
            break

    return float(np.max(selected)) if selected else float(df['close'].iloc[-1])


def compute_rsi(close: pd.Series, period: int = 14) -> float:
    """RSI calculation."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(window=period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1]) if not np.isnan(rsi.iloc[-1]) else 50.0


def compute_macd(close: pd.Series) -> dict:
    """MACD calculation."""
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    histogram = macd_line - signal_line
    return {
        "macd": float(macd_line.iloc[-1]),
        "signal": float(signal_line.iloc[-1]),
        "histogram": float(histogram.iloc[-1]),
        "trend": "BULLISH" if histogram.iloc[-1] > 0 else "BEARISH"
    }


def compute_atr(df: pd.DataFrame, period: int = 14) -> float:
    """ATR calculation."""
    high, low, close = df['high'], df['low'], df['close']
    tr1 = high - low
    tr2 = (high - close.shift()).abs()
    tr3 = (low - close.shift()).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    atr = tr.rolling(window=period).mean()
    return float(atr.iloc[-1]) if not np.isnan(atr.iloc[-1]) else 0


def compute_adx(df: pd.DataFrame, period: int = 14) -> float:
    """ADX calculation."""
    high, low, close = df['high'], df['low'], df['close']
    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    tr1 = high - low
    tr2 = (high - close.shift()).abs()
    tr3 = (low - close.shift()).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    atr = tr.rolling(window=period).mean()
    plus_di = 100 * (plus_dm.rolling(window=period).mean() / atr.replace(0, np.nan))
    minus_di = 100 * (minus_dm.rolling(window=period).mean() / atr.replace(0, np.nan))
    dx = 100 * ((plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan))
    adx = dx.rolling(window=period).mean()
    return float(adx.iloc[-1]) if not np.isnan(adx.iloc[-1]) else 20.0


def compute_volume_profile(df: pd.DataFrame) -> dict:
    """Volume profile — POC, value area high/low."""
    poc = float(df['close'].iloc[-1])
    vah = value_area_high(df)
    val = value_area_low(df)
    avg_vol = float(df['volume'].mean()) if 'volume' in df.columns else 0
    last_vol = float(df['volume'].iloc[-1]) if 'volume' in df.columns else 0
    vol_signal = "ABOVE_AVG" if last_vol > avg_vol * 1.2 else "LOW" if last_vol < avg_vol * 0.6 else "NORMAL"
    return {
        "poc": round(poc, 2),
        "value_area_high": round(vah, 2),
        "value_area_low": round(val, 2),
        "vol_signal": vol_signal,
    }


def analyze(symbol: str, df: pd.DataFrame, macro: Optional[dict] = None) -> dict:
    """
    Core deterministic market analysis.
    Returns a dict with verdict, confidence, price points, trend, etc.
    This is the SINGLE SOURCE OF TRUTH. LLM narrates this dict.
    """
    if df is None or df.empty or len(df) < 30:
        return {
            "symbol": symbol, "verdict": "HOLD", "confidence": 30,
            "trend": "UNKNOWN", "rsi": 50, "adx": 20,
            "entry": 0, "sl": 0, "tp1": 0, "tp2": 0, "rr": 0,
            "regime": "UNKNOWN", "vix": 0,
            "reason": "Insufficient data",
            "macd": {"macd": 0, "signal": 0, "histogram": 0, "trend": "UNKNOWN"},
            "atr": 0,
            "volume_profile": {},
            "support": 0, "resistance": 0,
        }

    last = df.iloc[-1]
    close = float(last['close'])
    high = float(last['high'])
    low = float(last['low'])

    # === INDICATORS ===
    rsi = compute_rsi(df['close'], 14)
    macd = compute_macd(df['close'])
    atr = compute_atr(df, 14)
    adx = compute_adx(df, 14)
    sma50 = float(df['close'].rolling(50).mean().iloc[-1]) if len(df) >= 50 else close
    sma200 = float(df['close'].rolling(200).mean().iloc[-1]) if len(df) >= 200 else sma50
    vol_profile = compute_volume_profile(df)

    # === TREND ===
    trend = "UP" if sma50 > sma200 else "DOWN"
    trend_strength = "STRONG" if abs(sma50 - sma200) / sma200 > 0.05 else "WEAK"

    # === SUPPORT / RESISTANCE (Fibonacci + Volume Profile) ===
    recent_high = float(df['high'].tail(60).max())
    recent_low = float(df['low'].tail(60).min())
    fib_range = recent_high - recent_low
    fib_382 = recent_low + fib_range * 0.382
    fib_500 = recent_low + fib_range * 0.500
    fib_618 = recent_low + fib_range * 0.618
    support = min(vol_profile["value_area_low"], fib_382)
    resistance = max(vol_profile["value_area_high"], fib_618)

    # === MACRO (from caller) ===
    vix = 0
    regime = "UNKNOWN"
    if macro:
        vix = macro.get("vix", 0)
        regime = macro.get("regime", "UNKNOWN")

    # === VERDICT LOGIC (Pro-Trader Rules) ===
    reasons = []
    score = 50  # base score

    # Regime adjustment
    if regime == "RISK_OFF":
        score -= 15
        reasons.append("RISK_OFF regime — defensive posture")
    elif regime == "RISK_ON":
        score += 10
        reasons.append("RISK_ON regime — risk-on tilt")
    elif regime == "GOLDILOCKS":
        score += 5
        reasons.append("GOLDILOCKS — balanced environment")

    # VIX adjustment
    if vix > 30:
        score -= 10
        reasons.append(f"VIX {vix:.1f} — elevated fear")
    elif vix > 22:
        score -= 5
        reasons.append(f"VIX {vix:.1f} — mild caution")

    # Trend
    if trend == "UP":
        score += 10
        reasons.append("Trend UP (SMA50 > SMA200)")
    else:
        score -= 10
        reasons.append("Trend DOWN (SMA50 < SMA200)")

    # ADX (trend strength)
    if adx > 25:
        reasons.append(f"ADX {adx:.1f} — strong trend")

    # RSI
    if rsi < 30:
        score += 25
        reasons.append(f"RSI {rsi:.1f} — deeply oversold")
    elif rsi < 40:
        score += 15
        reasons.append(f"RSI {rsi:.1f} — approaching oversold")
    elif rsi > 75:
        score -= 20
        reasons.append(f"RSI {rsi:.1f} — overbought")
    elif rsi > 65:
        score -= 5
        reasons.append(f"RSI {rsi:.1f} — elevated")

    # Price vs support zone
    if close <= support * 1.02:
        score += 15
        reasons.append(f"Price near demand zone ({support:.2f})")

    # MACD
    if macd["histogram"] > 0:
        score += 5
        reasons.append("MACD bullish crossover")
    else:
        score -= 5
        reasons.append("MACD bearish")

    # Volume
    if vol_profile["vol_signal"] == "ABOVE_AVG":
        score += 5
        reasons.append("Above-average volume")

    # Map score to verdict
    if score >= 75:
        verdict = "STRONG_BUY"
    elif score >= 60:
        verdict = "BUY"
    elif score >= 45:
        verdict = "HOLD"
    elif score >= 30:
        verdict = "WAIT"
    else:
        verdict = "AVOID"

    # Confidence from score
    confidence = max(20, min(95, score))

    # === EXACT PRICE POINTS (ATR-based) ===
    entry = max(support, close - 0.5 * atr) if atr > 0 else close
    sl = entry - 1.5 * atr if atr > 0 else close * 0.95
    tp1 = entry + 2.0 * atr if atr > 0 else close * 1.05
    tp2 = entry + 3.5 * atr if atr > 0 else close * 1.10
    rr = round((tp1 - entry) / (entry - sl), 2) if (entry - sl) > 0 else 0

    return {
        "symbol": symbol,
        "verdict": verdict,
        "confidence": confidence,
        "trend": trend,
        "trend_strength": trend_strength,
        "rsi": round(rsi, 1),
        "adx": round(adx, 1),
        "macd": macd,
        "atr": round(atr, 2),
        "entry": round(entry, 2),
        "sl": round(sl, 2),
        "tp1": round(tp1, 2),
        "tp2": round(tp2, 2),
        "rr": rr,
        "regime": regime,
        "vix": round(vix, 1),
        "support": round(support, 2),
        "resistance": round(resistance, 2),
        "sma50": round(sma50, 2),
        "sma200": round(sma200, 2),
        "volume_profile": vol_profile,
        "fib_levels": {
            "0.382": round(fib_382, 2),
            "0.500": round(fib_500, 2),
            "0.618": round(fib_618, 2),
        },
        "reasons": reasons,
        "reason": " | ".join(reasons) if reasons else "No significant signal",
        # META-ENSEMBLE STACKING (Upgrade 4): when the trained meta-
        # learner exists AND AI_ENABLE_META_ENSEMBLE=true, it recombines
        # the deterministic factor votes instead of the fixed weighted
        # sum. Missing/stale pkl or any failure → source stays
        # "weighted" and the verdict above is untouched (never crash).
        **_apply_meta_ensemble(locals()),
    }


def _apply_meta_ensemble(env: dict) -> dict:
    """Combine the deterministic factor votes with the trained meta-
    learner. Returns { metaEnsemble: {...} } (empty dict on disable)."""
    try:
        from app.config import meta_ensemble_enabled
        if not meta_ensemble_enabled():
            return {}
        from models.train_signal import simulate_model_votes, votes_to_feature_vector, predict_meta_direction

        # A vote-vector derived from THIS analysis' own factor states —
        # the same factors the reasons above were built from.
        row = {
            "rsi": env.get("rsi", 50.0),
            "adx": env.get("adx", 20.0),
            "sma_cross": (env.get("sma50", 0) - env.get("sma200", 1)) / max(env.get("sma200", 1), 1e-9),
            "ema10": env.get("sma50", 0.0), "ema20": env.get("sma50", 0.0), "ema50": env.get("sma200", 0.0),
            "bb_pct_b": 0.5, "volume_zscore": 0.0, "mfi": 50.0,
            "stoch_k": 50.0, "stoch_d": 50.0,
            "dist_52w_high": -0.1, "dist_52w_low": 0.1,
            "trend_strength": 0.0,
            "ret_5": env.get("macd", {}).get("histogram", 0.0) or 0.0,
            "acceleration": 0.0, "roc_10": env.get("rsi", 50.0) - 50.0,
            "consec_up": 0.0, "consec_down": 0.0, "obv": 1.0, "obv_slope": 0.0,
            "vix_proxy": env.get("vix", 0.0),
        }
        trend = env.get("trend")
        if trend == "UP":
            row["sma_cross"] = max(row["sma_cross"], 0.004)
            row["trend_strength"] = 1.2
        elif trend == "DOWN":
            row["sma_cross"] = min(row["sma_cross"], -0.004)
            row["trend_strength"] = -1.2

        votes = simulate_model_votes(row)
        regime_risk = 1.0 if env.get("regime") == "RISK_OFF" else 0.0
        pred = predict_meta_direction(votes, regime_risk)
        if pred is None:
            return {"metaEnsemble": {
                "applied": False, "source": "weighted",
                "note": "meta_ensemble.pkl missing/stale — weighted-average fallback",
            }}
        return {"metaEnsemble": {
            "applied": True, "source": "meta",
            "side": pred["side"], "confidence": pred["confidence"],
            "label": pred["label"],
        }}
    except Exception:
        # NEVER let the meta layer break the deterministic brain.
        return {"metaEnsemble": {"applied": False, "source": "weighted", "note": "meta layer error — fallback"}}


def brain_to_text(result: dict) -> str:
    """Convert Quant Brain dict to readable text — fallback when LLM is unavailable."""
    cur = "₹" if result.get("market") == "IN" else "$"
    lines = [
        f"📊 QUANT BRAIN — {result['symbol']}",
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"Verdict: {result['verdict']} ({result['confidence']}%)",
        f"Trend: {result['trend']} | RSI: {result['rsi']} | ADX: {result['adx']}",
        f"Regime: {result['regime']} | VIX: {result['vix']}",
        f"",
        f"🎯 Entry: {cur}{result['entry']}",
        f"🛑 Stop Loss: {cur}{result['sl']}",
        f"✅ Target 1: {cur}{result['tp1']}",
        f"✅ Target 2: {cur}{result['tp2']}",
        f"📐 R:R: {result['rr']}",
        f"",
        f"💡 Reasons:",
    ]
    for r in result.get("reasons", []):
        lines.append(f"  • {r}")
    return "\n".join(lines)
