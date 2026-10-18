import pandas as pd
import numpy as np
from typing import List


# ============================================================
# MULTI-TIMEFRAME RESAMPLING (Upgrade 1 — MTF confluence)
# ------------------------------------------------------------
# Pure OHLCV resampler: groups a fine-grained frame (e.g. 1m/5m
# bars) into coarser buckets ("5min", "15min", "1h"). open=first,
# high=max, low=min, close=last, volume=sum. Time-bucketed (not
# row-count based) so session gaps don't smear bars together.
# ============================================================
def resample_ohlcv(df: pd.DataFrame, rule: str = "15min") -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    work = df.copy()
    # need a DatetimeIndex to resample
    if not isinstance(work.index, pd.DatetimeIndex):
        if "date" in work.columns:
            try:
                work["date"] = pd.to_datetime(work["date"])
                work = work.set_index("date")
            except Exception:
                return pd.DataFrame()
        elif "time" in work.columns:
            try:
                ts = pd.to_datetime(work["time"], unit="ms", errors="coerce")
                work = work.assign(_ts=ts).set_index("_ts")
            except Exception:
                return pd.DataFrame()
        else:
            return pd.DataFrame()
    agg = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }
    cols = {k: v for k, v in agg.items() if k in work.columns}
    try:
        out = work.resample(rule).agg(cols).dropna(subset=["close"])
    except Exception:
        return pd.DataFrame()
    out = out[out["volume"].fillna(0) > 0] if "volume" in out.columns else out
    return out.reset_index()


def build_features(df: pd.DataFrame, timeframe: str = "1d") -> pd.DataFrame:
    """Feature builder. `timeframe` is informational metadata (which
    bar size the frame holds) — the feature math is identical on any
    bar granularity, so the same indicator stack serves the 5m/15m/
    1h MTF votes and the daily swing model."""
    result = df.copy()
    close = result["close"]
    high = result["high"]
    low = result["low"]
    volume = result["volume"]

    # === TREND / TECHNICAL (30 features) ===
    # RSI
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(14, min_periods=1).mean()
    avg_loss = loss.rolling(14, min_periods=1).mean()
    rs = avg_gain / (avg_loss + 1e-10)
    result["rsi"] = 100 - (100 / (1 + rs))

    # ATR
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    result["atr"] = tr.rolling(14, min_periods=1).mean()
    result["atr_pct"] = result["atr"] / (close + 1e-10)

    # ADX
    plus_dm = high.diff().clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)
    plus_dm[plus_dm < minus_dm] = 0
    minus_dm[minus_dm < plus_dm] = 0
    atr14 = result["atr"]
    plus_di = 100 * (plus_dm.rolling(14, min_periods=1).mean() / (atr14 + 1e-10))
    minus_di = 100 * (minus_dm.rolling(14, min_periods=1).mean() / (atr14 + 1e-10))
    dx = 100 * ((plus_di - minus_di).abs() / (plus_di + minus_di + 1e-10))
    result["adx"] = dx.rolling(14, min_periods=1).mean()

    # MACD
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    result["macd_line"] = ema12 - ema26
    result["macd_signal"] = result["macd_line"].ewm(span=9, adjust=False).mean()
    result["macd_hist"] = result["macd_line"] - result["macd_signal"]

    # Bollinger Bands
    sma20 = close.rolling(20, min_periods=1).mean()
    std20 = close.rolling(20, min_periods=1).std()
    result["bb_upper"] = sma20 + 2 * std20
    result["bb_lower"] = sma20 - 2 * std20
    result["bb_pct_b"] = (close - result["bb_lower"]) / (result["bb_upper"] - result["bb_lower"] + 1e-10)
    result["bb_width"] = (result["bb_upper"] - result["bb_lower"]) / (sma20 + 1e-10)

    # Stochastic
    low14 = low.rolling(14, min_periods=1).min()
    high14 = high.rolling(14, min_periods=1).max()
    result["stoch_k"] = 100 * (close - low14) / (high14 - low14 + 1e-10)
    result["stoch_d"] = result["stoch_k"].rolling(3, min_periods=1).mean()

    # EMAs
    for period in [10, 20, 50, 200]:
        result[f"ema{period}"] = close.ewm(span=period, adjust=False).mean()
        result[f"price_to_ema{period}"] = close / (result[f"ema{period}"] + 1e-10) - 1

    # SMAs
    result["sma20"] = sma20
    result["sma50"] = close.rolling(50, min_periods=1).mean()

    # SMA crossover
    result["sma_cross"] = (result["sma20"] - result["sma50"]) / (result["sma50"] + 1e-10)

    # === VOLATILITY (6 features) ===
    result["rolling_std20"] = close.pct_change().rolling(20, min_periods=1).std()
    result["rolling_std60"] = close.pct_change().rolling(60, min_periods=1).std()
    result["bollinger_width20"] = result["bb_width"]

    # Keltner Channel width
    ema20 = close.ewm(span=20, adjust=False).mean()
    result["keltner_width"] = (2 * result["atr"]) / (ema20 + 1e-10)

    # Historical volatility
    result["hvol_20"] = close.pct_change().rolling(20, min_periods=1).std() * np.sqrt(252)
    result["hvol_60"] = close.pct_change().rolling(60, min_periods=1).std() * np.sqrt(252)

    # === MOMENTUM (8 features) ===
    for n in [5, 21, 63, 126, 252]:
        result[f"ret_{n}"] = close.pct_change(n)

    result["roc_10"] = close.pct_change(10)
    result["roc_20"] = close.pct_change(20)

    # Volatility-adjusted momentum
    result["vol_adj_mom"] = result["ret_21"] / (result["rolling_std20"] + 1e-10)

    # === VOLUME (6 features) ===
    # OBV
    obv = (np.sign(close.diff()) * volume).fillna(0).cumsum()
    result["obv"] = obv
    result["obv_slope"] = obv.diff(5)

    # Volume z-score
    vol_mean = volume.rolling(20, min_periods=1).mean()
    vol_std = volume.rolling(20, min_periods=1).std()
    result["volume_zscore"] = (volume - vol_mean) / (vol_std + 1e-10)

    # MFI
    tp = (high + low + close) / 3
    mf = tp * volume
    pos_mf = mf.where(tp > tp.shift(1), 0).rolling(14, min_periods=1).sum()
    neg_mf = mf.where(tp < tp.shift(1), 0).rolling(14, min_periods=1).sum()
    mfi_ratio = pos_mf / (neg_mf + 1e-10)
    result["mfi"] = 100 - (100 / (1 + mfi_ratio))

    # Accum/Dist
    clv = ((close - low) - (high - close)) / (high - low + 1e-10)
    ad = (clv * volume).fillna(0).cumsum()
    result["accum_dist"] = ad

    # Volume rate of change
    result["volume_roc"] = volume.pct_change(5)

    # === ROLLING STATS (10 features) ===
    daily_ret = close.pct_change()
    for n in [5, 20, 60]:
        result[f"ret_mean_{n}"] = daily_ret.rolling(n, min_periods=1).mean()
        result[f"ret_std_{n}"] = daily_ret.rolling(n, min_periods=1).std()
        result[f"ret_min_{n}"] = daily_ret.rolling(n, min_periods=1).min()
        result[f"ret_max_{n}"] = daily_ret.rolling(n, min_periods=1).max()

    # Distance from 52-week high/low
    high_252 = high.rolling(252, min_periods=1).max()
    low_252 = low.rolling(252, min_periods=1).min()
    result["dist_52w_high"] = close / (high_252 + 1e-10) - 1
    result["dist_52w_low"] = close / (low_252 + 1e-10) - 1

    # === REGIME / MACRO PROXIES (6 features) ===
    # Use market-implied features instead of external data
    result["vix_proxy"] = result["rolling_std20"] * np.sqrt(252) * 100
    result["trend_strength"] = (close - close.rolling(200, min_periods=1).mean()) / (close.rolling(200, min_periods=1).std() + 1e-10)

    # Price acceleration
    result["acceleration"] = daily_ret.diff()

    # Consecutive up/down days
    up_down = np.sign(close.diff())
    result["consec_up"] = up_down.groupby((up_down != up_down.shift()).cumsum()).cumcount() + 1
    result["consec_up"] = result["consec_up"] * up_down.clip(lower=0)
    result["consec_down"] = up_down.groupby((up_down != up_down.shift()).cumsum()).cumcount() + 1
    result["consec_down"] = result["consec_down"] * (-up_down.clip(upper=0))

    # Clean up
    result = result.replace([np.inf, -np.inf], np.nan)
    result = result.dropna(subset=["close"])

    return result


def get_feature_columns(df: pd.DataFrame) -> List[str]:
    exclude = {"open", "high", "low", "close", "volume", "symbol", "date",
               "label", "fwd_return", "fwd_max_dd", "fwd_min_price"}
    return [c for c in df.columns if c not in exclude and df[c].dtype in ["float64", "int64", "float32", "int32"]]


if __name__ == "__main__":
    import sys
    from pathlib import Path  # FIX v18.1: Path was used below but never imported — __main__ crashed
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from pipeline.fetch_data import load_ohlcv
    df = load_ohlcv()
    if df is not None:
        sym = df[df["symbol"] == df["symbol"].unique()[0]]
        feat = build_features(sym)
        cols = get_feature_columns(feat)
        print(f"Features: {len(cols)}")
        print(f"NaN count per feature:")
        print(feat[cols].isna().sum().describe())
    else:
        print("No OHLCV data found. Run fetch_data.py first.")
