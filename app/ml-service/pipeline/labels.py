import pandas as pd
import numpy as np
from typing import Tuple
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import HORIZON_DAYS, META_DIR_DEADBAND, META_DIR_HORIZON_DAYS


def build_labels(df: pd.DataFrame, horizon: int = HORIZON_DAYS) -> pd.DataFrame:
    result = df.copy()
    close = result["close"]

    # Forward return over horizon
    result["fwd_return"] = close.shift(-horizon) / close - 1

    # Forward max drawdown within horizon (worst dip before the end)
    fwd_min = close.rolling(horizon, min_periods=1).min().shift(-horizon)
    result["fwd_max_dd"] = fwd_min / close - 1

    # Forward minimum price during horizon
    result["fwd_min_price"] = close.rolling(horizon, min_periods=1).min().shift(-horizon)

    # Classify: STRONG_BUY / BUY / HOLD / SELL
    # STRONG_BUY: high return AND limited downside
    strong_buy = (result["fwd_return"] > 0.15) & (result["fwd_max_dd"] > -0.08)
    buy = (result["fwd_return"] > 0.07) & ~strong_buy
    sell = result["fwd_return"] < -0.05
    hold = ~strong_buy & ~buy & ~sell

    result["label"] = np.select(
        [strong_buy, buy, sell],
        ["STRONG_BUY", "BUY", "SELL"],
        default="HOLD"
    )

    return result


def direction_label_from_return(fwd_return, deadband: float = META_DIR_DEADBAND):
    """Map a forward return to the 3-class direction label.

    UP:   fwd_return >  +deadband
    DOWN: fwd_return <  -deadband
    FLAT: |fwd_return| <= deadband   (noise band — no edge either way)

    Scalar or Series input, same type out (vectorised).
    """
    fr = pd.Series(fwd_return) if np.ndim(fwd_return) == 1 and hasattr(fwd_return, "__len__") else fwd_return
    if isinstance(fr, pd.Series):
        up = fr > deadband
        down = fr < -deadband
        return np.select([up, down], ["UP", "DOWN"], default="FLAT")
    # scalar
    if fwd_return is None or (isinstance(fwd_return, float) and np.isnan(fwd_return)):
        return None
    if fwd_return > deadband:
        return "UP"
    if fwd_return < -deadband:
        return "DOWN"
    return "FLAT"


def build_direction_labels(df: pd.DataFrame, horizon: int = META_DIR_HORIZON_DAYS) -> pd.DataFrame:
    """3-class direction labels (UP/DOWN/FLAT) for the meta-ensemble.

    The meta-learner combines model VOTES, so its label must be the
    actual forward-return direction — not the 4-class swing verdict
    (STRONG_BUY/BUY/HOLD/SELL) whose thresholds (±7%/15%) are tuned
    for position sizing, not direction. A 10-day horizon + ±0.5%
    deadband matches the ensemble's intraday-to-swing holding mix.
    """
    result = df.copy()
    close = result["close"]
    result["dir_return"] = close.shift(-horizon) / close - 1
    result["dir_label"] = direction_label_from_return(result["dir_return"])
    return result


def get_label_distribution(df: pd.DataFrame) -> dict:
    if "label" not in df.columns:
        return {}
    counts = df["label"].value_counts()
    total = len(df)
    return {
        label: {"count": int(counts.get(label, 0)), "pct": round(counts.get(label, 0) / total * 100, 1)}
        for label in ["STRONG_BUY", "BUY", "HOLD", "SELL"]
    }


if __name__ == "__main__":
    from pipeline.fetch_data import load_ohlcv
    from pipeline.features import build_features
    df = load_ohlcv()
    if df is not None:
        sym = df[df["symbol"] == df["symbol"].unique()[0]]
        feat = build_features(sym)
        labeled = build_labels(feat)
        print("Label distribution:")
        print(get_label_distribution(labeled))
        print(f"\nTotal rows: {len(labeled)}")
    else:
        print("No data.")
