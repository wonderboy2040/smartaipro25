"""
LOCAL HUGGINGFACE AI — Chronos-T5 forecast + FinBERT sentiment (v18.1 FULL)
===========================================================================

Zero hard dependencies: every heavy import happens lazily inside request
handlers. If torch / transformers / chronos are absent (the BASE ml-service
install), this router still mounts, /hf/status reports what's missing, and
the forecast/sentiment endpoints answer with a clear 503 — the base service
can never be broken by a missing optional dependency.

Model cache: set HF_HOME (the Windows launcher does this) to the package's
pre-cached models dir so Chronos works fully offline, out of the box.
FinBERT (~440MB) downloads on first use when online (warm-ai.bat can
pre-fetch it).
"""

import os
import time
import logging
import threading
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("ml-service.hf")

router = APIRouter()

_LOCK = threading.Lock()

_chronos = None            # ChronosPipeline singleton
_chronos_err: Optional[str] = None

_finbert = None            # transformers sentiment pipeline singleton
_finbert_err: Optional[str] = None

# Where pre-cached models live (launcher exports HF_HOME=<package>/ml-runtime/hf-cache)
# v18.2 FIX: huggingface_hub (>=0.26, which transformers 4.49 uses) resolves the
# hub cache to HF_HOME/hub/ — the models must sit at
#   hf-cache/hub/models--autogluon--chronos-t5-mini/...
# The previous TRANSFORMERS_CACHE=HF_HOME/transformers override (legacy env,
# deprecated warning) pointed at a DIFFERENT directory, so the pre-cached
# model was never found and transformers silently re-downloaded it online —
# and failed offline. One cache, one location, resolved by the hub default.
HF_HOME = os.environ.get("HF_HOME", "").strip()
if HF_HOME:
    os.environ.setdefault("HF_HOME", HF_HOME)
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

CHRONOS_MODEL = os.environ.get("CHRONOS_MODEL", "autogluon/chronos-t5-mini")
FINBERT_MODEL = os.environ.get("FINBERT_MODEL", "ProsusAI/finbert")

MAX_HISTORY_POINTS = 4096   # hard cap fed to the model
MIN_HISTORY_POINTS = 16     # below this a forecast is meaningless


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _load_chronos():
    """Lazy-load the Chronos pipeline exactly once. Never raises."""
    global _chronos, _chronos_err
    if _chronos is not None or _chronos_err is not None:
        return
    with _LOCK:
        if _chronos is not None or _chronos_err is not None:
            return
        try:
            import torch
            from chronos import ChronosPipeline
            t0 = time.time()
            _chronos = ChronosPipeline.from_pretrained(
                CHRONOS_MODEL,
                device_map="cpu",
                torch_dtype=torch.float32,
            )
            logger.info("chronos ready (%s) in %.1fs", CHRONOS_MODEL, time.time() - t0)
        except Exception as e:  # noqa: BLE001
            _chronos_err = f"{type(e).__name__}: {e}"
            logger.warning("chronos unavailable — %s", _chronos_err)


def _load_finbert():
    """Lazy-load FinBERT exactly once. Never raises."""
    global _finbert, _finbert_err
    if _finbert is not None or _finbert_err is not None:
        return
    with _LOCK:
        if _finbert is not None or _finbert_err is not None:
            return
        try:
            from transformers import pipeline as hf_pipeline
            t0 = time.time()
            _finbert = hf_pipeline("sentiment-analysis", model=FINBERT_MODEL)
            logger.info("finbert ready (%s) in %.1fs", FINBERT_MODEL, time.time() - t0)
        except Exception as e:  # noqa: BLE001
            _finbert_err = f"{type(e).__name__}: {e}"
            logger.warning("finbert unavailable — %s", _finbert_err)


# --------------------------------------------------------------------------
# Request / response models
# --------------------------------------------------------------------------

class ForecastRequest(BaseModel):
    symbol: str = ""
    history: List[float]
    horizon: int = 12
    quantiles: Optional[List[float]] = None


class SentimentRequest(BaseModel):
    headlines: List[str]


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

@router.get("/status")
def hf_status():
    """Probe — what's installed / loaded. Never fails."""
    chronos_state = "ready" if _chronos is not None else (
        "error: " + _chronos_err if _chronos_err else "not-loaded"
    )
    finbert_state = "ready" if _finbert is not None else (
        "error: " + _finbert_err if _finbert_err else "not-loaded"
    )
    return {
        "torch": _torch_available(),
        "chronos": {
            "model": CHRONOS_MODEL,
            "state": chronos_state,
        },
        "finbert": {
            "model": FINBERT_MODEL,
            "state": finbert_state,
        },
        "hf_home": HF_HOME or "(default user cache)",
        "hint": "forecast/sentiment load models lazily on first call; "
                "run warm-ai.bat once to pre-download everything.",
    }


@router.post("/forecast")
def hf_forecast(req: ForecastRequest):
    """Chronos-T5 time-series forecast over a raw close-price series."""
    _load_chronos()
    if _chronos is None:
        raise HTTPException(
            status_code=503,
            detail=f"Chronos unavailable — {_chronos_err or 'still loading'}. "
                   "Install torch+chronos-forecasting (FULL package includes both) "
                   "or run warm-ai.bat.",
        )

    # sanitize history: drop NaN/None, keep finite floats, cap length
    clean = []
    for v in req.history or []:
        try:
            f = float(v)
            if f == f and f not in (float("inf"), float("-inf")):  # NaN/inf guard
                clean.append(f)
        except (TypeError, ValueError):
            continue
    if len(clean) > MAX_HISTORY_POINTS:
        clean = clean[-MAX_HISTORY_POINTS:]
    if len(clean) < MIN_HISTORY_POINTS:
        raise HTTPException(
            status_code=400,
            detail=f"history too short — need >= {MIN_HISTORY_POINTS} clean points, got {len(clean)}",
        )

    horizon = max(1, min(int(req.horizon or 12), 64))
    quantiles = sorted(set(
        min(max(float(q), 0.01), 0.99)
        for q in (req.quantiles or [0.1, 0.25, 0.5, 0.75, 0.9])
    ))

    import torch  # safe here: _chronos loaded means torch imports fine

    t0 = time.time()
    try:
        ctx = torch.tensor(clean, dtype=torch.float32)
        # v18.2 FIX: chronos-forecasting 1.5.x REMOVED the `quantiles=`
        # kwarg from predict() (it now returns raw sample paths) and added
        # predict_quantiles(). The old call raised
        # "predict() got an unexpected keyword argument 'quantiles'" — a
        # 502 on EVERY forecast. Supported API returns
        # (quantiles, mean) with shapes (batch, horizon, n_quantiles).
        qs, _mean = _chronos.predict_quantiles(
            ctx,
            prediction_length=horizon,
            quantile_levels=quantiles,
        )
        # v20.9.1 [H3]: custom quantile list me 0.5 na ho to KeyError → 502
        # hota tha (defaults me 0.5 hai, isliye sirf custom requests toote
        # the). Median slot: requested 0.5 warna list ka middle quantile.
        q_idx = {q: i for i, q in enumerate(quantiles)}
        med_slot = q_idx.get(0.5, len(quantiles) // 2)
        med = [float(x) for x in qs[0, :, med_slot]]
        low = [float(x) for x in qs[0, :, 0]]
        high = [float(x) for x in qs[0, :, len(quantiles) - 1]]
        quantile_series = {f"{q}": [float(x) for x in qs[0, :, i]] for q, i in q_idx.items()}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"forecast failed: {type(e).__name__}: {e}")

    last_price = clean[-1]
    expected = med[-1]
    move_pct = ((expected - last_price) / last_price * 100.0) if last_price else 0.0
    direction = "up" if move_pct > 0.5 else ("down" if move_pct < -0.5 else "flat")

    return {
        "symbol": req.symbol or "(unnamed)",
        "model": CHRONOS_MODEL,
        "horizon": horizon,
        "points_used": len(clean),
        "last_price": last_price,
        "median": med,
        "low": low,
        "high": high,
        "quantiles": quantile_series,
        "direction": direction,
        "expected_move_pct": round(move_pct, 3),
        "elapsed_s": round(time.time() - t0, 2),
    }


@router.post("/sentiment")
def hf_sentiment(req: SentimentRequest):
    """FinBERT sentiment per headline + aggregate read."""
    _load_finbert()
    if _finbert is None:
        raise HTTPException(
            status_code=503,
            detail=f"FinBERT unavailable — {_finbert_err or 'still loading'}. "
                   "Install transformers (FULL package includes it) or run warm-ai.bat "
                   "with internet once.",
        )

    headlines = [h.strip() for h in (req.headlines or []) if h and h.strip()][:50]
    if not headlines:
        raise HTTPException(status_code=400, detail="no non-empty headlines provided")

    t0 = time.time()
    try:
        raw = _finbert(headlines, truncation=True, max_length=256)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"sentiment failed: {type(e).__name__}: {e}")

    results = [
        {"text": h, "label": r.get("label", "?"), "score": round(float(r.get("score", 0.0)), 4)}
        for h, r in zip(headlines, raw)
    ]
    pos = sum(1 for r in results if r["label"].lower() == "positive")
    neg = sum(1 for r in results if r["label"].lower() == "negative")
    neu = len(results) - pos - neg
    net = round((pos - neg) / len(results), 3)
    read = "bullish" if net > 0.15 else ("bearish" if net < -0.15 else "neutral")

    return {
        "model": FINBERT_MODEL,
        "results": results,
        "aggregate": {
            "positive": pos, "negative": neg, "neutral": neu,
            "net_score": net, "read": read,
        },
        "elapsed_s": round(time.time() - t0, 2),
    }
