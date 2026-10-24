// ============================================================
// test/routeMount.test.ts — Route-mounting regression guard
// ------------------------------------------------------------
// Static analysis test: reads server/index.js source and verifies
// that all critical route modules are imported AND registered.
// This catches the exact class of regression that broke the
// Intraday tab — a route import/registration being silently
// removed during a refactor without any unit test noticing.
//
// WHY static analysis instead of supertest?
// server/index.js has heavy boot side-effects (cron jobs,
// Telegram bot fork, port binding, durable restore). Importing
// it in a test would need extensive mocking and still risk
// flaky port collisions. Reading the source text is fast,
// deterministic, and catches the failure mode perfectly.
// ============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const INDEX_PATH = path.resolve(__dirname, '..', 'server', 'index.js');
const indexSource = fs.readFileSync(INDEX_PATH, 'utf-8');

describe('Route-mounting regression guard (server/index.js)', () => {
  describe('root async guard', () => {
    it('wraps the ROOT app so direct app.get/post async handlers cannot hang', () => {
      expect(indexSource).toContain('const app = withAsyncRouteGuard(express(),');
      expect(indexSource).toContain('const routesApp = app;');
    });
  });

  // ----------------------------------------------------------
  // INTRADAY DESK — 20 /api/intraday-* endpoints
  // ----------------------------------------------------------
  describe('Intraday routes', () => {
    it('imports registerIntradayRoutes from intraday/routes.js', () => {
      expect(indexSource).toMatch(
        /import\s*\{[^}]*registerIntradayRoutes[^}]*\}\s*from\s*['"]\.\/intraday\/routes\.js['"]/
      );
    });

    it('calls registerIntradayRoutes(routesApp, { ... }) — v21.3.0 async-guard proxy', () => {
      expect(indexSource).toMatch(/registerIntradayRoutes\s*\(\s*routesApp\s*,/);
    });

    it('passes all required deps to registerIntradayRoutes', () => {
      // Extract the registerIntradayRoutes call block
      const callMatch = indexSource.match(
        /registerIntradayRoutes\s*\(\s*routesApp\s*,\s*\{([^}]+)\}\s*\)/s
      );
      expect(callMatch).toBeTruthy();
      const depsBlock = callMatch![1];

      const requiredDeps = [
        'fetchGrowwNseQuote',
        'fetchCoinDcxTickers',
        'KEYS',
        'OPENAI_COMPAT',
        'TG',
        'escapeHtml',
        'jsonError',
      ];
      for (const dep of requiredDeps) {
        expect(depsBlock, `missing dep: ${dep}`).toContain(dep);
      }
    });
  });

  // ----------------------------------------------------------
  // AI TRADING — 39 /api/ai/* endpoints
  // ----------------------------------------------------------
  describe('AI Trading routes', () => {
    it('imports registerAITradingRoutes from ai/routes.js', () => {
      expect(indexSource).toMatch(
        /import\s*\{[^}]*registerAITradingRoutes[^}]*\}\s*from\s*['"]\.\/ai\/routes\.js['"]/
      );
    });

    it('calls registerAITradingRoutes(routesApp, { ... }) — v21.3.0 async-guard proxy', () => {
      expect(indexSource).toMatch(/registerAITradingRoutes\s*\(\s*routesApp\s*,/);
    });
  });

  // ----------------------------------------------------------
  // MCP (INDMoney + CoinDCX + Tapetide) — /api/mcp/* endpoints
  // ----------------------------------------------------------
  describe('MCP routes', () => {
    it('imports indmMcpRoutes from mcp/routes.js', () => {
      expect(indexSource).toMatch(
        /import\s+\w+\s+from\s*['"]\.\/mcp\/routes\.js['"]/
      );
    });

    it('mounts MCP router via app.use()', () => {
      expect(indexSource).toMatch(/app\.use\s*\(\s*indmMcpRoutes\s*\)/);
    });
  });
});
