import pandas as pd
import numpy as np
from typing import Dict, List
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))


def walk_forward_backtest(
    df: pd.DataFrame,
    feature_cols: List[str],
    window: int = 756,
    step: int = 63,
) -> Dict:
    try:
        import lightgbm as lgb
    except ImportError:
        return {"error": "lightgbm not installed"}

    try:
        from sklearn.metrics import f1_score
    except ImportError:
        return {"error": "scikit-learn not installed"}

    if "label" not in df.columns or "fwd_return" not in df.columns:
        return {"error": "Labels not found. Run labels.py first."}

    df = df.dropna(subset=["label", "fwd_return"])
    df = df[~df[feature_cols].isin([np.inf, -np.inf]).any(axis=1)]
    # v20.7.3 FIX (temporal leakage): walk-forward windows are positional —
    # a symbol-blocked frame let a train window cross into another symbol's
    # future dates. Sort globally by date first.
    if "date" in df.columns:
        df = df.sort_values(["date", "symbol"], kind="stable").reset_index(drop=True)

    if len(df) < window + step * 2:
        return {"error": f"Not enough data: {len(df)} rows, need {window + step * 2}"}

    results = []
    equity = 100000
    equity_curve = []

    for start in range(0, len(df) - window - step, step):
        train_end = start + window
        test_end = min(train_end + step, len(df))

        train = df.iloc[start:train_end]
        test = df.iloc[train_end:test_end]

        if len(test) == 0:
            break

        X_train = train[feature_cols].values
        y_train = train["label"].values
        X_test = test[feature_cols].values
        y_test = test["label"].values
        fwd_returns = test["fwd_return"].values

        valid_train = ~(np.isnan(X_train).any(axis=1) | np.isinf(X_train).any(axis=1))
        valid_test = ~(np.isnan(X_test).any(axis=1) | np.isinf(X_test).any(axis=1))

        if valid_train.sum() < 100 or valid_test.sum() == 0:
            continue

        X_train, y_train = X_train[valid_train], y_train[valid_train]
        X_test, y_test = X_test[valid_test], y_test[valid_test]
        fwd_returns = fwd_returns[valid_test]

        model = lgb.LGBMClassifier(
            n_estimators=200, learning_rate=0.05, num_leaves=31,
            subsample=0.8, colsample_bytree=0.8, class_weight="balanced",
            random_state=42, verbosity=-1, n_jobs=-1,
        )
        model.fit(X_train, y_train)
        preds = model.predict(X_test)

        # Map predictions to returns
        buy_mask = np.isin(preds, ["STRONG_BUY", "BUY"])
        sell_mask = preds == "SELL"

        period_return = 0
        if buy_mask.any():
            period_return = fwd_returns[buy_mask].mean()
        elif sell_mask.any():
            # FIX H5: previously `-abs(fwd_returns[sell_mask].mean())` always
            # made sells lose money even when the asset actually fell (a
            # correct short profits when fwd_return < 0). Use the negation of
            # the forward return so a correct short call earns +|return|.
            period_return = -fwd_returns[sell_mask].mean()

        equity *= (1 + period_return)

        hit = (preds == y_test).mean()
        equity_curve.append({
            "equity": round(float(equity), 2),
            "return": round(float(period_return * 100), 2),
            "hit_rate": round(float(hit * 100), 1),
        })

        results.append({
            "period": f"{start}-{test_end}",
            "samples": len(X_test),
            "hit_rate": round(float(hit * 100), 1),
            "return_pct": round(float(period_return * 100), 2),
            "f1_weighted": round(float(f1_score(y_test, preds, average="weighted")), 3),
        })

    if not results:
        return {"error": "No valid backtest periods."}

    total_return = (equity - 100000) / 100000 * 100
    avg_hit = np.mean([r["hit_rate"] for r in results])
    avg_return = np.mean([r["return_pct"] for r in results])
    avg_f1 = np.mean([r["f1_weighted"] for r in results])
    win_count = sum(1 for r in results if r["return_pct"] > 0)
    win_rate = win_count / len(results) * 100

    returns = [r["return_pct"] for r in results]
    avg_r = np.mean(returns)
    std_r = np.std(returns) if len(returns) > 1 else 1
    # v20.9.1 [M]: Sharpe ab ANNUALIZED (63-step quarterly returns →
    # sqrt(252/63) = 2x scaling; JS twin mlEngine.js:310 wahi karta hai).
    # Pehle raw ratio reported hota tha jo "sharpe_ratio" naam se
    # systematically ~2x understated tha.
    sharpe = (avg_r / std_r if std_r > 0 else 0) * np.sqrt(252 / 63)

    gross_profit = sum(r for r in returns if r > 0)
    gross_loss = abs(sum(r for r in returns if r < 0))
    # v20.9.1 [M]: no-loss sentinel 99 → None (JS twin jaisa honest
    # "undefined" — 99 ek fake bounded number hai jo comparisons break
    # karta hai).
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None

    return {
        "total_periods": len(results),
        "total_return_pct": round(float(total_return), 2),
        "avg_hit_rate": round(float(avg_hit), 1),
        "avg_return_per_period": round(float(avg_return), 2),
        "avg_f1_weighted": round(float(avg_f1), 3),
        "period_win_rate": round(float(win_rate), 1),
        "sharpe_ratio": round(float(sharpe), 2),
        "profit_factor": round(float(profit_factor), 2) if profit_factor is not None else None,
        "equity_curve": equity_curve,
        "periods": results[-5:],
    }


if __name__ == "__main__":
    from pipeline.fetch_data import load_ohlcv
    from pipeline.features import build_features, get_feature_columns
    from pipeline.labels import build_labels

    import sys as _sys

    # --strategy regime_weighted → the Pro Upgrade #4 A/B: the SAME
    # weighted-average baseline with STATIC weights vs the regime
    # multiplier layer (TRENDING/CHOPPY/HIGH_VOL/LOW_VOL tilt, the
    # ensemble.js table mirrored here). Walk-forward, same folds for
    # BOTH legs — the honest comparison that decides whether
    # AI_ENABLE_REGIME_WEIGHTS goes live.
    if len(_sys.argv) > 1 and _sys.argv[1] == "--strategy" and len(_sys.argv) > 2 and _sys.argv[2] == "regime_weighted":
        from models.train_signal import build_meta_training_frame, meta_feature_names

        frame = build_meta_training_frame(load_ohlcv())
        if frame.empty or "regime_label" not in frame.columns:
            print({"error": "No training data with regime labels — run fetch_data.py first."})
            raise SystemExit(0)

        try:
            from sklearn.metrics import f1_score, accuracy_score
        except ImportError:
            print({"error": "scikit-learn not installed"})
            raise SystemExit(0)

        X = frame[meta_feature_names()].values.astype(float)
        y = frame["dir_label"].values
        rl = frame["regime_label"].values.astype(str)
        valid = ~(np.isnan(X).any(axis=1) | np.isinf(X).any(axis=1))
        X, y, rl = X[valid], y[valid], rl[valid]

        # the ensemble.js base weights + the REGIME_MODEL_MULTIPLIERS tilt
        WEIGHTS = {"trend": 1.4, "momentum": 1.3, "volatility": 0.9, "volume": 1.2,
                   "pattern": 1.0, "sr": 1.1, "options": 1.0, "regime": 0.8,
                   "smc": 1.1, "tape": 1.3, "aicouncil": 1.5,
                   "sentiment": 0.7, "instflow": 0.8, "fundamentals": 0.5}
        MULTIPLIERS = {
            "TRENDING": {"trend": 1.25, "momentum": 1.15, "smc": 1.15, "tape": 1.15, "volatility": 0.85, "sr": 0.90, "pattern": 0.95, "volume": 1.05, "regime": 1.10},
            "CHOPPY": {"trend": 0.75, "momentum": 0.80, "smc": 0.80, "tape": 0.85, "volatility": 1.20, "sr": 1.25, "pattern": 1.10, "volume": 1.00, "regime": 1.00, "instflow": 1.10},
            "HIGH_VOL": {"trend": 0.85, "momentum": 0.90, "smc": 0.90, "tape": 0.95, "volatility": 1.25, "sr": 1.05, "pattern": 0.95, "volume": 1.00, "regime": 1.10, "options": 1.05},
            "LOW_VOL": {"trend": 1.10, "momentum": 1.05, "smc": 1.00, "tape": 1.05, "volatility": 0.80, "sr": 0.95, "pattern": 1.00, "volume": 1.00, "regime": 1.00},
        }

        def weighted_side(vec, mul_table=None):
            votes = {}
            names = meta_feature_names()
            for i, mid in enumerate([n.rsplit("__", 1)[0] for n in names if n.endswith("__dir")]):
                votes[mid] = (vec[i * 2], vec[i * 2 + 1])
            w = WEIGHTS if mul_table is None else {m: WEIGHTS.get(m, 1.0) * mul_table.get(m, 1.0) for m in votes}
            raw = sum(d * w.get(m, 1.0) * (c / 100.0) for m, (d, c) in votes.items())
            if raw > 0.15:
                return "UP"
            if raw < -0.15:
                return "DOWN"
            return "FLAT"

        out = {"static": [], "regime": []}
        regime_counts = {}
        for i in range(0, len(X) - 120, 120):
            te = X[i:i + 120]
            yte, rte = y[i:i + 120], rl[i:i + 120]
            if len(te) < 30:
                continue
            static_pred = np.array([weighted_side(v) for v in te])
            regime_pred = np.array([weighted_side(v, MULTIPLIERS.get(lbl, {})) for v, lbl in zip(te, rte)])
            for lbl in rte:
                regime_counts[lbl] = regime_counts.get(lbl, 0) + 1
            out["static"].append({
                "acc": round(float(accuracy_score(yte, static_pred)), 3),
                "f1w": round(float(f1_score(yte, static_pred, average="weighted", labels=np.unique(yte))), 3),
            })
            out["regime"].append({
                "acc": round(float(accuracy_score(yte, regime_pred)), 3),
                "f1w": round(float(f1_score(yte, regime_pred, average="weighted", labels=np.unique(yte))), 3),
            })

        s_acc = float(np.mean([f["acc"] for f in out["static"]])) if out["static"] else 0
        r_acc = float(np.mean([f["acc"] for f in out["regime"]])) if out["regime"] else 0
        s_f1 = float(np.mean([f["f1w"] for f in out["static"]])) if out["static"] else 0
        r_f1 = float(np.mean([f["f1w"] for f in out["regime"]])) if out["regime"] else 0
        total = max(1, sum(regime_counts.values()))
        print({
            "strategy": "regime_weighted vs static weights (walk-forward)",
            "folds": len(out["static"]),
            "static_accuracy": round(s_acc, 3),
            "regime_accuracy": round(r_acc, 3),
            "static_f1_weighted": round(s_f1, 3),
            "regime_f1_weighted": round(r_f1, 3),
            "regime_mix": {k: round(v / total, 3) for k, v in sorted(regime_counts.items())},
            "verdict": "regime wins — flip AI_ENABLE_REGIME_WEIGHTS on the boards" if (r_acc, r_f1) >= (s_acc, s_f1) else "static wins — keep the flag OFF",
        })
        raise SystemExit(0)

    # --strategy meta_ensemble → side-by-side weighted-average vs the
    # trained meta-learner (walk-forward, same folds for BOTH so the
    # comparison is honest — overfitting-safe by construction).
    if len(_sys.argv) > 1 and _sys.argv[1] == "--strategy" and len(_sys.argv) > 2 and _sys.argv[2] == "meta_ensemble":
        from models.train_signal import (
            build_meta_training_frame, meta_feature_names,
            simulate_model_votes, votes_to_feature_vector, load_meta_ensemble,
        )

        frame = build_meta_training_frame(load_ohlcv())
        if frame.empty:
            print({"error": "No meta training data — run fetch_data.py first."})
            raise SystemExit(0)

        try:
            import lightgbm as lgb
            from sklearn.metrics import f1_score, accuracy_score
        except ImportError:
            print({"error": "lightgbm/scikit-learn not installed"})
            raise SystemExit(0)

        X = frame[meta_feature_names()].values.astype(float)
        y = frame["dir_label"].values
        valid = ~(np.isnan(X).any(axis=1) | np.isinf(X).any(axis=1))
        X, y = X[valid], y[valid]

        window = max(600, len(X) // 8)
        step = max(120, window // 6)
        folds = []
        for start in range(0, len(X) - window - step, step):
            tr, te = X[start:start + window], X[start + window:start + window + step]
            ytr, yte = y[start:start + window], y[start + window:start + window + step]
            if len(te) == 0 or len(np.unique(ytr)) < 2:
                continue
            folds.append((tr, te, ytr, yte))

        # WEIGHTED-AVERAGE baseline: the live ensemble.js formula in
        # miniature — weighted dir·conf sum → majority side.
        WEIGHTS = {"trend": 1.4, "momentum": 1.3, "volatility": 0.9, "volume": 1.2,
                   "pattern": 1.0, "sr": 1.1, "options": 1.0, "regime": 0.8,
                   "smc": 1.1, "tape": 1.3, "aicouncil": 1.5,
                   "sentiment": 0.7, "instflow": 0.8, "fundamentals": 0.5}

        def weighted_side(vec):
            votes = {}
            names = meta_feature_names()
            for i, mid in enumerate([n.rsplit("__", 1)[0] for n in names if n.endswith("__dir")]):
                votes[mid] = (vec[i * 2], vec[i * 2 + 1])
            raw = sum(d * WEIGHTS.get(m, 1.0) * (c / 100.0) for m, (d, c) in votes.items())
            if raw > 0.15:
                return "UP"
            if raw < -0.15:
                return "DOWN"
            return "FLAT"

        out = {"folds": len(folds), "meta": [], "weighted": []}
        for tr, te, ytr, yte in folds:
            m = lgb.LGBMClassifier(
                n_estimators=400, learning_rate=0.03, num_leaves=31,
                subsample=0.8, colsample_bytree=0.8, class_weight="balanced",
                random_state=42, verbosity=-1, n_jobs=-1,
            )
            m.fit(tr, ytr)
            meta_pred = m.predict(te)
            w_pred = np.array([weighted_side(v) for v in te])
            out["meta"].append({
                "acc": round(float(accuracy_score(yte, meta_pred)), 3),
                "f1w": round(float(f1_score(yte, meta_pred, average="weighted")), 3),
            })
            out["weighted"].append({
                "acc": round(float(accuracy_score(yte, w_pred)), 3),
                "f1w": round(float(f1_score(yte, w_pred, average="weighted", labels=np.unique(ytr))), 3),
            })

        meta_acc = float(np.mean([f["acc"] for f in out["meta"]])) if out["meta"] else 0
        w_acc = float(np.mean([f["acc"] for f in out["weighted"]])) if out["weighted"] else 0
        meta_f1 = float(np.mean([f["f1w"] for f in out["meta"]])) if out["meta"] else 0
        w_f1 = float(np.mean([f["f1w"] for f in out["weighted"]])) if out["weighted"] else 0
        print({
            "strategy": "meta_ensemble vs weighted-average (walk-forward)",
            "folds": out["folds"],
            "meta_accuracy": round(meta_acc, 3),
            "weighted_accuracy": round(w_acc, 3),
            "meta_f1_weighted": round(meta_f1, 3),
            "weighted_f1_weighted": round(w_f1, 3),
            "verdict": "meta wins" if (meta_acc, meta_f1) >= (w_acc, w_f1) else "weighted wins — keep the flag OFF",
        })
        raise SystemExit(0)

    df = load_ohlcv()
    if df is None:
        print("No data.")
    else:
        all_feat = []
        for sym in df["symbol"].unique():
            sdf = df[df["symbol"] == sym]
            if len(sdf) < 300:
                continue
            feat = build_features(sdf)
            labeled = build_labels(feat)
            all_feat.append(labeled)

        if all_feat:
            combined = pd.concat(all_feat, ignore_index=True)
            feature_cols = get_feature_columns(combined)
            result = walk_forward_backtest(combined, feature_cols)
            print(result)
