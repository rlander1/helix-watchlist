#!/usr/bin/env python3
"""Refresh docs/watchlist.json quotes + docs/history/{SYMBOL}.json from Yahoo.

Never invents prices. Quote failures leave prior watchlist values (stale mark).
History: skip whole symbol file if no usable range (>=2 closes); omit failed ranges.
Simulation / research only — no broker.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
UA = (
    "Mozilla/5.0 (compatible; HelixWatchlistQuoteRefresh/1.0; "
    "+https://github.com/rlander1/helix-watchlist)"
)
ET = ZoneInfo("America/New_York")

# Forge-locked range button ids → Yahoo params
HISTORY_PRESETS = [
    {"id": "1d", "yahoo_range": "1d", "interval": "5m", "trim": None},
    {"id": "5d", "yahoo_range": "5d", "interval": "15m", "trim": None},
    {"id": "10d", "yahoo_range": "1mo", "interval": "1d", "trim": 10},
    {"id": "1mo", "yahoo_range": "1mo", "interval": "1d", "trim": None},
]


def yahoo_chart(symbol: str, range_: str, interval: str) -> dict:
    url = YAHOO.format(symbol=urllib.parse.quote(symbol, safe=""))
    url += f"?range={urllib.parse.quote(range_)}&interval={urllib.parse.quote(interval)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_quote(symbol: str) -> dict:
    payload = yahoo_chart(symbol, "5d", "1d")
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
        raise RuntimeError(f"missing price fields last={last!r} prev={prev!r}")
    last_f = float(last)
    prev_f = float(prev)
    change = last_f - prev_f
    change_pct = (change / prev_f) * 100.0 if prev_f else 0.0
    return {
        "last": round(last_f, 4),
        "change": round(change, 4),
        "change_pct": round(change_pct, 4),
        "currency": meta.get("currency") or "USD",
        "previous_close": round(prev_f, 4),
    }


def series_from_payload(payload: dict, trim: int | None) -> dict | None:
    """Return timestamps/closes/last/change/change_pct or None if <2 points."""
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        return None
    r0 = result[0]
    meta = r0.get("meta") or {}
    timestamps = list(r0.get("timestamp") or [])
    quote = (r0.get("indicators") or {}).get("quote") or [{}]
    closes_raw = (quote[0] or {}).get("close") or []
    pairs = []
    for i, ts in enumerate(timestamps):
        if i >= len(closes_raw):
            break
        c = closes_raw[i]
        if c is None:
            continue
        try:
            pairs.append((int(ts), float(c)))
        except (TypeError, ValueError):
            continue
    if trim is not None and len(pairs) > trim:
        pairs = pairs[-trim:]
    if len(pairs) < 2:
        return None
    timestamps_o = [p[0] for p in pairs]
    closes_o = [round(p[1], 4) for p in pairs]
    last = closes_o[-1]
    prev = meta.get("chartPreviousClose")
    if prev is None:
        prev = meta.get("previousClose")
    change = change_pct = None
    if prev is not None:
        try:
            prev_f = float(prev)
            change = round(last - prev_f, 4)
            change_pct = round((change / prev_f) * 100.0, 4) if prev_f else 0.0
        except (TypeError, ValueError):
            pass
    return {
        "timestamps": timestamps_o,
        "closes": closes_o,
        "last": last,
        "change": change,
        "change_pct": change_pct,
    }


def write_history(symbol: str, hist_dir: Path, now_iso: str) -> bool:
    """Write docs/history/{SYMBOL}.json. Return True if file written."""
    sym = symbol.strip().upper()
    ranges_out: dict = {}
    for preset in HISTORY_PRESETS:
        try:
            payload = yahoo_chart(sym, preset["yahoo_range"], preset["interval"])
            series = series_from_payload(payload, preset["trim"])
            if not series:
                print(f"  history skip range {preset['id']}: <2 closes", file=sys.stderr)
                continue
            block = {
                "interval": preset["interval"],
                "yahoo_range": preset["yahoo_range"],
                "timestamps": series["timestamps"],
                "closes": series["closes"],
                "last": series["last"],
                "change": series["change"],
                "change_pct": series["change_pct"],
            }
            ranges_out[preset["id"]] = block
            print(f"  history {preset['id']}: {len(series['closes'])} pts last={series['last']}")
            time.sleep(0.15)
        except Exception as exc:  # noqa: BLE001
            print(f"  history skip range {preset['id']}: {exc}", file=sys.stderr)
    if not ranges_out:
        print(f"HISTORY SKIP {sym}: no usable ranges", file=sys.stderr)
        return False
    doc = {"symbol": sym, "updated_at": now_iso, "ranges": ranges_out}
    hist_dir.mkdir(parents=True, exist_ok=True)
    out = hist_dir / f"{sym}.json"
    out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    return True


def refresh_quotes(data: dict, now_iso: str) -> tuple[list[str], list[dict]]:
    ok: list[str] = []
    failed: list[dict] = []
    tickers = data.get("tickers") or []
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
            time.sleep(0.15)
        except Exception as exc:  # noqa: BLE001
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
    if ok:
        data["updated_at"] = now_iso
    return ok, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--skip-watchlist",
        action="store_true",
        help="Only write docs/history/*.json; do not modify watchlist.json",
    )
    ap.add_argument(
        "--skip-history",
        action="store_true",
        help="Only refresh watchlist.json quotes",
    )
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    path = root / "docs" / "watchlist.json"
    hist_dir = root / "docs" / "history"
    if not path.is_file():
        print(f"ERROR: missing {path}", file=sys.stderr)
        return 2

    data = json.loads(path.read_text(encoding="utf-8"))
    tickers = data.get("tickers")
    if not isinstance(tickers, list):
        print("ERROR: watchlist.json has no tickers list", file=sys.stderr)
        return 2

    now_iso = datetime.now(ET).isoformat(timespec="seconds")
    symbols = [
        str(t.get("symbol") or "").strip().upper()
        for t in tickers
        if isinstance(t, dict) and t.get("symbol")
    ]

    quote_ok: list[str] = []
    if not args.skip_watchlist:
        quote_ok, failed = refresh_quotes(data, now_iso)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {path} — ok={len(quote_ok)} stale={len(failed)}")
    else:
        print("Skipping watchlist.json update (--skip-watchlist)")

    hist_ok = 0
    if not args.skip_history:
        for sym in symbols:
            if write_history(sym, hist_dir, now_iso):
                hist_ok += 1
            time.sleep(0.2)
        print(f"History files written: {hist_ok}/{len(symbols)}")
    else:
        print("Skipping history (--skip-history)")

    if not args.skip_watchlist and tickers and not quote_ok and not args.skip_history and hist_ok == 0:
        return 1
    if args.skip_watchlist and not args.skip_history and hist_ok == 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
