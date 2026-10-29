@echo off
REM v20.9.0: UTF-8 console (Hindi text readable on default OEM codepages)
chcp 65001 >nul
setlocal enableextensions
REM ============================================================
REM SmartAI PRO v21.27.2 - ANTI-FREEZE WATCHDOG (recommended launcher)
REM
REM KYA HAI: ye SUPERVISOR hai. Server ko child banake chalata hai
REM aur har 20s /api/ping probe karta hai APNE event-loop se.
REM Server HANG ho jaye (process zinda, site atki) -> force-kill
REM + auto-restart. CRASH ho jaye -> backoff auto-restart.
REM Yahi "site atak rahi hai" ka complete fix hai.
REM
REM v20.1: node_modules missing ho to supervisor KHUD npm install
REM chala dega (pehli baar, internet chahiye) - fresh installs bhi
REM seedha chalega.
REM
REM v20.8.3 ALWAYS-LATEST: dist/ (frontend build) STALE ya missing
REM ho to supervisor KHUD npm install + vite build chala dega. Matlab:
REM naya code zip/copy se update karo -> Watchdog chalao -> FRESH
REM site guaranteed. "purana version serve ho raha hai" bug khatam.
REM (Pehli baar / build ke waqt internet chahiye, 2-5 min.)
REM
REM v20.9.0 SINGLE-INSTANCE: dusra watchdog double-click karo to wo khud
REM band ho jayega (lock file + port check) - node_modules corruption
REM (do npm install ek saath) aur masked crash-loop dono khatam.
REM
REM v21.14 LAYA REMOVED: Laya local AI model permanently retire ho
REM chuka hai (sidecar + autolink + start-laya.cmd sab hata diye gaye).
REM Ye watchdog ab SIRF site child manage karta hai - 10048 bind-war
REM class ke bugs ka poora surface hi khatam.
REM
REM USE: double-click karo, window khuli/minimized rakho.
REM      startai.exe iske SAATH mat chalao (port 8080 clash).
REM      Band karna = Ctrl+C ya window close.
REM ============================================================
title SmartAI PRO v21.27.2 - Anti-Freeze Watchdog
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if not defined NODE_EXE (
  echo.
  echo [ERROR] node nahi mila - PATH me nahi, app folder me bhi nahi.
  echo startai.exe use karo - uske andar bundled node hai.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  SMARTAI PRO v21.27.2 - ANTI-FREEZE SUPERVISOR
echo  Site   : localhost:8080
echo  Engine : %NODE_EXE%
echo  Hang   : FREEZE detect - force-kill + restart
echo  Crash  : backoff restart - site kabhi down nahi
echo  Deps   : missing ho to auto npm-install (v20.3)
echo  Build  : dist/ stale/mismatch ho to AUTO npm install
echo          + vite build (v20.8.3+ - latest code guaranteed)
echo ============================================================
echo.

"%NODE_EXE%" server\supervisor.js
echo.
echo [watchdog] supervisor band hua. Dobara chalane ke liye
echo is file ko phir se double-click karo.
pause
