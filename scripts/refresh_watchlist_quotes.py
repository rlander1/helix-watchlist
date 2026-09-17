#!/usr/bin/env python3
"""Refresh docs/watchlist.json last/change/change_pct from Yahoo public chart API.

Never invents prices. On fetch failure, leaves prior values and marks the ticker stale.
Simulation / research dashboard only — no broker.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
UA = (
    "Mozilla/5.0 (compatible; HelixWatchlistQuoteRefresh/1.0; "
    "+https://github.com/rlander1/helix-watchlist)"
)
ET = ZoneInfo("America/New_York")


def fetch_quote(symbol: str) -> dict:
    """Return {last, change, change_pct, currency, previous_close} from Yahoo chart meta."""
    url = YAHOO.format(symbol=urllib.parse.quote(symbol, safe=""))
    url += "?range=5d&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        err = (payload.get("chart") or {}).get("error")
        raise RuntimeError(f"no chart result: {err!r}")
    meta = result[0].get("meta") or {}
    last = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose")
    if prev is None:
        prev = meta.get("previousClose")
    if last is None or prev is None:
        raise RuntimeError(
            f"missing price fields last={last!r} prev={prev!r}"
        )
    last_f = float(last)
    prev_f = float(prev)
    change = last_f - prev_f
    change_pct = (change / prev_f) * 100.0 if prev_f else 0.0
    currency = meta.get("currency") or "USD"
    return {
        "last": round(last_f, 4),
        "change": round(change, 4),
        "change_pct": round(change_pct, 4),
        "currency": currency,
        "previous_close": round(prev_f, 4),
    }


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    path = root / "docs" / "watchlist.json"
    if not path.is_file():
        print(f"ERROR: missing {path}", file=sys.stderr)
        return 2

    data = json.loads(path.read_text(encoding="utf-8"))
    tickers = data.get("tickers")
    if not isinstance(tickers, list):
        print("ERROR: watchlist.json has no tickers list", file=sys.stderr)
        return 2

    now_et = datetime.now(ET)
    now_iso = now_et.isoformat(timespec="seconds")
    ok: list[str] = []
    failed: list[dict] = []

    for t in tickers:
        if not isinstance(t, dict):
            continue
        symbol = str(t.get("symbol") or "").strip()
        if not symbol:
            continue
        try:
            q = fetch_quote(symbol)
            t["last"] = q["last"]
            t["change"] = q["change"]
            t["change_pct"] = q["change_pct"]
            if q.get("currency"):
                t["currency"] = q["currency"]
            t["quote_status"] = "ok"
            t.pop("quote_note", None)
            t["previous_close"] = q["previous_close"]
            ok.append(symbol)
            print(f"OK  {symbol}: last={q['last']} change_pct={q['change_pct']}")
        except Exception as exc:  # noqa: BLE001 — keep prior prices
            t["quote_status"] = "stale"
            t["quote_note"] = f"Yahoo fetch failed; kept prior last={t.get('last')!r}: {exc}"
            failed.append({"symbol": symbol, "error": str(exc)})
            print(f"STALE {symbol}: {exc}", file=sys.stderr)

    data["quotes_refreshed_at"] = now_iso
    data["quote_refresh"] = {
        "at": now_iso,
        "source": "yahoo_chart_public",
        "ok": ok,
        "failed": [f["symbol"] for f in failed],
        "failed_detail": failed,
    }
    # Bump updated_at only when at least one live quote landed (never fake a book refresh).
    if ok:
        data["updated_at"] = now_iso

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {path} — ok={len(ok)} stale={len(failed)}")
    # Exit 0 even with partial stale so the Action can still commit successful updates.
    # Exit 1 only if every ticker failed (nothing useful to push).
    if tickers and not ok:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
