# Helix Watchlist

Static simulation dashboard for a capped research watchlist (max 20 tickers).

**This is research / paper simulation only.** Action labels (Buy / Hold / Sell / Watch / Trim) are annotations — they do not place or imply brokerage orders. Paper trades stay in your browser’s localStorage. There is no broker integration and no live order path in this repo.

## Live site

https://rlander1.github.io/helix-watchlist/

## Local Operate (optional)

On a machine with the full Helix workspace:

```bash
cd artifacts/dashboard
python3 preview_server.py
# open http://127.0.0.1:8765/
```

The local preview server proxies Yahoo Finance for same-origin refresh. GitHub Pages has no proxy; the UI falls back to Yahoo CORS or keeps last file prices from `docs/watchlist.json` (never invents prices).

## License / use

Personal research dashboard. Not investment advice.

## How quotes update on GitHub Pages

The in-browser **Refresh quotes** button prefers a same-origin `/api/quote` proxy that only exists on local Operate (`preview_server.py` at http://127.0.0.1:8765/). On GitHub Pages that proxy is absent, so the browser falls back to Yahoo CORS — which often fails. When it fails, the UI **keeps file prices** from `docs/watchlist.json` and warns (it never invents prices).

**Weekday quote refresh (GitHub Action):** `.github/workflows/refresh-watchlist-quotes.yml` runs on weekdays at **9:30 AM ET** and **4:00 PM ET** (cron `30 13 * * 1-5` and `0 20 * * 1-5` UTC, aligned to Eastern Daylight Time). It also supports **Run workflow** (`workflow_dispatch`). The Action runs `scripts/refresh_watchlist_quotes.py`, which updates `docs/watchlist.json` from Yahoo’s public chart API, commits, and pushes to `main` so Pages rebuilds. Failed symbols keep prior values and are marked `quote_status: stale`. No secrets beyond `GITHUB_TOKEN`; simulation / research only.

