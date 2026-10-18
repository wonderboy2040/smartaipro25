"""
ml-service/tests/test_meta_ensemble.py — v10.5 META-ENSEMBLE (Upgrade 4)

Locks the Python side of the stacked meta-learner:
  1. Feature contract: 16 models x (dir, conf) + regime flag = 33, in order
     (v21.13.x recheck M3: the 16-seat roster sync — structure / macross /
     tape-mtf proxies + the legacy 'tape' key retired)
  2. Direction labels: deadband boundaries + horizon alignment
  3. resample_ohlcv: OHLCV aggregation correctness (the MTF helper)
  4. load_meta_ensemble: missing pkl → (None, None) — the WEIGHTED FALLBACK
     contract (never crash)
  5. Stale/mismatched feature contract → rejected → fallback
  6. train → predict roundtrip on synthetic data (walk-forward shape)
Run:  cd ml-service && python -m pytest tests/test_meta_ensemble.py -q
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import META_MODEL_IDS  # noqa: E402
from models.train_signal import (  # noqa: E402
    meta_feature_names, simulate_model_votes, votes_to_feature_vector,
    build_meta_training_frame, train_meta_ensemble, load_meta_ensemble,
    predict_meta_direction,
)
from pipeline.labels import direction_label_from_return, build_direction_labels  # noqa: E402
from pipeline.features import resample_ohlcv  # noqa: E402


# ------------------------------------------------------------------
# 1. The feature contract
# ------------------------------------------------------------------
def test_feature_contract_shape():
    names = meta_feature_names()
    assert len(names) == 33
    assert names[0] == "trend__dir" and names[1] == "trend__conf"
    assert names[-1] == "regime_risk_flag"
    # the 16 model ids are the contract order
    for i, mid in enumerate(META_MODEL_IDS):
        assert names[i * 2] == f"{mid}__dir"
        assert names[i * 2 + 1] == f"{mid}__conf"
    # v21.13.x: the new seats are IN the contract, the legacy tape is OUT
    assert "tape-mtf__dir" in names and "structure__dir" in names and "macross__dir" in names
    assert not any(n.startswith("tape__") for n in names)


def test_votes_to_feature_vector_order_and_clamps():
    votes = {"trend": (1, 80), "momentum": (-1, 60)}
    vec = votes_to_feature_vector(votes, 0.5)
    assert len(vec) == 33
    assert vec[0] == 1 and vec[1] == 80           # trend
    assert vec[2] == -1 and vec[3] == 60           # momentum
    assert vec[4] == 0 and vec[5] == 0            # volatility (absent → abstain)
    assert vec[-1] == 0.5                          # regime flag
    # clamping: dir > 1 / conf > 100 must not pass through
    wild = votes_to_feature_vector({"trend": (7, 500)}, 9)
    assert wild[0] == 1 and wild[1] == 100
    # dict-shaped votes (the live wire format)
    d = votes_to_feature_vector({"trend": {"dir": -1, "conf": 44}}, 0)
    assert d[0] == -1 and d[1] == 44


def test_simulate_model_votes_shape():
    row = {"rsi": 70.0, "sma_cross": 0.01, "bb_pct_b": 0.8, "stoch_k": 60, "stoch_d": 50,
           "dist_52w_high": -0.01, "dist_52w_low": 0.5, "ret_5": 0.01, "roc_10": 0.02,
           "obv": 1000.0, "obv_slope": 50.0,
           # v21.13.x M2: the new seats' inputs (a realistic trending row)
           "ema10": 105.0, "ema20": 103.0, "ema50": 100.0, "trend_strength": 1.5,
           "acceleration": 0.002}
    votes = simulate_model_votes(row)
    assert set(votes.keys()) == set(META_MODEL_IDS)
    for d, c in votes.values():
        assert d in (-1, 0, 1)
        assert 0 <= c <= 100
    # v21.13.x M2: the 3 new seats have LIVE proxies (not constant 0) —
    # a trending row (ema stack up + fresh sma cross + aligned momentum)
    # must produce non-abstain LONG votes from all three.
    assert votes["macross"][0] == 1
    assert votes["structure"][0] == 1
    assert votes["tape-mtf"][0] == 1
    assert votes["tape-mtf"][1] >= 50
    # a choppy/flat row → the new seats abstain honestly
    flat = simulate_model_votes({"rsi": 50.0})
    assert flat["macross"] == (0, 0)
    assert flat["structure"] == (0, 0)
    assert flat["tape-mtf"] == (0, 0)


# ------------------------------------------------------------------
# 2. Direction labels
# ------------------------------------------------------------------
def test_direction_label_deadband():
    assert direction_label_from_return(0.01) == "UP"
    assert direction_label_from_return(-0.01) == "DOWN"
    assert direction_label_from_return(0.0) == "FLAT"
    assert direction_label_from_return(0.004) == "FLAT"   # inside ±0.5%
    assert direction_label_from_return(None) is None


def test_direction_labels_series_and_horizon():
    n = 60
    h = 5
    df = pd.DataFrame({"close": pd.Series(range(1, n + 2), dtype=float)})
    out = build_direction_labels(df, horizon=h)
    assert "dir_label" in out.columns and "dir_return" in out.columns
    # a strictly rising series → every row WITH a forward window is UP
    assert (out["dir_label"].iloc[:-h] == "UP").all()
    # the tail (no forward window) is NaN → FLAT via the deadband default
    assert (out["dir_label"].iloc[-h:] == "FLAT").all()
    assert out["dir_return"].isna().iloc[-h:].all()


def test_build_meta_training_frame_synthetic():
    n = 400
    rng = np.random.default_rng(7)
    frames = []
    for sym in ("AAA", "BBB"):
        px = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.01, n)))
        frames.append(pd.DataFrame({
            "symbol": sym,
            "date": pd.date_range("2024-01-01", periods=n, freq="D"),
            "open": px * 0.99, "high": px * 1.01, "low": px * 0.98,
            "close": px, "volume": rng.integers(1e5, 5e5, n),
        }))
    frame = build_meta_training_frame(pd.concat(frames, ignore_index=True))
    assert not frame.empty
    # v10.6: the frame now carries [features..., dir_label, regime_label]
    # (the rolling regime feeds backtest.py --strategy regime_weighted).
    assert list(frame.columns[:-2]) == meta_feature_names()
    assert frame.columns[-2] == "dir_label"
    assert frame.columns[-1] == "regime_label"
    assert set(frame["dir_label"].unique()) <= {"UP", "DOWN", "FLAT"}
    assert set(frame["regime_label"].unique()) <= {
        "TRENDING", "CHOPPY", "HIGH_VOL", "LOW_VOL", "UNKNOWN",
    }


# ------------------------------------------------------------------
# 3. resample_ohlcv (the MTF helper)
# ------------------------------------------------------------------
def test_resample_ohlcv_aggregates():
    idx = pd.date_range("2024-01-01 09:15", periods=6, freq="5min")
    df = pd.DataFrame({
        "date": idx,
        "open": [10, 11, 12, 13, 14, 15],
        "high": [11, 12, 13, 14, 15, 16],
        "low": [9, 10, 11, 12, 13, 14],
        "close": [10.5, 11.5, 12.5, 13.5, 14.5, 15.5],
        "volume": [100, 100, 100, 100, 100, 100],
    })
    out = resample_ohlcv(df, "15min")
    assert len(out) == 2
    r0 = out.iloc[0]
    assert r0["open"] == 10 and r0["close"] == 12.5 and r0["high"] == 13 and r0["low"] == 9
    assert r0["volume"] == 300


def test_resample_ohlcv_time_bucketed():
    # a 10-minute gap must NOT smear two distant bars into one bucket key
    df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01 09:15", "2024-01-01 09:20", "2024-01-01 09:40"]),
        "open": [1, 2, 3], "high": [1, 2, 3], "low": [1, 2, 3],
        "close": [1, 2, 3], "volume": [10, 10, 10],
    })
    out = resample_ohlcv(df, "15min")
    assert len(out) == 2  # 09:15 bucket (2 bars) + 09:40 bucket (1 bar)


# ------------------------------------------------------------------
# 4-6. The pkl lifecycle (weighted-fallback contract)
# ------------------------------------------------------------------
@pytest.fixture()
def _clean_artifacts(tmp_path, monkeypatch):
    import app.config as cfg
    import models.train_signal as ts
    monkeypatch.setattr(cfg, "META_ENSEMBLE_PATH", tmp_path / "meta_ensemble.pkl")
    monkeypatch.setattr(cfg, "META_FEATURE_COLS_PATH", tmp_path / "meta_feature_cols.pkl")
    # train_signal holds direct imports of the paths — patch them too
    monkeypatch.setattr(ts, "META_ENSEMBLE_PATH", tmp_path / "meta_ensemble.pkl")
    monkeypatch.setattr(ts, "META_FEATURE_COLS_PATH", tmp_path / "meta_feature_cols.pkl")
    ts._meta_cache.update({"at": 0, "clf": None, "cols": None})
    yield tmp_path
    ts._meta_cache.update({"at": 0, "clf": None, "cols": None})


def _synthetic_df(n=700, seed=42):
    rng = np.random.default_rng(seed)
    frames = []
    for sym in ("AAA", "BBB", "CCC"):
        drift = rng.choice([-0.001, 0.0012, 0.0002])
        px = 100 * np.exp(np.cumsum(rng.normal(drift, 0.012, n)))
        frames.append(pd.DataFrame({
            "symbol": sym,
            "date": pd.date_range("2023-01-01", periods=n, freq="D"),
            "open": px * 0.995, "high": px * 1.012, "low": px * 0.988,
            "close": px, "volume": rng.integers(1e5, 5e5, n),
        }))
    return pd.concat(frames, ignore_index=True)


def test_load_missing_pkl_is_none(_clean_artifacts):
    # THE fallback contract: no artifact → (None, None), never an exception
    assert load_meta_ensemble() == (None, None)
    assert predict_meta_direction({"trend": (1, 80)}) is None


def test_train_then_predict_roundtrip(_clean_artifacts):
    out = train_meta_ensemble(_synthetic_df())
    assert out.get("status") == "trained", out
    assert out["features"] == 33
    assert (_clean_artifacts / "meta_ensemble.pkl").exists()
    # predict works with the fresh artifact
    clf, cols = load_meta_ensemble()
    assert clf is not None and list(cols) == meta_feature_names()
    pred = predict_meta_direction({"trend": (1, 85), "momentum": (1, 70)}, 0.2)
    assert pred is not None
    assert pred["side"] in ("LONG", "SHORT", "FLAT")
    assert 0 <= pred["confidence"] <= 100


def test_stale_feature_contract_rejected(_clean_artifacts):
    # train a real artifact, then CORRUPT the contract file → fallback
    assert train_meta_ensemble(_synthetic_df(seed=3, n=700)).get("status") == "trained"
    import joblib
    joblib.dump(["some", "old", "columns"], _clean_artifacts / "meta_feature_cols.pkl")
    import models.train_signal as ts
    ts._meta_cache.update({"at": 0, "clf": None, "cols": None})
    assert load_meta_ensemble() == (None, None)
    assert predict_meta_direction({"trend": (1, 80)}) is None
