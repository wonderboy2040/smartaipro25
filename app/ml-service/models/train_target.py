import pandas as pd
import numpy as np
import joblib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import QUANTILE_PARAMS, MODEL_DIR
from pipeline.fetch_data import load_ohlcv
from pipeline.features import build_features, get_feature_columns
from pipeline.labels import build_labels


QUANTILES = [0.1, 0.5, 0.9]
TARGET_FILES = {0.1: "target_q10.pkl", 0.5: "target_q50.pkl", 0.9: "target_q90.pkl"}


def train_target_models(all_symbols_df: pd.DataFrame = None) -> dict:
    if all_symbols_df is None:
        all_symbols_df = load_ohlcv()
    if all_symbols_df is None or all_symbols_df.empty:
        return {"error": "No OHLCV data."}

    all_features = []
    for sym in all_symbols_df["symbol"].unique():
        sym_df = all_symbols_df[all_symbols_df["symbol"] == sym]
        if len(sym_df) < 300:
            continue
        feat = build_features(sym_df)
        labeled = build_labels(feat)
        all_features.append(labeled)

    if not all_features:
        return {"error": "Not enough data."}

    combined = pd.concat(all_features, ignore_index=True)
    # v20.7.3 FIX (temporal leakage): sort globally by date so the 80/20
    # positional split trains on the PAST and tests on the FUTURE — see
    # the same fix in train_signal.py.
    if "date" in combined.columns:
        combined = combined.sort_values(["date", "symbol"], kind="stable").reset_index(drop=True)
    combined = combined.dropna(subset=["fwd_return"])

    feature_cols = get_feature_columns(combined)
    X = combined[feature_cols].values
    y = combined["fwd_return"].values

    valid_mask = ~(np.isnan(X).any(axis=1) | np.isinf(X).any(axis=1))
    X = X[valid_mask]
    y = y[valid_mask]

    if len(X) < 500:
        return {"error": f"Not enough samples: {len(X)}"}

    try:
        import lightgbm as lgb
    except ImportError:
        return {"error": "lightgbm not installed."}

    results = {}
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    for q in QUANTILES:
        print(f"Training quantile q={q}...")
        model = lgb.LGBMRegressor(
            objective="quantile",
            alpha=q,
            **QUANTILE_PARAMS
        )
        split = int(len(X) * 0.8)
        model.fit(X[:split], y[:split])
        joblib.dump(model, MODEL_DIR / TARGET_FILES[q])

        # Evaluate on test
        pred = model.predict(X[split:])
        actual = y[split:]
        # v20.9.1 [M]: "coverage" ab per-quantile BAND coverage hai (is
        # q-model ka apna P10-P90 interval kitna actual cover karta hai) —
        # pehle version 5th-95th percentile of PREDICTIONS ko actual se
        # compare karta tha, jo "predictions ki spread" hai, quantile
        # calibration nahi (reported number misleading tha).
        p10 = np.percentile(pred, 10)
        p90 = np.percentile(pred, 90)
        coverage = np.mean((actual >= p10) & (actual <= p90))
        results[f"q{int(q*100)}"] = {
            "test_samples": len(actual),
            "mean_prediction": round(float(pred.mean()), 4),
            "mean_actual": round(float(actual.mean()), 4),
            # FIX L31: coverage was computed but never returned. Surface it so
            # callers can see quantile calibration quality.
            "coverage": round(float(coverage), 3),
            "coverage_band": "P10-P90 of this model's predictions vs actuals",
        }

    # Save feature columns
    joblib.dump(feature_cols, MODEL_DIR / "target_feature_cols.pkl")

    print(f"Quantile models saved. Results: {results}")
    return {"status": "trained", "results": results}


if __name__ == "__main__":
    result = train_target_models()
    print(result)
