// ============================================
// AI CHAT ENGINE — DEEP MIND AI ADVANCE PRO v23 → v18 LATENCY-AWARE SMART ROUTER
// 6-Provider LLM Router + Quant Brain Fallback
// NEVER shows "AI Offline" — Quant Brain always works
// ============================================
import {
  GROQ_KEY, GEMINI_KEY, CLAUDE_KEY, TAVILY_API_KEY,
  OPENROUTER_KEY, CEREBRAS_KEY, HF_KEY, NVIDIA_KEY,
  isGroqAvailable, isGeminiAvailable, isClaudeAvailable, isTavilyAvailable,
  isOpenRouterAvailable, isCerebrasAvailable, isHFAvailable, isNvidiaAvailable,
  ALPHA_ETFS_IN, ALPHA_ETFS_US
} from './config.mjs';
import { fetchMarketIntelligence, fetchForexRate } from './market.mjs';
import { calculateMetrics, analyzeAsset } from './analysis.mjs';
import { MCP_TOOLS_OPENAI, MCP_TOOLS_GEMINI, executeMCPTool } from './mcp-tools.mjs';
import { loadSyncMeta } from './siteSync.mjs';

let realtimeMarketCache = { data: null, timestamp: 0 };
let realtimeForexCache = { rate: 85.5, timestamp: 0 };

const chatHistory = new Map();
const MAX_HISTORY = 10;

// ============================================
// AI MODEL SELECTION — per-chat engine preference
// ============================================
export const AI_ENGINE_LABELS = {
  auto: '⚡ Auto (Smart Failover)',
  gemini: '🔷 Gemini 3.5 Flash',
  groq: '🧠 Groq GPT-OSS 120B',
  claude: '🟣 Claude Sonnet 5',
  openrouter: '🔶 OpenRouter GLM-5.2',
  cerebras: '🧠 Cerebras GPT-OSS 120B',
  huggingface: '🤗 HuggingFace Qwen3 235B',
  nvidia: '🟢 NVIDIA GPT-OSS 120B',
};
const chatEnginePref = new Map(); // chatId -> engineId
export function setChatEngine(chatId, engine) {
  if (!AI_ENGINE_LABELS[engine]) return false;
  chatEnginePref.set(String(chatId), engine);
  return true;
}
export function getChatEngine(chatId) {
  return chatEnginePref.get(String(chatId)) || 'auto';
}

let cachedIntel = null;
let intelTimestamp = 0;

// ============================================
// ENGINE HEALTH — 6 providers with cooldown
// ============================================
const engineHealth = {
  nvidia: { failures: 0, lastFailure: 0, cooldownMs: 15000, latencyMs: 0 },
  groq: { failures: 0, lastFailure: 0, cooldownMs: 30000, latencyMs: 0 },
  gemini: { failures: 0, lastFailure: 0, cooldownMs: 15000, latencyMs: 0 },
  claude: { failures: 0, lastFailure: 0, cooldownMs: 15000, latencyMs: 0 },
  openrouter: { failures: 0, lastFailure: 0, cooldownMs: 30000, latencyMs: 0 },
  cerebras: { failures: 0, lastFailure: 0, cooldownMs: 30000, latencyMs: 0 },
  huggingface: { failures: 0, lastFailure: 0, cooldownMs: 60000, latencyMs: 0 },
};

function recordEngineFailure(engine = 'groq') {
  if (!engineHealth[engine]) return;
  engineHealth[engine].failures++;
  engineHealth[engine].lastFailure = Date.now();
}
function recordEngineSuccess(engine = 'groq', latencyMs = 0) {
  if (!engineHealth[engine]) return;
  engineHealth[engine].failures = 0;
  // v18: track EWMA latency per engine so the router can prefer the fastest
  // healthy provider. 0.3 smoothing converges in ~3 samples.
  if (latencyMs > 0) {
    const prev = engineHealth[engine].latencyMs || latencyMs;
    engineHealth[engine].latencyMs = Math.round(prev * 0.7 + latencyMs * 0.3);
  }
}

// v18: LATENCY-AWARE SMART ROUTER — given the base engine list, return an
// ordering that prefers healthy engines with proven low latency. Engines on
// cooldown (3+ failures) sink to the bottom; untested engines keep original
// order among themselves (fair exploration).
function isEngineCooling(name) {
  const h = engineHealth[name];
  return !!h && h.failures >= 3 && (Date.now() - h.lastFailure) < h.cooldownMs;
}
function orderEnginesByHealth(engines) {
  const withMeta = engines.map((e, idx) => {
    const h = engineHealth[e.name] || {};
    return {
      ...e, _idx: idx,
      _cooling: isEngineCooling(e.name),
      _latency: h.latencyMs || 0,
      _failures: h.failures || 0,
    };
  });
  withMeta.sort((a, b) => {
    if (a._cooling !== b._cooling) return a._cooling ? 1 : -1;
    if (a._failures !== b._failures) return a._failures - b._failures;
    const la = a._latency || 0, lb = b._latency || 0;
    if (la > 0 && lb > 0 && la !== lb) return la - lb;      // both measured → fastest first
    if (la > 0 && lb === 0) return 0 === 0 ? -1 : 0;         // measured first (proven)
    if (la === 0 && lb > 0) return 1;
    return a._idx - b._idx;                                  // original order (fair)
  });
  return withMeta;
}

console.log(`🤖 AI Engines: Gemini=${isGeminiAvailable()} Groq=${isGroqAvailable()} Claude=${isClaudeAvailable()} OpenRouter=${isOpenRouterAvailable()} Cerebras=${isCerebrasAvailable()} HF=${isHFAvailable()}`);

async function retryWithBackoff(fn, maxRetries = 1, baseDelay = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300;
      console.warn(`  ↻ Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ============================================
// TAVILY REAL-TIME WEB SEARCH
// ============================================
async function fetchRealtimeWebData(query) {
  if (!isTavilyAvailable()) return '';
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY, query,
        search_depth: 'basic', include_answer: true,
        max_results: 5, topic: 'finance'
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      let ctx = '';
      if (data.answer) ctx += `LIVE WEB INTEL: ${data.answer}\n`;
      if (data.results) for (const r of data.results.slice(0, 3)) ctx += `• ${r.title}: ${r.content?.substring(0, 200)}\n`;
      return ctx;
    }
  } catch (e) { console.warn('Tavily:', e.message); }
  return '';
}

// ============================================
// REAL-TIME MARKET SNAPSHOT
// ============================================
async function getRealtimeMarketSnapshot() {
  const now = Date.now();
  if (realtimeMarketCache.data && now - realtimeMarketCache.timestamp < 60000) return realtimeMarketCache.data;
  try {
    const tickers = ['NSE:NIFTY','BSE:SENSEX','NSE:BANKNIFTY','AMEX:SPY','NASDAQ:QQQ','CBOE:VIX','NSE:INDIAVIX','TVC:DXY','COMEX:GC1!','NYMEX:CL1!','BITSTAMP:BTCUSD'];
    const res = await fetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ symbols: { tickers }, columns: ['name','close','change','high','low','volume'] }),
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json();
      let snap = 'REAL-TIME MARKET SNAPSHOT:\n';
      const nm = {'NSE:NIFTY':'NIFTY50','BSE:SENSEX':'SENSEX','NSE:BANKNIFTY':'BANKNIFTY','AMEX:SPY':'S&P500','NASDAQ:QQQ':'NASDAQ100','CBOE:VIX':'US_VIX','NSE:INDIAVIX':'INDIA_VIX','TVC:DXY':'DXY','COMEX:GC1!':'GOLD','NYMEX:CL1!':'CRUDE_OIL','BITSTAMP:BTCUSD':'BITCOIN'};
      if (data?.data) for (const i of data.data) {
        const n = nm[i.s] || i.s; const p = parseFloat(i.d?.[1])||0; const c = parseFloat(i.d?.[2])||0;
        if (p>0) snap += `${n}: ${p.toFixed(2)} (${c>=0?'+':''}${c.toFixed(2)}%)\n`;
      }
      realtimeMarketCache = { data: snap, timestamp: now };
      return snap;
    }
  } catch (e) { console.warn('Market snap:', e.message); }
  return realtimeMarketCache.data || '';
}

async function getRealtimeForex() {
  const now = Date.now();
  if (now - realtimeForexCache.timestamp < 30000) return realtimeForexCache.rate;
  try { const r = await fetchForexRate(); realtimeForexCache = { rate: r, timestamp: now }; return r; }
  catch { return realtimeForexCache.rate; }
}

// ============================================
// LLM CALLERS — 6 Providers
// ============================================

// 0) NVIDIA (Primary Fallback out-of-the-box)
async function callNvidia(messages, systemPrompt, modelName = 'openai/gpt-oss-120b') {
  if (!isNvidiaAvailable()) throw new Error('NVIDIA key missing');
  if (engineHealth.nvidia.failures >= 3 && Date.now() - engineHealth.nvidia.lastFailure < engineHealth.nvidia.cooldownMs) throw new Error('NVIDIA cooling down');
  let res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature: 0.7, max_tokens: 4000 }),
    signal: AbortSignal.timeout(10000)
  });
  // Fallback to Nemotron if primary model deprecated/404
  if (!res.ok && (res.status === 404 || res.status === 400) && modelName !== 'nvidia/nemotron-3.5-lightning-30b-a3b') {
    res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NVIDIA_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature: 0.7, max_tokens: 4000 }),
      signal: AbortSignal.timeout(10000)
    });
  }
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`NVIDIA ${res.status}: ${err.error?.message||res.statusText}`); }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text || text.trim().length < 5) throw new Error('NVIDIA empty response');
  return text;
}

// 1) GOOGLE GEMINI (with MCP Function Calling)
async function callGemini(messages, systemPrompt, modelName = 'gemini-3.5-flash', toolContext = {}) {
  if (!isGeminiAvailable()) throw new Error('Gemini key missing');
  if (engineHealth.gemini.failures >= 3 && Date.now() - engineHealth.gemini.lastFailure < engineHealth.gemini.cooldownMs) throw new Error('Gemini cooling down');
  
  let targetModel = modelName;
  if (!targetModel || targetModel.includes('2.0') || targetModel.includes('1.5')) {
    targetModel = 'gemini-3.5-flash';
  }

  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: MCP_TOOLS_GEMINI,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
  };
  
  let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok && res.status === 404 && targetModel !== 'gemini-2.5-flash') {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
  }
  if (!res.ok && res.status === 404) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
  }

  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`Gemini ${res.status}: ${err.error?.message||res.statusText}`); }
  let data = await res.json();
  let candidate = data.candidates?.[0]?.content?.parts?.[0];

  // Tool calling execution loop (up to 2 iterations)
  let loopCount = 0;
  while (candidate?.functionCall && loopCount < 2) {
    loopCount++;
    const fn = candidate.functionCall;
    console.log(`  🔧 [MCP] Gemini called tool: ${fn.name}`, fn.args);
    const result = await executeMCPTool(fn.name, fn.args, toolContext);

    contents.push({ role: 'model', parts: [{ functionCall: fn }] });
    contents.push({
      role: 'user',
      parts: [{
        functionResponse: {
          name: fn.name,
          response: { result }
        }
      }]
    });

    const followUpRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    if (followUpRes.ok) {
      data = await followUpRes.json();
      candidate = data.candidates?.[0]?.content?.parts?.[0];
    } else {
      break;
    }
  }

  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
  if (!text || text.trim().length < 5) throw new Error('Gemini empty response');
  return text;
}

// 2) GROQ GPT-OSS 120B (with MCP Tool Calling)
async function callGroq(messages, systemPrompt, modelName = 'openai/gpt-oss-120b', toolContext = {}) {
  if (!isGroqAvailable()) throw new Error('Groq key missing');
  if (engineHealth.groq.failures >= 3 && Date.now() - engineHealth.groq.lastFailure < engineHealth.groq.cooldownMs) throw new Error('Groq cooling down');
  
  let targetModel = modelName;
  if (!targetModel || targetModel.includes('3.3-70b') || targetModel.includes('3.2-90b') || targetModel.includes('llama-4-scout') || targetModel.includes('3.1-8b')) {
    targetModel = 'openai/gpt-oss-120b';
  }

  const reqMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  let res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: targetModel,
      messages: reqMessages,
      tools: MCP_TOOLS_OPENAI,
      temperature: 0.7,
      max_completion_tokens: 8000
    }),
    signal: AbortSignal.timeout(15000)
  });

  // FIX Bug 5: Robust multi-model fallback chain for Groq tool calling.
  // Primary (openai/gpt-oss-120b) → llama-3.3-70b-versatile → qwen/qwen3-32b
  if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
    console.warn(`  ⚠️ Groq ${targetModel} failed (${res.status}), trying llama-3.3-70b-versatile...`);
    targetModel = 'llama-3.3-70b-versatile';
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel, messages: reqMessages, tools: MCP_TOOLS_OPENAI, temperature: 0.7, max_completion_tokens: 8000 }),
      signal: AbortSignal.timeout(15000)
    });
  }
  if (!res.ok && (res.status === 400 || res.status === 404 || res.status === 422)) {
    console.warn(`  ⚠️ Groq ${targetModel} failed (${res.status}), trying qwen/qwen3-32b...`);
    targetModel = 'qwen/qwen3-32b';
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel, messages: reqMessages, tools: MCP_TOOLS_OPENAI, temperature: 0.7, max_completion_tokens: 8000 }),
      signal: AbortSignal.timeout(15000)
    });
  }

  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`Groq ${res.status}: ${err.error?.message||res.statusText}`); }
  let data = await res.json();
  let choice = data.choices?.[0];

  // Tool calling execution loop
  let loopCount = 0;
  while (choice?.message?.tool_calls && choice.message.tool_calls.length > 0 && loopCount < 2) {
    loopCount++;
    reqMessages.push(choice.message);

    for (const toolCall of choice.message.tool_calls) {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
      console.log(`  🔧 [MCP] Groq called tool: ${toolCall.function.name}`, args);
      const result = await executeMCPTool(toolCall.function.name, args, toolContext);
      reqMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      });
    }

    const followUpRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: targetModel, messages: reqMessages, temperature: 0.7, max_completion_tokens: 8000 }),
      signal: AbortSignal.timeout(15000)
    });

    if (followUpRes.ok) {
      data = await followUpRes.json();
      choice = data.choices?.[0];
    } else {
      break;
    }
  }

  const text = choice?.message?.content;
  if (!text || text.trim().length < 5) throw new Error('Groq empty response');
  return text;
}

// 3) ANTHROPIC CLAUDE SONNET 5
async function callClaude(messages, systemPrompt, modelName = 'claude-sonnet-5') {
  if (!isClaudeAvailable()) throw new Error('Claude key missing');
  if (engineHealth.claude?.failures >= 3 && Date.now() - engineHealth.claude.lastFailure < (engineHealth.claude?.cooldownMs||30000)) throw new Error('Claude cooling down');
  const claudeMessages = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, max_tokens: 8000, system: systemPrompt, messages: claudeMessages }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`Claude ${res.status}: ${err.error?.message||res.statusText}`); }
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text || text.trim().length < 5) throw new Error('Claude empty response');
  return text;
}

// 4) OPENROUTER (free models with MCP Tool Calling)
async function callOpenRouter(messages, systemPrompt, modelName = 'z-ai/glm-5.2:free', toolContext = {}) {
  if (!isOpenRouterAvailable()) throw new Error('OpenRouter key missing');
  if (engineHealth.openrouter.failures >= 3 && Date.now() - engineHealth.openrouter.lastFailure < engineHealth.openrouter.cooldownMs) throw new Error('OpenRouter cooling down');
  const reqMessages = [{ role: 'system', content: systemPrompt }, ...messages];
  let res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://smartai1.onrender.com' },
    body: JSON.stringify({ model: modelName, messages: reqMessages, tools: MCP_TOOLS_OPENAI, temperature: 0.7, max_tokens: 8000 }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`OpenRouter ${res.status}: ${err.error?.message||res.statusText}`); }
  let data = await res.json();
  let choice = data.choices?.[0];

  // Tool calling execution loop
  let loopCount = 0;
  while (choice?.message?.tool_calls && choice.message.tool_calls.length > 0 && loopCount < 2) {
    loopCount++;
    reqMessages.push(choice.message);

    for (const toolCall of choice.message.tool_calls) {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
      console.log(`  🔧 [MCP] OpenRouter called tool: ${toolCall.function.name}`, args);
      const result = await executeMCPTool(toolCall.function.name, args, toolContext);
      reqMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result)
      });
    }

    const followUpRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://smartai1.onrender.com' },
      body: JSON.stringify({ model: modelName, messages: reqMessages, temperature: 0.7, max_tokens: 8000 }),
      signal: AbortSignal.timeout(12000)
    });

    if (followUpRes.ok) {
      data = await followUpRes.json();
      choice = data.choices?.[0];
    } else {
      break;
    }
  }

  const text = choice?.message?.content;
  if (!text || text.trim().length < 5) throw new Error('OpenRouter empty response');
  return text;
}

// 5) CEREBRAS
async function callCerebras(messages, systemPrompt, modelName = 'gpt-oss-120b') {
  if (!isCerebrasAvailable()) throw new Error('Cerebras key missing');
  if (engineHealth.cerebras.failures >= 3 && Date.now() - engineHealth.cerebras.lastFailure < engineHealth.cerebras.cooldownMs) throw new Error('Cerebras cooling down');
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CEREBRAS_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature: 0.7, max_tokens: 8000 }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`Cerebras ${res.status}: ${err.error?.message||res.statusText}`); }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text || text.trim().length < 5) throw new Error('Cerebras empty response');
  return text;
}

// 6) HUGGINGFACE INFERENCE
async function callHuggingFace(messages, systemPrompt, modelName = 'Qwen/Qwen3-235B-A22B-Instruct-2507') {
  if (!isHFAvailable()) throw new Error('HF key missing');
  if (engineHealth.huggingface.failures >= 3 && Date.now() - engineHealth.huggingface.lastFailure < engineHealth.huggingface.cooldownMs) throw new Error('HuggingFace cooling down');
  // Use HF Inference Providers (OpenAI-compatible chat completions via router)
  const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HF_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature: 0.7, max_tokens: 4096 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(`HF ${res.status}: ${JSON.stringify(err)}`); }
  const data = await res.json();
  // OpenAI-compatible response format from router
  const text = data.choices?.[0]?.message?.content || (Array.isArray(data) && data[0] ? data[0].generated_text : data.generated_text || '');
  if (!text || text.trim().length < 5) throw new Error('HuggingFace empty response');
  return text;
}

// ============================================
// QUANT BRAIN — Deterministic fallback (always works)
// ============================================
// FIX H6: Previously searched for the literal string 'PORTFOLIO' in context
// lines, which never matched any position line. Now: if symbol is 'PORTFOLIO'
// (general query), extract the FIRST valid position line's price/change.
function quantBrainFallback(symbol, contextData) {
  const lines = contextData.split('\n');
  let rsi = 50, price = 0, change = 0;
  let foundPosition = false;

  for (const line of lines) {
    if (line.includes('RSI=')) {
      const m = line.match(/RSI=(\d+\.?\d*)/);
      if (m) rsi = parseFloat(m[1]);
    }
    // FIX H6: if symbol is 'PORTFOLIO' (general fallback), grab the FIRST
    // position line that has a price pattern. Otherwise look for the specific
    // symbol.
    const shouldMatch = symbol === 'PORTFOLIO' ? !foundPosition : line.includes(symbol);
    if (shouldMatch && line.includes(':')) {
      const m = line.match(/:\s*(\d+\.?\d+)\s*\(([+-]?\d+\.?\d*)%\)/);
      if (m) {
        price = parseFloat(m[1]);
        change = parseFloat(m[2]);
        foundPosition = true;
        if (symbol !== 'PORTFOLIO') break;  // found specific symbol, stop
      }
    }
  }

  let verdict = 'HOLD';
  let confidence = 55;
  let entry = price, sl = price * 0.95, tp1 = price * 1.05, tp2 = price * 1.10;

  if (rsi < 30) { verdict = 'STRONG_BUY'; confidence = 85; entry = price; sl = price * 0.93; tp1 = price * 1.08; tp2 = price * 1.15; }
  else if (rsi < 45) { verdict = 'BUY'; confidence = 70; entry = price; sl = price * 0.95; tp1 = price * 1.06; tp2 = price * 1.12; }
  else if (rsi > 75) { verdict = 'WAIT'; confidence = 60; }
  else if (rsi > 65) { verdict = 'HOLD'; confidence = 55; }

  // FIX CRIT: when price=0 (no data matched in context), `entry - sl = 0` →
  // R:R = NaN rendered as "R:R: NaN". Also `₹0.00` everywhere. Guard with a
  // safe denominator and a "no data" notice.
  const riskDenom = entry - sl;
  const rr = riskDenom > 0 ? ((tp1 - entry) / riskDenom).toFixed(2) : 'N/A';
  const noDataNote = price > 0 ? '' : '\n⚠️ No live price in context — values may be zero.';

  return `📊 QUANT BRAIN — ${symbol} (Auto-Analysis)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Verdict: ${verdict} (${confidence}%)
RSI: ${rsi} | Price: ₹${price.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)

🎯 Entry: ₹${entry.toFixed(2)}
🛑 Stop Loss: ₹${sl.toFixed(2)}
✅ Target 1: ₹${tp1.toFixed(2)}
✅ Target 2: ₹${tp2.toFixed(2)}
📐 R:R: ${rr}${noDataNote}

💡 ${rsi < 30 ? 'Deeply oversold — strong buying opportunity' : rsi < 45 ? 'Approaching oversold zone — accumulate' : rsi > 75 ? 'Overbought — wait for pullback' : 'Neutral — hold current position'}

⚡ LLM narration unavailable — Quant Brain always online`;
}

// ============================================
// ANTI-HALLUCINATION GUARD
// ============================================
// FIX H9: previously this function only logged a warning and ALWAYS returned
// the LLM text unchanged — fabricated numbers flowed through to the user.
// Now returns `null` when too many suspicious numbers are detected so the
// caller (chatWithAI) can fall back to Quant Brain.
function antiHallucinationCheck(llmText, contextData) {
  if (!llmText) return llmText;
  // Extract numbers from LLM response
  const numbersInText = (llmText.match(/\b\d+\.?\d*\b/g) || []);
  // Extract numbers from context (prices, RSI, etc.)
  const contextNumbers = (contextData.match(/\b\d+\.?\d*\b/g) || []);
  const contextSet = new Set(contextNumbers);
  // Flag suspicious numbers > 100 not in context, but exempt common market ranges
  // (Sensex 60K-100K, Nifty 15K-30K, stock prices 100-10000, BTC 20K-200K, percentages, years)
  const suspicious = numbersInText.filter(n => {
    const val = parseFloat(n);
    if (val <= 100) return false; // small numbers are fine
    if (contextSet.has(n)) return false; // number is in context data
    // Exempt common ranges: years (2020-2030), percentages (already small), round targets
    if (val >= 2020 && val <= 2035) return false; // years
    if (val % 100 === 0 && val <= 10000) return false; // round price targets like 500, 1000
    if (val % 1000 === 0 && val <= 100000) return false; // round levels like 20000, 50000
    return true;
  });
  // FIX: raised threshold from 5 → 15. Stock analysis naturally contains many numbers
  // (prices, targets, support/resistance, market caps) that won't match context exactly.
  // Previous threshold of 5 caused valid responses to be rejected, falling back to
  // the simplistic Quant Brain which gave inaccurate generic results.
  // FIX H4: raised from 15→30 to avoid discarding accurate LLM output that
  // contains support/resistance levels, market caps, percentages, etc.
  if (suspicious.length > 30) {
    console.warn(`  ⚠️ Anti-hallucination triggered: ${suspicious.length} suspicious numbers — falling back to Quant Brain`);
    return null;
  }
  if (suspicious.length > 8) {
    console.warn(`  ⚠️ Anti-hallucination warning: ${suspicious.length} suspicious numbers (keeping response with disclaimer)`);
    return llmText + '\n\n⚠️ Note: Some figures may be approximate. Verify critical numbers from live data.';
  }
  return llmText;
}

// ============================================
// SUPERINTELLIGENCE PORTFOLIO & WEALTH BLUEPRINT PROMPT
// ============================================
function build7StepPrompt(contextData, intent) {
  const d = new Date().toLocaleDateString('en-IN', {timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric'});
  const t = new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit'});

  return `You are DEEP MIND AI SUPERINTELLIGENCE v6.0 — a premier Quantitative Wealth & Market Superintelligence Engine with 24x7 REAL-TIME market data, autonomous MCP tools, and institutional portfolio management capabilities.

PERSONA & TONE:
You are the user's personal ADVANCE INSTITUTIONAL QUANT WEALTH ADVISOR (20+ years experience across NSE/BSE/US/Crypto).
Speak in clear, punchy, actionable **Hinglish** ("Bhai", "dekho", "simple words me", "kab buy kare", "SL trail karo", "compounding ka power"). Explain complex quant concepts in simple words that anyone can execute.

CORE SUPERINTELLIGENCE MANDATE FOR USER PORTFOLIO:
When the user asks about their portfolio, holdings, or long-term wealth strategy, you MUST provide a complete **Holding-by-Holding Deep Audit** and **Long-Term Higher Return Blueprint**:

1. 📋 **AUDIT EVERY SINGLE HOLDING (Har Holding Ka Detailed Analysis):**
   For EVERY stock, ETF, and crypto holding in the user's portfolio, give:
   • ⚡ **SuperScore (1-99)** & Action Badge (💎 ACCUMULATE ON DIPS / 🛡️ HOLD & COMPOUND / 💰 BOOK PARTIAL PROFIT / ⚠️ REVIEW)
   • ⏳ **KAB INVEST KARE (Dip Buy Zone)**: Give EXACT price range (support/pullback) jahan fresh quantity add karni chahiye.
   • 🛡️ **KAB HOLD KARE**: Agar uptrend healthy hai to clear bolo "Shanti se hold karo, compounding chalne do".
   • 💰 **KAB PROFIT LE (Trim Zone)**: Agar RSI > 72 ya asset overbought hai to exact level do jahan 15-25% partial profit book karke cash ready rakhna hai.
   • 🎯 **Target 1 & Long-Term (3-5 Year) Compounding Target**: Realistic projection (14-22% CAGR based).
   • 🛑 **Trailing Stop Loss**: Capital protection price level.

2. 🚀 **LONG-TERM HIGHER RETURN & ALPHA WEALTH MAXIMIZATION:**
   • Konsa asset sabse fast grow karega (High Alpha momentum compounders).
   • SIP Tilt strategy: Konsi holding me monthly allocation badhana chahiye.
   • 10-15 saal ka realistic compounding wealth projection.

3. 🛡️ **ANTI-HALLUCINATION & ACCURACY RULES:**
   • Use REAL-TIME data provided below and MCP tools. Never invent old or imaginary prices.
   • Reference user's actual quantities, invested amounts, and live P&L.

TODAY: ${d} | ${t} IST
INTENT: ${intent}

=== LIVE REAL-TIME MARKET & PORTFOLIO DATA ===
${contextData}
=== END LIVE DATA ===

Deliver your analysis in a structured, visual format with emojis, clean sections, bold levels, and unmistakable advice in natural Hinglish.`;
}

// ============================================
// BUILD CONTEXT — Real-Time Portfolio + Market + Web
// ============================================
async function buildContext(portfolio, livePrices, usdInrRate, userQuery = '') {
  let ctx = '';
  const now = Date.now();

  // ===== PERFORMANCE FIX: Run ALL network calls in PARALLEL =====
  // Previously these were sequential (25-45s). Now parallel (6-10s max).
  const needsIntel = !cachedIntel || now - intelTimestamp > 60000;
  const q = (userQuery || '').toLowerCase();
  const isMarketQuery = /\b(news|market|nifty|sensex|fed|rbi|ipo|crude|gold|dollar|bitcoin|btc|crypto|budget|gdp|inflation|earnings|breaking|today|live)\b/i.test(q);
  const isPortfolioQuery = /\b(portfolio|analy|strategy|deep|comprehensive|fundamental|valuation|sip|retirement|cagr|projection|holding|position)\b/i.test(q);

  // Build list of parallel fetches
  const tasks = [
    getRealtimeMarketSnapshot(),  // 0: market snapshot
    getRealtimeForex(),            // 1: forex rate
  ];
  if (needsIntel) tasks.push(fetchMarketIntelligence()); // 2: market intel
  else tasks.push(Promise.resolve(cachedIntel));

  // Only fetch Tavily web data for market/news queries (skip for simple questions)
  if (userQuery && isTavilyAvailable() && isMarketQuery) {
    console.log('  🔍 Fetching live web data via Tavily (parallel)...');
    tasks.push(fetchRealtimeWebData(userQuery + (/news|stock|crypto|market|price/i.test(userQuery)?'':' latest market news'))); // 3
  } else {
    tasks.push(Promise.resolve('')); // 3: no Tavily needed
  }

  // Only fetch portfolio-specific news for portfolio queries (saves 8s+ for general questions)
  if (portfolio?.length && isTavilyAvailable() && (isPortfolioQuery || isMarketQuery)) {
    try {
      const topHoldings = [...portfolio]
        .sort((a, b) => ((livePrices[`${b.market}_${b.symbol}`]?.price || b.avgPrice) * b.qty) - ((livePrices[`${a.market}_${a.symbol}`]?.price || a.avgPrice) * a.qty))
        .slice(0, 5)
        .map(p => p.symbol.replace('.NS', '').replace('.BO', ''));
      if (topHoldings.length > 0) {
        console.log(`  📰 Fetching portfolio-specific news for: ${topHoldings.join(', ')} (parallel)`);
        const portfolioQuery = `${topHoldings.join(' ')} stock news latest quarterly results insider trading institutional moves today`;
        tasks.push(fetchRealtimeWebData(portfolioQuery)); // 4
      } else {
        tasks.push(Promise.resolve('')); // 4
      }
    } catch (e) {
      console.warn('Portfolio news query build failed:', e.message);
      tasks.push(Promise.resolve('')); // 4
    }
  } else {
    tasks.push(Promise.resolve('')); // 4: skip portfolio news for non-portfolio queries
  }

  // ===== Execute ALL network calls in parallel =====
  const results = await Promise.allSettled(tasks);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // 0: Market Snapshot
  const ms = val(0);
  if (ms) ctx += ms + '\n';

  // 1: Forex
  const fx = val(1) || 85.5;
  ctx += `LIVE USD/INR: ₹${fx.toFixed(4)}\nTimestamp: ${new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'})} IST\n\n`;

  // 2: Market Intelligence
  const intel = val(2);
  if (intel) {
    if (needsIntel) { cachedIntel = intel; intelTimestamp = now; }
    ctx += `GLOBAL INDICES:\n`;
    intel.globalIndices.forEach(i => ctx += `${i.name}: ${i.price.toFixed(1)} (${i.change>=0?'+':''}${i.change.toFixed(1)}%)\n`);
    ctx += `\nSECTOR ROTATION:\n`;
    intel.sectors.forEach(s => ctx += `${s.name}: ${s.change>=0?'+':''}${s.change.toFixed(2)}%\n`);
    ctx += `Fear/Greed: ${intel.fearGreedScore}/100\nAI Narrative: ${intel.marketNarrative}\n\n`;
  }

  // 3: Tavily Web Data
  const web = val(3);
  if (web) ctx += `\nLIVE WEB SEARCH RESULTS:\n${web}\n`;

  // 4: Portfolio News
  const newsRes = val(4);
  if (newsRes) ctx += `\nPORTFOLIO-SPECIFIC NEWS (top holdings):\n${String(newsRes).substring(0, 1500)}\n`;

  // ===== Portfolio positions (local computation, no network) =====
  if (portfolio?.length) {
    const m = calculateMetrics(portfolio, livePrices, usdInrRate);
    // 2026-09 site integration: header shows which sources feed this
    // portfolio + freshness, and each position line carries its source tag
    // (🏦 INDMoney / 🪙 CoinDCX) + LIVE/NAV status so the AI reasons about
    // NAV-priced rows (MF/FD/bond — no intraday quote) correctly.
    const syncHeader = loadSyncMeta();
    const srcLine = syncHeader && syncHeader.counts?.visible > 0
      ? `Sources: 🏦 INDMoney (${syncHeader.counts.indmoney}) + 🪙 CoinDCX (${syncHeader.counts.coindcx}) · last sync ${syncHeader.syncedAt ? new Date(syncHeader.syncedAt).toISOString() : 'never'}${syncHeader.stale ? ' (STALE)' : ''} · auto-sync 2x daily 09:30/21:30 IST\n`
      : '';
    ctx += `\nPORTFOLIO DASHBOARD (site-synced — INDMoney MCP + CoinDCX):\n${srcLine}Total Value: ₹${Math.round(m.totalValue).toLocaleString('en-IN')}\nInvested: ₹${Math.round(m.totalInvested).toLocaleString('en-IN')}\nTotal P&L: ${m.totalPL>=0?'+':''}₹${Math.round(m.totalPL).toLocaleString('en-IN')} (${m.plPct.toFixed(2)}%)\nToday P&L: ${m.todayPL>=0?'+':''}₹${Math.round(m.todayPL).toLocaleString('en-IN')} (${m.todayPct.toFixed(2)}%)\n\n`;
    ctx += `POSITIONS WITH LIVE TECHNICALS + INSIDE STORY:\n`;

    // Track warnings + opportunities for auto-flagging.
    const warnings = [];
    const opportunities = [];
    let topGainer = null, topLoser = null;


    for (const p of portfolio) {
      const k = `${p.market}_${p.symbol}`;
      const d = livePrices[k];
      const price = d?.price || p.lastSyncPrice || p.avgPrice;
      const chg = d?.change ?? p.lastSyncPnlPct ?? 0;
      const rsi = d?.rsi || 50;
      const sma20 = d?.sma20, sma50 = d?.sma50, macd = d?.macd;
      const plPct = p.avgPrice>0 ? ((price-p.avgPrice)/p.avgPrice)*100 : 0;
      const plAbs = (price-p.avgPrice)*p.qty;
      const plINR = p.market==='US' ? plAbs*usdInrRate : plAbs;
      const sig = analyzeAsset(p, d);
      const cur = p.market==='IN'?'₹':'$';
      const srcTag = p.source === 'coindcx' ? '🪙' : (p.source === 'indmoney' ? '🏦' : '');
      const priceTag = p.noLive ? 'NAV' : (d?.price ? 'LIVE' : '');
      const nameTag = p.name && p.name !== p.symbol ? ` "${String(p.name).slice(0, 28)}"` : '';
      ctx += `${srcTag}${p.symbol.replace('.NS','')} [${p.market}${priceTag ? '/' + priceTag : ''}]${nameTag}: ${cur}${price.toFixed(2)} (${chg>=0?'+':''}${chg.toFixed(1)}%) | RSI=${p.noLive ? 'n/a' : rsi.toFixed(0)} | ${p.noLive ? `Type=${p.assetType || 'NAV asset'} | Sync P&L=${plPct.toFixed(1)}%` : `${sig.signal}(${sig.confidence}%)`} | Qty=${p.qty} Avg=${cur}${p.avgPrice.toFixed(2)} P&L=${plPct.toFixed(1)}% (₹${Math.round(plINR).toLocaleString('en-IN')})${p.assetType ? ` · ${p.assetType}` : ''}\n`;

      // ===== INSIDE STORY (derived from price action + technicals) =====
      const stories = [];
      if (chg > 3) stories.push(`🔥 +${chg.toFixed(1)}% strong rally`);
      else if (chg < -3) stories.push(`⚠️ ${chg.toFixed(1)}% sharp drop`);
      if (rsi < 30) stories.push(`💎 RSI ${rsi.toFixed(0)} oversold — accumulation zone`);
      else if (rsi > 75) stories.push(`🚨 RSI ${rsi.toFixed(0)} overbought — distribution risk`);
      if (sma20 && sma50) {
        if (sma20 > sma50) stories.push(`🟢 Golden Cross`);
        else stories.push(`🔴 Death Cross`);
      }
      if (macd !== undefined) {
        if (macd > 0) stories.push(`📈 MACD bullish`);
        else stories.push(`📉 MACD bearish`);
      }
      if (plPct > 15) stories.push(`💰 +${plPct.toFixed(0)}% profit — trail SL`);
      else if (plPct < -15) stories.push(`💸 ${plPct.toFixed(0)}% loss — review thesis`);
      if (stories.length > 0) ctx += `  Inside Story: ${stories.join(' · ')}\n`;

      // Track warnings + opportunities
      if (rsi > 75) warnings.push(`${p.symbol} overbought (RSI ${rsi.toFixed(0)})`);
      if (rsi < 30) opportunities.push(`${p.symbol} oversold (RSI ${rsi.toFixed(0)}) — accumulation zone`);
      if (chg > 4) opportunities.push(`${p.symbol} +${chg.toFixed(1)}% rally`);
      if (chg < -4) warnings.push(`${p.symbol} ${chg.toFixed(1)}% drop`);
      if (!topGainer || chg > topGainer.pct) topGainer = { symbol: p.symbol, pct: chg };
      if (!topLoser || chg < topLoser.pct) topLoser = { symbol: p.symbol, pct: chg };
    }

    // ===== AUTO WARNINGS + OPPORTUNITIES (Superintelligence v4.0) =====
    if (warnings.length > 0) {
      ctx += `\n⚠️ AUTO WARNINGS:\n`;
      warnings.forEach(w => ctx += `• ${w}\n`);
    }
    if (opportunities.length > 0) {
      ctx += `\n💡 AUTO OPPORTUNITIES:\n`;
      opportunities.forEach(o => ctx += `• ${o}\n`);
    }
    if (topGainer) ctx += `\nTop Gainer: ${topGainer.symbol} (+${topGainer.pct.toFixed(2)}%)\n`;
    if (topLoser) ctx += `Top Loser: ${topLoser.symbol} (${topLoser.pct.toFixed(2)}%)\n`;
  }
  return ctx;
}

// ============================================
// MAIN CHAT — 6-Engine Router + Quant Brain Fallback
// NEVER shows "AI Offline" again
// ============================================
// FIX L7: chatMutex declared BEFORE chatWithAI (which references it) so the
// code reads top-down without TDZ confusion.
const chatMutex = new Map();

export async function chatWithAI(chatId, userMessage, portfolio=[], livePrices={}, usdInrRate=83.5) {
  // v17 FIX (memory hygiene): cap total tracked chats — on long dyno runs
  // stray chatIds could grow this Map forever. Maps iterate in insertion
  // order, so evict the oldest entries first.
  const MAX_CHATS = 20;
  if (!chatHistory.has(chatId) && chatHistory.size >= MAX_CHATS) {
    const oldest = chatHistory.keys().next().value;
    chatHistory.delete(oldest);
    chatMutex.delete(oldest);
  }
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const history = chatHistory.get(chatId);

  // FIX H15: race condition — two concurrent /ai calls from the same chatId
  // could interleave: both push `user` before either pushes `assistant`,
  // producing [u1, u2, a1, a2] instead of [u1, a1, u2, a2]. Use a per-chat
  // mutex (chain of promises) so chats serialize cleanly.
  const prev = chatMutex.get(chatId) || Promise.resolve();
  const next = prev.then(() => _chatWithAIInner(chatId, userMessage, history, portfolio, livePrices, usdInrRate));
  chatMutex.set(chatId, next.catch(() => {}));  // never let a rejection break the chain
  return next;
}

async function _chatWithAIInner(chatId, userMessage, history, portfolio, livePrices, usdInrRate) {
  history.push({ role: 'user', content: userMessage });

  const q = userMessage.toLowerCase();
  const isMarketQuery = /\b(news|market|live|nifty|sensex|breaking|ipo|fii|dii|rbi|fed|crude|gold|dollar|bitcoin|btc|crypto|budget|gdp|inflation|earnings|sector|global|pre.?market|gift\s*nifty)\b/i.test(q);
  const intent = isMarketQuery ? 'MARKET_INTEL' : (/\b(portfolio|analy|strategy|deep|comprehensive|fundamental|valuation|sip|retirement|cagr|projection)\b/i.test(q) ? 'DEEP_ANALYSIS' : 'GENERAL');
  console.log(`  🧠 Intent: ${intent}`);

  let contextData = '';
  try { contextData = await buildContext(portfolio, livePrices, usdInrRate, userMessage); }
  // FIX M3: log buildContext failures so Tavily/TradingView/calculateMetrics
  // errors don't silently produce empty context.
  catch (e) { console.warn('buildContext failed:', e.message); }

  const systemPrompt = build7StepPrompt(contextData, intent);
  const recentHistory = history.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }));

  let aiText = '';
  let usedEngine = '';

  const toolContext = { portfolio, livePrices, usdInrRate };

  // Try 7 engines in order: NVIDIA -> Gemini -> Groq -> Claude -> OpenRouter -> Cerebras -> HuggingFace
  const engines = [
    { name: 'nvidia', fn: () => callNvidia(recentHistory, systemPrompt), available: isNvidiaAvailable },
    { name: 'gemini', fn: () => callGemini(recentHistory, systemPrompt, 'gemini-3.5-flash', toolContext), available: isGeminiAvailable },
    { name: 'groq', fn: () => callGroq(recentHistory, systemPrompt, 'openai/gpt-oss-120b', toolContext), available: isGroqAvailable },
    { name: 'claude', fn: () => callClaude(recentHistory, systemPrompt), available: isClaudeAvailable },
    { name: 'openrouter', fn: () => callOpenRouter(recentHistory, systemPrompt, 'z-ai/glm-5.2:free', toolContext), available: isOpenRouterAvailable },
    { name: 'cerebras', fn: () => callCerebras(recentHistory, systemPrompt), available: isCerebrasAvailable },
    { name: 'huggingface', fn: () => callHuggingFace(recentHistory, systemPrompt), available: isHFAvailable },
  ];

  // Honor per-chat model selection: chosen engine first, rest as failover.
  const pref = getChatEngine(chatId);
  let orderedEngines;
  if (pref && pref !== 'auto') {
    const chosen = engines.filter(e => e.name === pref);
    const rest = orderEnginesByHealth(engines.filter(e => e.name !== pref));
    orderedEngines = [...chosen, ...rest];
    console.log(`  🎛️ Model preference: ${pref} (first)`);
  } else {
    // v18: automatic mode → latency-aware smart routing
    orderedEngines = orderEnginesByHealth(engines);
  }

  for (const engine of orderedEngines) {
    try {
      if (engine.available()) {
        console.log(`  🤖 Trying ${engine.name}...`);
        const t0 = Date.now();
        aiText = await retryWithBackoff(engine.fn, 0, 500);
        recordEngineSuccess(engine.name, Date.now() - t0);
        usedEngine = engine.name;
        break;
      }
    } catch (e) {
      console.warn(`  ❌ ${engine.name} failed: ${e.message}`);
      recordEngineFailure(engine.name);
    }
  }

  // QUANT BRAIN FALLBACK — NEVER show "AI Offline"
  if (!aiText) {
    console.log('  🧠 All LLMs unavailable — using Quant Brain fallback');
    aiText = quantBrainFallback('PORTFOLIO', contextData);
    usedEngine = 'quant_brain';
  }

  // Anti-hallucination check
  // FIX H9: handle `null` return (hallucination detected) → fall back to
  // Quant Brain so the user gets deterministic data instead of fabricated LLM
  // numbers.
  const checked = antiHallucinationCheck(aiText, contextData);
  if (checked === null) {
    console.log('  🧠 Anti-hallucination fallback → Quant Brain');
    aiText = quantBrainFallback('PORTFOLIO', contextData);
    usedEngine = 'quant_brain_hallucination_fallback';
  } else {
    aiText = checked;
  }

  let safeText = aiText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  safeText = safeText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  safeText = safeText.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\*(.+?)\*/g,'<i>$1</i>').replace(/`(.+?)`/g,'<code>$1</code>');

  history.push({ role: 'assistant', content: aiText });
  if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY);

  const engineLabels = {
    nvidia: '🟢 NVIDIA GPT-OSS 120B', gemini: '🔷 Gemini 3.5 Flash', groq: '🧠 Groq GPT-OSS 120B', claude: '🟣 Claude Sonnet 5',
    openrouter: '🔶 OpenRouter GLM-5.2', cerebras: '🧠 Cerebras GPT-OSS 120B', huggingface: '🤗 HuggingFace Qwen3 235B',
    quant_brain: '📊 Quant Brain',
  };
  const label = engineLabels[usedEngine] || usedEngine;
  return `${label} | ${intent} | LIVE\n\n${safeText}`;
}

// ============================================
// MULTI-MODEL AI CONSENSUS VOTING
// Queries 3 models in parallel, calculates agreement %, synthesizes output
// ============================================
export async function chatWithConsensus(chatId, userMessage, portfolio, livePrices, usdInrRate) {
  let contextData = '';
  try { contextData = await buildContext(portfolio, livePrices, usdInrRate, userMessage); }
  catch {}

  const systemPrompt = `You are an elite quantitative consensus engine.
Context: ${contextData.substring(0, 3000)}
Task: Give a definitive stance (BULLISH / BEARISH / NEUTRAL), specific price levels/targets, key technical reason, and risk parameters in concise Hinglish.`;

  const models = [
    { name: 'Gemini 3.5 Flash', fn: () => callGemini([{ role: 'user', content: userMessage }], systemPrompt), available: isGeminiAvailable },
    { name: 'Groq GPT-OSS 120B', fn: () => callGroq([{ role: 'user', content: userMessage }], systemPrompt), available: isGroqAvailable },
    { name: 'Cerebras GPT-OSS 120B', fn: () => callCerebras([{ role: 'user', content: userMessage }], systemPrompt), available: isCerebrasAvailable },
    { name: 'Claude Sonnet 5', fn: () => callClaude([{ role: 'user', content: userMessage }], systemPrompt), available: isClaudeAvailable },
  ];

  const results = await Promise.allSettled(
    models.map(async (m) => {
      if (!m.available()) throw new Error(`${m.name} unavailable`);
      const start = Date.now();
      const text = await m.fn();
      if (!text) throw new Error(`${m.name} empty response`);

      const lower = text.toLowerCase();
      let stance = 'NEUTRAL';
      if (lower.includes('bullish') || lower.includes('buy') || lower.includes('accumulate')) stance = 'BULLISH';
      else if (lower.includes('bearish') || lower.includes('sell') || lower.includes('avoid')) stance = 'BEARISH';

      return {
        model: m.name,
        stance,
        response: text,
        latencyMs: Date.now() - start
      };
    })
  );

  const successful = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length === 0) {
    return `⚠️ Consensus engines unavailable — falling back to single AI:\n\n` + (await chatWithAI(chatId, userMessage, portfolio, livePrices, usdInrRate));
  }

  const stanceCounts = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const s of successful) stanceCounts[s.stance] = (stanceCounts[s.stance] || 0) + 1;

  let consensusStance = 'NEUTRAL';
  let maxCount = 0;
  for (const [st, cnt] of Object.entries(stanceCounts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      consensusStance = st;
    }
  }

  const agreementPct = Math.round((maxCount / successful.length) * 100);
  const stanceEmoji = consensusStance === 'BULLISH' ? '🟢' : consensusStance === 'BEARISH' ? '🔴' : '🟡';

  let safeText = (successful[0]?.response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  safeText = safeText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  safeText = safeText.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\*(.+?)\*/g,'<i>$1</i>').replace(/`(.+?)`/g,'<code>$1</code>');

  const modelsList = successful.map(s => `• <b>${s.model}</b>: ${s.stance === 'BULLISH' ? '🟢 Bullish' : s.stance === 'BEARISH' ? '🔴 Bearish' : '🟡 Neutral'} (${s.latencyMs}ms)`).join('\n');

  return `🤝 <b>AI MULTI-MODEL CONSENSUS: ${stanceEmoji} ${consensusStance}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Agreement:</b> ${agreementPct}% (${maxCount}/${successful.length} Engines Agree)
👥 <b>Voting Engines:</b>
${modelsList}

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>Synthesized Analysis:</b>
${safeText}`;
}

// ============================================
// MULTI-MODAL VISION: Chart / Screenshot Technical Analysis
// ============================================
export async function analyzeChartImage(base64Image, caption = '', mimeType = 'image/jpeg') {
  if (!isGeminiAvailable()) {
    throw new Error('Gemini Vision API key is not configured');
  }

  const prompt = caption || 'Analyze this financial trading chart in detail. Identify the symbol/asset, current trend direction, key horizontal support and resistance zones, candlestick price action patterns, technical indicators, and provide an actionable setup with exact Entry, Stop Loss, and Target 1 & Target 2 with Risk-to-Reward ratio in simple Hinglish.';

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64Image } }
      ]
    }]
  };

  let url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`;
  let res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });

  if (!res.ok && res.status === 404) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000)
    });
  }

  if (!res.ok) {
    throw new Error(`Gemini Vision API error (${res.status})`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No analysis generated from image');

  let safeText = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  safeText = safeText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  safeText = safeText.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\*(.+?)\*/g,'<i>$1</i>').replace(/`(.+?)`/g,'<code>$1</code>');

  return `📸 <b>CHART VISION TECHNICAL ANALYSIS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Gemini 3.5 Multi-Modal Vision</i>

${safeText}`;
}

export function clearChatHistory(chatId) {
  chatHistory.delete(chatId);
  return '🧹 Chat history cleared!';
}

export function getAIHealthStatus() {
  return {
    gemini: { available: isGeminiAvailable(), health: engineHealth.gemini },
    groq: { available: isGroqAvailable(), health: engineHealth.groq },
    claude: { available: isClaudeAvailable(), health: engineHealth.claude },
    openrouter: { available: isOpenRouterAvailable(), health: engineHealth.openrouter },
    cerebras: { available: isCerebrasAvailable(), health: engineHealth.cerebras },
    huggingface: { available: isHFAvailable(), health: engineHealth.huggingface },
  };
}

// ============================================
// 🎤 VOICE TRANSCRIPTION (#5 voice notes)
// Groq Whisper large-v3 (fast + cheap, the bot's own key) →
// Gemini inline-audio fallback (the bot's primary key).
// Never hallucinates a transcript — every engine failure is
// surfaced honestly to the caller.
// ============================================
export async function transcribeVoice(base64Audio, { mimeType = 'audio/ogg' } = {}) {
  const b64 = String(base64Audio || '').replace(/^data:[^,]+,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('empty voice payload');

  // 1) Groq Whisper large-v3 — the default STT engine
  if (isGroqAvailable()) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mimeType || 'audio/ogg' }), 'voice.ogg');
      fd.append('model', 'whisper-large-v3');
      fd.append('response_format', 'json');
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: fd,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const text = String(j?.text || '').trim();
        if (text) { recordEngineSuccess('groq'); return { ok: true, text, engine: 'groq-whisper-large-v3' }; }
      } else {
        recordEngineFailure('groq');
        console.warn(`[voice] groq whisper HTTP ${res.status} — trying fallback`);
      }
    } catch (e) {
      recordEngineFailure('groq');
      console.warn('[voice] groq whisper failed:', e?.message);
    }
  }

  // 2) Gemini inline-audio fallback — same multimodal path
  //    analyzeChartImage uses for images, just with audio parts.
  if (isGeminiAvailable()) {
    try {
      const payload = {
        contents: [{
          parts: [
            { text: 'Transcribe this voice note exactly. Reply with ONLY the spoken text — no labels, no commentary, no translation notes. Hinglish stays Hinglish.' },
            { inlineData: { mimeType: mimeType || 'audio/ogg', data: b64 } },
          ],
        }],
      };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        const text = String(j?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        if (text) { recordEngineSuccess('gemini'); return { ok: true, text, engine: 'gemini-inline-audio' }; }
      } else {
        recordEngineFailure('gemini');
      }
    } catch (e) {
      recordEngineFailure('gemini');
      console.warn('[voice] gemini fallback failed:', e?.message);
    }
  }

  throw new Error('voice transcription unavailable — GROQ_API_KEY / GEMINI_KEY check karo');
}
