"""
META-ENSEMBLE RETRAIN SCHEDULER (Upgrade 4)
------------------------------------------------
Weekly retrain of the stacked meta-learner so it never goes stale
as new market data lands. Stale training data = silently degraded
accuracy — the exact thing the meta layer exists to fix.

Run modes:
  1. Standalone daemon (default):
       python -m models.retrain_scheduler
     Retrains immediately on boot, then every RETRAIN_INTERVAL_HOURS
     (default 168 = weekly). APScheduler when available, else a
     plain sleep-loop (zero hard deps).
  2. One-shot (Render cron / CI):
       python -m models.retrain_scheduler --once
  3. Import + call:
       from models.retrain_scheduler import retrain_now
       result = retrain_now()

Environment:
  META_RETRAIN_INTERVAL_HOURS  (default 168 — weekly)
  META_RETRAIN_FETCH           ('true' = re-fetch fresh OHLCV first)
"""

import os
import sys
import time
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [mmeta-retrain] %(message)s")
logger = logging.getLogger("meta-retrain")

RETRAIN_INTERVAL_HOURS = float(os.getenv("META_RETRAIN_INTERVAL_HOURS", "168") or 168)


def retrain_now(fetch_fresh: bool = False) -> dict:
    """One full retrain cycle. Returns the train_meta_ensemble dict
    (or an error dict — never raises: a failed retrain keeps the
    previous pkl in place, which is exactly the graceful degrade
    the inference side expects)."""
    try:
        if fetch_fresh or os.getenv("META_RETRAIN_FETCH", "").strip().lower() in ("1", "true", "on", "yes"):
            logger.info("fetching fresh OHLCV data…")
            try:
                # FIX v18.1: fetch_data exposes fetch_all_symbols (not fetch_all) —
                # the old name raised ImportError so retrain NEVER fetched fresh data.
                from pipeline.fetch_data import fetch_all_symbols
                fetch_all_symbols()
            except Exception as e:  # noqa: BLE001 — fetch is best-effort
                logger.warning("fresh fetch failed (%s) — training on stored data", e)

        from models.train_signal import train_meta_ensemble
        result = train_meta_ensemble()
        if result.get("error"):
            logger.warning("retrain skipped: %s", result["error"])
        else:
            logger.info(
                "retrained: %s samples, walk-forward F1 %s → %s",
                result.get("samples"), result.get("avg_weighted_f1"), result.get("artifact"),
            )
        return result
    except Exception as e:  # noqa: BLE001 — scheduler must never die
        logger.error("retrain failed: %s", e)
        return {"error": str(e)}


def _schedule_loop():
    interval_s = RETRAIN_INTERVAL_HOURS * 3600
    try:
        from apscheduler.schedulers.blocking import BlockingScheduler

        sched = BlockingScheduler(timezone="UTC")
        sched.add_job(
            retrain_now, "interval", hours=RETRAIN_INTERVAL_HOURS,
            id="meta-ensemble-retrain", next_run_time=None, max_instances=1,
            kwargs={"fetch_fresh": True},
        )
        logger.info("APScheduler armed — retrain every %sh", RETRAIN_INTERVAL_HOURS)
        retrain_now()  # immediate boot train
        sched.start()
    except ImportError:
        logger.info("APScheduler not installed — plain loop every %sh", RETRAIN_INTERVAL_HOURS)
        retrain_now()
        while True:
            time.sleep(interval_s)
            retrain_now(fetch_fresh=True)


def start_retrain_daemon() -> bool:
    """ACCURACY-PLAN PHASE 5: the non-blocking background-worker mode.
    The FastAPI service (app/main.py) calls this at startup — the weekly
    retrain then rides the SAME container (Render single-service deploy),
    no separate cron service needed. META_RETRAIN_DAEMON=false disables
    (e.g. when a dedicated `python -m models.retrain_scheduler --once`
    cron job owns the cadence instead). A failed retrain NEVER kills the
    API — the thread is a daemon and retrain_now itself never raises.
    """
    import threading
    flag = os.getenv("META_RETRAIN_DAEMON", "true").strip().lower()
    if flag in ("0", "false", "off", "no"):
        logger.info("retrain daemon disabled (META_RETRAIN_DAEMON=false)")
        return False
    if os.getenv("META_RETRAIN_ON_BOOT", "true").strip().lower() in ("0", "false", "off", "no"):
        # skip the immediate boot-train; only the weekly interval arms
        threading.Thread(
            target=lambda: (time.sleep(60), _schedule_loop_bootless()),
            name="meta-retrain", daemon=True,
        ).start()
        logger.info("meta-retrain daemon armed (weekly only — boot train skipped)")
        return True
    t = threading.Thread(target=_schedule_loop, name="meta-retrain", daemon=True)
    t.start()
    logger.info("meta-retrain daemon thread started (boot train + every %sh)", RETRAIN_INTERVAL_HOURS)
    return True


def _schedule_loop_bootless():
    """The interval loop without the immediate boot-train (for containers
    that redeploy frequently and only want the weekly cadence)."""
    interval_s = RETRAIN_INTERVAL_HOURS * 3600
    while True:
        time.sleep(interval_s)
        retrain_now(fetch_fresh=True)


if __name__ == "__main__":
    if "--once" in sys.argv:
        print(retrain_now(fetch_fresh=True))
    else:
        _schedule_loop()
