import pandas as pd
import numpy as np
import joblib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import HMM_N_COMPONENTS, HMM_COVARIANCE_TYPE, MODEL_DIR
from pipeline.fetch_data import load_ohlcv


def train_regime_model(all_symbols_df: pd.DataFrame = None) -> dict:
    if all_symbols_df is None:
        all_symbols_df = load_ohlcv()
    if all_symbols_df is None or all_symbols_df.empty:
        return {"error": "No OHLCV data."}

    # Build macro features from broad market indices
    regime_symbols = ["SPY", "QQQ", "VIX"]
    available = [s for s in regime_symbols if s in all_symbols_df["symbol"].unique()]

    if len(available) < 2:
        return {"error": f"Not enough regime symbols. Available: {all_symbols_df['symbol'].unique().tolist()}"}

    # Build features from SPY/QQQ returns + VIX
    regime_data = []
    for sym in available:
        sdf = all_symbols_df[all_symbols_df["symbol"] == sym].copy()
        sdf = sdf.set_index("date")
        ret = sdf["close"].pct_change()
        vol = ret.rolling(20).std() * np.sqrt(252)
        feat = pd.DataFrame({
            f"{sym}_ret": ret,
            f"{sym}_vol": vol,
            f"{sym}_sma20_ratio": sdf["close"] / sdf["close"].rolling(20).mean() - 1,
        }, index=sdf.index)
        regime_data.append(feat)

    combined = pd.concat(regime_data, axis=1).dropna()
    if len(combined) < 200:
        return {"error": f"Not enough data for HMM: {len(combined)} rows"}

    # Select key features
    feature_cols = [c for c in combined.columns if "_vol" in c or "_sma20_ratio" in c or "_ret" in c]
    X = combined[feature_cols].values
    X = np.nan_to_num(X, nan=0.0)

    try:
        from hmmlearn.hmm import GaussianHMM
    except ImportError:
        return {"error": "hmmlearn not installed. Run: pip install hmmlearn"}

    print(f"Training HMM with {len(X)} samples, {len(feature_cols)} features")

    hmm = GaussianHMM(
        n_components=HMM_N_COMPONENTS,
        covariance_type=HMM_COVARIANCE_TYPE,
        random_state=42,
        n_iter=200,
    )
    hmm.fit(X)

    # Predict regimes
    regimes = hmm.predict(X)
    regime_dist = {int(r): int(c) for r, c in zip(*np.unique(regimes, return_counts=True))}

    # Map regimes to risk labels based on mean features
    regime_labels = {}
    for r in range(HMM_N_COMPONENTS):
        mask = regimes == r
        mean_ret = X[mask, 0].mean() if X.shape[1] > 0 else 0
        mean_vol = X[mask, 1].mean() if X.shape[1] > 1 else 0
        if mean_ret > 0.001 and mean_vol < 0.02:
            regime_labels[r] = "RISK_ON"
        elif mean_ret < -0.001 and mean_vol > 0.03:
            regime_labels[r] = "RISK_OFF"
        elif mean_vol > 0.025:
            regime_labels[r] = "STAGFLATION"
        else:
            regime_labels[r] = "GOLDILOCKS"

    # Auto-detect risk-on index (highest mean return)
    risk_on_idx = max(regime_labels.keys(), key=lambda r: X[regimes == r, 0].mean() if X.shape[1] > 0 else 0)
    risk_off_idx = min(regime_labels.keys(), key=lambda r: X[regimes == r, 0].mean() if X.shape[1] > 0 else 0)

    # SIP multipliers
    sip_multipliers = {}
    for r, label in regime_labels.items():
        if label == "RISK_ON":
            sip_multipliers[r] = 1.5
        elif label == "GOLDILOCKS":
            sip_multipliers[r] = 1.2
        elif label == "STAGFLATION":
            sip_multipliers[r] = 0.8
        else:
            sip_multipliers[r] = 0.7

    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    model_data = {
        "model": hmm,
        "feature_cols": feature_cols,
        "regime_labels": regime_labels,
        "sip_multipliers": sip_multipliers,
        "risk_on_idx": risk_on_idx,
        "risk_off_idx": risk_off_idx,
    }
    joblib.dump(model_data, MODEL_DIR / "hmm_model.pkl")

    print(f"Regime model saved. Regimes: {regime_labels}")
    print(f"SIP multipliers: {sip_multipliers}")
    return {
        "status": "trained",
        "regimes": regime_labels,
        "sip_multipliers": sip_multipliers,
        "samples": len(X),
    }


if __name__ == "__main__":
    result = train_regime_model()
    print(result)
