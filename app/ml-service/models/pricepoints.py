import numpy as np
import pandas as pd
from typing import Dict, List, Optional


def volume_profile(df: pd.DataFrame, bins: int = 50) -> Dict:
    lo = df["low"].min()
    hi = df["high"].max()
    if hi <= lo:
        hi = lo + 1

    edges = np.linspace(lo, hi, bins + 1)
    vol = np.zeros(bins)

    for _, row in df.iterrows():
        idx = int(((row["close"] - lo) / (hi - lo)) * bins)
        idx = max(0, min(bins - 1, idx))
        vol[idx] += row["volume"]

    poc_idx = np.argmax(vol)
    poc = (edges[poc_idx] + edges[poc_idx + 1]) / 2

    # Value area (70% of volume)
    total_vol = vol.sum()
    sorted_idx = np.argsort(vol)[::-1]
    cumsum = 0
    va_indices = []
    for i in sorted_idx:
        cumsum += vol[i]
        va_indices.append(i)
        if cumsum >= total_vol * 0.70:
            break

    va_prices = [(edges[i] + edges[i + 1]) / 2 for i in va_indices]
    va_low = min(va_prices) if va_prices else lo
    va_high = max(va_prices) if va_prices else hi

    # Volume bins
    volume_bins = []
    total = vol.sum() if vol.sum() > 0 else 1
    for i in range(bins):
        price = (edges[i] + edges[i + 1]) / 2
        volume_bins.append({
            "price": round(float(price), 2),
            "volume": int(vol[i]),
            "pct": round(float(vol[i] / total * 100), 2),
        })

    return {
        "poc": round(float(poc), 2),
        "value_area_high": round(float(va_high), 2),
        "value_area_low": round(float(va_low), 2),
        "volume_bins": volume_bins,
    }


def fibonacci_levels(df: pd.DataFrame) -> List[Dict]:
    swing_hi = df["high"].tail(120).max()
    swing_lo = df["low"].tail(120).min()
    rng = swing_hi - swing_lo

    levels = [
        ("0.0%", swing_lo, "RETRACEMENT"),
        ("23.6%", swing_lo + rng * 0.236, "RETRACEMENT"),
        ("38.2%", swing_lo + rng * 0.382, "RETRACEMENT"),
        ("50.0%", swing_lo + rng * 0.5, "RETRACEMENT"),
        ("61.8%", swing_lo + rng * 0.618, "RETRACEMENT"),
        ("78.6%", swing_lo + rng * 0.786, "RETRACEMENT"),
        ("100.0%", swing_hi, "RETRACEMENT"),
        ("127.2%", swing_hi + rng * 0.272, "EXTENSION"),
        ("161.8%", swing_hi + rng * 0.618, "EXTENSION"),
    ]
    return [{"level": l, "price": round(float(p), 2), "type": t} for l, p, t in levels]


def price_points(df: pd.DataFrame, support: Optional[float] = None) -> Dict:
    close = df["close"].iloc[-1]
    atr = (df["high"] - df["low"]).tail(14).mean()
    if atr <= 0:
        atr = close * 0.02

    swing_hi = df["high"].tail(120).max()
    swing_lo = df["low"].tail(120).min()

    fib_0382 = swing_hi - (swing_hi - swing_lo) * 0.382
    fib_05 = (swing_hi + swing_lo) / 2
    fib_0618 = swing_hi - (swing_hi - swing_lo) * 0.618

    # Entry: max of support zone and fib 0.618, minus 0.5*ATR
    if support is None:
        support = fib_0618

    entry = max(support, fib_0618) - 0.5 * atr
    sl = entry - 1.5 * atr
    tp1 = entry + 2 * atr
    tp2 = entry + 3.5 * atr
    tp3 = swing_hi

    rr = (tp1 - entry) / (entry - sl) if (entry - sl) > 0 else 0

    # Volatility-aware dip ladder
    ladder = [
        {"price": round(float(entry - 0.5 * atr), 2), "pct_budget": 0.20, "label": "ATR 0.5x"},
        {"price": round(float(entry - 1.0 * atr), 2), "pct_budget": 0.25, "label": "ATR 1.0x"},
        {"price": round(float(entry - 1.75 * atr), 2), "pct_budget": 0.30, "label": "ATR 1.75x"},
        {"price": round(float(entry - 2.5 * atr), 2), "pct_budget": 0.25, "label": "ATR 2.5x"},
    ]

    return {
        "entry": round(float(entry), 2),
        "stop_loss": round(float(sl), 2),
        "tp1": round(float(tp1), 2),
        "tp2": round(float(tp2), 2),
        "tp3": round(float(tp3), 2),
        "risk_reward": round(float(rr), 2),
        "atr": round(float(atr), 2),
        "fib_levels": {
            "0.382": round(float(fib_0382), 2),
            "0.5": round(float(fib_05), 2),
            "0.618": round(float(fib_0618), 2),
        },
        "dip_ladder": ladder,
    }


def calculate_exact_entry(df: pd.DataFrame) -> Dict:
    close = df["close"].iloc[-1]
    vp = volume_profile(df)
    pp = price_points(df, support=vp["value_area_low"])
    fibs = fibonacci_levels(df)
    atr = pp["atr"]

    # Combine entry zones
    nearest_fib_support = max(
        [f["price"] for f in fibs if f["price"] < close and f["type"] == "RETRACEMENT"],
        default=close * 0.95
    )

    optimal_entry = (pp["entry"] + nearest_fib_support) / 2
    rr = (pp["tp1"] - close) / (close - pp["stop_loss"]) if (close - pp["stop_loss"]) > 0 else 0

    return {
        "symbol": "",
        "market": "",
        "current_price": round(float(close), 2),
        "volume_profile": vp,
        "fibonacci_levels": fibs,
        "price_points": pp,
        "optimal_entry": round(float(optimal_entry), 2),
        "stop_loss": pp["stop_loss"],
        "tp1": pp["tp1"],
        "tp2": pp["tp2"],
        "tp3": pp["tp3"],
        "risk_reward": round(float(rr), 2),
        "atr": atr,
        "signal": "STRONG_BUY" if rr >= 2.0 else "BUY" if rr >= 1.5 else "HOLD" if rr >= 1.0 else "AVOID",
    }
