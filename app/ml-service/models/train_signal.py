import pandas as pd
import numpy as np
import joblib
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import f1_score, classification_report
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import (
    LGBM_PARAMS, CALIBRATION_METHOD, CV_SPLITS,
    SIGNAL_MODEL_PATH, CALIBRATOR_PATH, MODEL_DIR,
    META_ENSEMBLE_PATH, META_FEATURE_COLS_PATH, META_MODEL_IDS,
    META_DIR_HORIZON_DAYS,
)
from pipeline.fetch_data import load_ohlcv
from pipeline.features import build_features, get_feature_columns
from pipeline.labels import build_labels, get_label_distribution, build_direction_labels


def train_signal_model(all_symbols_df: pd.DataFrame = None) -> dict:
    if all_symbols_df is None:
        all_symbols_df = load_ohlcv()
    if all_symbols_df is None or all_symbols_df.empty:
        return {"error": "No OHLCV data. Run fetch_data.py first."}

    all_features = []
    for sym in all_symbols_df["symbol"].unique():
        sym_df = all_symbols_df[all_symbols_df["symbol"] == sym]
        if len(sym_df) < 300:
            continue
        feat = build_features(sym_df)
        labeled = build_labels(feat)
        all_features.append(labeled)

    if not all_features:
        return {"error": "Not enough data per symbol for training."}

    combined = pd.concat(all_features, ignore_index=True)
    # v20.7.3 FIX (temporal leakage): the per-symbol blocks are each
    # chronological, but pd.concat stacks SYMBOLS — TimeSeriesSplit cuts by
    # ROW POSITION, so a train window could contain symbol A's 2025 rows
    # while the validation window held symbol B's 2016 rows (future info in
    # training). Sort GLOBALLY by date so positional splits are honest.
    if "date" in combined.columns:
        combined = combined.sort_values(["date", "symbol"], kind="stable").reset_index(drop=True)
    combined = combined.dropna(subset=["label", "fwd_return"])

    feature_cols = get_feature_columns(combined)
    X = combined[feature_cols].values
    y = combined["label"].values

    valid_mask = ~(np.isnan(X).any(axis=1) | np.isinf(X).any(axis=1))
    X = X[valid_mask]
    y = y[valid_mask]

    if len(X) < 500:
        return {"error": f"Not enough samples: {len(X)}"}

    print(f"Training on {len(X)} samples, {len(feature_cols)} features")
    print(f"Label distribution: {dict(zip(*np.unique(y, return_counts=True)))}")

    try:
        import lightgbm as lgb
        base = lgb.LGBMClassifier(**LGBM_PARAMS)
    except ImportError:
        return {"error": "lightgbm not installed. Run: pip install lightgbm"}

    tscv = TimeSeriesSplit(n_splits=min(CV_SPLITS, max(2, len(X) // 200)))

    clf = CalibratedClassifierCV(base, method=CALIBRATION_METHOD, cv=tscv)
    clf.fit(X, y)

    # Evaluate
    scores = []
    for train_idx, val_idx in tscv.split(X):
        X_train, X_val = X[train_idx], X[val_idx]
        y_train, y_val = y[train_idx], y[val_idx]
        base_temp = lgb.LGBMClassifier(**LGBM_PARAMS)
        base_temp.fit(X_train, y_train)
        pred = base_temp.predict(X_val)
        scores.append(f1_score(y_val, pred, average="weighted"))

    avg_f1 = np.mean(scores)

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(clf, SIGNAL_MODEL_PATH)

    # Also save feature columns for inference
    feature_cols_path = MODEL_DIR / "feature_cols.pkl"
    joblib.dump(feature_cols, feature_cols_path)

    print(f"Model saved. Avg weighted F1: {avg_f1:.3f}")
    return {
        "status": "trained",
        "samples": len(X),
        "features": len(feature_cols),
        "avg_weighted_f1": round(avg_f1, 3),
        "label_dist": {k: int(v) for k, v in zip(*np.unique(y, return_counts=True))},
    }


if __name__ == "__main__":
    result = train_signal_model()
    print(result)


# ============================================================
# META-ENSEMBLE STACKING (Upgrade 4)
# ------------------------------------------------------------
# A trained meta-learner that combines the 16 model votes instead
# of the fixed weighted-average. Training-time the live model
# votes don't exist (they live in server/ai/models.js, Node), so
# each model's vote is SIMULATED from the same feature row with a
# faithful deterministic proxy of its live logic (EMA stack →
# TrendMatrix, RSI zones → MomentumQuant, ...). The feature
# CONTRACT is identical to the live wire format: one {dir, conf}
# pair per model id + a market-regime flag.
# v21.13.x recheck (M2): the 16-seat roster needs proxies for
# structure / macross / tape-mtf too (pehle the legacy 14-proxy set
# with 'tape' emitted — the 3 new seats trained as constant-0
# features, so the meta-learner could NEVER learn from them).
# ============================================================

def _clip_conf(x, lo=20.0, hi=95.0):
    return float(np.clip(x, lo, hi))


def simulate_model_votes(row) -> dict:
    """Deterministic per-model {dir, conf} from one feature row — the
    training-time mirror of server/ai/models.js. dir ∈ {-1,0,+1},
    conf ∈ [0,100]. Abstain-votes (dir 0, conf 0) are faithful:
    options/aicouncil have no offline data in this pipeline.
    v21.13.x: _fin/_safe_float None-safe helpers — np.isfinite(None)
    raises TypeError (not False), so a row missing EMA keys used to
    crash the trend proxy's fallback branch (latent since v10.5; live
    rows always carried the EMAs)."""
    votes = {}

    def _fin(x):
        """float(x) if finite else None (None/NaN/inf/garbage → None)."""
        try:
            x = float(x)
        except (TypeError, ValueError):
            return None
        return x if np.isfinite(x) else None

    def _safe_float(x, default=0.0):
        v = _fin(x)
        return default if v is None else v

    # 1. trend — EMA stack + SMA cross (TrendMatrix proxy)
    e10, e20, e50 = _fin(row.get("ema10")), _fin(row.get("ema20")), _fin(row.get("ema50"))
    sma_cross = _safe_float(row.get("sma_cross", 0.0))
    if abs(sma_cross) > 0.002:
        d = 1 if sma_cross > 0 else -1
        votes["trend"] = (d, _clip_conf(45 + min(45, abs(sma_cross) * 900)))
    elif e10 is not None and e20 is not None and e10 != e20:
        d = 1 if e10 > e20 else -1
        votes["trend"] = (d, _clip_conf(38 + abs(e10 - e20) / max(e20, 1e-9) * 1500))
    else:
        votes["trend"] = (0, 0)

    # 2. momentum — RSI zones (MomentumQuant proxy)
    rsi = _safe_float(row.get("rsi", 50.0), 50.0)
    if rsi > 55: votes["momentum"] = (1, _clip_conf(40 + (rsi - 55) * 1.8))
    elif rsi < 45: votes["momentum"] = (-1, _clip_conf(40 + (45 - rsi) * 1.8))
    else: votes["momentum"] = (0, 0)

    # 3. volatility — Bollinger %B (VolatilityScope proxy)
    pb = _safe_float(row.get("bb_pct_b", 0.5), 0.5)
    if pb > 0.7: votes["volatility"] = (1, _clip_conf(42 + (pb - 0.7) * 80))
    elif pb < 0.3: votes["volatility"] = (-1, _clip_conf(42 + (0.3 - pb) * 80))
    else: votes["volatility"] = (0, 0)

    # 4. volume — volume z-score + MFI (VolumeFlow proxy)
    vz, mfi = _safe_float(row.get("volume_zscore", 0.0)), _safe_float(row.get("mfi", 50.0), 50.0)
    vscore = np.clip(vz, -3, 3) * 12 + (mfi - 50) * 0.8
    if abs(vscore) > 10:
        votes["volume"] = (1 if vscore > 0 else -1, _clip_conf(40 + abs(vscore)))
    else: votes["volume"] = (0, 0)

    # 5. pattern — stochastic cross + 52w position (PatternNeural proxy)
    k, d_ = _safe_float(row.get("stoch_k"), 50.0), _safe_float(row.get("stoch_d"), 50.0)
    dh = _fin(row.get("dist_52w_high"))
    if k > d_ and k < 80: votes["pattern"] = (1, _clip_conf(38 + (k - d_) * 1.5))
    elif k < d_ and k > 20: votes["pattern"] = (-1, _clip_conf(38 + (d_ - k) * 1.5))
    elif dh is not None and dh > -0.03: votes["pattern"] = (1, 52.0)
    else: votes["pattern"] = (0, 0)

    # 6. sr — distance from 52w extremes (SRMatrix proxy)
    dlow = _fin(row.get("dist_52w_low"))
    if dh is not None and dh > -0.02: votes["sr"] = (1, 58.0)
    elif dlow is not None and dlow < 0.02: votes["sr"] = (-1, 58.0)
    else: votes["sr"] = (0, 0)

    # 7. options — no chain data in this pipeline (honest abstain)
    votes["options"] = (0, 0)

    # 8. regime — trend strength as the macro gate proxy
    ts = _safe_float(row.get("trend_strength", 0.0))
    if abs(ts) > 0.8: votes["regime"] = (1 if ts > 0 else -1, _clip_conf(40 + min(35, abs(ts) * 12)))
    else: votes["regime"] = (0, 0)

    # 9. smc — swing geometry proxy: 5-bar return + acceleration
    r5, acc = _safe_float(row.get("ret_5", 0.0)), _fin(row.get("acceleration", 0.0))
    s = (r5 * 60) + ((acc or 0.0) * 200)
    if abs(s) > 8: votes["smc"] = (1 if s > 0 else -1, _clip_conf(40 + abs(s) * 1.2))
    else: votes["smc"] = (0, 0)

    # 10. tape-mtf — multi-timeframe momentum confluence (IntradayTapeMTF
    #     w1.6 proxy). Live seat reads the 5m/15m/1h confluence; offline
    #     daily domain me the three horizons map to ret_5 (fast, fraction)
    #     / roc_10 (medium, fraction) / trend_strength (slow, z-score).
    #     Sab teen aligned = the full confluence vote; fast+medium with
    #     slow flat = partial; mixed = honest abstain (the live seat bhi
    #     confluence ke bina abstain karta hai).
    roc = _safe_float(row.get("roc_10", 0.0))
    _r5_v, _roc_v, _ts_v = _safe_float(r5), roc, _safe_float(ts)
    _fast = 1 if _r5_v > 0.005 else (-1 if _r5_v < -0.005 else 0)
    _med = 1 if _roc_v > 0.01 else (-1 if _roc_v < -0.01 else 0)
    _slow = 1 if _ts_v > 0.8 else (-1 if _ts_v < -0.8 else 0)
    if _fast != 0 and _fast == _med == _slow:
        votes["tape-mtf"] = (_fast, _clip_conf(50 + min(40, abs(_roc_v) * 900)))
    elif _fast != 0 and _fast == _med and _slow == 0:
        votes["tape-mtf"] = (_fast, _clip_conf(42 + min(25, abs(_roc_v) * 600)))
    else:
        votes["tape-mtf"] = (0, 0)

    # 11. aicouncil — LLM seat has no offline data (honest abstain)
    votes["aicouncil"] = (0, 0)

    # 12. sentiment — consecutive-day bias proxy
    cu, cd = _safe_float(row.get("consec_up", 0.0)), _safe_float(row.get("consec_down", 0.0))
    if cu >= 3: votes["sentiment"] = (1, 45.0 + cu * 3)
    elif cd >= 3: votes["sentiment"] = (-1, 45.0 + cd * 3)
    else: votes["sentiment"] = (0, 0)

    # 13. instflow — OBV slope proxy
    obs = _fin(row.get("obv_slope", 0.0))
    if obs is not None and abs(obs) > 0:
        rel = abs(obs) / ((abs(_safe_float(row.get("obv"), 1.0))) + 1.0)
        if rel > 0.01: votes["instflow"] = (1 if obs > 0 else -1, _clip_conf(40 + min(30, rel * 800)))
        else: votes["instflow"] = (0, 0)
    else: votes["instflow"] = (0, 0)

    # 14. fundamentals — deep-value proxy only
    if dlow is not None and dlow > 0.6:
        votes["fundamentals"] = (1, 40.0)
    else: votes["fundamentals"] = (0, 0)

    # 15. structure — BOS/CHoCH swing-structure proxy (StructurePro).
    #     A break-of-structure ≈ the fast swing (ret_5) making a new
    #     extreme IN the direction of the prevailing stack (ema10 vs
    #     ema50); acceleration confirming = stronger conf. A break
    #     AGAINST the stack = CHoCH (potential reversal — honest lower
    #     conf, exactly the live seat's BOS-vs-CHoCH distinction).
    _e10s, _e50s, _r5s, _accs = e10, e50, _fin(r5), _fin(acc)
    if _e10s is not None and _e50s is not None and _e10s != _e50s and _r5s is not None and abs(_r5s) > 0.004:
        _stack = 1 if _e10s > _e50s else -1
        _d = 1 if _r5s > 0 else -1
        _acc_ok = _accs is not None and ((_accs > 0) == (_d > 0))
        if _d == _stack:
            votes["structure"] = (_d, _clip_conf(44 + min(35, abs(_r5s) * 2000) + (8 if _acc_ok else 0)))
        else:
            votes["structure"] = (_d, _clip_conf(34 + min(20, abs(_r5s) * 1000)))
    else:
        votes["structure"] = (0, 0)

    # 16. macross — SMA20/50 + EMA10/20 cross-state proxy (MACrossTracker).
    #     sma_cross IS the live seat's cross state; EMA10/20 agreement
    #     adds the confirmation bonus (the live seat grades both crosses).
    _sc, _e20s = _fin(sma_cross), e20
    if _sc is not None and abs(_sc) > 0.001:
        _d = 1 if _sc > 0 else -1
        _ema_agree = _e10s is not None and _e20s is not None and _e10s != _e20s and ((_e10s > _e20s) == (_d > 0))
        votes["macross"] = (_d, _clip_conf(40 + min(40, abs(_sc) * 800) + (6 if _ema_agree else 0)))
    else:
        votes["macross"] = (0, 0)

    return votes


def meta_feature_names() -> list:
    """The 33-feature contract: 16 models x (dir, conf) + regime flag."""
    cols = []
    for mid in META_MODEL_IDS:
        cols.append(f"{mid}__dir")
        cols.append(f"{mid}__conf")
    cols.append("regime_risk_flag")
    return cols


def votes_to_feature_vector(votes: dict, regime_risk: float = 0.0) -> list:
    """votes: {model_id: [dir, conf] | (dir, conf) | {dir, conf}} →
    the ordered 33-feature list. Unknown/missing models vote (0, 0).
    regime_risk: 0..1 (0 = risk-on, 1 = risk-off)."""
    out = []
    for mid in META_MODEL_IDS:
        v = votes.get(mid) if isinstance(votes, dict) else None
        if v is None:
            out.extend([0.0, 0.0])
            continue
        if isinstance(v, dict):
            d, c = float(v.get("dir", 0) or 0), float(v.get("conf", 0) or 0)
        else:
            try:
                d, c = float(v[0]), float(v[1])
            except (TypeError, ValueError, IndexError):
                d, c = 0.0, 0.0
        out.append(max(-1.0, min(1.0, d)))
        out.append(max(0.0, min(100.0, c)))
    out.append(max(0.0, min(1.0, float(regime_risk))))
    return out


def regime_label_of(r) -> str:
    """v10.6 (Pro Upgrade #4): the PAST-ONLY rolling regime label for one
    feature row (daily domain). Mirrors ensemble.js classifyRegime with
    thresholds scaled from 24h gate-index moves to 10-day daily momentum
    (roc_10) — no look-ahead: roc_10/ema20/ema50 are computed from bars
    strictly BEFORE the label horizon is evaluated on.
    """
    roc = r.get("roc_10", np.nan)
    e20, e50 = r.get("ema20", np.nan), r.get("ema50", np.nan)
    if not np.isfinite(roc) or not np.isfinite(e20) or not np.isfinite(e50) or e50 <= 0:
        return "UNKNOWN"
    if e20 > e50 * 1.005:
        trend = "UP"
    elif e20 < e50 * 0.995:
        trend = "DOWN"
    else:
        trend = "FLAT"
    if abs(roc) >= 10:
        return "HIGH_VOL"
    if abs(roc) >= 3 and ((roc > 0 and trend == "UP") or (roc < 0 and trend == "DOWN")):
        return "TRENDING"
    if abs(roc) < 1.5 and trend == "FLAT":
        return "LOW_VOL"
    return "CHOPPY"


def build_meta_training_frame(all_symbols_df: pd.DataFrame = None) -> pd.DataFrame:
    """Per-symbol feature rows → the 33-vote-feature training frame
    with the 3-class direction label (UP/DOWN/FLAT)."""
    if all_symbols_df is None:
        all_symbols_df = load_ohlcv()
    if all_symbols_df is None or all_symbols_df.empty:
        return pd.DataFrame()

    rows = []
    for sym in all_symbols_df["symbol"].unique():
        sym_df = all_symbols_df[all_symbols_df["symbol"] == sym]
        if len(sym_df) < 300:
            continue
        feat = build_features(sym_df)
        labeled = build_direction_labels(feat, horizon=META_DIR_HORIZON_DAYS)
        labeled = labeled.replace([np.inf, -np.inf], np.nan)
        cols = [
            "ema10", "ema20", "ema50", "sma_cross", "rsi", "bb_pct_b",
            "volume_zscore", "mfi", "stoch_k", "stoch_d", "dist_52w_high",
            "dist_52w_low", "trend_strength", "ret_5", "acceleration", "roc_10",
            "consec_up", "consec_down", "obv", "obv_slope", "dir_return", "dir_label",
            # v20.9.3 FIX (H2): the REAL date column rides along — the
            # v20.91 attempt derived `_ts` from `r.name`, but load_ohlcv()
            # returns a RangeIndex frame (fetch_data.py: reset_index(drop=True)
            # + to_parquet(index=False) + sort_values(["symbol","date"])) —
            # so r.name was the integer ROW POSITION and pd.Timestamp(int)
            # = 1970-epoch-ns → the "global date sort" sorted by row
            # position → symbol-block order PRESERVED → TimeSeriesSplit
            # still trained on symbol A's 2025 while validating on symbol
            # B's 2016 (future-in-train leakage, inflated walk-forward F1,
            # corrupted meta_ensemble.pkl served live behind
            # AI_ENABLE_META_ENSEMBLE). The date COLUMN is the truth.
            "date",
        ]
        keep = [c for c in cols if c in labeled.columns]
        labeled = labeled.dropna(subset=[c for c in keep if c in ("dir_label", "dir_return")])
        for _, r in labeled[keep].iterrows():
            votes = simulate_model_votes(r)
            risk_flag = 1.0 if (np.isfinite(r.get("vix_proxy", np.nan)) and r.get("vix_proxy", 0) > 20) else 0.0
            vec = votes_to_feature_vector(votes, risk_flag)
            # v20.9.1 [H2] → v20.9.3 FIX: DATE CARRY from the actual `date`
            # column (the old `r.name` derivation was a NO-OP — see the
            # cols-table comment above for the full post-mortem).
            _ts = pd.to_datetime(r.get("date"), errors="coerce")
            rows.append(vec + [r.get("dir_label"), regime_label_of(r), _ts])

    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=meta_feature_names() + ["dir_label", "regime_label", "_ts"])
    df = df.dropna(subset=["dir_label"])
    # v20.9.1 [H2]: GLOBAL DATE SORT — positional walk-forward splits ab honest
    # (dono consumers: train_meta_ensemble + backtest --strategy meta_ensemble).
    df = df.sort_values("_ts", kind="stable", na_position="last").reset_index(drop=True)
    return df.drop(columns=["_ts"])


def train_meta_ensemble(all_symbols_df: pd.DataFrame = None) -> dict:
    """Train the stacked meta-learner over the 16-model vote features (v21.13 roster).
    Saves meta_ensemble.pkl + meta_feature_cols.pkl (the contract)."""
    frame = build_meta_training_frame(all_symbols_df)
    if frame.empty:
        return {"error": "No training data — run fetch_data.py first."}

    X = frame[meta_feature_names()].values.astype(float)
    y = frame["dir_label"].values

    valid = ~(np.isnan(X).any(axis=1) | np.isinf(X).any(axis=1))
    X, y = X[valid], y[valid]

    if len(X) < 500:
        return {"error": f"Not enough meta samples: {len(X)}"}
    dist = dict(zip(*np.unique(y, return_counts=True)))
    if len(dist) < 2:
        return {"error": f"Degenerate label distribution: {dist}"}

    print(f"[mmeta-ensemble] training on {len(X)} samples, {X.shape[1]} vote-features")
    print(f"[mmeta-ensemble] label distribution: {dist}")

    try:
        import lightgbm as lgb
    except ImportError:
        return {"error": "lightgbm not installed. Run: pip install lightgbm"}

    tscv = TimeSeriesSplit(n_splits=min(CV_SPLITS, max(2, len(X) // 500)))
    clf = lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.03, num_leaves=31,
        subsample=0.8, colsample_bytree=0.8, class_weight="balanced",
        random_state=42, verbosity=-1, n_jobs=-1,
    )

    # walk-forward F1 (honest out-of-sample estimate)
    scores = []
    for tr_idx, va_idx in tscv.split(X):
        m = lgb.LGBMClassifier(
            n_estimators=400, learning_rate=0.03, num_leaves=31,
            subsample=0.8, colsample_bytree=0.8, class_weight="balanced",
            random_state=42, verbosity=-1, n_jobs=-1,
        )
        m.fit(X[tr_idx], y[tr_idx])
        scores.append(f1_score(y[va_idx], m.predict(X[va_idx]), average="weighted"))
    avg_f1 = float(np.mean(scores)) if scores else None

    clf.fit(X, y)
    joblib.dump(clf, META_ENSEMBLE_PATH)
    joblib.dump(meta_feature_names(), META_FEATURE_COLS_PATH)

    print(f"[mmeta-ensemble] saved {META_ENSEMBLE_PATH} · walk-forward weighted-F1: {avg_f1:.3f}")
    return {
        "status": "trained",
        "samples": int(len(X)),
        "features": int(X.shape[1]),
        "avg_weighted_f1": round(avg_f1, 3) if avg_f1 is not None else None,
        "label_dist": {k: int(v) for k, v in dist.items()},
        "artifact": str(META_ENSEMBLE_PATH),
    }


# ---- inference side (consumed by quant_brain.analyze + orchestrator) ----

_meta_cache = {"at": 0, "clf": None, "cols": None}


def load_meta_ensemble(max_age_s: float = 300.0):
    """Lazy cached load of the meta-learner. Returns (clf, cols) or
    (None, None) when the artifact is missing/unreadable — callers
    MUST treat that as the weighted-average fallback, never crash."""
    if not META_ENSEMBLE_PATH.exists():
        return None, None
    now = __import__("time").time()
    if _meta_cache["clf"] is not None and now - _meta_cache["at"] < max_age_s:
        return _meta_cache["clf"], _meta_cache["cols"]
    try:
        clf = joblib.load(META_ENSEMBLE_PATH)
        cols = joblib.load(META_FEATURE_COLS_PATH) if META_FEATURE_COLS_PATH.exists() else meta_feature_names()
        # shape contract: the pkl must consume exactly the contract features
        expected = meta_feature_names()
        if list(cols) != list(expected):
            return None, None  # stale artifact → weighted fallback
        _meta_cache.update({"at": now, "clf": clf, "cols": cols})
        return clf, cols
    except Exception:
        return None, None


def predict_meta_direction(votes: dict, regime_risk: float = 0.0):
    """(side, confidence) from the trained meta-learner, or None when
    it can't answer (no artifact / feature mismatch / predict error)."""
    clf, cols = load_meta_ensemble()
    if clf is None:
        return None
    vec = votes_to_feature_vector(votes, regime_risk)
    X = np.array([vec], dtype=float)
    if np.isnan(X).any() or np.isinf(X).any():
        return None
    try:
        proba = clf.predict_proba(X)[0]
        classes = list(clf.classes_)
        idx = int(np.argmax(proba))
        label = classes[idx]
        conf = float(proba[idx]) * 100.0
        side = {"UP": "LONG", "DOWN": "SHORT"}.get(label, "FLAT")
        return {"side": side, "confidence": round(conf, 1), "label": label}
    except Exception:
        return None


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "meta":
    print(train_meta_ensemble())
