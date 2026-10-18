from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool  # v20.7.3: unblock the event loop for sync LLM calls
from pydantic import BaseModel
from typing import Optional, List
import secrets
import pandas as pd
import numpy as np
import joblib
import time
from pathlib import Path
import sys
import os

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import (
    MODEL_DIR, SIGNAL_MODEL_PATH, CALIBRATOR_PATH, HMM_MODEL_PATH,
    ALL_SYMBOLS, FEATURE_COLS
)
from pipeline.fetch_data import load_ohlcv, fetch_all_symbols
from pipeline.features import build_features, get_feature_columns
from pipeline.labels import build_labels
from models.pricepoints import calculate_exact_entry
from models.backtest import walk_forward_backtest

app = FastAPI(title="WealthAI ML Service", version="1.0.0")

# FIX H12: `allow_origins=["*"]` + `allow_credentials=True` is rejected by
# browsers (CORS spec). Use a safe default that allows any origin WITHOUT
# credentials; if specific origins are needed, set ML_CORS_ORIGINS env var.
_cors_origins = os.environ.get("ML_CORS_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,  # safe with allow_origins=["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# SECURITY FIX (audit H-3): zero authentication previously — anyone who
# could reach port 8000 could trigger hours-long /train runs (CPU/memory
# DoS), scrape predictions, and burn LLM quota via /analyze. When
# ML_API_TOKEN is set, every route (except /health) now requires it via
# the `X-API-Key` header or `Authorization: Bearer <token>`.
# ============================================================
ML_API_TOKEN = os.environ.get("ML_API_TOKEN", "").strip()
if not ML_API_TOKEN:
    print("[ml-service] WARNING: ML_API_TOKEN is not set — all endpoints are "
          "UNAUTHENTICATED. Set ML_API_TOKEN before exposing this service beyond "
          "localhost.")


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    # Health stays open for orchestrators/uptime checks.
    if request.url.path in ("/health", "/") or request.method == "OPTIONS":
        return await call_next(request)
    # v20.8.4 FIX (M — fail-open in containers): with ML_API_TOKEN unset the
    # service was fully UNAUTHENTICATED while the Docker image binds
    # 0.0.0.0 — anyone who could reach port 8000 could trigger hours-long
    # /train runs (CPU DoS) and burn LLM quota. A published deployment
    # (non-loopback client) now gets an honest 503 telling the operator to
    # set ML_API_TOKEN; same-origin/local callers keep working (the Node
    # server's default target is 127.0.0.1:8000).
    if not ML_API_TOKEN:
        client_host = request.client.host if request.client else ""
        if client_host not in ("127.0.0.1", "::1", "localhost", "testclient"):
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=503,
                content={"error": "ML_API_TOKEN is not set — this ml-service refuses unauthenticated non-local traffic. Set ML_API_TOKEN before exposing port 8000."},
            )
        return await call_next(request)
    provided = request.headers.get("x-api-key", "")
    if not provided:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            provided = auth[7:].strip()
    if not provided or not secrets.compare_digest(provided, ML_API_TOKEN):
        # v18.2 FIX: raising HTTPException from MIDDLEWARE bypasses
        # FastAPI's exception handlers — the client got a 500
        # "Internal Server Error" instead of the intended 401.
        # Return the response directly instead.
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized — invalid or missing API token"},
        )
    return await call_next(request)

# Cache for predictions — FIX H12: previously unbounded (`{}` grew forever).
# Use OrderedDict + max-size cap (LRU eviction) to prevent OOM in long-running
# service. Each entry also has a TTL via the cached `ts` field.
from collections import OrderedDict  # noqa: E402
prediction_cache = OrderedDict()
CACHE_TTL = 300  # 5 minutes
CACHE_MAX = 256  # max entries — evict oldest when exceeded

_orch_cache = OrderedDict()
_ORCH_CACHE_MAX = 128

def _cache_get(cache: OrderedDict, key: str, ttl: int):
    if key not in cache:
        return None
    entry = cache[key]
    if time.time() - entry["ts"] > ttl:
        cache.pop(key, None)
        return None
    # LRU touch
    cache.move_to_end(key)
    return entry["data"]

def _cache_set(cache: OrderedDict, key: str, data, max_size: int):
    cache[key] = {"data": data, "ts": time.time()}
    cache.move_to_end(key)
    while len(cache) > max_size:
        cache.popitem(last=False)


class PredictionRequest(BaseModel):
    symbol: str
    market: str = "IN"


class TrainRequest(BaseModel):
    symbols: Optional[List[str]] = None


# ============================================================
# ACCURACY-PLAN PHASE 5: the meta-ensemble retrain rides THIS process.
# The weekly background worker (models/retrain_scheduler.py — boot train
# + META_RETRAIN_INTERVAL_HOURS cadence, default 168h/weekly) starts as
# a daemon thread at FastAPI startup: a single Render service carries
# the API AND the retrain loop, no separate cron needed. A failed
# retrain keeps the previous pkl in place (graceful degrade) and never
# kills the API. META_RETRAIN_DAEMON=false hands the cadence to an
# external `python -m models.retrain_scheduler --once` cron instead.
# ============================================================
@app.on_event("startup")
async def _start_retrain_worker():
    try:
        from models.retrain_scheduler import start_retrain_daemon
        start_retrain_daemon()
    except Exception as _e:  # noqa: BLE001 — the API must boot regardless
        print(f"ml-service] retrain daemon not started: {_e}")


@app.get("/health")
async def health():
    from app.llm_router import get_provider_status
    providers = get_provider_status()
    active = [p for p in providers if p["available"]]
    return {
        "status": "ok",
        "models_loaded": {
            "signal": SIGNAL_MODEL_PATH.exists(),
            "hmm": HMM_MODEL_PATH.exists(),
        },
        "providers": providers,
        "active_count": len(active),
        "quant_brain": "always_online",
        "version": "2.0.0",
    }


@app.post("/predict")
async def predict(req: PredictionRequest):
    cache_key = f"{req.symbol}_{req.market}"
    # FIX H12: use LRU cache helpers instead of raw dict access.
    cached = _cache_get(prediction_cache, cache_key, CACHE_TTL)
    if cached is not None:
        return cached

    ohlcv = load_ohlcv()
    if ohlcv is None:
        raise HTTPException(status_code=503, detail="No OHLCV data. Train models first via /train.")

    sym = req.symbol.replace(".NS", "").replace(".BO", "")
    # FIX L10: `.str.contains(sym)` was a substring match — querying `BTC`
    # would also match `BTCUSD`, `BTCUSDT`, `ABTC`. Use exact match (case-
    # insensitive) so only the requested symbol is returned.
    sym_upper = sym.upper()
    sym_data = ohlcv[ohlcv["symbol"].str.upper() == sym_upper]
    if sym_data.empty:
        raise HTTPException(status_code=404, detail=f"No data for {req.symbol}")

    sym = sym_data["symbol"].unique()[0]
    sym_df = ohlcv[ohlcv["symbol"] == sym].tail(500)

    if len(sym_df) < 100:
        raise HTTPException(status_code=400, detail=f"Not enough data for {req.symbol}: {len(sym_df)} rows")

    feat = build_features(sym_df)
    labeled = build_labels(feat)
    feature_cols = get_feature_columns(labeled)

    # Signal model prediction
    signal_result = {"signal": "HOLD", "confidence": 50, "top_features": []}
    if SIGNAL_MODEL_PATH.exists():
        try:
            model = joblib.load(SIGNAL_MODEL_PATH)
            last_row = labeled[feature_cols].iloc[[-1]].values
            last_row = np.nan_to_num(last_row, nan=0.0)
            if np.isinf(last_row).any():
                last_row = np.clip(last_row, -1e10, 1e10)

            pred = model.predict(last_row)[0]
            proba = model.predict_proba(last_row)[0]
            classes = model.classes_
            confidence = float(max(proba)) * 100

            signal_result = {
                "signal": str(pred),
                "confidence": round(confidence, 1),
                "probabilities": {str(c): round(float(p) * 100, 1) for c, p in zip(classes, proba)},
            }

            # Top features (SHAP-like via feature importance)
            # FIX H8: previously used `hasattr(model, "estimators")` but
            # CalibratedClassifierCV exposes `calibrated_classifiers_`, not
            # `estimators` → top_features was always []. Dig into the wrapped
            # estimator inside the first calibrated classifier.
            base_models = []
            if hasattr(model, "calibrated_classifiers_"):
                for cc in model.calibrated_classifiers_:
                    inner = getattr(cc, "estimator", None)
                    if inner is not None:
                        base_models.append(inner)
            elif hasattr(model, "estimators_"):
                base_models = list(model.estimators_)
            elif hasattr(model, "estimators"):
                base_models = list(model.estimators)
            for base_model in base_models[:1]:
                try:
                    if hasattr(base_model, "feature_importances_"):
                        importances = base_model.feature_importances_
                        top_idx = np.argsort(importances)[::-1][:5]
                        signal_result["top_features"] = [
                            {"feature": feature_cols[i], "importance": round(float(importances[i]), 3)}
                            for i in top_idx if i < len(feature_cols)
                        ]
                        break
                except Exception:
                    pass
        except Exception as e:
            signal_result["error"] = str(e)

    # Quantile targets
    targets = {}
    for q, fname in [("P10", "target_q10.pkl"), ("P50", "target_q50.pkl"), ("P90", "target_q90.pkl")]:
        model_path = MODEL_DIR / fname
        if model_path.exists():
            try:
                q_model = joblib.load(model_path)
                last_row = labeled[feature_cols].iloc[[-1]].values
                last_row = np.nan_to_num(last_row, nan=0.0)
                if np.isinf(last_row).any():
                    last_row = np.clip(last_row, -1e10, 1e10)
                fwd_ret = float(q_model.predict(last_row)[0])
                current_price = float(sym_df["close"].iloc[-1])
                target_price = current_price * (1 + fwd_ret)
                targets[q] = {
                    "expected_return": round(fwd_ret * 100, 2),
                    "target_price": round(target_price, 2),
                }
            except Exception:
                pass

    # Price points
    price_points = calculate_exact_entry(sym_df)

    # Current data
    # FIX M14: NaN/inf values in RSI/volume/change leak into JSON response
    # (FastAPI serialises NaN as bare `NaN` → JSON.parse fails in browser →
    # whole /predict response unusable). Coerce to safe defaults.
    def _safe_num(v, default=0):
        try:
            f = float(v)
            if not np.isfinite(f):
                return default
            return f
        except Exception:
            return default

    last = sym_df.iloc[-1]
    current_data = {
        "symbol": req.symbol,
        "market": req.market,
        "price": round(_safe_num(last["close"]), 2),
        "change": round(_safe_num(sym_df["close"].pct_change().iloc[-1] * 100, 0) if len(sym_df) > 1 else 0, 2),
        "rsi": round(_safe_num(feat["rsi"].iloc[-1] if "rsi" in feat.columns else 50, 50), 1),
        "volume": int(_safe_num(last.get("volume", 0), 0)),
    }

    result = {
        **current_data,
        **signal_result,
        "price_targets": targets,
        "price_points": price_points,
        "timestamp": int(time.time() * 1000),
    }

    # FIX H12: use LRU cache setter (auto-evicts oldest when full).
    _cache_set(prediction_cache, cache_key, result, CACHE_MAX)
    return result


@app.get("/signals")
async def get_all_signals(market: Optional[str] = None):
    ohlcv = load_ohlcv()
    if ohlcv is None:
        raise HTTPException(status_code=503, detail="No OHLCV data.")

    symbols = list(ohlcv["symbol"].unique())
    # FIX CRIT (review #1): previous dict-based filter had `"US": None` which
    # silently skipped filtering for US → returned ALL symbols. Replace with
    # explicit per-market branches using exact substring tests.
    if market:
        mu = market.upper()
        if mu == "IN":
            symbols = [s for s in symbols if (".NS" in s or "BEES" in s or "NIFTY" in s
                                              or "SMALLCAP" in s or "MOMENTUM" in s)]
        elif mu == "US":
            symbols = [s for s in symbols if (".NS" not in s and "USD" not in s
                                              and "BEES" not in s and "NIFTY" not in s)]
        elif mu == "CRYPTO":
            symbols = [s for s in symbols if "USD" in s]
        # else: no filter (return all)

    signals = []
    for sym in symbols[:50]:
        try:
            req = PredictionRequest(symbol=sym, market=market or "IN")
            sig = await predict(req)
            signals.append(sig)
        except Exception:
            continue

    signals.sort(key=lambda x: x.get("confidence", 0), reverse=True)
    return {"signals": signals, "count": len(signals), "timestamp": int(time.time() * 1000)}


@app.post("/train")
async def train_models(req: TrainRequest = None, background_tasks: BackgroundTasks = None):
    # v20.8.4 FIX (H3 — event-loop freeze): the sync train pipeline (fetch
    # + 4 model trainings + walk-forward backtest) used to run DIRECTLY on
    # the event loop — for minutes /health stopped answering and the Docker
    # HEALTHCHECK (3x30s failures) killed the container mid-training,
    # defeating the graceful-degrade design. /analyze already used
    # run_in_threadpool for exactly this class (v20.7.3) — /train now does
    # too. The body below is unchanged, just off-loop.
    return await run_in_threadpool(_train_models_sync, req)


def _train_models_sync(req: TrainRequest = None):
    results = {}

    # Step 1: Fetch data
    print("Fetching OHLCV data...")
    symbols = req.symbols if req and req.symbols else ALL_SYMBOLS
    ohlcv = fetch_all_symbols(symbols)
    # FIX CRIT: fetch_all_symbols can return an empty DataFrame when yfinance/
    # Binance fail. Accessing `ohlcv["symbol"]` then raises KeyError → 500.
    if ohlcv is None or "symbol" not in ohlcv.columns or ohlcv.empty:
        raise HTTPException(status_code=503, detail="No OHLCV data fetched — upstream APIs may be down.")
    results["fetch"] = {"symbols": int(ohlcv["symbol"].nunique()), "rows": len(ohlcv)}

    # Step 2: Train signal model
    print("Training signal model...")
    from models.train_signal import train_signal_model
    results["signal_model"] = train_signal_model(ohlcv)

    # Step 3: Train quantile targets
    print("Training quantile models...")
    from models.train_target import train_target_models
    results["target_models"] = train_target_models(ohlcv)

    # Step 4: Train regime model
    print("Training regime model...")
    from models.train_regime import train_regime_model
    results["regime_model"] = train_regime_model(ohlcv)

    # Step 5: Backtest
    print("Running walk-forward backtest...")
    feat_list = []
    for sym in ohlcv["symbol"].unique():
        sdf = ohlcv[ohlcv["symbol"] == sym]
        if len(sdf) < 300:
            continue
        feat = build_features(sdf)
        labeled = build_labels(feat)
        feat_list.append(labeled)

    if feat_list:
        combined = pd.concat(feat_list, ignore_index=True)
        feature_cols = get_feature_columns(combined)
        results["backtest"] = walk_forward_backtest(combined, feature_cols)

    # Clear prediction cache
    prediction_cache.clear()

    return {"status": "complete", "results": results, "timestamp": int(time.time() * 1000)}


@app.get("/backtest")
async def get_backtest(symbol: Optional[str] = None):
    ohlcv = load_ohlcv()
    if ohlcv is None:
        raise HTTPException(status_code=503, detail="No data.")

    if symbol:
        sym_data = ohlcv[ohlcv["symbol"].str.upper() == symbol.upper()]  # FIX L10: exact match (was str.contains → substring)
        if sym_data.empty:
            raise HTTPException(status_code=404, detail=f"No data for {symbol}")
        ohlcv = sym_data

    feat_list = []
    for sym in ohlcv["symbol"].unique():
        sdf = ohlcv[ohlcv["symbol"] == sym]
        if len(sdf) < 300:
            continue
        feat = build_features(sdf)
        labeled = build_labels(feat)
        feat_list.append(labeled)

    if not feat_list:
        raise HTTPException(status_code=400, detail="Not enough data for backtest.")

    combined = pd.concat(feat_list, ignore_index=True)
    feature_cols = get_feature_columns(combined)
    return walk_forward_backtest(combined, feature_cols)


@app.get("/pricepoints/{symbol}")
async def get_pricepoints(symbol: str):
    ohlcv = load_ohlcv()
    if ohlcv is None:
        raise HTTPException(status_code=503, detail="No data.")

    sym_data = ohlcv[ohlcv["symbol"].str.upper() == symbol.upper()]  # FIX L10: exact match (was str.contains → substring)
    if sym_data.empty:
        raise HTTPException(status_code=404, detail=f"No data for {symbol}")

    sym = sym_data["symbol"].unique()[0]
    sym_df = ohlcv[ohlcv["symbol"] == sym].tail(300)
    result = calculate_exact_entry(sym_df)
    result["symbol"] = symbol
    return result


@app.post("/refresh")
async def refresh_data():
    ohlcv = fetch_all_symbols()
    # v20.7.3 FIX: same guard as /train (FIX CRIT) — fetch_all_symbols
    # returns an EMPTY frame when yfinance/Binance fail and no parquet
    # store exists; ohlcv["symbol"] then raises KeyError -> 500.
    if ohlcv is None or "symbol" not in ohlcv.columns or ohlcv.empty:
        raise HTTPException(status_code=503, detail="No OHLCV data fetched — upstream APIs may be down.")
    prediction_cache.clear()
    return {"status": "refreshed", "symbols": int(ohlcv["symbol"].nunique()), "rows": len(ohlcv)}


@app.get("/regime")
async def get_regime():
    """Get current market regime from HMM model + SIP multiplier."""
    hmm_path = MODEL_DIR / "hmm_model.pkl"
    if not hmm_path.exists():
        raise HTTPException(status_code=503, detail="HMM model not trained yet. Call /train first.")

    model_data = joblib.load(hmm_path)
    hmm = model_data["model"]
    feature_cols = model_data["feature_cols"]
    regime_labels = model_data["regime_labels"]
    sip_multipliers = model_data["sip_multipliers"]

    ohlcv = load_ohlcv()
    if ohlcv is None:
        raise HTTPException(status_code=503, detail="No OHLCV data.")

    # Build same features used during training
    import numpy as np
    regime_symbols = ["SPY", "QQQ", "VIX"]
    available = [s for s in regime_symbols if s in ohlcv["symbol"].unique()]

    # v20.7.3 FIX: pd.concat([]) raises ValueError when NO regime symbol is
    # available (empty upstream store) -> 500. Guard like the dropna case.
    if not available:
        raise HTTPException(status_code=503, detail="No regime symbols available (SPY/QQQ/VIX missing from the data store).")
    regime_data = []
    for sym in available:
        sdf = ohlcv[ohlcv["symbol"] == sym].copy().set_index("date")
        ret = sdf["close"].pct_change()
        vol = ret.rolling(20).std() * np.sqrt(252)
        feat = pd.DataFrame({
            f"{sym}_ret": ret,
            f"{sym}_vol": vol,
            f"{sym}_sma20_ratio": sdf["close"] / sdf["close"].rolling(20).mean() - 1,
        }, index=sdf.index)
        regime_data.append(feat)

    combined = pd.concat(regime_data, axis=1).dropna()
    # v20.7.3 FIX: if the store's symbol set drifted from training time,
    # combined[feature_cols] raises KeyError -> 500. Intersect + guard.
    missing_cols = [c for c in feature_cols if c not in combined.columns]
    if missing_cols:
        raise HTTPException(status_code=503, detail=f"Regime feature drift — missing columns: {missing_cols[:3]}...")
    # FIX CRIT: if dropna removes all rows (sparse data), `X[-1:]` is empty
    # → hmm.predict([]) raises ValueError. Guard explicitly.
    if combined.empty:
        raise HTTPException(status_code=503, detail="No regime data available after dropna().")
    X = combined[feature_cols].values
    X = np.nan_to_num(X, nan=0.0)
    if len(X) == 0:
        raise HTTPException(status_code=503, detail="No regime rows to predict on.")

    # Predict current regime (last row)
    current_state = int(hmm.predict(X[-1:])[0])
    regime = regime_labels.get(current_state, "UNKNOWN")
    sip_mult = sip_multipliers.get(current_state, 1.0)

    # Get probability of current state
    probs = hmm.predict_proba(X[-1:])[0]
    probability = float(probs[current_state])

    # Last 10 states for sequence view
    last_states = hmm.predict(X[-10:])
    state_sequence = [regime_labels.get(int(s), "UNKNOWN") for s in last_states]

    return {
        "regime": regime,
        "probability": round(probability, 4),
        "sip_multiplier": sip_mult,
        "state_sequence": state_sequence,
        "current_state_id": current_state,
        "timestamp": pd.Timestamp.now().isoformat(),
    }


# ============================================================
# ORCHESTRATOR — 7-Step Pro-Trader Analysis + Multi-Provider LLM
# ============================================================
from app.quant_brain import analyze as quant_analyze, brain_to_text
from app.llm_router import ask_llm as router_ask_llm, get_provider_status, anti_hallucination_check
from app.prompts import get_7step_system_prompt, build_analysis_prompt, build_signals_prompt, build_portfolio_prompt

import time as _time
import hashlib as _hashlib

# FIX H12: `_orch_cache` was a plain unbounded dict — same OOM risk as
# prediction_cache. Reuse the OrderedDict helpers defined near the top
# (the second `_orch_cache = {}` declaration below has been removed).
ORCH_CACHE_TTL = 60


@app.post("/analyze")
async def analyze_symbol(req: PredictionRequest):
    """Full deep analysis: Quant Brain + LLM narration."""
    cache_key = _hashlib.md5(f"{req.symbol}:{_time.time() // ORCH_CACHE_TTL}".encode()).hexdigest()
    cached = _cache_get(_orch_cache, cache_key, ORCH_CACHE_TTL)
    if cached is not None:
        cached = dict(cached)
        cached["from_cache"] = True
        return cached

    ohlcv = load_ohlcv()
    df = pd.DataFrame()
    if ohlcv is not None:
        sym_data = ohlcv[ohlcv["symbol"].str.upper() == req.symbol.upper()]
        if not sym_data.empty:
            df = sym_data.tail(300)

    brain_result = quant_analyze(req.symbol, df, {"vix": 0, "regime": "UNKNOWN"})
    brain_result["market"] = req.market

    system_prompt = get_7step_system_prompt()
    user_prompt = build_analysis_prompt(brain_result)
    # v20.7.3 FIX: router_ask_llm is BLOCKING (sync urllib, up to 6 providers
    # x 30-60s). Inside `async def` it froze the uvicorn event loop (and with
    # it /health + the Docker HEALTHCHECK). Run it in the threadpool.
    llm_text = await run_in_threadpool(router_ask_llm, system_prompt, user_prompt)

    used_provider = "none"
    if llm_text:
        # FIX M13: anti_hallucination_check now returns None when too many
        # suspicious numbers are detected. Fall back to brain_to_text in that case.
        checked = anti_hallucination_check(llm_text, brain_result)
        if checked is None:
            llm_text = brain_to_text(brain_result)
            used_provider = "quant_brain_hallucination_fallback"
        else:
            llm_text = checked
            used_provider = "llm"
    else:
        llm_text = brain_to_text(brain_result)
        used_provider = "quant_brain"

    result = {
        "data": brain_result,
        "text": llm_text,
        "used_provider": used_provider,
        "from_cache": False,
        "timestamp": _time.time(),
    }
    _cache_set(_orch_cache, cache_key, result, _ORCH_CACHE_MAX)
    return result


@app.post("/orchestrate/signals")
async def orchestrate_signals():
    """Scan watchlist for STRONG_BUY/BUY signals."""
    ohlcv = load_ohlcv()
    if ohlcv is None:
        return {"signals": [], "message": "No data"}

    symbols = ohlcv["symbol"].unique().tolist()[:20]
    results = []
    for sym in symbols:
        sym_data = ohlcv[ohlcv["symbol"] == sym]
        df = sym_data.tail(300) if not sym_data.empty else pd.DataFrame()
        brain = quant_analyze(sym, df, {"vix": 0, "regime": "UNKNOWN"})
        results.append(brain)

    results.sort(key=lambda x: x.get("confidence", 0), reverse=True)

    system_prompt = get_7step_system_prompt()
    user_prompt = build_signals_prompt(results)
    # v20.7.3 FIX: blocking LLM router -> threadpool (see /analyze note).
    llm_text = await run_in_threadpool(router_ask_llm, system_prompt, user_prompt)

    if not llm_text:
        llm_text = "\n".join([
            f"{r['symbol']}: {r['verdict']} ({r['confidence']}%) | Entry: {r['entry']} | SL: {r['sl']} | TP1: {r['tp1']}"
            for r in results if r['verdict'] in ('STRONG_BUY', 'BUY')
        ]) or "No strong signals currently."

    return {"signals": results, "text": llm_text, "count": len(results)}


@app.get("/providers")
async def providers():
    return {"providers": get_provider_status()}


# ============================================================
# v18.2 FIX — mount the orchestrator's /meta-ensemble handler onto
# THIS app. The handler previously lived only on orchestrator.py's
# OWN FastAPI instance, which is never served by uvicorn
# (uvicorn serves app.main:app) — so POST /meta-ensemble was a 404
# forever and the Node-side stacked meta-learner silently fell back
# to the weighted average on every single call. Same contract:
#   { ok, side, confidence, agreement, grade, source }
# ============================================================
try:
    from app.orchestrator import meta_ensemble as _orch_meta_ensemble
    app.add_api_route("/meta-ensemble", _orch_meta_ensemble, methods=["POST"])
    print("[ml-service] meta-ensemble route mounted (was orphaned on the unserved orchestrator app)")
except Exception as _me_err:  # noqa: BLE001
    print(f"[ml-service] meta-ensemble NOT mounted (non-fatal): {_me_err}")


# ============================================================
# v18.1 FULL — LOCAL HUGGINGFACE AI (Chronos forecast + FinBERT
# sentiment), guarded mount: a missing torch/transformers/chronos
# can NEVER break the base service. /hf/status reports what's
# available; /hf/forecast and /hf/sentiment answer 503 gracefully.
# ============================================================
# v20.7.3 FIX: the UNCONDITIONAL mount that used to live here made the
# v20.6 HF_MODELS_ENABLED gate below dead code — /hf/* was always
# reachable (and registered twice when the flag was true), defeating
# the RAM budget the flag exists for. Removed; only the gated mount
# remains.

# ============================================================
# v20.6 — HF models DISABLED by default on a local 16GB laptop setup.
# Chronos-T5 (torch) + FinBERT (torch) compete with Ollama for RAM and
# push the box into swap → event-loop freezes on the Node server side
# (the very thing selfHeal flags). On a cloud box with abundant RAM,
# set HF_MODELS_ENABLED=true to mount them; on a local Ollama-first
# install, leave them off — the base LightGBM/sklearn ML service does
# everything the trade-signal path actually reads.
# ============================================================
if os.environ.get("HF_MODELS_ENABLED", "false").lower() == "true":
    try:
        from app.hf_models import router as _hf_router
        app.include_router(_hf_router, prefix="/hf")
        print("[ml-service] hf models router mounted — /hf/status, /hf/forecast, /hf/sentiment")
    except Exception as _hf_err:  # noqa: BLE001
        print(f"[ml-service] hf models NOT mounted (non-fatal): {_hf_err}")
else:
    print("[ml-service] hf models DISABLED by default (HF_MODELS_ENABLED not 'true') — base LightGBM/sklearn service only. Saves RAM for the local Ollama engine.")


# ============================================================
# v18.4 — EXPERT MODE: local-AI trading superintelligence.
# 5-pillar ensemble (technical confluence + momentum + Chronos-T5
# forecast + FinBERT sentiment + risk) with ATR trade plan and
# background model downloads. Guarded mount, same contract as /hf.
# v20.6: EXPERT_MODE follows the same gate as HF_MODELS — defaults
# OFF on local installs (it imports torch + HF models internally).
# ============================================================
if os.environ.get("EXPERT_MODE_ENABLED", "false").lower() == "true":
    try:
        from app.expert_mode import router as _expert_router
        app.include_router(_expert_router, prefix="/expert")
        print("ml-service] EXPERT MODE mounted")
    except Exception as _expert_err:  # noqa: BLE001
        print(f"ml-service] EXPERT MODE NOT mounted (non-fatal): {_expert_err}")
else:
    print("[ml-service] EXPERT MODE disabled by default (EXPERT_MODE_ENABLED not 'true') — would import torch + HF models; same RAM budget as /hf.")


if __name__ == "__main__":
    import os
    import uvicorn
    # v21.11.0 PORT-COLLISION FIX: 8000 → 8100 — port 8000 LAYA ka home port
    # hai (laya-serve sidecar). ml-service ko apna port chahiye. ML_PORT env
    # se override hota hai; Dockerfile aur Node clients (ensemble.js,
    # mlHealth.js, index.js) isi default ke saath synced hain.
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_PORT", "8100")))
