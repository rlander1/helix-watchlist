# Chart history files (Harbor Action)

Published on Pages as same-origin `history/{SYMBOL}.json` (repo path: `docs/history/{SYMBOL}.json`).

`app.js` on github.io loads these first. It never calls `/api/chart` on Pages.

## Exact JSON shape (preferred)

```json
{
  "symbol": "NVDA",
  "updated_at": "2026-09-17T19:16:37-04:00",
  "ranges": {
    "1d": {
      "interval": "5m",
      "yahoo_range": "1d",
      "timestamps": [1726612500, 1726612800],
      "closes": [120.5, 120.75],
      "last": 120.75,
      "change": 0.5,
      "change_pct": 0.42
    },
    "5d": {
      "interval": "15m",
      "yahoo_range": "5d",
      "timestamps": [],
      "closes": [],
      "last": null,
      "change": null,
      "change_pct": null
    },
    "10d": {
      "interval": "1d",
      "yahoo_range": "1mo",
      "timestamps": [],
      "closes": [],
      "last": null,
      "change": null,
      "change_pct": null
    },
    "1mo": {
      "interval": "1d",
      "yahoo_range": "1mo",
      "timestamps": [],
      "closes": [],
      "last": null,
      "change": null,
      "change_pct": null
    }
  }
}
```

### Field rules
- `symbol`: uppercase ticker matching filename (`NVDA.json`).
- `updated_at`: ISO-8601 when the Action wrote the file.
- `ranges` keys **must** be exactly: `1d`, `5d`, `10d`, `1mo` (app range button ids).
- `timestamps`: Unix **seconds** (not ms), parallel to `closes`.
- `closes`: numbers only; drop nulls when writing (app also skips nulls).
- Need **≥ 2** valid close points per range or that range is treated as missing.
- `last` / `change` / `change_pct`: optional; if omitted, chart uses last close.
- Never invent prices. On Yahoo failure for a symbol, **skip the whole file** (or omit that range key) — do not fabricate series.
- Filename: `docs/history/{SYMBOL}.json` (uppercase symbol).

### Yahoo fetch mapping (server-side Action)
| range id | Yahoo `range` | Yahoo `interval` | notes |
|----------|---------------|------------------|-------|
| 1d       | 1d            | 5m               | |
| 5d       | 5d            | 15m              | |
| 10d      | 1mo           | 1d               | keep last ~10 sessions |
| 1mo      | 1mo           | 1d               | |

### Alternate accepted shape
If easier, each `ranges[id]` may be a raw Yahoo `chart` payload (`{ "chart": { "result": [...] } }`) or `{ "yahoo": { "chart": ... } }`. Prefer the simplified `timestamps`/`closes` shape above.

### After write
Redeploy `docs/history/*.json` with `app.js`. Weekday quote Action + Refresh-triggered Action should refresh these files for every watchlist symbol.
