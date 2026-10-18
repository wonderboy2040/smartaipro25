"""
MULTI-PROVIDER LLM ROUTER — Free, Auto-Failover, Effectively Unlimited
Rotates across free providers. If all fail, returns None (caller uses Quant Brain text).

Providers (all free tiers, no credit card):
  1. Gemini   — 1,500 req/day free
  2. Groq     — fast, large daily token budget
  3. OpenRouter — rotating free models
  4. Cerebras — free dev tier, very fast
  5. HuggingFace — free rate-limited
  6. Ollama   — self-host, truly keyless (localhost)
"""

import os
import re
import time
import json
import logging
from typing import Optional

logger = logging.getLogger("llm_router")

# ============================================================
# PROVIDER CONFIG
# ============================================================
PROVIDERS = [
    {
        "name": "gemini",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        "model": "gemini-3.5-flash",
        "env_key": "GEMINI_API_KEY",
        "format": "gemini",
    },
    {
        "name": "groq",
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": "openai/gpt-oss-120b",
        "env_key": "GROQ_API_KEY",
        "format": "openai",
    },
    {
        "name": "openrouter",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "z-ai/glm-5.2:free",
        "env_key": "OPENROUTER_API_KEY",
        "format": "openai",
    },
    {
        "name": "cerebras",
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "model": "gpt-oss-120b",
        "env_key": "CEREBRAS_API_KEY",
        "format": "openai",
    },
    {
        "name": "huggingface",
        "url": "https://router.huggingface.co/v1/chat/completions",
        "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
        "env_key": "HF_API_KEY",
        "format": "openai",
    },
    {
        "name": "ollama",
        "url": "http://localhost:11434/api/chat",
        "model": "llama3.1:8b",
        "env_key": None,
        "format": "ollama",
    },
]

# Health tracking per provider
_provider_health = {}
for p in PROVIDERS:
    _provider_health[p["name"]] = {"failures": 0, "last_failure": 0, "cooldown_ms": 30000}


def _is_provider_available(name: str) -> bool:
    """Check if a provider has its key configured (or is local like Ollama)."""
    for p in PROVIDERS:
        if p["name"] != name:
            continue
        if p["env_key"] is None:
            return True  # Ollama — always try
        return bool(os.environ.get(p["env_key"]))
    return False


def _record_failure(name: str):
    _provider_health[name]["failures"] += 1
    _provider_health[name]["last_failure"] = time.time() * 1000


def _record_success(name: str):
    _provider_health[name]["failures"] = 0


def _is_in_cooldown(name: str) -> bool:
    h = _provider_health[name]
    if h["failures"] < 3:
        return False
    elapsed = time.time() * 1000 - h["last_failure"]
    return elapsed < h["cooldown_ms"]


# ============================================================
# CALL FUNCTIONS
# ============================================================
import urllib.request
import urllib.error


def _call_gemini(provider: dict, system_prompt: str, user_prompt: str, key: str) -> Optional[str]:
    url = provider["url"].format(model=provider["model"], key=key)
    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4096},
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        return text.strip() if text and len(text.strip()) >= 5 else None


def _call_openai_compat(provider: dict, system_prompt: str, user_prompt: str, key: str = None) -> Optional[str]:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if provider["name"] == "openrouter":
        headers["HTTP-Referer"] = "https://smartai1.onrender.com"

    payload = json.dumps({
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 4096,
    }).encode("utf-8")

    req = urllib.request.Request(provider["url"], data=payload, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return text.strip() if text and len(text.strip()) >= 5 else None


def _call_hf(provider: dict, system_prompt: str, user_prompt: str, key: str) -> Optional[str]:
    url = provider["url"].format(model=provider["model"])
    full_prompt = f"System: {system_prompt}\n\nUser: {user_prompt}"
    payload = json.dumps({
        "inputs": full_prompt,
        "parameters": {"max_new_tokens": 4096, "temperature": 0.7},
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=payload, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
        if isinstance(data, list) and data:
            text = data[0].get("generated_text", "")
        elif isinstance(data, dict):
            text = data.get("generated_text", "")
        else:
            text = ""
        return text.strip() if text and len(text.strip()) >= 5 else None


def _call_ollama(provider: dict, system_prompt: str, user_prompt: str) -> Optional[str]:
    payload = json.dumps({
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(provider["url"], data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
        text = data.get("message", {}).get("content", "")
        return text.strip() if text and len(text.strip()) >= 5 else None


# ============================================================
# MAIN ROUTER
# ============================================================
def ask_llm(system_prompt: str, user_prompt: str) -> Optional[str]:
    """
    Try each provider in order. Return first successful response.
    If all fail, return None — caller should use quant_brain.brain_to_text().
    """
    import random
    for provider in PROVIDERS:
        name = provider["name"]

        if not _is_provider_available(name):
            continue
        if _is_in_cooldown(name):
            continue

        key = os.environ.get(provider["env_key"]) if provider["env_key"] else None

        try:
            logger.info(f"  🤖 Trying {name}...")
            if provider["format"] == "gemini":
                text = _call_gemini(provider, system_prompt, user_prompt, key)
            elif provider["format"] == "ollama":
                text = _call_ollama(provider, system_prompt, user_prompt)
            elif provider["format"] == "hf":
                text = _call_hf(provider, system_prompt, user_prompt, key)
            else:
                text = _call_openai_compat(provider, system_prompt, user_prompt, key)

            if text:
                _record_success(name)
                logger.info(f"  ✅ {name} responded ({len(text)} chars)")
                return text
            else:
                _record_failure(name)
                logger.warning(f"  ⚠️ {name} empty response")
        except Exception as e:
            _record_failure(name)
            logger.warning(f"  ❌ {name} error: {e}")

    return None


def get_provider_status() -> list:
    """Return status of all providers for the /health endpoint."""
    statuses = []
    for provider in PROVIDERS:
        name = provider["name"]
        available = _is_provider_available(name)
        health = _provider_health[name]
        statuses.append({
            "name": name,
            "available": available,
            "key_set": bool(os.environ.get(provider["env_key"])) if provider["env_key"] else True,
            "model": provider["model"],
            "failures": health["failures"],
            "in_cooldown": _is_in_cooldown(name),
        })
    return statuses


# ============================================================
# ANTI-HALLUCINATION GUARD
# ============================================================
def anti_hallucination_check(llm_text: str, quant_data: dict) -> str:
    """
    Regex-scan LLM text for numbers NOT present in the quant_data dict.
    FIX M13: previously this only logged a warning and always returned the
    LLM text — fabricated numbers flowed through to the user. Now return
    None when too many suspicious numbers are detected so the caller can
    fall back to `brain_to_text(quant_data)` (deterministic).
    """
    if not llm_text:
        return llm_text

    # Extract all numbers from LLM response
    numbers_in_text = set(re.findall(r'\b\d+\.?\d*\b', llm_text))

    # Extract expected numbers from quant_data
    expected_numbers = set()
    for key in ["rsi", "adx", "entry", "sl", "tp1", "tp2", "rr", "vix", "support", "resistance", "atr"]:
        val = quant_data.get(key)
        if val is not None:
            if isinstance(val, dict):
                for v in val.values():
                    if isinstance(v, (int, float)):
                        expected_numbers.add(str(v))
            else:
                expected_numbers.add(str(val))

    # Allow common small numbers (1-100) and percentages
    suspicious = []
    for num_str in numbers_in_text:
        try:
            num = float(num_str)
            if num > 100 and num_str not in expected_numbers:
                suspicious.append(num_str)
        except ValueError:
            pass

    # If too many suspicious numbers, signal hallucination → return None so
    # the caller (main.py /analyze) can fall back to brain_to_text().
    if len(suspicious) > 3:
        logger.warning(f"  ⚠️ Anti-hallucination triggered: {len(suspicious)} suspicious numbers — returning None for fallback")
        return None

    return llm_text
