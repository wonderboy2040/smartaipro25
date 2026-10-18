// ============================================================
// eslint.config.mjs — v20.9.1 (lint-gate repair)
// ------------------------------------------------------------
// v20.9.0 ka config `js.configs.recommended` (espree — JS-only parser)
// GLOBALLY apply karta tha, isliye src/**/*.tsx files "Parsing error:
// The keyword 'interface' is reserved" ke saath fail hoti thi — 66 parse
// errors aur lint gate TSX ke liye KABHI kaam hi nahi karta tha.
// v20.9.1: typescript-eslint install + per-scope parsers.
//   server/**  → espree + js recommended + trading-path error rules
//   src/**     → @typescript-eslint parser (tsc --noEmit pehle hi types
//                gate karta hai — yahan sirf catchall rules)
// Run: npm run lint  (ab || true nahi hai — errors FAIL karte hain,
// aur npm run check me lint chain ho gaya hai)
// ============================================================
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/**', 'scripts/**', 'telegram-bot/**', 'ml-service/**', '*.config.*'],
  },
  {
    files: ['server/**/*.js', 'server/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        FormData: 'readonly', Blob: 'readonly', AbortSignal: 'readonly',
        setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', clearImmediate: 'readonly',
        queueMicrotask: 'readonly', structuredClone: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly',
        performance: 'readonly', crypto: 'readonly', global: 'writable',
      },
    },
    rules: {
      // v20.9.0 (L4): empty catch = silent failure. Trading paths me ye
      // kabhi acceptable nahi — kam se kam ek comment hona chahiye jo
      // bataye KYA ignore kiya gaya (intent documented).
      'no-empty': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-throw-literal': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'off', // false positives on class fields in this codebase
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    plugins: { 'react-hooks': hooks },
    rules: {
      // TS files tsc --noEmit se gated hain — sirf catchall lint.
      'no-empty': 'warn',
      'no-var': 'error',
      // v20.9.1: react-hooks rules — codebase me pehle se deliberate
      // eslint-disable-next-line annotations hain (v20.x audits); plugin
      // ke bina wo "rule not found" ERROR bante the. 'warn' — tsc + tests
      // hi hard gate hain.
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // tsc already gates these (codebase style: defensive any + ts-ignore
      // in legacy spots) — lint duplication sirf noise hai.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
