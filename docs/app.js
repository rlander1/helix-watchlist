(function () {
  "use strict";

  const CAP = 20;
  const ACTIONS = ["Buy", "Hold", "Sell", "Watch", "Trim"];
  const STORAGE_KEY = "helix-watchlist-overlay-v1";
  const NOTES_KEY = "helix-watchlist-notes-v1";
  const ACTION_HISTORY_KEY = "helix-action-history";
  const ACTION_HISTORY_CAP = 500;
  const DATA_URL = "watchlist.json";
  const GH_PAT_KEY = "helix-gh-pat";
  const PENDING_KEY = "helix-pending-symbols";
  const GH_REPO = "rlander1/helix-watchlist";
  const GH_PATH = "docs/watchlist.json";
  const PAGES_WATCHLIST_URL =
    "https://rlander1.github.io/helix-watchlist/watchlist.json";
  // Prefer raw GitHub after commits — Pages CDN can lag and make Add look failed.
  const RAW_WATCHLIST_URL =
    "https://raw.githubusercontent.com/rlander1/helix-watchlist/main/docs/watchlist.json";
  let commitInFlight = false;
  const PAPER_PORTFOLIO_KEY = "helix-paper-portfolio";
  const PAPER_ORDERS_KEY = "helix-paper-orders";
  const PRICE_ALERTS_KEY = "helix-price-alerts";
  const DEFAULT_STARTING_CASH = 10000;
  const PAPER_ORDERS_CAP = 200;

  /** @type {{ id: string, label: string, range: string, interval: string, maxPoints: number|null }[]} */
  const RANGE_PRESETS = [
    { id: "1d", label: "1 day", range: "1d", interval: "5m", maxPoints: null },
    { id: "5d", label: "5 day", range: "5d", interval: "15m", maxPoints: null },
    { id: "10d", label: "10 day", range: "1mo", interval: "1d", maxPoints: 10 },
    { id: "1mo", label: "1 month", range: "1mo", interval: "1d", maxPoints: null },
  ];

  /** @type {{ updated_at: string, status: string, cap: number, horizon: string, book_usd: number, tickers: any[] }} */
  let state = {
    updated_at: "",
    status: "",
    cap: CAP,
    horizon: "",
    book_usd: 0,
    tickers: [],
  };

  let selectedSymbol = null;
  let selectedRangeId = "1d";
  let quotesCorsBlocked = false;
  let baseFromFile = null;
  /** @type {Record<string, { timestamps: number[], closes: (number|null)[], last: number|null, fetchedAt: string }>} */
  let chartCache = {};
  let chartFetchToken = 0;
  /** Last successful paint geometry + series (for hover; never invent prices). */
  let chartPlotState = null;

  const $ = (id) => document.getElementById(id);

  function setStatus(msg, kind) {
    const el = $("statusMsg");
    el.textContent = msg || "";
    el.className = "status-msg" + (kind ? " " + kind : "");
  }

  function loadOverlay() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveOverlay() {
    // Do not persist an empty ticker list over a known committed file list.
    const fileTickers =
      baseFromFile && Array.isArray(baseFromFile.tickers)
        ? baseFromFile.tickers
        : [];
    if (
      (!state.tickers || state.tickers.length === 0) &&
      fileTickers.length > 0
    ) {
      return;
    }
    const payload = {
      updated_at: state.updated_at,
      tickers: state.tickers,
      saved_at: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }


  function isLocalPreview() {
    const h = (location.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }

  function loadPendingSymbols() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map((s) => String(s).toUpperCase()) : [];
    } catch {
      return [];
    }
  }

  function savePendingSymbols(list) {
    const uniq = Array.from(
      new Set((list || []).map((s) => String(s).toUpperCase()).filter(Boolean))
    );
    localStorage.setItem(PENDING_KEY, JSON.stringify(uniq));
  }

  function markPending(symbol) {
    const list = loadPendingSymbols();
    const sym = String(symbol).toUpperCase();
    if (!list.includes(sym)) list.push(sym);
    savePendingSymbols(list);
  }

  function clearPending(symbol) {
    const sym = String(symbol).toUpperCase();
    savePendingSymbols(loadPendingSymbols().filter((s) => s !== sym));
  }

  function isPending(symbol) {
    return loadPendingSymbols().includes(String(symbol).toUpperCase());
  }

  function getGhPat() {
    try {
      return (localStorage.getItem(GH_PAT_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function setGhPat(token) {
    const t = (token || "").trim();
    if (!t) {
      localStorage.removeItem(GH_PAT_KEY);
      return;
    }
    localStorage.setItem(GH_PAT_KEY, t);
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function buildWatchlistPayload() {
    return {
      updated_at: state.updated_at,
      status: state.status || "committed",
      cap: CAP,
      horizon: state.horizon,
      book_usd: state.book_usd,
      tickers: state.tickers.map((t) => ({
        symbol: t.symbol,
        name: t.name || "",
        last: t.last != null ? t.last : null,
        change: t.change != null ? t.change : null,
        change_pct: t.change_pct != null ? t.change_pct : null,
        currency: t.currency || "USD",
        action: normalizeAction(t.action),
        action_why: t.action_why || "",
        size_usd: t.size_usd != null ? t.size_usd : null,
        source:
          t.source ||
          "https://finance.yahoo.com/quote/" + encodeURIComponent(t.symbol),
      })),
      committed_count: state.tickers.length,
      notes: "",
    };
  }

  function applyWatchlistData(data, opts) {
    const options = opts || {};
    if (!data || !Array.isArray(data.tickers)) return;
    if (options.setBase) baseFromFile = data;
    state = {
      updated_at: data.updated_at || state.updated_at || "",
      status: data.status || state.status || "committed",
      cap: CAP,
      horizon: data.horizon != null ? data.horizon : state.horizon,
      book_usd: data.book_usd != null ? data.book_usd : state.book_usd,
      tickers: data.tickers.slice(0, CAP).map((t) => ({
        ...t,
        action: normalizeAction(t.action),
      })),
    };
    if (options.clearOverlay) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {
        /* ignore */
      }
    } else {
      saveOverlay();
    }
    render();
  }

  async function reloadFromWatchlistFile() {
    const res = await fetch(DATA_URL + "?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    applyWatchlistData(data, { setBase: true, clearOverlay: false });
    // Drop pending flags for symbols now confirmed on file.
    const fileSyms = new Set(
      (data.tickers || []).map((t) => String(t.symbol).toUpperCase())
    );
    savePendingSymbols(
      loadPendingSymbols().filter((s) => !fileSyms.has(s))
    );
    render();
    return data;
  }

  async function commitViaLocalApi(action, body) {
    const path =
      action === "remove" ? "/api/commit-remove" : "/api/commit-add";
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      payload = null;
    }
    if (!res.ok || !payload || !payload.ok) {
      const err =
        (payload && payload.error) ||
        "HTTP " + res.status + " commit failed";
      const e = new Error(err);
      e.payload = payload;
      throw e;
    }
    return payload;
  }

  async function commitViaGithubPat(message) {
    const pat = getGhPat();
    if (!pat) return null;
    const getRes = await fetch(
      "https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + pat,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!getRes.ok) {
      throw new Error(
        "GitHub Contents GET failed (HTTP " +
          getRes.status +
          "). Check token Contents R/W on " +
          GH_REPO +
          " only."
      );
    }
    const meta = await getRes.json();
    const sha = meta && meta.sha;
    if (!sha) throw new Error("GitHub Contents response missing sha");
    const payload = buildWatchlistPayload();
    const content = utf8ToBase64(JSON.stringify(payload, null, 2) + "\n");
    const putRes = await fetch(
      "https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + pat,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          message: message,
          content: content,
          sha: sha,
        }),
      }
    );
    if (!putRes.ok) {
      let detail = "HTTP " + putRes.status;
      try {
        const errBody = await putRes.json();
        if (errBody && errBody.message) detail = errBody.message;
      } catch (_) {
        /* ignore */
      }
      throw new Error("GitHub Contents PUT failed: " + detail);
    }
    // After PUT: apply the payload we just wrote (no Pages CDN). Optionally
    // confirm via raw.githubusercontent.com (not github.io).
    applyWatchlistData(payload, { setBase: true });
    try {
      const rawUrl = RAW_WATCHLIST_URL + "?t=" + Date.now();
      let fres = await fetch(rawUrl, { cache: "no-store" });
      if (!fres.ok) {
        await new Promise((r) => setTimeout(r, 600));
        fres = await fetch(RAW_WATCHLIST_URL + "?t=" + Date.now(), {
          cache: "no-store",
        });
      }
      if (fres.ok) {
        const data = await fres.json();
        applyWatchlistData(data, { setBase: true });
      }
    } catch (_) {
      /* keep applied payload */
    }
    return { ok: true, watchlist: payload };
  }

  async function tryCommitAdd(ticker) {
    const sym = ticker.symbol;
    if (isLocalPreview()) {
      try {
        const result = await commitViaLocalApi("add", {
          symbol: sym,
          name: ticker.name || "",
          action: ticker.action || "Watch",
          action_why: ticker.action_why || "",
          size_usd: ticker.size_usd,
        });
        if (result.watchlist) {
          applyWatchlistData(result.watchlist, { setBase: true });
        } else {
          await reloadFromWatchlistFile();
        }
        clearPending(sym);
        render();
        setStatus(
          "Committed add " +
            sym +
            " to public watchlist (" +
            (result.count != null ? result.count : state.tickers.length) +
            "/" +
            CAP +
            ").",
          "ok"
        );
        return true;
      } catch (err) {
        markPending(sym);
        render();
        setStatus(
          "Added " +
            sym +
            " locally — not on public file yet. " +
            (err && err.message ? err.message : err) +
            " Download JSON or tell Helix to commit " +
            sym +
            ".",
          "warn"
        );
        return false;
      }
    }

    // Public Pages: always keep overlay; try PAT commit if present.
    markPending(sym);
    render();
    if (getGhPat()) {
      try {
        await commitViaGithubPat("watchlist: add " + sym);
        clearPending(sym);
        render();
        setStatus(
          "Committed add " + sym + " via GitHub token (Contents API).",
          "ok"
        );
        return true;
      } catch (err) {
        downloadJson();
        setStatus(
          "Saved in this browser only — commit failed (" +
            (err && err.message ? err.message : err) +
            "). Token stays in localStorage only; or tell Helix to commit " +
            sym +
            ".",
          "warn"
        );
        return false;
      }
    }
    downloadJson();
    setStatus(
      "Saved in this browser only — add a commit token in Settings, or tell Helix to commit " +
        sym +
        ".",
      "warn"
    );
    return false;
  }

  async function tryCommitRemove(sym) {
    if (isLocalPreview()) {
      try {
        const result = await commitViaLocalApi("remove", { symbol: sym });
        if (result.watchlist) {
          applyWatchlistData(result.watchlist, { setBase: true });
        } else {
          await reloadFromWatchlistFile();
        }
        clearPending(sym);
        render();
        setStatus(
          "Committed remove " +
            sym +
            " from public watchlist (" +
            (result.count != null ? result.count : state.tickers.length) +
            "/" +
            CAP +
            ").",
          "ok"
        );
        return true;
      } catch (err) {
        markPending(sym);
        render();
        setStatus(
          "Removed " +
            sym +
            " locally — public file not updated. " +
            (err && err.message ? err.message : err),
          "warn"
        );
        return false;
      }
    }

    if (getGhPat()) {
      try {
        await commitViaGithubPat("watchlist: remove " + sym);
        clearPending(sym);
        render();
        setStatus(
          "Committed remove " + sym + " via GitHub token (Contents API).",
          "ok"
        );
        return true;
      } catch (err) {
        markPending(sym);
        render();
        downloadJson();
        setStatus(
          "Removed in this browser only — commit failed (" +
            (err && err.message ? err.message : err) +
            "). Or tell Helix to remove " +
            sym +
            ".",
          "warn"
        );
        return false;
      }
    }
    markPending(sym);
    render();
    setStatus(
      "Removed in this browser only — add a commit token in Settings, or tell Helix to remove " +
        sym +
        ".",
      "warn"
    );
    return false;
  }

  function syncSettingsPatUi() {
    const input = $("settingsPat");
    const status = $("settingsPatStatus");
    if (!input || !status) return;
    const has = !!getGhPat();
    // Never put the real token back into the field after save.
    if (!input.dataset.editing) input.value = "";
    input.placeholder = has ? "Token saved in this browser (hidden)" : "ghp_… fine-grained PAT";
    status.textContent = has
      ? "Token present in localStorage (never written to disk/repo)."
      : "No token — Pages Add/Remove stay overlay-only until you add one or tell Helix.";
    status.className = "settings-pat-status" + (has ? " ok" : "");
  }


  function loadNotes() {
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveNote(symbol, text) {
    const notes = loadNotes();
    notes[symbol] = text;
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }

  function loadActionHistory() {
    try {
      const raw = localStorage.getItem(ACTION_HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveActionHistory(entries) {
    const capped = entries.slice(-ACTION_HISTORY_CAP);
    localStorage.setItem(ACTION_HISTORY_KEY, JSON.stringify(capped));
  }

  function appendActionChange(symbol, from, to) {
    if (!symbol || from === to) return;
    const entries = loadActionHistory();
    entries.push({
      symbol: String(symbol),
      from: String(from),
      to: String(to),
      at: new Date().toISOString(),
    });
    saveActionHistory(entries);
  }

  function actionHistoryForSymbol(symbol) {
    return loadActionHistory().filter(
      (e) => e && e.symbol === symbol && e.at && e.from != null && e.to != null
    );
  }

  function fmtMoney(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    const sign = Number(n) > 0 ? "+" : "";
    return sign + Number(n).toFixed(2) + "%";
  }

  function fmtChange(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    const sign = Number(n) > 0 ? "+" : "";
    return sign + Number(n).toFixed(2);
  }

  /** Render a display string; do NOT Number() formatted strings (e.g. "+4.88%"). */
  function priceCell(display, clsExtra) {
    if (display == null || display === "") {
      return '<span class="missing">missing</span>';
    }
    const cls = "num" + (clsExtra ? " " + clsExtra : "");
    return '<span class="' + cls + '">' + display + "</span>";
  }

  function normalizeAction(a) {
    if (!a) return "Watch";
    const t = String(a).trim();
    const hit = ACTIONS.find((x) => x.toLowerCase() === t.toLowerCase());
    return hit || "Watch";
  }

  function mergeOverlay(fileData, overlay) {
    if (!overlay) return fileData;
    const fileTickers = Array.isArray(fileData.tickers) ? fileData.tickers : [];
    // Never blank the table: empty/missing overlay.tickers fall back to the committed file list.
    if (!Array.isArray(overlay.tickers) || overlay.tickers.length === 0) {
      return {
        ...fileData,
        updated_at: overlay.updated_at || fileData.updated_at,
        tickers: fileTickers,
      };
    }
    return {
      ...fileData,
      updated_at: overlay.updated_at || fileData.updated_at,
      tickers: overlay.tickers.map((t) => ({
        ...t,
        action: normalizeAction(t.action),
      })),
    };
  }

  /** Repair corrupt empty overlay so it cannot hide the committed watchlist. */
  function repairEmptyOverlay(fileData, overlay) {
    const fileTickers = Array.isArray(fileData && fileData.tickers)
      ? fileData.tickers
      : [];
    if (!overlay) return;
    if (Array.isArray(overlay.tickers) && overlay.tickers.length > 0) return;
    if (fileTickers.length === 0) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function remainingSlots() {
    return Math.max(0, CAP - state.tickers.length);
  }

  function renderMeta() {
    $("metaUpdated").textContent = state.updated_at || "-";
    const count = state.tickers.length;
    const countEl = $("metaCount");
    countEl.textContent = count + "/" + CAP;
    countEl.className = "value" + (count >= CAP ? " cap-full" : "");
    $("metaSlots").textContent = String(remainingSlots());
    $("metaHorizon").textContent = state.horizon || "-";
    $("metaStatus").textContent = state.status || "-";

    $("btnAdd").disabled = count >= CAP;
    $("btnAdd").title =
      count >= CAP ? "Watchlist at hard cap of 20" : "Add a ticker";
  }

  function renderTable() {
    const body = $("wlBody");
    body.innerHTML = "";

    if (!state.tickers.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="10" style="color:var(--muted);text-align:center;padding:1.5rem">No tickers - add one (max ' +
        CAP +
        ")</td>";
      body.appendChild(tr);
      return;
    }

    const paperPortfolio = loadPortfolio();
    state.tickers.forEach((t, idx) => {
      const tr = document.createElement("tr");
      tr.dataset.symbol = t.symbol;
      if (selectedSymbol === t.symbol) tr.classList.add("selected");

      const lastStr = fmtMoney(t.last);
      const chStr = fmtChange(t.change);
      const pctStr = fmtPct(t.change_pct);
      const chClass =
        t.change == null || Number.isNaN(Number(t.change))
          ? ""
          : Number(t.change) > 0
            ? "pos"
            : Number(t.change) < 0
              ? "neg"
              : "";
      const pctClass =
        t.change_pct == null || Number.isNaN(Number(t.change_pct))
          ? ""
          : Number(t.change_pct) > 0
            ? "pos"
            : Number(t.change_pct) < 0
              ? "neg"
              : "";

      const action = normalizeAction(t.action);
      const opts = ACTIONS.map(
        (a) =>
          '<option value="' +
          a +
          '"' +
          (a === action ? " selected" : "") +
          ">" +
          a +
          "</option>"
      ).join("");

      const paperPos = paperPortfolio.positions[t.symbol];
      let size;
      if (paperPos && paperPos.qty > 0) {
        const lastNum =
          t.last != null && !Number.isNaN(Number(t.last))
            ? Number(t.last)
            : null;
        if (lastNum != null) {
          const mkt = paperPos.qty * lastNum;
          size =
            '<span class="num" title="Paper: ' +
            escapeAttr(String(paperPos.qty)) +
            ' × $' +
            escapeAttr(fmtMoney(lastNum)) +
            '">' +
            "$" +
            Number(mkt).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) +
            "</span>";
        } else {
          size =
            '<span class="num" title="Paper qty (last missing)">' +
            escapeHtml(String(paperPos.qty)) +
            " sh</span>";
        }
      } else {
        size = '<span class="missing">—</span>';
      }
      const why = t.action_why
        ? escapeHtml(t.action_why)
        : '<span class="missing">-</span>';

      const pendingBadge = isPending(t.symbol)
        ? '<span class="badge not-public-badge" title="Saved in this browser; not confirmed on public watchlist.json">Not on public file yet</span>'
        : "";

      tr.innerHTML =
        '<td><div class="sym">' +
        escapeHtml(t.symbol) +
        pendingBadge +
        "</div></td>" +
        '<td><div class="name" title="' +
        escapeAttr(t.name || "") +
        '">' +
        escapeHtml(t.name || "-") +
        "</div></td>" +
        "<td>" +
        (lastStr
          ? priceCell(lastStr)
          : '<span class="missing">missing</span>') +
        "</td>" +
        "<td>" +
        (chStr
          ? priceCell(chStr, chClass)
          : '<span class="missing">missing</span>') +
        "</td>" +
        "<td>" +
        (pctStr
          ? priceCell(pctStr, pctClass)
          : '<span class="missing">missing</span>') +
        "</td>" +        "<td>" +
        size +
        "</td>" +
        "<td>" +
        '<select class="action-select ' +
        action +
        '" data-symbol="' +
        escapeAttr(t.symbol) +
        '" data-stop="1">' +
        opts +
        "</select></td>" +
        '<td><div class="why">' +
        why +
        "</div></td>" +
        '<td><div class="row-actions">' +
        '<button type="button" class="sm paper-buy btn-paper" data-symbol="' +
        escapeAttr(t.symbol) +
        '" data-side="Buy" data-stop="1" title="Simulation buy">Buy</button>' +
        '<button type="button" class="sm paper-sell btn-paper" data-symbol="' +
        escapeAttr(t.symbol) +
        '" data-side="Sell" data-stop="1" title="Simulation sell">Sell</button>' +
        "</div></td>" +
        '<td><div class="row-actions">' +
        (t.source
          ? '<a class="source" data-stop="1" href="' +
            escapeAttr(t.source) +
            '" target="_blank" rel="noopener">src</a>'
          : "") +
        '<button type="button" class="sm danger btn-remove" data-symbol="' +
        escapeAttr(t.symbol) +
        '" data-stop="1">Remove</button>' +
        "</div></td>";

      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-stop]")) return;
        openDetail(t.symbol);
      });

      body.appendChild(tr);
    });

    body.querySelectorAll("select.action-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        e.stopPropagation();
        const sym = sel.getAttribute("data-symbol");
        const ticker = state.tickers.find((x) => x.symbol === sym);
        if (!ticker) return;
        const from = normalizeAction(ticker.action);
        const to = normalizeAction(sel.value);
        if (from !== to) {
          appendActionChange(sym, from, to);
        }
        ticker.action = to;
        sel.className = "action-select " + to;
        state.updated_at = new Date().toISOString();
        saveOverlay();
        renderMeta();
        setStatus("Action updated for " + sym + " (local)", "ok");
        // Persist + immediately re-draw every history marker on open chart.
        if (selectedSymbol === sym) {
          redrawChartMarkersNow(sym);
        }
      });
      sel.addEventListener("click", (e) => e.stopPropagation());
    });

    body.querySelectorAll("button.btn-remove").forEach((btn) => {
      btn.addEventListener("click", onRemoveClick);
    });

    body.querySelectorAll("button.btn-paper").forEach((btn) => {
      btn.addEventListener("click", onRowPaperTrade);
    });
  }

  function onRemoveClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const sym = btn.getAttribute("data-symbol");
    if (!sym) return;
    const ok = window.confirm("Remove " + sym + " from the watchlist?");
    if (!ok) return;
    removeTicker(sym);
  }

  async function removeTicker(sym) {
    const i = state.tickers.findIndex((t) => t.symbol === sym);
    if (i < 0) {
      setStatus("Could not find " + sym + " to remove.", "err");
      return;
    }
    state.tickers.splice(i, 1);
    state.updated_at = new Date().toISOString();
    if (selectedSymbol === sym) {
      selectedSymbol = null;
      $("detailPanel").classList.remove("open");
    }
    clearPending(sym);
    saveOverlay();
    render();
    setStatus("Removed " + sym + " (local) — committing…", "ok");
    setCommitBusy(true);
    try {
      await tryCommitRemove(sym);
    } finally {
      setCommitBusy(false);
      renderMeta();
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }


  /* ========== SIMULATION-ONLY paper portfolio (localStorage; no broker) ========== */

  function defaultPortfolio() {
    return {
      startingCash: DEFAULT_STARTING_CASH,
      cash: DEFAULT_STARTING_CASH,
      positions: {},
      realizedPnL: 0,
    };
  }

  function loadPortfolio() {
    try {
      const raw = localStorage.getItem(PAPER_PORTFOLIO_KEY);
      if (!raw) return defaultPortfolio();
      const p = JSON.parse(raw);
      if (!p || typeof p !== "object") return defaultPortfolio();
      const starting =
        p.startingCash != null && !Number.isNaN(Number(p.startingCash))
          ? Number(p.startingCash)
          : DEFAULT_STARTING_CASH;
      const cash =
        p.cash != null && !Number.isNaN(Number(p.cash))
          ? Number(p.cash)
          : starting;
      const positions =
        p.positions && typeof p.positions === "object" ? p.positions : {};
      const realizedPnL =
        p.realizedPnL != null && !Number.isNaN(Number(p.realizedPnL))
          ? Number(p.realizedPnL)
          : 0;
      return { startingCash: starting, cash, positions, realizedPnL };
    } catch {
      return defaultPortfolio();
    }
  }

  function savePortfolio(p) {
    localStorage.setItem(PAPER_PORTFOLIO_KEY, JSON.stringify(p));
  }

  function loadOrders() {
    try {
      const raw = localStorage.getItem(PAPER_ORDERS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveOrders(orders) {
    localStorage.setItem(
      PAPER_ORDERS_KEY,
      JSON.stringify(orders.slice(-PAPER_ORDERS_CAP))
    );
  }

  function loadAlerts() {
    try {
      const raw = localStorage.getItem(PRICE_ALERTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveAlerts(alerts) {
    localStorage.setItem(PRICE_ALERTS_KEY, JSON.stringify(alerts));
  }

  function tickerLast(symbol) {
    const t = state.tickers.find((x) => x.symbol === symbol);
    if (!t || t.last == null || Number.isNaN(Number(t.last))) return null;
    return Number(t.last);
  }

  function fmtSignedMoney(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    const sign = v > 0 ? "+" : v < 0 ? "-" : "";
    return sign + "$" + fmtMoney(Math.abs(v));
  }

  function pnlClass(n) {
    if (n == null || Number.isNaN(Number(n)) || n === 0) return "";
    return Number(n) > 0 ? "pos" : "neg";
  }

  function defaultQtyFor(symbol) {
    const t = state.tickers.find((x) => x.symbol === symbol);
    const last = tickerLast(symbol);
    if (t && t.size_usd != null && last && last > 0) {
      const q = Math.floor(Number(t.size_usd) / last);
      if (q >= 1) return q;
    }
    return 1;
  }

  function promptQty(side, symbol) {
    const def = defaultQtyFor(symbol);
    const raw = window.prompt(
      "SIMULATION only — " + side + " " + symbol + "\nEnter quantity:",
      String(def)
    );
    if (raw == null) return null;
    const qty = Number(String(raw).trim());
    if (!Number.isFinite(qty) || qty <= 0) {
      setStatus("Invalid quantity.", "err");
      return null;
    }
    return qty;
  }

  /**
   * Simulated fill only. NEVER calls IBKR or any broker execution API.
   */
  function simulatePaperTrade(symbol, side, qty, tradeOptions) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) {
      setStatus("Missing symbol for paper trade.", "err");
      return false;
    }
    const options = tradeOptions || {};
    const hasCustomPrice = options.price != null && options.price !== "";
    const last = tickerLast(sym);
    if (last == null && !hasCustomPrice) {
      setStatus(
        "Cannot paper-" +
          side.toLowerCase() +
          " " +
          sym +
          ": last price missing (refresh quotes or enter a simulated price). No invented price.",
        "err"
      );
      return false;
    }
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) {
      setStatus("Quantity must be a positive number.", "err");
      return false;
    }
    const executionPrice = hasCustomPrice ? Number(options.price) : last;
    const fee = options.fee == null || options.fee === "" ? 0 : Number(options.fee);
    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      setStatus("Price must be a positive number.", "err");
      return false;
    }
    if (!Number.isFinite(fee) || fee < 0) {
      setStatus("Fee must be zero or a positive number.", "err");
      return false;
    }

    const portfolio = loadPortfolio();
    const cost = q * executionPrice;
    let realizedPnL = null;

    if (side === "Buy") {
      const debit = cost + fee;
      if (portfolio.cash < debit) {
        setStatus(
          "Insufficient paper cash: need $" +
            fmtMoney(debit) +
            ", have $" +
            fmtMoney(portfolio.cash) +
            ".",
          "err"
        );
        return false;
      }
      const pos = portfolio.positions[sym] || { qty: 0, avgCost: 0 };
      const newQty = pos.qty + q;
      const newAvg =
        newQty > 0 ? (pos.qty * pos.avgCost + cost + fee) / newQty : 0;
      const nextPos = { qty: newQty, avgCost: newAvg };
      // Persist open-plan target/stop on the position when a Buy fills.
      if (options.target != null && Number.isFinite(Number(options.target))) {
        nextPos.target = Number(options.target);
      } else if (pos.target != null && Number.isFinite(Number(pos.target))) {
        nextPos.target = Number(pos.target);
      }
      if (options.stop != null && Number.isFinite(Number(options.stop))) {
        nextPos.stop = Number(options.stop);
      } else if (pos.stop != null && Number.isFinite(Number(pos.stop))) {
        nextPos.stop = Number(pos.stop);
      }
      portfolio.positions[sym] = nextPos;
      portfolio.cash -= debit;
    } else if (side === "Sell") {
      const pos = portfolio.positions[sym];
      if (!pos || pos.qty < q) {
        const have = pos ? pos.qty : 0;
        setStatus(
          "Insufficient paper shares of " +
            sym +
            ": need " +
            q +
            ", have " +
            have +
            ".",
          "err"
        );
        return false;
      }
      const proceeds = cost - fee;
      realizedPnL = (executionPrice - pos.avgCost) * q - fee;
      portfolio.realizedPnL += realizedPnL;
      const left = pos.qty - q;
      if (left <= 1e-10) {
        delete portfolio.positions[sym];
      } else {
        const remain = { qty: left, avgCost: pos.avgCost };
        if (pos.target != null && Number.isFinite(Number(pos.target))) {
          remain.target = Number(pos.target);
        }
        if (pos.stop != null && Number.isFinite(Number(pos.stop))) {
          remain.stop = Number(pos.stop);
        }
        portfolio.positions[sym] = remain;
      }
      portfolio.cash += proceeds;
    } else {
      setStatus("Unknown side.", "err");
      return false;
    }

    savePortfolio(portfolio);

    const orders = loadOrders();
    const order = {
      id: "sim-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      at: new Date().toISOString(),
      symbol: sym,
      side: side,
      qty: q,
      price: executionPrice,
      fee: fee,
      target: options.target != null ? Number(options.target) : null,
      stop: options.stop != null ? Number(options.stop) : null,
      status: "filled",
    };
    if (realizedPnL != null) order.realizedPnL = realizedPnL;
    orders.push(order);
    saveOrders(orders);

    setStatus(
      "SIM filled " +
        side +
        " " +
        q +
        " " +
        sym +
        " @ $" +
        fmtMoney(executionPrice) +
        (fee ? " + $" + fmtMoney(fee) + " fee" : "") +
        " (localStorage only — not a real order).",
      "ok"
    );
    renderPaperPanels();
    renderTable();
    renderMeta();
    if (selectedSymbol === sym) {
      updateDetailTradeHint(sym);
      redrawChartMarkersNow(sym);
    }
    return true;
  }

  function onRowPaperTrade(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    const sym = btn.getAttribute("data-symbol");
    const side = btn.getAttribute("data-side");
    if (!sym || !side) return;
    const qty = promptQty(side, sym);
    if (qty == null) return;
    simulatePaperTrade(sym, side, qty);
  }

  function onDetailPaperTrade(side) {
    if (!selectedSymbol) {
      setStatus("Open a ticker detail first.", "err");
      return;
    }
    const raw = ($("detailTradeQty").value || "").trim();
    let qty = Number(raw);
    if (!Number.isFinite(qty) || qty <= 0) {
      qty = promptQty(side, selectedSymbol);
      if (qty == null) return;
    }
    const readOptional = (id, label, min) => {
      const value = ($(id).value || "").trim();
      if (!value) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) {
        setStatus(label + " must be " + (min === 0 ? "zero or a positive number." : "a positive number."), "err");
        return undefined;
      }
      return parsed;
    };
    const price = readOptional("detailTradePrice", "Price", 0.0000001);
    const fee = readOptional("detailTradeFee", "Fee", 0);
    const target = readOptional("detailTradeTarget", "Target", 0.0000001);
    const stop = readOptional("detailTradeStop", "Stop", 0.0000001);
    if (price === undefined || fee === undefined || target === undefined || stop === undefined) return;
    simulatePaperTrade(selectedSymbol, side, qty, { price, fee, target, stop });
  }

  function syncTicketSymbolList() {
    const list = $("ticketSymbolList");
    if (!list) return;
    list.innerHTML = state.tickers
      .map((t) => '<option value="' + escapeAttr(t.symbol) + '"></option>')
      .join("");
  }

  function fillTicketFromSymbol(symbol) {
    const symEl = $("ticketSymbol");
    const hint = $("ticketHint");
    if (!symEl) return;
    const sym = String(symbol || "").trim().toUpperCase();
    if (sym) symEl.value = sym;
    const last = tickerLast(sym);
    const priceEl = $("ticketPrice");
    if (priceEl && last != null && (!priceEl.value || priceEl.dataset.autofilled === "1")) {
      priceEl.value = String(last);
      priceEl.dataset.autofilled = "1";
    }
    const qtyEl = $("ticketQty");
    if (qtyEl && (!qtyEl.value || qtyEl.dataset.autofilled === "1")) {
      qtyEl.value = String(defaultQtyFor(sym) || 1);
      qtyEl.dataset.autofilled = "1";
    }
    if (hint) {
      const portfolio = loadPortfolio();
      const pos = portfolio.positions[sym];
      const bits = [];
      if (sym) bits.push(sym);
      if (last != null) bits.push("last $" + fmtMoney(last));
      else if (sym) bits.push("last missing — enter Entry price");
      bits.push("cash $" + fmtMoney(portfolio.cash));
      if (pos) bits.push("held " + pos.qty);
      hint.textContent = bits.join(" · ") || "Pick a symbol, set qty / entry / limit / stop, then Buy or Sell.";
    }
  }

  function onTicketPaperTrade(side) {
    const sym = (($("ticketSymbol") && $("ticketSymbol").value) || "").trim().toUpperCase();
    if (!sym || !/^[A-Z0-9.\-]{1,12}$/.test(sym)) {
      setStatus("Enter a valid symbol for the paper trade ticket.", "err");
      return;
    }
    const raw = (($("ticketQty") && $("ticketQty").value) || "").trim();
    let qty = Number(raw);
    if (!Number.isFinite(qty) || qty <= 0) {
      setStatus("Enter a positive quantity.", "err");
      return;
    }
    const readOptional = (id, label, min) => {
      const el = $(id);
      const value = el ? (el.value || "").trim() : "";
      if (!value) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) {
        setStatus(label + " must be a valid number.", "err");
        return undefined;
      }
      return parsed;
    };
    const price = readOptional("ticketPrice", "Entry / Price", 0.0000001);
    const fee = readOptional("ticketFee", "Fee", 0);
    const target = readOptional("ticketTarget", "Limit / Target", 0.0000001);
    const stop = readOptional("ticketStop", "Stop", 0.0000001);
    if (price === undefined || fee === undefined || target === undefined || stop === undefined) return;
    const ok = simulatePaperTrade(sym, side, qty, { price, fee, target, stop });
    if (ok) {
      fillTicketFromSymbol(sym);
      openDetail(sym);
      const box = $("detailTradeBox") || $("tradeTicketPanel");
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function updateDetailTradeHint(symbol) {
    const hint = $("detailTradeHint");
    if (!hint) return;
    const last = tickerLast(symbol);
    const priceEl = $("detailTradePrice");
    if (priceEl && last != null && (!priceEl.value || priceEl.dataset.autofilled === "1")) {
      priceEl.value = String(last);
      priceEl.dataset.autofilled = "1";
    }
    const portfolio = loadPortfolio();
    const pos = portfolio.positions[symbol];
    const bits = [];
    if (last != null) bits.push("last $" + fmtMoney(last));
    else bits.push("last missing — trade blocked");
    bits.push("cash $" + fmtMoney(portfolio.cash));
    if (pos) bits.push("held " + pos.qty);
    hint.textContent = bits.join(" · ");
    const qtyEl = $("detailTradeQty");
    if (qtyEl && (!qtyEl.value || qtyEl.dataset.autofilled === "1")) {
      qtyEl.value = String(defaultQtyFor(symbol));
      qtyEl.dataset.autofilled = "1";
    }
    const plan = resolveOpenTradePlan(symbol);
    const targetEl = $("detailTradeTarget");
    const stopEl = $("detailTradeStop");
    if (targetEl && (!targetEl.value || targetEl.dataset.autofilled === "1")) {
      if (plan && plan.target != null) {
        targetEl.value = String(plan.target);
        targetEl.dataset.autofilled = "1";
      } else if (targetEl.dataset.autofilled === "1") {
        targetEl.value = "";
      }
    }
    if (stopEl && (!stopEl.value || stopEl.dataset.autofilled === "1")) {
      if (plan && plan.stop != null) {
        stopEl.value = String(plan.stop);
        stopEl.dataset.autofilled = "1";
      } else if (stopEl.dataset.autofilled === "1") {
        stopEl.value = "";
      }
    }
  }

  function computeMarkToMarket(portfolio) {
    let mkt = 0;
    let unrealized = 0;
    let missingMarks = 0;
    const rows = [];
    Object.keys(portfolio.positions)
      .sort()
      .forEach((sym) => {
        const pos = portfolio.positions[sym];
        const last = tickerLast(sym);
        const costBasis = pos.qty * pos.avgCost;
        let mktVal = null;
        let uPnL = null;
        if (last != null) {
          mktVal = pos.qty * last;
          uPnL = mktVal - costBasis;
          mkt += mktVal;
          unrealized += uPnL;
        } else {
          missingMarks++;
        }
        rows.push({
          symbol: sym,
          qty: pos.qty,
          avgCost: pos.avgCost,
          last,
          mktVal,
          uPnL,
        });
      });
    return {
      rows,
      mkt,
      unrealized,
      missingMarks,
      equity: portfolio.cash + mkt,
    };
  }

  function renderPortfolioPanel(
    portfolio = loadPortfolio(),
    orders = loadOrders()
  ) {
    const mt = computeMarkToMarket(portfolio);
    const closed = orders.filter((o) => o && o.side === "Sell" && Number.isFinite(Number(o.realizedPnL)));
    const wins = closed.filter((o) => Number(o.realizedPnL) > 0).length;
    const losses = closed.filter((o) => Number(o.realizedPnL) < 0).length;
    const cashIn = $("startingCashInput");
    if (cashIn && document.activeElement !== cashIn) {
      cashIn.value = String(portfolio.startingCash);
    }
    $("paperCash").textContent = "$" + fmtMoney(portfolio.cash);
    $("paperEquity").textContent = "$" + fmtMoney(mt.equity);
    const uEl = $("paperUnrealized");
    uEl.textContent =
      fmtSignedMoney(mt.unrealized) +
      (mt.missingMarks
        ? " (" + mt.missingMarks + " missing mark)"
        : "");
    uEl.className = "value " + pnlClass(mt.unrealized);
    const rEl = $("paperRealized");
    rEl.textContent = fmtSignedMoney(portfolio.realizedPnL);
    rEl.className = "value " + pnlClass(portfolio.realizedPnL);
    $("paperTradeCount").textContent = String(orders.length);
    $("paperWinLoss").textContent = wins + " / " + losses;
    const netEl = $("paperNetPnl");
    netEl.textContent = fmtSignedMoney(portfolio.realizedPnL + mt.unrealized);
    netEl.className = "value " + pnlClass(portfolio.realizedPnL + mt.unrealized);

    const body = $("paperPosBody");
    body.innerHTML = "";
    if (!mt.rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="5" style="color:var(--muted);text-align:center;padding:1rem">No open paper positions</td>';
      body.appendChild(tr);
      return;
    }
    mt.rows.forEach((r) => {
      const tr = document.createElement("tr");
      const mkt =
        r.mktVal != null
          ? '<span class="num">$' + fmtMoney(r.mktVal) + "</span>"
          : '<span class="missing">missing last</span>';
      const u =
        r.uPnL != null
          ? '<span class="num ' +
            pnlClass(r.uPnL) +
            '">' +
            fmtSignedMoney(r.uPnL) +
            "</span>"
          : '<span class="missing">—</span>';
      tr.innerHTML =
        '<td><div class="sym">' +
        escapeHtml(r.symbol) +
        "</div></td>" +
        '<td class="num">' +
        r.qty +
        "</td>" +
        '<td class="num">$' +
        fmtMoney(r.avgCost) +
        "</td>" +
        "<td>" +
        mkt +
        "</td>" +
        "<td>" +
        u +
        "</td>";
      body.appendChild(tr);
    });
  }

  function renderOrdersPanel(orders = loadOrders()) {
    const body = $("paperOrdersBody");
    body.innerHTML = "";
    orders = orders.slice().reverse();
    if (!orders.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="8" style="color:var(--muted);text-align:center;padding:1rem">No simulated fills yet</td>';
      body.appendChild(tr);
      return;
    }
    orders.forEach((o) => {
      const tr = document.createElement("tr");
      const sideCls = o.side === "Buy" ? "side-buy" : "side-sell";
      const when = o.at
        ? new Date(o.at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "—";
      tr.innerHTML =
        "<td>" +
        escapeHtml(when) +
        "</td>" +
        '<td><div class="sym">' +
        escapeHtml(o.symbol) +
        "</div></td>" +
        '<td class="' +
        sideCls +
        '">' +
        escapeHtml(o.side) +
        "</td>" +
        '<td class="num">' +
        o.qty +
        "</td>" +
        '<td class="num">$' +
        fmtMoney(o.price) +
        "</td>" +
        '<td class="num">' +
        (o.fee ? "$" + fmtMoney(o.fee) : "—") +
        "</td>" +
        "<td>" +
        (o.target != null || o.stop != null
          ? "T " + (o.target != null ? "$" + fmtMoney(o.target) : "—") + " / S " + (o.stop != null ? "$" + fmtMoney(o.stop) : "—")
          : "—") +
        "</td>" +
        '<td><span class="status-filled">' +
        escapeHtml(o.status || "filled") +
        "</span></td>";
      body.appendChild(tr);
    });
  }

  function renderAlertsPanel() {
    const list = $("alertList");
    const banner = $("alertFiredBanner");
    const dl = $("alertSymbolList");
    if (dl) {
      dl.innerHTML = state.tickers
        .map(
          (t) =>
            '<option value="' + escapeAttr(t.symbol) + '"></option>'
        )
        .join("");
    }
    const alerts = loadAlerts();
    const fired = alerts.filter((a) => a && a.fired);
    if (fired.length) {
      banner.hidden = false;
      banner.textContent =
        fired.length +
        " alert(s) fired in-UI (local only — no SMS/email): " +
        fired
          .map(
            (a) =>
              a.symbol +
              " " +
              a.direction +
              " " +
              a.threshold +
              (a.firedPrice != null ? " @ " + a.firedPrice : "")
          )
          .join("; ");
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }

    list.innerHTML = "";
    if (!alerts.length) {
      const li = document.createElement("li");
      li.style.color = "var(--muted)";
      li.textContent = "No local alerts — add one above. Checked on load and Refresh.";
      list.appendChild(li);
      return;
    }
    alerts
      .slice()
      .reverse()
      .forEach((a) => {
        const li = document.createElement("li");
        if (a.fired) li.classList.add("fired");
        const badge = a.fired
          ? '<span class="badge fired-badge">fired</span>'
          : '<span class="badge pending">pending</span>';
        const last = tickerLast(a.symbol);
        const lastNote =
          last != null
            ? ' · last $' + fmtMoney(last)
            : " · last missing";
        li.innerHTML =
          badge +
          " <strong>" +
          escapeHtml(a.symbol) +
          "</strong> " +
          escapeHtml(a.direction) +
          " <span class=\"num\">$" +
          fmtMoney(a.threshold) +
          "</span>" +
          '<span class="alert-meta">' +
          escapeHtml(lastNote) +
          (a.firedAt
            ? " · fired " +
              new Date(a.firedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "") +
          "</span>" +
          '<span class="spacer"></span>' +
          '<button type="button" class="sm danger btn-remove-alert" data-id="' +
          escapeAttr(a.id) +
          '">Remove</button>';
        list.appendChild(li);
      });
    list.querySelectorAll(".btn-remove-alert").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const next = loadAlerts().filter((x) => x.id !== id);
        saveAlerts(next);
        renderAlertsPanel();
        setStatus("Alert removed.", "ok");
      });
    });
  }

  function checkPriceAlerts() {
    const alerts = loadAlerts();
    let changed = false;
    const newly = [];
    alerts.forEach((a) => {
      if (!a || a.fired) return;
      const last = tickerLast(a.symbol);
      if (last == null) return;
      const th = Number(a.threshold);
      if (!Number.isFinite(th)) return;
      let hit = false;
      if (a.direction === "above" && last >= th) hit = true;
      if (a.direction === "below" && last <= th) hit = true;
      if (hit) {
        a.fired = true;
        a.firedAt = new Date().toISOString();
        a.firedPrice = last;
        changed = true;
        newly.push(a);
      }
    });
    if (changed) {
      saveAlerts(alerts);
      if (newly.length) {
        setStatus(
          "Price alert fired: " +
            newly
              .map(
                (a) =>
                  a.symbol +
                  " " +
                  a.direction +
                  " $" +
                  fmtMoney(a.threshold) +
                  " (last $" +
                  fmtMoney(a.firedPrice) +
                  ")"
              )
              .join("; ") +
            " — in-UI only.",
          "warn"
        );
      }
    }
    renderAlertsPanel();
    return newly;
  }

  function renderPaperPanels(portfolio, orders) {
    renderPortfolioPanel(portfolio);
    renderOrdersPanel(orders);
    renderAlertsPanel();
  }

  function isCleanPaperReset(portfolio, orders) {
    return (
      portfolio &&
      portfolio.startingCash === DEFAULT_STARTING_CASH &&
      portfolio.cash === DEFAULT_STARTING_CASH &&
      portfolio.realizedPnL === 0 &&
      Object.keys(portfolio.positions || {}).length === 0 &&
      Array.isArray(orders) &&
      orders.length === 0
    );
  }

  function resetPaperSim() {
    if (
      !confirm(
        "Reset paper portfolio and simulated order history? Local price alerts are separate and unchanged; use Clear all alerts to clear them. This cannot be undone."
      )
    ) {
      return;
    }

    // Update the input before any render/change handling can observe stale cash.
    const cashInput = $("startingCashInput");
    if (cashInput) cashInput.value = String(DEFAULT_STARTING_CASH);

    let portfolio;
    let orders;
    let clean = false;
    let writeError = null;
    for (let attempt = 0; attempt < 2 && !clean; attempt += 1) {
      try {
        localStorage.setItem(
          PAPER_PORTFOLIO_KEY,
          JSON.stringify(defaultPortfolio())
        );
        localStorage.setItem(PAPER_ORDERS_KEY, JSON.stringify([]));
        writeError = null;
      } catch (err) {
        writeError = err;
      }
      portfolio = loadPortfolio();
      orders = loadOrders();
      clean = isCleanPaperReset(portfolio, orders);
    }

    // Render exactly the state read back from storage, while leaving alerts alone.
    renderPaperPanels(portfolio, orders);
    renderMeta();
    if (selectedSymbol) {
      updateDetailTradeHint(selectedSymbol);
      redrawChartMarkersNow(selectedSymbol);
    }
    if (!clean) {
      setStatus(
        "Reset failed to persist clean paper state" +
          (writeError && writeError.message ? ": " + writeError.message : "."),
        "err"
      );
      return;
    }
    setStatus(
      "Paper portfolio and order history reset. Local price alerts were left unchanged; use Clear all alerts to clear them.",
      "ok"
    );
  }

  function addPriceAlert() {
    const sym = ($("alertSymbol").value || "").trim().toUpperCase();
    const direction = $("alertDir").value === "below" ? "below" : "above";
    const th = Number(($("alertThreshold").value || "").trim());
    if (!sym || !/^[A-Z0-9.\\-]{1,12}$/.test(sym)) {
      setStatus("Enter a valid alert symbol.", "err");
      return;
    }
    if (!Number.isFinite(th) || th <= 0) {
      setStatus("Enter a positive threshold price.", "err");
      return;
    }
    const alerts = loadAlerts();
    alerts.push({
      id: "al-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      symbol: sym,
      direction,
      threshold: th,
      createdAt: new Date().toISOString(),
      fired: false,
      firedAt: null,
      firedPrice: null,
    });
    saveAlerts(alerts);
    $("alertThreshold").value = "";
    renderAlertsPanel();
    checkPriceAlerts();
    setStatus(
      "Alert set: " + sym + " " + direction + " $" + fmtMoney(th) + " (local).",
      "ok"
    );
  }

  function clearAllAlerts() {
    if (!loadAlerts().length) {
      setStatus("No alerts to clear.", "warn");
      return;
    }
    if (!confirm("Clear all local price alerts?")) return;
    saveAlerts([]);
    renderAlertsPanel();
    setStatus("All local alerts cleared.", "ok");
  }

  function onStartingCashChange() {
    const raw = Number(($("startingCashInput").value || "").trim());
    if (!Number.isFinite(raw) || raw < 0) {
      setStatus("Starting cash must be a non-negative number.", "err");
      renderPortfolioPanel();
      return;
    }
    const portfolio = loadPortfolio();
    const hasPos = Object.keys(portfolio.positions).length > 0;
    const hasOrders = loadOrders().length > 0;
    if (hasPos || hasOrders) {
      // Adjust cash by the delta in starting capital without wiping positions.
      const delta = raw - portfolio.startingCash;
      portfolio.startingCash = raw;
      portfolio.cash = Math.max(0, portfolio.cash + delta);
      savePortfolio(portfolio);
      setStatus(
        "Starting cash set to $" +
          fmtMoney(raw) +
          " (cash adjusted by delta; positions kept).",
        "ok"
      );
    } else {
      portfolio.startingCash = raw;
      portfolio.cash = raw;
      portfolio.realizedPnL = 0;
      savePortfolio(portfolio);
      setStatus("Starting cash set to $" + fmtMoney(raw) + ".", "ok");
    }
    renderPaperPanels();
    renderMeta();
  }


  function render() {
    renderMeta();
    renderTable();
    renderPaperPanels();
    syncTicketSymbolList();
  }

  function getPreset(id) {
    return RANGE_PRESETS.find((p) => p.id === id) || RANGE_PRESETS[0];
  }

  function syncRangeButtons() {
    document.querySelectorAll(".range-btn").forEach((btn) => {
      const id = btn.getAttribute("data-range");
      btn.setAttribute("aria-pressed", id === selectedRangeId ? "true" : "false");
    });
  }

  function openDetail(symbol) {
    const t = state.tickers.find((x) => x.symbol === symbol);
    if (!t) return;
    selectedSymbol = symbol;
    renderTable();
    $("detailPanel").classList.add("open");
    $("detailTitle").textContent = t.symbol + (t.name ? " · " + t.name : "");
    $("detailWhy").textContent = t.action_why || "No thesis note on file.";
    const src = $("detailSource");
    src.href = t.source || "https://finance.yahoo.com/quote/" + encodeURIComponent(t.symbol);
    src.textContent = "Open " + t.symbol + " on Yahoo Finance";
    const notes = loadNotes();
    $("noteArea").value = notes[symbol] || "";
    $("noteArea").oninput = () => saveNote(symbol, $("noteArea").value);
    syncRangeButtons();
    updateDetailTradeHint(t.symbol);
    fillTicketFromSymbol(t.symbol);
    drawHistoryChart(t.symbol);
    const tradeBox = $("detailTradeBox");
    if (tradeBox && tradeBox.scrollIntoView) {
      setTimeout(() => tradeBox.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
    const ticket = $("tradeTicketPanel");
    if (ticket) ticket.classList.add("pulse-visible");
  }

  function cacheKey(symbol, rangeId) {
    return symbol + "|" + rangeId;
  }

  function parseYahooChartPayload(data, symbol, preset) {
    if (data && data.error && !(data.chart && data.chart.result)) {
      throw new Error(String(data.error));
    }
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result || !result.meta) throw new Error("No chart result");
    const meta = result.meta;
    const last =
      meta.regularMarketPrice != null
        ? meta.regularMarketPrice
        : meta.previousClose;
    const prev =
      meta.chartPreviousClose != null
        ? meta.chartPreviousClose
        : meta.previousClose;
    let change = null;
    let change_pct = null;
    if (last != null && prev != null && prev !== 0) {
      change = last - prev;
      change_pct = (change / prev) * 100;
    }
    let timestamps = Array.isArray(result.timestamp) ? result.timestamp.slice() : [];
    let closes =
      result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0] &&
      result.indicators.quote[0].close
        ? result.indicators.quote[0].close.slice()
        : [];

    // Pair and drop null closes
    const pairs = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c != null && !Number.isNaN(Number(c))) {
        pairs.push({ t: timestamps[i], c: Number(c) });
      }
    }

    // 10d: Yahoo may lack range=10d - use 1mo daily and keep last ~10 sessions
    if (preset.maxPoints && pairs.length > preset.maxPoints) {
      pairs.splice(0, pairs.length - preset.maxPoints);
    }

    return {
      symbol: symbol,
      last,
      change,
      change_pct,
      timestamps: pairs.map((p) => p.t),
      closes: pairs.map((p) => p.c),
      rangeId: preset.id,
      interval: preset.interval,
      yahooRange: preset.range,
      via: null,
    };
  }

  /** Same-origin quote proxy (preview_server.py). Never invents prices. */
  async function fetchQuoteViaProxy(symbol) {
    const res = await fetch(
      "/api/quote?symbol=" + encodeURIComponent(symbol),
      { cache: "no-store" }
    );
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) detail = String(errBody.error);
      } catch (_) {}
      throw new Error("proxy " + detail);
    }
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (data.last == null) throw new Error("Missing last price");
    return {
      symbol: data.symbol || symbol,
      last: data.last,
      change: data.change != null ? data.change : null,
      change_pct: data.change_pct != null ? data.change_pct : null,
      via: "proxy",
    };
  }

  async function fetchYahooChart(symbol, rangeId) {
    const preset = getPreset(rangeId || "1d");
    const proxyUrl =
      "/api/chart?symbol=" +
      encodeURIComponent(symbol) +
      "&interval=" +
      encodeURIComponent(preset.interval) +
      "&range=" +
      encodeURIComponent(preset.range);
    const yahooUrl =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=" +
      encodeURIComponent(preset.interval) +
      "&range=" +
      encodeURIComponent(preset.range);

    // Prefer same-origin proxy (local preview_server.py); fall back to direct Yahoo.
    let data = null;
    let via = null;
    let proxyErr = null;
    try {
      const res = await fetch(proxyUrl, { cache: "no-store" });
      if (res.ok) {
        data = await res.json();
        via = "proxy";
      } else {
        proxyErr = "proxy HTTP " + res.status;
        try {
          const errBody = await res.json();
          if (errBody && errBody.error) proxyErr = "proxy " + errBody.error;
        } catch (_) {}
      }
    } catch (err) {
      proxyErr = String(err && err.message ? err.message : err);
    }

    if (!data) {
      try {
        const res = await fetch(yahooUrl, { mode: "cors", cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        data = await res.json();
        via = "yahoo";
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (proxyErr) {
          throw new Error(msg + " (proxy: " + proxyErr + ")");
        }
        throw err;
      }
    }

    const parsed = parseYahooChartPayload(data, symbol, preset);
    parsed.via = via;
    return parsed;
  }

  function nearestIndex(timestamps, targetSec) {
    if (!timestamps.length) return -1;
    let best = 0;
    let bestDist = Math.abs(timestamps[0] - targetSec);
    for (let i = 1; i < timestamps.length; i++) {
      const d = Math.abs(timestamps[i] - targetSec);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  }

  function formatChartTime(tsSec, rangeId) {
    const d = new Date(tsSec * 1000);
    if (rangeId === "1d" || rangeId === "5d") {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function updateMarkerUi(symbol, plotted, offChartEntries) {
    const empty = $("markerEmpty");
    const legend = $("markerLegend");
    const hist = actionHistoryForSymbol(symbol);
    if (!hist.length) {
      empty.hidden = false;
      empty.textContent = "no status changes yet";
      legend.hidden = true;
      legend.innerHTML = "";
      return;
    }
    empty.hidden = true;
    legend.hidden = false;
    const bits = plotted.map(
      (m) =>
        '<span class="mk"><span class="dot" aria-hidden="true"></span>' +
        escapeHtml(m.from) +
        "→" +
        escapeHtml(m.to) +
        " · " +
        escapeHtml(m.label) +
        "</span>"
    );
    const off = Array.isArray(offChartEntries) ? offChartEntries : [];
    off.forEach((m) => {
      bits.push(
        '<span class="mk off"><span class="dot" aria-hidden="true"></span>' +
          escapeHtml(m.from) +
          "→" +
          escapeHtml(m.to) +
          " · outside range · " +
          escapeHtml(m.label) +
          "</span>"
      );
    });
    if (!plotted.length && !off.length && hist.length) {
      bits.push(
        '<span class="mk off">' + hist.length + " change(s) on file</span>"
      );
    }
    legend.innerHTML = bits.join("");
  }

  function parseOptionalPositiveInput(id) {
    const el = $(id);
    if (!el) return null;
    const value = (el.value || "").trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  }

  /**
   * Open paper-trade plan for overlays.
   * Entry = position.avgCost. Target/Stop: position fields, else latest Buy
   * order for symbol, else detail form (when that symbol is selected).
   * Returns null when flat / no open paper position.
   */
  function resolveOpenTradePlan(symbol) {
    if (!symbol) return null;
    const portfolio = loadPortfolio();
    const pos = portfolio.positions[symbol];
    if (!pos || !(Number(pos.qty) > 0)) return null;
    const entry = Number(pos.avgCost);
    if (!Number.isFinite(entry) || entry <= 0) return null;

    let target =
      pos.target != null && Number.isFinite(Number(pos.target))
        ? Number(pos.target)
        : null;
    let stop =
      pos.stop != null && Number.isFinite(Number(pos.stop))
        ? Number(pos.stop)
        : null;

    if (target == null || stop == null) {
      const orders = loadOrders();
      for (let i = orders.length - 1; i >= 0; i--) {
        const o = orders[i];
        if (!o || o.symbol !== symbol || o.side !== "Buy") continue;
        if (target == null && o.target != null && Number.isFinite(Number(o.target))) {
          target = Number(o.target);
        }
        if (stop == null && o.stop != null && Number.isFinite(Number(o.stop))) {
          stop = Number(o.stop);
        }
        break; // most recent Buy only
      }
    }

    if (selectedSymbol === symbol) {
      const formTarget = parseOptionalPositiveInput("detailTradeTarget");
      const formStop = parseOptionalPositiveInput("detailTradeStop");
      if (formTarget !== undefined && formTarget != null) target = formTarget;
      if (formStop !== undefined && formStop != null) stop = formStop;
    }

    return { entry: entry, target: target, stop: stop, qty: Number(pos.qty) };
  }

  function drawTradeLevelOverlays(ctx, plan, yAt, w, padL, padR) {
    if (!plan) return;
    const levels = [
      { key: "entry", label: "Entry", price: plan.entry, color: "#38bdf8" },
      { key: "target", label: "Limit/Target", price: plan.target, color: "#4ade80" },
      { key: "stop", label: "Stop", price: plan.stop, color: "#f87171" },
    ];
    levels.forEach((lv) => {
      if (lv.price == null || !Number.isFinite(Number(lv.price))) return;
      const y = yAt(Number(lv.price));
      ctx.save();
      ctx.strokeStyle = lv.color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lv.color;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const tag = lv.label + " $" + fmtMoney(lv.price);
      const tx = padL + 2;
      const ty = Math.max(12, y - 2);
      ctx.fillStyle = "rgba(15, 20, 25, 0.72)";
      const tw = ctx.measureText(tag).width + 6;
      ctx.fillRect(tx - 2, ty - 11, tw, 13);
      ctx.fillStyle = lv.color;
      ctx.fillText(tag, tx, ty);
      ctx.restore();
    });
  }

  function hideChartHover() {
    const tip = $("chartHoverTip");
    if (tip) {
      tip.hidden = true;
      tip.textContent = "";
    }
    if (chartPlotState) chartPlotState.hoverIndex = -1;
  }

  function updateChartHoverFromEvent(e) {
    const canvas = $("sparkCanvas");
    const tip = $("chartHoverTip");
    if (!canvas || !tip || !chartPlotState) {
      hideChartHover();
      return;
    }
    const st = chartPlotState;
    const pts = st.pts;
    const timestamps = st.timestamps;
    if (!pts || pts.length < 2) {
      hideChartHover();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      hideChartHover();
      return;
    }
    const scaleX = st.w / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;
    const n = pts.length;
    let idx = Math.round(
      ((mx - st.padL) / Math.max(1e-9, st.w - st.padL - st.padR)) * (n - 1)
    );
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    const price = pts[idx];
    if (price == null || !Number.isFinite(Number(price))) {
      hideChartHover();
      return;
    }
    st.hoverIndex = idx;
    const when =
      timestamps && timestamps[idx] != null
        ? formatChartTime(timestamps[idx], st.rangeId)
        : "";
    tip.hidden = false;
    tip.textContent =
      "$" +
      fmtMoney(price) +
      (when ? " · " + when : "") +
      " · pt " +
      (idx + 1) +
      "/" +
      n;

    // Re-paint crosshair on top of last series without inventing prices.
    paintHistoryChart(st.symbol, st.series, st.warning, { hoverIndex: idx });
  }

  function onTradePlanFormChange() {
    const targetEl = $("detailTradeTarget");
    const stopEl = $("detailTradeStop");
    if (targetEl) targetEl.dataset.autofilled = "0";
    if (stopEl) stopEl.dataset.autofilled = "0";
    if (!selectedSymbol) return;
    const portfolio = loadPortfolio();
    const pos = portfolio.positions[selectedSymbol];
    if (pos && Number(pos.qty) > 0) {
      const t = parseOptionalPositiveInput("detailTradeTarget");
      const s = parseOptionalPositiveInput("detailTradeStop");
      if (t === undefined || s === undefined) {
        // invalid number — do not persist; still try redraw from prior plan
      } else {
        if (t != null) pos.target = t;
        else delete pos.target;
        if (s != null) pos.stop = s;
        else delete pos.stop;
        portfolio.positions[selectedSymbol] = pos;
        savePortfolio(portfolio);
      }
    }
    redrawChartMarkersNow(selectedSymbol);
  }

    /** Paint price series + every action-history marker for symbol (sync). */
  function paintHistoryChart(symbol, series, warning, opts) {
    const canvas = $("sparkCanvas");
    const msg = $("chartMsg");
    const ctx = canvas.getContext("2d");
    const rangeId = selectedRangeId;
    const preset = getPreset(rangeId);
    const options = opts || {};
    const hoverIndex =
      options.hoverIndex != null ? options.hoverIndex : -1;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pts = (series && series.closes) || [];
    const timestamps = (series && series.timestamps) || [];
    const hist = actionHistoryForSymbol(symbol);
    const plan = resolveOpenTradePlan(symbol);

    if (pts.length < 2) {
      chartPlotState = null;
      hideChartHover();
      msg.className = "chart-msg" + (warning ? " warn" : "");
      msg.textContent =
        (warning ? warning + " · " : "") +
        "Not enough history points for " +
        preset.label +
        ".";
      const offAll = [];
      hist.forEach((entry) => {
        const atMs = Date.parse(entry.at);
        if (Number.isNaN(atMs)) return;
        offAll.push({
          from: entry.from,
          to: entry.to,
          label: formatChartTime(atMs / 1000, rangeId),
        });
      });
      updateMarkerUi(symbol, [], offAll);
      if (!pts.length) {
        ctx.strokeStyle = "#475569";
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(12, canvas.height / 2);
        ctx.lineTo(canvas.width - 12, canvas.height / 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }

    const w = canvas.width;
    const h = canvas.height;
    const padL = 12;
    const padR = 12;
    const padT = 18;
    const padB = 28;
    let min = Math.min.apply(null, pts);
    let max = Math.max.apply(null, pts);
    // Expand y-domain to include open-trade levels so overlays stay visible.
    if (plan) {
      [plan.entry, plan.target, plan.stop].forEach((p) => {
        if (p != null && Number.isFinite(Number(p))) {
          const v = Number(p);
          if (v < min) min = v;
          if (v > max) max = v;
        }
      });
    }
    const span = max - min || 1;

    function xAt(i) {
      return padL + (i / (pts.length - 1)) * (w - padL - padR);
    }
    function yAt(v) {
      return h - padB - ((v - min) / span) * (h - padT - padB);
    }

    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = xAt(i);
      const y = yAt(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Open paper position levels (hidden when flat).
    drawTradeLevelOverlays(ctx, plan, yAt, w, padL, padR);

    // Plot EVERY recorded status transition; off-range stay in legend.
    const tMin = timestamps[0];
    const tMax = timestamps[timestamps.length - 1];
    const plotted = [];
    const offChart = [];

    hist.forEach((entry) => {
      const atMs = Date.parse(entry.at);
      if (Number.isNaN(atMs)) return;
      const atSec = atMs / 1000;
      const whenLabel = formatChartTime(atSec, rangeId);
      if (atSec < tMin || atSec > tMax) {
        offChart.push({ from: entry.from, to: entry.to, label: whenLabel });
        return;
      }
      const idx = nearestIndex(timestamps, atSec);
      if (idx < 0) {
        offChart.push({ from: entry.from, to: entry.to, label: whenLabel });
        return;
      }
      const x = xAt(idx);
      const price = pts[idx];
      const y = yAt(price);
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#0f1419";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const label = entry.from + "→" + entry.to;
      ctx.fillStyle = "#fde68a";
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, x, Math.max(12, y - 10));
      plotted.push({
        from: entry.from,
        to: entry.to,
        label: formatChartTime(timestamps[idx], rangeId),
      });
    });

    // Hover crosshair at nearest plotted point (no invented prices).
    if (hoverIndex >= 0 && hoverIndex < pts.length) {
      const hx = xAt(hoverIndex);
      const hy = yAt(pts[hoverIndex]);
      ctx.save();
      ctx.strokeStyle = "rgba(226, 232, 240, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, h - padB);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(padL, hy);
      ctx.lineTo(w - padR, hy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#e2e8f0";
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = "#8b9bb4";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(formatChartTime(timestamps[0], rangeId), padL, h - 8);
    ctx.textAlign = "right";
    ctx.fillText(
      formatChartTime(timestamps[timestamps.length - 1], rangeId),
      w - padR,
      h - 8
    );

    const lastStr =
      series.last != null ? fmtMoney(series.last) : fmtMoney(pts[pts.length - 1]);
    msg.className = "chart-msg" + (warning ? " warn" : "");
    msg.textContent =
      (warning ? warning + " · " : "") +
      preset.label +
      " · Yahoo " +
      preset.range +
      "/" +
      preset.interval +
      " · " +
      pts.length +
      " pts" +
      (lastStr ? " · last " + lastStr : "");

    updateMarkerUi(symbol, plotted, offChart);

    chartPlotState = {
      symbol: symbol,
      series: series,
      warning: warning || null,
      pts: pts,
      timestamps: timestamps,
      rangeId: rangeId,
      w: w,
      h: h,
      padL: padL,
      padR: padR,
      padT: padT,
      padB: padB,
      min: min,
      max: max,
      hoverIndex: hoverIndex,
    };
  }

  /**
   * Immediately re-draw markers from localStorage history using cached series
   * when available (no invented prices). Falls back to a full fetch.
   */
  function redrawChartMarkersNow(symbol) {
    if (!symbol || selectedSymbol !== symbol) return;
    const key = cacheKey(symbol, selectedRangeId);
    const cached = chartCache[key];
    if (cached && cached.closes && cached.closes.length) {
      paintHistoryChart(symbol, cached, null);
      return true;
    }
    drawHistoryChart(symbol);
    return false;
  }

  async function drawHistoryChart(symbol) {
    const canvas = $("sparkCanvas");
    const msg = $("chartMsg");
    const token = ++chartFetchToken;
    const rangeId = selectedRangeId;
    const preset = getPreset(rangeId);
    const key = cacheKey(symbol, rangeId);

    msg.className = "chart-msg";
    msg.textContent = "Loading " + preset.label + " chart...";

    let series = null;
    let warning = null;

    try {
      const q = await fetchYahooChart(symbol, rangeId);
      if (token !== chartFetchToken || selectedSymbol !== symbol) return;
      quotesCorsBlocked = false;
      series = {
        timestamps: q.timestamps,
        closes: q.closes,
        last: q.last,
        fetchedAt: new Date().toISOString(),
      };
      chartCache[key] = series;
    } catch (err) {
      if (token !== chartFetchToken || selectedSymbol !== symbol) return;
      quotesCorsBlocked = true;
      const cached = chartCache[key];
      if (cached && cached.closes && cached.closes.length) {
        series = cached;
        warning =
          "Chart fetch failed (CORS/429/network) - showing last-known series. " +
          (err && err.message ? err.message : "");
      } else {
        warning =
          "Chart blocked (CORS/429/network). No invented prices. " +
          (err && err.message ? err.message : "");
        series = { timestamps: [], closes: [], last: null };
      }
    }

    if (token !== chartFetchToken || selectedSymbol !== symbol) return;
    paintHistoryChart(symbol, series, warning);
  }

  /**
   * Reload Action statuses from watchlist.json and re-apply local action history.
   * Merge rule (status refresh): research file actions win for symbols present in
   * the file; local-only overlay tickers keep their action; other overlay fields
   * (quotes, adds/removes, notes) are left intact. Does not invent prices.
   */
  async function refreshStatuses() {
    const btn = $("btnRefreshStatuses");
    if (btn) btn.disabled = true;
    setStatus("Refreshing action statuses from watchlist.json...");
    try {
      const res = await fetch(DATA_URL + "?t=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      baseFromFile = data;

      const fileBySym = {};
      (data.tickers || []).forEach((t) => {
        if (t && t.symbol) fileBySym[String(t.symbol)] = t;
      });

      let matched = 0;
      let changed = 0;
      state.tickers.forEach((t) => {
        const f = fileBySym[t.symbol];
        if (!f) return; // local-only ticker: keep overlay action
        matched++;
        const next = normalizeAction(f.action);
        if (normalizeAction(t.action) !== next) changed++;
        t.action = next;
        if (f.action_why != null) t.action_why = f.action_why;
      });

      if (data.status) state.status = data.status;
      if (data.horizon) state.horizon = data.horizon;
      state.updated_at = data.updated_at || state.updated_at;

      // Persist file-won actions into overlay; reload history from localStorage.
      saveOverlay();
      const hist = loadActionHistory();

      render();
      if (selectedSymbol) {
        const t = state.tickers.find((x) => x.symbol === selectedSymbol);
        if (t) {
          $("detailWhy").textContent = t.action_why || "No thesis note on file.";
          redrawChartMarkersNow(selectedSymbol);
        } else {
          updateMarkerUi(selectedSymbol, [], []);
        }
      }

      setStatus(
        "Statuses refreshed: " +
          matched +
          " file match(es), " +
          changed +
          " action(s) updated (file wins). " +
          hist.length +
          " local history entr" +
          (hist.length === 1 ? "y" : "ies") +
          " applied to chart markers.",
        "ok"
      );
    } catch (err) {
      setStatus(
        "Failed to refresh statuses: " +
          (err && err.message ? err.message : err),
        "err"
      );
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshQuotes() {
    if (!state.tickers.length) {
      setStatus("No tickers to refresh.", "warn");
      return;
    }
    setStatus("Refreshing quotes...");
    $("btnRefresh").disabled = true;
    let ok = 0;
    let fail = 0;
    let cors = false;
    let usedProxy = 0;
    let usedYahoo = 0;

    for (const t of state.tickers) {
      try {
        let q = null;
        // Prefer same-origin /api/quote (preview_server.py), then chart proxy/Yahoo.
        try {
          q = await fetchQuoteViaProxy(t.symbol);
          usedProxy++;
        } catch (_) {
          q = await fetchYahooChart(t.symbol, "5d");
          if (q.via === "proxy") usedProxy++;
          else usedYahoo++;
        }
        if (q.last != null) {
          t.last = q.last;
          t.change = q.change;
          t.change_pct = q.change_pct;
          ok++;
        } else {
          fail++;
        }
      } catch (err) {
        fail++;
        const msg = String(err && err.message ? err.message : err);
        if (
          /Failed to fetch|NetworkError|CORS|blocked|429/i.test(msg) ||
          err.name === "TypeError"
        ) {
          cors = true;
        }
      }
    }

    $("btnRefresh").disabled = false;
    if (ok > 0) {
      quotesCorsBlocked = false;
      state.updated_at = new Date().toISOString();
      saveOverlay();
      render();
      if (selectedSymbol) {
        updateDetailTradeHint(selectedSymbol);
        drawHistoryChart(selectedSymbol);
      }
    }
    checkPriceAlerts();

    if (cors && ok === 0) {
      quotesCorsBlocked = true;
      setStatus(
        "Refresh blocked by CORS - prices kept from watchlist.json (no invented prices).",
        "warn"
      );
    } else if (fail && ok) {
      setStatus(
        "Refreshed " +
          ok +
          "; " +
          fail +
          " failed (kept last known / file prices)" +
          (usedProxy ? " via proxy" : "") +
          ".",
        "warn"
      );
    } else if (ok) {
      const how =
        usedProxy && !usedYahoo
          ? " via local proxy"
          : usedYahoo && !usedProxy
            ? " via Yahoo"
            : usedProxy
              ? " (proxy + Yahoo fallback)"
              : "";
      setStatus("Quotes refreshed for " + ok + " ticker(s)" + how + ".", "ok");
    } else {
      setStatus(
        "Could not refresh quotes - keeping prices from watchlist.json.",
        "warn"
      );
    }
  }

  function downloadJson() {
    const out = {
      updated_at: state.updated_at,
      status: state.status || "committed",
      cap: CAP,
      horizon: state.horizon,
      book_usd: state.book_usd,
      tickers: state.tickers.map((t) => ({
        symbol: t.symbol,
        name: t.name || "",
        last: t.last != null ? t.last : null,
        change: t.change != null ? t.change : null,
        change_pct: t.change_pct != null ? t.change_pct : null,
        currency: t.currency || "USD",
        action: normalizeAction(t.action),
        action_why: t.action_why || "",
        size_usd: t.size_usd != null ? t.size_usd : null,
        source:
          t.source ||
          "https://finance.yahoo.com/quote/" + encodeURIComponent(t.symbol),
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "watchlist.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Downloaded updated watchlist.json", "ok");
  }


  function setCommitBusy(busy) {
    commitInFlight = !!busy;
    const submit = $("btnAddSubmit");
    const addBtn = $("btnAdd");
    if (submit) {
      submit.disabled = !!busy || (state.tickers.length >= CAP && !busy);
      submit.textContent = busy ? "Committing…" : "Add to watchlist";
    }
    if (addBtn) {
      addBtn.disabled = !!busy || state.tickers.length >= CAP;
    }
  }

  async function addTicker() {
    if (commitInFlight) {
      setStatus("Commit already in flight — wait for it to finish.", "warn");
      return;
    }
    if (state.tickers.length >= CAP) {
      setStatus(
        "Hard stop: watchlist is at cap (" + CAP + "). Cannot add a 21st ticker.",
        "err"
      );
      alert("Cannot add ticker: hard cap of " + CAP + " reached.");
      return;
    }
    const raw = ($("addSymbol").value || "").trim().toUpperCase();
    if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
      setStatus("Enter a valid symbol (letters/numbers).", "err");
      return;
    }
    if (state.tickers.some((t) => t.symbol === raw)) {
      setStatus(raw + " is already on the watchlist.", "err");
      return;
    }
    const name = ($("addName").value || "").trim();
    const action = normalizeAction($("addAction").value);
    const why = ($("addWhy").value || "").trim();
    const sizeRaw = ($("addSize").value || "").trim();
    const size_usd = sizeRaw === "" ? null : Number(sizeRaw);

    const ticker = {
      symbol: raw,
      name: name || raw,
      last: null,
      change: null,
      change_pct: null,
      currency: "USD",
      action,
      action_why: why,
      size_usd: size_usd != null && !Number.isNaN(size_usd) ? size_usd : null,
      source: "https://finance.yahoo.com/quote/" + encodeURIComponent(raw),
    };
    state.tickers.push(ticker);
    state.updated_at = new Date().toISOString();
    markPending(raw);
    saveOverlay();
    $("addPanel").classList.remove("open");
    $("addSymbol").value = "";
    $("addName").value = "";
    $("addWhy").value = "";
    $("addSize").value = "";
    render();
    setStatus(
      "Added " +
        raw +
        " (" +
        state.tickers.length +
        "/" +
        CAP +
        ") — committing to public file…",
      "ok"
    );
    setCommitBusy(true);
    try {
      await tryCommitAdd(ticker);
    } finally {
      setCommitBusy(false);
      renderMeta();
    }
  }

  function wireUi() {
    $("btnAdd").addEventListener("click", () => {
      if (state.tickers.length >= CAP) {
        setStatus(
          "Hard stop: at cap of " + CAP + " - cannot add another ticker.",
          "err"
        );
        return;
      }
      $("addPanel").classList.toggle("open");
    });
    $("btnAddCancel").addEventListener("click", () => {
      $("addPanel").classList.remove("open");
    });
    $("btnAddSubmit").addEventListener("click", addTicker);
    $("btnRefresh").addEventListener("click", refreshQuotes);
    $("btnRefreshStatuses").addEventListener("click", refreshStatuses);
    $("btnDownload").addEventListener("click", downloadJson);
    $("btnResetOverlay").addEventListener("click", () => {
      if (
        !confirm(
          "Clear local watchlist edits and reload the committed list from watchlist.json? (Paper portfolio / orders are separate and unchanged.)"
        )
      )
        return;
      localStorage.removeItem(STORAGE_KEY);
      bootstrap();
    });

    document.querySelectorAll(".range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-range");
        if (!id || id === selectedRangeId) {
          // still re-fetch if same range clicked
        }
        selectedRangeId = id || "1d";
        syncRangeButtons();
        if (selectedSymbol) drawHistoryChart(selectedSymbol);
      });
    });

    $("btnDetailBuy").addEventListener("click", (e) => {
      e.stopPropagation();
      onDetailPaperTrade("Buy");
    });
    $("btnDetailSell").addEventListener("click", (e) => {
      e.stopPropagation();
      onDetailPaperTrade("Sell");
    });
    const btnTicketBuy = $("btnTicketBuy");
    const btnTicketSell = $("btnTicketSell");
    if (btnTicketBuy) {
      btnTicketBuy.addEventListener("click", (e) => {
        e.stopPropagation();
        onTicketPaperTrade("Buy");
      });
    }
    if (btnTicketSell) {
      btnTicketSell.addEventListener("click", (e) => {
        e.stopPropagation();
        onTicketPaperTrade("Sell");
      });
    }
    const ticketSym = $("ticketSymbol");
    if (ticketSym) {
      ticketSym.addEventListener("change", () => fillTicketFromSymbol(ticketSym.value));
      ticketSym.addEventListener("blur", () => fillTicketFromSymbol(ticketSym.value));
    }
    ["ticketQty", "ticketPrice", "ticketTarget", "ticketStop", "ticketFee"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        el.dataset.autofilled = "0";
      });
    });
    $("btnResetPaper").addEventListener("click", resetPaperSim);
    $("btnAddAlert").addEventListener("click", addPriceAlert);
    $("btnClearAlerts").addEventListener("click", clearAllAlerts);
    $("startingCashInput").addEventListener("change", onStartingCashChange);
    $("detailTradeQty").addEventListener("input", () => {
      $("detailTradeQty").dataset.autofilled = "0";
    });
    $("detailTradePrice").addEventListener("input", () => {
      $("detailTradePrice").dataset.autofilled = "0";
    });
    const targetEl = $("detailTradeTarget");
    const stopEl = $("detailTradeStop");
    if (targetEl) targetEl.addEventListener("input", onTradePlanFormChange);
    if (stopEl) stopEl.addEventListener("input", onTradePlanFormChange);

    const canvas = $("sparkCanvas");
    if (canvas) {
      canvas.addEventListener("mousemove", updateChartHoverFromEvent);
      canvas.addEventListener("mouseleave", () => {
        hideChartHover();
        if (chartPlotState && chartPlotState.symbol) {
          paintHistoryChart(
            chartPlotState.symbol,
            chartPlotState.series,
            chartPlotState.warning
          );
        }
      });
    }

    const btnSettings = $("btnSettings");
    const settingsPanel = $("settingsPanel");
    if (btnSettings && settingsPanel) {
      btnSettings.addEventListener("click", () => {
        settingsPanel.classList.toggle("open");
        syncSettingsPatUi();
      });
    }
    const btnSettingsClose = $("btnSettingsClose");
    if (btnSettingsClose && settingsPanel) {
      btnSettingsClose.addEventListener("click", () => {
        settingsPanel.classList.remove("open");
      });
    }
    const patInput = $("settingsPat");
    if (patInput) {
      patInput.addEventListener("input", () => {
        patInput.dataset.editing = "1";
      });
    }
    const btnSavePat = $("btnSavePat");
    if (btnSavePat) {
      btnSavePat.addEventListener("click", () => {
        const val = ($("settingsPat") && $("settingsPat").value) || "";
        setGhPat(val);
        if ($("settingsPat")) {
          $("settingsPat").value = "";
          delete $("settingsPat").dataset.editing;
        }
        syncSettingsPatUi();
        setStatus(
          getGhPat()
            ? "Commit token saved in this browser only (localStorage)."
            : "Commit token cleared.",
          "ok"
        );
      });
    }
    const btnClearPat = $("btnClearPat");
    if (btnClearPat) {
      btnClearPat.addEventListener("click", () => {
        setGhPat("");
        if ($("settingsPat")) {
          $("settingsPat").value = "";
          delete $("settingsPat").dataset.editing;
        }
        syncSettingsPatUi();
        setStatus("Commit token cleared from this browser.", "ok");
      });
    }
    syncSettingsPatUi();
  }

  async function bootstrap() {
    setStatus("Loading watchlist.json...");
    try {
      const res = await fetch(DATA_URL + "?t=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      baseFromFile = data;
      const overlay = loadOverlay();
      repairEmptyOverlay(data, overlay);
      const merged = mergeOverlay(data, loadOverlay());
      state = {
        updated_at: merged.updated_at || "",
        status: merged.status || data.status || "",
        cap: CAP,
        horizon: merged.horizon || data.horizon || "",
        book_usd: merged.book_usd != null ? merged.book_usd : data.book_usd,
        tickers: (merged.tickers || []).slice(0, CAP).map((t) => ({
          ...t,
          action: normalizeAction(t.action),
        })),
      };
      if (state.tickers.length > CAP) state.tickers = state.tickers.slice(0, CAP);
      render();
      checkPriceAlerts();
      const fromOverlay = !!overlay;
      setStatus(
        "Loaded " +
          state.tickers.length +
          " ticker(s) from watchlist.json" +
          (fromOverlay ? " + local edits" : "") +
          ".",
        "ok"
      );
    } catch (err) {
      setStatus(
        "Failed to load watchlist.json: " +
          (err && err.message ? err.message : err),
        "err"
      );
    }
  }

  wireUi();
  bootstrap();
})();
