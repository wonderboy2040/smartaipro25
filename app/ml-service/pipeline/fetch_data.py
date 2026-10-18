import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.config import (
    ALL_SYMBOLS, OHLCV_STORE_PATH, YAHOO_PERIOD, YAHOO_INTERVAL,
    USE_YFINANCE, USE_BINANCE, BINANCE_BASE
)


def fetch_ohlcv_yfinance(symbol: str, period: str = YAHOO_PERIOD, interval: str = YAHOO_INTERVAL) -> Optional[pd.DataFrame]:
    try:
        import yfinance as yf
        df = yf.download(symbol, period=period, interval=interval, auto_adjust=True, progress=False)
        if df is None or df.empty:
            return None
        df = df.rename(columns=str.lower)
        if "adj close" in df.columns:
            df = df.rename(columns={"adj close": "adj_close"})
        df = df[["open", "high", "low", "close", "volume"]].copy()
        df.index = pd.to_datetime(df.index)
        df.index = df.index.tz_localize(None)
        df["symbol"] = symbol
        df["date"] = df.index.date
        return df.dropna()
    except Exception as e:
        print(f"  yfinance failed for {symbol}: {e}")
        return None


def fetch_ohlcv_crypto(symbol: str, days: int = 3650) -> Optional[pd.DataFrame]:
    clean = symbol.replace("-USD", "")
    pair = f"{clean}USDT"
    try:
        end_ms = int(datetime.now().timestamp() * 1000)
        start_ms = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
        all_data = []
        current_start = start_ms
        while current_start < end_ms:
            url = f"{BINANCE_BASE}/klines?symbol={pair}&interval=1d&startTime={current_start}&limit=1000"
            import requests
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                break
            data = resp.json()
            if not data:
                break
            for k in data:
                all_data.append({
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[5]),
                    "symbol": symbol,
                    "date": pd.to_datetime(k[0], unit="ms").date(),
                })
            current_start = data[-1][0] + 86400000
        if not all_data:
            return None
        df = pd.DataFrame(all_data)
        df["date"] = pd.to_datetime(df["date"])
        df = df.set_index("date")
        return df[["open", "high", "low", "close", "volume", "symbol"]].dropna()
    except Exception as e:
        print(f"  Binance failed for {symbol}: {e}")
        return None


def fetch_all_symbols(symbols: list = None, progress: bool = True) -> pd.DataFrame:
    if symbols is None:
        symbols = ALL_SYMBOLS

    store_path = OHLCV_STORE_PATH
    existing = None
    if store_path.exists():
        try:
            existing = pd.read_parquet(store_path)
            if progress:
                print(f"  Loaded existing store: {existing['symbol'].nunique()} symbols")
        except Exception:
            existing = None

    new_frames = []
    for i, sym in enumerate(symbols):
        if progress:
            print(f"  [{i+1}/{len(symbols)}] Fetching {sym}...")
        df = None
        if "USD" in sym and USE_BINANCE:
            df = fetch_ohlcv_crypto(sym)
        elif USE_YFINANCE:
            df = fetch_ohlcv_yfinance(sym)
        if df is not None and not df.empty:
            new_frames.append(df)

    if not new_frames and existing is not None:
        return existing

    if new_frames:
        new_data = pd.concat(new_frames, ignore_index=False)
        if existing is not None:
            combined = pd.concat([existing, new_data], ignore_index=True)
            combined = combined.drop_duplicates(subset=["symbol", "date"], keep="last")
            combined = combined.sort_values(["symbol", "date"]).reset_index(drop=True)
        else:
            combined = new_data.reset_index(drop=True)
        combined.to_parquet(store_path, index=False)
        if progress:
            print(f"  Saved: {combined['symbol'].nunique()} symbols, {len(combined)} rows")
        return combined

    return existing if existing is not None else pd.DataFrame()


def load_ohlcv() -> Optional[pd.DataFrame]:
    store_path = OHLCV_STORE_PATH
    if not store_path.exists():
        return None
    try:
        return pd.read_parquet(store_path)
    except Exception:
        return None


if __name__ == "__main__":
    print("=== Fetching OHLCV Data ===")
    df = fetch_all_symbols()
    # FIX: fetch_all_symbols can return None or empty DataFrame when
    # yfinance/Binance are down — guard before accessing columns.
    if df is None or df.empty or "symbol" not in df.columns:
        print("No data fetched — upstream APIs may be down.")
        raise SystemExit(1)
    print(f"\nDone: {df['symbol'].nunique()} symbols, {len(df)} rows total")
    print(f"Date range: {df['date'].min()} to {df['date'].max()}")
