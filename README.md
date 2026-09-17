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
