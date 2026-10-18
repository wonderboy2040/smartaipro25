# Configuration for ML Service
import os
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
STORE_DIR = BASE_DIR / "store"
STORE_DIR.mkdir(exist_ok=True)

# Symbols to track (portfolio + watchlist)
SYMBOLS_IN = [
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HDFCBANK.NS", "ICICIBANK.NS",
    "BAJFINANCE.NS", "TATAMOTORS.NS", "BHARTIARTL.NS", "LT.NS", "SBIN.NS",
    "HCLTECH.NS", "MARUTI.NS", "TITAN.NS", "ADANIENT.NS", "WIPRO.NS",
    "NIFTYBEES.NS", "JUNIORBEES.NS", "MID150BEES.NS", "SMALLCAP.NS", "MOMENTUM50.NS",
]
SYMBOLS_US = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO",
    "AMD", "CRM", "NFLX", "PLTR", "COIN", "UBER", "NOW",
    "VOO", "VGT", "SMH", "QQQ", "SPY",
]
SYMBOLS_CRYPTO = ["BTC-USD", "ETH-USD"]

ALL_SYMBOLS = SYMBOLS_IN + SYMBOLS_US + SYMBOLS_CRYPTO

# Model parameters
HORIZON_DAYS = 90
LOOKBACK_DAYS = 180
VOLUME_PROFILE_BINS = 50
VALUE_AREA_PCT = 0.70

# LightGBM params
LGBM_PARAMS = {
    "n_estimators": 600,
    "learning_rate": 0.02,
    "num_leaves": 48,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "class_weight": "balanced",
    "random_state": 42,
    "n_jobs": -1,
    "verbosity": -1,
}

# Quantile regression params
QUANTILE_PARAMS = {
    "n_estimators": 500,
    "learning_rate": 0.02,
    "random_state": 42,
    "n_jobs": -1,
    "verbosity": -1,
}

# HMM params
HMM_N_COMPONENTS = 3
HMM_COVARIANCE_TYPE = "full"

# Calibration
CALIBRATION_METHOD = "isotonic"
CV_SPLITS = 5

# API Keys (from env)
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "")

# Data source settings
USE_YFINANCE = True
USE_BINANCE = True
BINANCE_BASE = "https://api.binance.com/api/v3"
YAHOO_PERIOD = "10y"
YAHOO_INTERVAL = "1d"

# Feature columns (will be populated by features.py)
FEATURE_COLS = []

# Model file paths
MODEL_DIR = STORE_DIR / "models"
MODEL_DIR.mkdir(exist_ok=True)

SIGNAL_MODEL_PATH = MODEL_DIR / "signal_model.pkl"
CALIBRATOR_PATH = MODEL_DIR / "calibrator.pkl"
TARGET_Q10_PATH = MODEL_DIR / "target_q10.pkl"
TARGET_Q50_PATH = MODEL_DIR / "target_q50.pkl"
TARGET_Q90_PATH = MODEL_DIR / "target_q90.pkl"
HMM_MODEL_PATH = MODEL_DIR / "hmm_model.pkl"
OHLCV_STORE_PATH = STORE_DIR / "ohlcv.parquet"

# ============================================================
# META-ENSEMBLE STACKING (Upgrade 4)
# ------------------------------------------------------------
# A trained meta-learner (LightGBM) that combines the 16 model
# votes {dir, conf} instead of the fixed weighted-average.
#   - 16 models x 2 features (dir, conf) = 32 features
#   - + 1 market-regime flag = 33 features
#   - label: forward-return direction (UP / DOWN / FLAT)
# v21.13.x recheck (M1): default ON — the Node master accuracy switch
# (AI_ACCURACY_SUITE) is typo-proof default-ON since v21.12, but the
# Python flag still defaulted OFF, so a bare `uvicorn app.main:app`
# left /meta-ensemble answering `source:"weighted"` forever while the
# Node banner honestly said "META ARMED". Node semantics mirrored:
# unset/empty/garbage → ON; ONLY an explicit false/0/off/no disables.
# Enabled via AI_ENABLE_META_ENSEMBLE (explicit false/0/off/no → off).
# The Node ensemble consumes it through POST /meta-ensemble (see
# orchestrator.py) and ALWAYS falls back to the weighted average when
# the pkl is missing, stale or shape-mismatched — never crashes.
# ============================================================
META_ENSEMBLE_PATH = MODEL_DIR / "meta_ensemble.pkl"
META_FEATURE_COLS_PATH = MODEL_DIR / "meta_feature_cols.pkl"

# The voting registry the meta-learner consumes (order is the feature
# contract — keep in sync with server/ai/models.js). A previously-trained
# pkl on the OLD 14-id contract is detected as stale by
# load_meta_ensemble() (cols mismatch) → graceful weighted fallback until
# the retrain scheduler produces a new pkl on THIS contract (self-healing).
# v21.13: FULL 16-seat voting roster sync — pehle 14 ids the (structure /
# macross / tape-mtf missing → their live votes were silently zero-filled,
# skewing META's confidence calibration). The list now matches the Node
# committee 1:1 (models.js MODELS + master-switch tape-mtf w1.6).
# Legacy 'tape' removed — superseded by 'tape-mtf' (IntradayTapeMTF w1.6).
META_MODEL_IDS = [
    "trend", "momentum", "volatility", "volume", "pattern", "sr",
    "options", "regime", "smc", "structure", "macross", "tape-mtf",
    "aicouncil", "sentiment", "instflow", "fundamentals",
]

# Direction label deadband: |fwd return| <= this → FLAT
META_DIR_DEADBAND = 0.005
# Shorter horizon for the direction label (90d swing labels are too
# coarse for the ensemble's intraday/swing mix — 10 trading days)
META_DIR_HORIZON_DAYS = 10


def meta_ensemble_enabled() -> bool:
    """AI_ENABLE_META_ENSEMBLE flag — Node master-switch semantics
    (v21.13.x M1): unset/empty/garbage → True (default ON); ONLY an
    explicit false/0/off/no disables it (typo-proof, same as Node's
    AI_ACCURACY_SUITE)."""
    return os.getenv("AI_ENABLE_META_ENSEMBLE", "").strip().lower() not in ("false", "0", "off", "no")