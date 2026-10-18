"""
AI ORCHESTRATOR — FastAPI Service
Powers both NeuralChat (web) and Telegram bot.
1) Collects real-time data
2) Runs Quant Brain (deterministic — always online)
3) Calls LLM Router (optional — narrates the numbers)
4) Returns combined result
"""

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool  # v20.9.1 [M]: sync ask_llm ko event-loop se hatao
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import time
import hashlib
import json
import logging

from app.quant_brain import analyze, brain_to_text
from app.llm_router import ask_llm, get_provider_status, anti_hallucination_check
from app.prompts import (
    get_7step_system_prompt,
    build_analysis_prompt,
    build_signals_prompt,
    build_portfolio_prompt,
    build_crypto_prompt,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orchestrator")

app = FastAPI(title="WealthAI Orchestrator", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# CACHE (60s TTL per symbol — cuts quota, survives outages)
# ============================================================
_analysis_cache = {}
CACHE_TTL = 60


def _cache_key(symbol: str, query: str = "") -> str:
    raw = f"{symbol}:{query}:{int(time.time() / CACHE_TTL)}"
    return hashlib.md5(raw.encode()).hexdigest()


# ============================================================
# REQUEST MODELS
# ============================================================
class AnalyzeRequest(BaseModel):
    symbol: str
    market: str = "IN"
    user_query: str = ""
    live_snapshot: str = ""
    ohlcv_data: Optional[List[dict]] = None


class SignalsRequest(BaseModel):
    symbols: Optional[List[str]] = None
    market: str = "IN"


class PortfolioRequest(BaseModel):
    positions: List[dict]
    live_prices: dict = {}
    usd_inr_rate: float = 85.5
    user_query: str = ""


class MetaEnsembleRequest(BaseModel):
    """16-model vote wire format from the Node ensemble (Upgrade 4, v21.13 16-seat roster).
    votes: [{id, dir (-1|0|1), conf (0-100), weight?}] — unknown ids
    are ignored, missing ids vote (0,0). regime: 'RISK_ON'|'NEUTRAL'|
    'RISK_OFF'|'GOLDILOCKS'|... maps to the risk flag feature."""
    votes: List[dict] = []
    regime: str = "NEUTRAL"
    # caller's own weighted consensus (fallback + agreement recompute)
    weighted: Optional[dict] = None


class CryptoAgentRequest(BaseModel):
    """Upgrade 2 — the ml-service narration leg of the CoinDCX desk
    agent. The Node side runs the tool loop (live signals / wallet /
    positions / regime); this endpoint narrates the tool context with
    the CRYPTO DESK persona when its LLM keys differ from Node's."""
    symbol: str = ""
    tools_context: str = ""
    user_query: str = ""


# ============================================================
# ENDPOINTS
# ============================================================
@app.get("/health")
async def health():
    providers = get_provider_status()
    active = [p for p in providers if p["available"]]
    return {
        "status": "ok",
        "providers": providers,
        "active_count": len(active),
        "quant_brain": "always_online",
        "version": "2.0.0",
    }


@app.post("/analyze")
async def analyze_symbol(req: AnalyzeRequest):
    """Full deep analysis: Quant Brain + LLM narration."""
    cache_k = _cache_key(req.symbol, req.user_query)
    if cache_k in _analysis_cache:
        cached = _analysis_cache[cache_k]
        cached["from_cache"] = True
        return cached

    # 1) Build macro context
    macro = {"vix": 0, "regime": "UNKNOWN"}

    # 2) Run Quant Brain (deterministic — always works)
    import pandas as pd
    if req.ohlcv_data:
        df = pd.DataFrame(req.ohlcv_data)
    else:
        # Try loading from store
        try:
            from pipeline.fetch_data import load_ohlcv
            ohlcv = load_ohlcv()
            if ohlcv is not None:
                sym_data = ohlcv[ohlcv["symbol"].str.upper() == req.symbol.upper()]
                df = sym_data.tail(300) if not sym_data.empty else pd.DataFrame()
            else:
                df = pd.DataFrame()
        except Exception:
            df = pd.DataFrame()

    brain_result = analyze(req.symbol, df, macro)
    brain_result["market"] = req.market

    # 3) Try LLM narration (optional — falls back to brain_to_text)
    system_prompt = get_7step_system_prompt()
    user_prompt = build_analysis_prompt(brain_result, req.live_snapshot, req.user_query)
    llm_text = await run_in_threadpool(ask_llm, system_prompt, user_prompt)

    used_provider = "none"
    if llm_text:
        # FIX H4: anti_hallucination_check returns None on hallucination;
        # fall back to brain_to_text instead of returning None to the caller.
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
        "timestamp": time.time(),
    }

    _analysis_cache[cache_k] = result
    return result


@app.post("/signals")
async def get_signals(req: SignalsRequest):
    """Scan watchlist for STRONG_BUY/BUY signals."""
    import pandas as pd
    try:
        from pipeline.fetch_data import load_ohlcv
        ohlcv = load_ohlcv()
    except Exception:
        ohlcv = None

    symbols = req.symbols
    if not symbols and ohlcv is not None:
        symbols = ohlcv["symbol"].unique().tolist()[:20]

    if not symbols:
        return {"signals": [], "message": "No symbols to scan"}

    results = []
    for sym in symbols:
        df = pd.DataFrame()
        if ohlcv is not None:
            sym_data = ohlcv[ohlcv["symbol"].str.upper() == sym.upper()]
            if not sym_data.empty:
                df = sym_data.tail(300)

        brain = analyze(sym, df, {"vix": 0, "regime": "UNKNOWN"})
        brain["market"] = req.market
        results.append(brain)

    # Sort by confidence
    results.sort(key=lambda x: x.get("confidence", 0), reverse=True)

    # Try LLM for ranking
    system_prompt = get_7step_system_prompt()
    user_prompt = build_signals_prompt(results)
    llm_text = await run_in_threadpool(ask_llm, system_prompt, user_prompt)

    if not llm_text:
        llm_text = "\n".join([
            f"{r['symbol']}: {r['verdict']} ({r['confidence']}%) | Entry: {r['entry']} | SL: {r['sl']} | TP1: {r['tp1']} | R:R: {r['rr']}"
            for r in results if r['verdict'] in ('STRONG_BUY', 'BUY')
        ]) or "No strong signals currently."

    return {
        "signals": results,
        "text": llm_text,
        "count": len(results),
        "timestamp": time.time(),
    }


@app.post("/portfolio")
async def analyze_portfolio(req: PortfolioRequest):
    """Full portfolio analysis with Quant Brain per position."""
    import pandas as pd
    try:
        from pipeline.fetch_data import load_ohlcv
        ohlcv = load_ohlcv()
    except Exception:
        ohlcv = None

    results = []
    for pos in req.positions:
        sym = pos.get("symbol", "")
        df = pd.DataFrame()
        if ohlcv is not None:
            sym_data = ohlcv[ohlcv["symbol"].str.upper() == sym.upper()]
            if not sym_data.empty:
                df = sym_data.tail(300)

        macro = {"vix": 0, "regime": "UNKNOWN"}
        brain = analyze(sym, df, macro)
        brain["market"] = pos.get("market", "IN")
        brain["position"] = pos
        results.append(brain)

    # Build portfolio context
    portfolio_ctx = f"Total positions: {len(req.positions)}\n"
    for pos in req.positions:
        portfolio_ctx += f"{pos.get('symbol', '?')}: Qty={pos.get('qty', 0)} Avg={pos.get('avgPrice', 0)}\n"

    system_prompt = get_7step_system_prompt()
    user_prompt = build_portfolio_prompt(results, portfolio_ctx)
    llm_text = await run_in_threadpool(ask_llm, system_prompt, user_prompt)

    if not llm_text:
        llm_text = "\n".join([brain_to_text(r) for r in results])

    return {
        "data": results,
        "text": llm_text,
        "count": len(results),
        "timestamp": time.time(),
    }


@app.post("/ask")
async def ask_freeform(symbol: str = "", query: str = "", live_snapshot: str = ""):
    """Free-form question — Quant Brain + LLM."""
    import pandas as pd
    df = pd.DataFrame()
    try:
        from pipeline.fetch_data import load_ohlcv
        ohlcv = load_ohlcv()
        if ohlcv is not None and symbol:
            sym_data = ohlcv[ohlcv["symbol"].str.upper() == symbol.upper()]
            if not sym_data.empty:
                df = sym_data.tail(300)
    except Exception:
        pass

    brain = analyze(symbol or "UNKNOWN", df, {"vix": 0, "regime": "UNKNOWN"})
    brain_result = brain

    system_prompt = get_7step_system_prompt()
    user_prompt = build_analysis_prompt(brain_result, live_snapshot, query)
    llm_text = await run_in_threadpool(ask_llm, system_prompt, user_prompt)

    used_provider = "llm"
    if not llm_text:
        llm_text = brain_to_text(brain_result)
        used_provider = "quant_brain"

    return {
        "data": brain_result,
        "text": llm_text,
        "used_provider": used_provider,
        "timestamp": time.time(),
    }


@app.get("/providers")
async def providers():
    """List all LLM providers and their status."""
    return {"providers": get_provider_status()}


# ============================================================
# META-ENSEMBLE COMBINATION (Upgrade 4)
# ------------------------------------------------------------
# The Node ensemble (server/ai/ensemble.js) POSTs its 16 raw votes
# here when the meta flag is ON (default ON since v21.13.x — explicit
# AI_ENABLE_META_ENSEMBLE=false/0/off/no disables). Response shape (the
# contract the Node side validates before using):
#   { ok, side, confidence, agreement, grade, source: "meta"|"weighted" }
# EVERY failure mode (pkl missing, feature mismatch, predict
# error, empty votes) degrades to the weighted-average answer —
# the endpoint NEVER 500s on a model problem.
# ============================================================
@app.post("/meta-ensemble")
async def meta_ensemble(req: MetaEnsembleRequest):
    from app.config import meta_ensemble_enabled
    from models.train_signal import predict_meta_direction

    votes = [v for v in (req.votes or []) if isinstance(v, dict) and v.get("id")]
    # weighted fallback (mirrors ensemble.js aggregateVotes math).
    # v21.13.x recheck (M6): weight-0 SHADOW seats are excluded from the
    # voting denominator (Node-side contract — meshModels.js gating forces
    # weight 0 on shadow seats; `or 1.0` was silently counting them as
    # full votes in this echo, overstating `agreement`).
    def _w(v):
        try:
            w = float(v.get("weight") or 0.0)
        except (TypeError, ValueError):
            w = 0.0
        return w if w > 0 else 0.0

    def _vote_weight(v):
        # a missing weight = a plain committee vote (weight 1); an explicit
        # 0 = shadow — not counted
        return 1.0 if v.get("weight") is None else _w(v)

    bull = sum(_vote_weight(v) * (v.get("conf") or 0) / 100.0
               for v in votes if (v.get("dir") or 0) > 0)
    bear = sum(_vote_weight(v) * (v.get("conf") or 0) / 100.0
               for v in votes if (v.get("dir") or 0) < 0)
    voting = sum(_vote_weight(v) for v in votes if (v.get("dir") or 0) != 0 and (v.get("conf") or 0) > 0)
    # v21.13.x (B6): tie rule mirrors Node exactly — bull>bear LONG,
    # bear>bull SHORT, EXACT TIE → FLAT (pehle `bull >= bear` free-LONG
    # bias tha; Node kabhi meta-side disagree accept nahi karta, par
    # echo honest hona chahiye).
    side = "LONG" if bull > bear else "SHORT" if bear > bull else "FLAT"
    if voting <= 0 or (bull == 0 and bear == 0):
        side = "FLAT"
    agreement = (max(bull, bear) / voting) if voting > 0 else 0.0
    score = (abs(bull - bear) / voting) if voting > 0 else 0.0
    w_conf = round(100 * score * (0.60 + 0.40 * agreement))
    grade = "STRONG" if (w_conf >= 75 and agreement >= 0.70) else \
            "ACTION" if w_conf >= 55 else \
            "WATCH" if w_conf >= 35 else "NEUTRAL"

    if not meta_ensemble_enabled() or not votes:
        return {"ok": True, "side": side, "confidence": w_conf, "agreement": round(agreement, 2),
                "grade": grade, "source": "weighted",
                "note": "flag off or no votes — weighted-average"}

    risk_flag = 1.0 if "RISK_OFF" in str(req.regime or "").upper() else 0.0
    vote_map = {v["id"]: (v.get("dir") or 0, v.get("conf") or 0) for v in votes}
    try:
        pred = predict_meta_direction(vote_map, risk_flag)
    except Exception:
        pred = None
    if pred is None or pred.get("side") == "FLAT":
        return {"ok": True, "side": side, "confidence": w_conf, "agreement": round(agreement, 2),
                "grade": grade, "source": "weighted",
                "note": "meta pkl unavailable/mismatch — weighted fallback"}
    # meta answered: scale its confidence with the committee agreement
    # (a split committee halves ANY combiner's conviction — honest)
    m_conf = round(float(pred["confidence"]) * (0.60 + 0.40 * agreement))
    m_grade = "STRONG" if (m_conf >= 75 and agreement >= 0.70) else \
              "ACTION" if m_conf >= 55 else \
              "WATCH" if m_conf >= 35 else "NEUTRAL"
    return {"ok": True, "side": pred["side"], "confidence": m_conf,
            "agreement": round(agreement, 2), "grade": m_grade, "source": "meta",
            "label": pred.get("label"), "weighted": {"side": side, "confidence": w_conf}}


# ============================================================
# CRYPTO-AGENT NARRATION (Upgrade 2)
# ------------------------------------------------------------
# The Node side (server/ai/cryptoAgent.js) owns the tool loop and
# the FULL-TICKET discipline; this endpoint is the Python LLM leg
# (Groq/other keys configured only on ml-service). It never
# fabricates data — it narrates ONLY the tools_context it was
# handed, quant_brain fallback when no LLM answers.
# ============================================================
@app.post("/crypto-agent")
async def crypto_agent(req: CryptoAgentRequest):
    user_prompt = build_crypto_prompt(req.symbol, req.tools_context, req.user_query)
    llm_text = await run_in_threadpool(ask_llm, get_7step_system_prompt(), user_prompt)

    used_provider = "llm"
    if not llm_text:
        llm_text = (
            f"CRYPTO DESK QUANT READ (no LLM — deterministic fallback)\n"
            f"Symbol: {req.symbol or 'N/A'}\n"
            f"{req.tools_context or 'No tool context provided.'}"
        )
        used_provider = "quant_brain"
    return {
        "text": llm_text,
        "used_provider": used_provider,
        "symbol": req.symbol,
        "timestamp": time.time(),
    }
