@echo off
REM ============================================================
REM Run-Full-Diagnostic.bat — SmartAI Pro FULL SITE DIAGNOSTIC
REM ------------------------------------------------------------
REM Double-click karo — poore site ka health check chalega:
REM   A. Environment & Files (env keys, deps, dist, data)
REM   B. Code Integrity (syntax, versions, API wiring)
REM   C. Live Runtime (server, health, 4-market signal boards,
REM      expert picks, Bot-Lab AI, websocket feeds)
REM   D. AI Confirm Layer — Jev (live status + trading-signals par effect)
REM
REM Server band ho to ye khud start karke check karta hai
REM (diagnostic ke baad band kar deta hai — watchdog apna chalega).
REM Report file: app\data\diagnostic-report-*.txt me save hoti hai.
REM
REM Options (Advanced): --quick (fast)  --markets INDIA,CRYPTO
REM ============================================================
title SmartAI Pro - Full Site Diagnostic
cd /d "%~dp0"
color 0B

where node >nul 2>nul
if errorlevel 1 (
  color 0C
  echo [FATAL] Node.js nahi mila — https://nodejs.org se install karo (LTS)
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   SmartAI Pro — FULL SITE DIAGNOSTIC TOOL
echo   Full site ke sabhi features/functions check ho rahe hain...
echo   (Cold start ho to 2-5 min lag sakte hain — board compute)
echo ============================================================
echo.

node scripts\full-diagnostic.mjs --boot %*
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
  color 0A
  echo ============================================================
  echo   RESULT: ALL SYSTEMS OK — koi issue nahi mila
  echo ============================================================
) else (
  color 0C
  echo ============================================================
  echo   RESULT: ISSUES MILE — upar [FAIL] lines padho aur fix karo
  echo   Report file app\data\ me saved hai (share kar sakte ho)
  echo ============================================================
)
echo.
echo Koi bhi key karke band karo...
pause >nul
exit /b %EXITCODE%
