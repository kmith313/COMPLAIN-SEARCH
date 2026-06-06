/* Sheet Search PWA
   - Multiple Google Sheets add kar sakte ho (Spreadsheet URL)
   - Data cache localStorage me save hota hai (side drawer me list)
   - Main screen par sirf Search + Results
   - Har 5 min me auto-refresh (background) */

(() => {
  const STORAGE_META = "sheetSearch:sheets:v1";
  const STORAGE_CACHE_PREFIX = "sheetSearch:cache:v1:"; // + sheetId
  const REFRESH_MS = 5 * 60 * 1000;
  const LIVE_SEARCH_DEBOUNCE_MS = 350; // typing par sheet se data leke search
  const LIVE_REFRESH_GAP_MS = 20 * 1000; // har keypress par spam na ho; 20s me max 1 live refresh

  // LOCK MODE: ek hi sheet rahegi, user add/remove/delete nahi kar sakta (UI level par).
  const LOCKED_SINGLE_SHEET_MODE = true;

  // ====== PERMANENT DEFAULT SHEET (shared HTML ke liye) ======
  // Yaha apna Google Sheet URL daal do. Jis bhi phone me ye HTML/PWA open hogi,
  // pehli baar automatically ye sheet "Added Sheets" me aa jayegi.
  // Example:
  // const DEFAULT_SHEETS = [{ url: "https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0", name: "COMPILE", tabName: "COMPILE" }];
  const DEFAULT_SHEETS = [
    {
      url: "https://docs.google.com/spreadsheets/d/1qjOJ879V4FGGQtf2RvqjtSH1eHzGXh4fARJZE0LtdnM/edit?gid=1464518527#gid=1464518527",
      name: "COMPILE"
    }
  ];

  // refresh queue: GViz JSONP single-flight safe rakho
  let refreshQueue = Promise.resolve();
  const queueRefresh = (fn) => (refreshQueue = refreshQueue.then(fn, fn));

  /** @type {Array<{id:string, url:string, name:string, tabName?:string, gid?:string, addedAt:number}>} */
  let sheets = [];
  /** @type {Map<string, {headers:string[], rows:string[][], updatedAt:number}>} */
  const cacheMap = new Map();
  let searchRunId = 0;

  // DOM
  const btnMenu = $("#btnMenu");
  const btnRefresh = $("#btnRefresh");
  const btnCloseDrawer = $("#btnCloseDrawer");
  const drawer = $("#drawer");
  const backdrop = $("#backdrop");
  const sheetList = $("#sheetList");
  const addForm = $("#addForm");
  const sheetUrlInput = $("#sheetUrl");
  const sheetNameInput = $("#sheetName");
  const tabNameInput = $("#tabName");
  const btnClearCache = $("#btnClearCache");
  const searchInput = $("#searchInput");
  const resultsEl = $("#results");
  const resultMeta = $("#resultMeta");
  const scopeSelect = $("#scopeSelect");
  const statusLine = $("#statusLine");
  const lastUpdatedEl = $("#lastUpdated");

  const detailDialog = $("#detailDialog");
  const btnCloseDetail = $("#btnCloseDetail");
  const detailTitle = $("#detailTitle");
  const detailBody = $("#detailBody");

  // --------- Init ----------
  loadSheets();
  loadCaches();
  renderSheets();
  renderScopeOptions();
  updateLastUpdatedUI();

  // initial refresh + interval
  refreshAll({ showStatus: true }).catch(() => {});
  setInterval(() => refreshAll({ showStatus: false }).catch(() => {}), REFRESH_MS);

  // --------- Events ----------
  btnMenu.addEventListener("click", openDrawer);
  btnCloseDrawer.addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  btnRefresh.addEventListener("click", () => refreshAll({ showStatus: true }));

  btnClearCache.addEventListener("click", () => {
    if (!confirm("Cache clear karna hai? (Sheet list rahegi, sirf data cache delete hoga)")) return;
    for (const s of sheets) {
      const key = sheetKey(s);
      localStorage.removeItem(STORAGE_CACHE_PREFIX + key);
      cacheMap.delete(key);
    }
    updateLastUpdatedUI();
    void runSearchLive({ forceRefresh: true });
    setStatus("Cache cleared.");
  });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (LOCKED_SINGLE_SHEET_MODE) {
      alert("Ye app locked hai: single fixed sheet. Add/Remove allowed nahi hai.");
      return;
    }
    const url = sheetUrlInput.value.trim();
    const name = sheetNameInput.value.trim();
    const tabName = tabNameInput.value.trim();
    try {
      const parsed = parseGoogleSheetUrl(url);
      const id = parsed.spreadsheetId;
      const gid = parsed.gid || undefined;

      // already exists?
      if (sheets.some((x) => x.id === id && (x.tabName || "") === (tabName || "") && (x.gid || "") === (gid || ""))) {
        alert("Ye sheet already added hai.");
        return;
      }

      const displayName = name || buildDefaultName(id, tabName || gid);
      sheets.push({
        id,
        url,
        name: displayName,
        tabName: tabName || undefined,
        gid,
        addedAt: Date.now(),
      });
      saveSheets();
      renderSheets();
      renderScopeOptions();
      closeDrawer();
      sheetUrlInput.value = "";
      sheetNameInput.value = "";
      tabNameInput.value = "";
      setStatus("Sheet added. Refreshing…");
      const newKey = sheetKey(sheets[sheets.length - 1]);
      refreshByKey(newKey, { showStatus: true }).catch(() => {});
    } catch (err) {
      alert(String(err?.message || err));
    }
  });

  searchInput.addEventListener(
    "input",
    debounce(() => {
      void runSearchLive({ forceRefresh: false });
    }, LIVE_SEARCH_DEBOUNCE_MS)
  );
  scopeSelect.addEventListener("change", () => void runSearchLive({ forceRefresh: true }));

  btnCloseDetail.addEventListener("click", () => detailDialog.close());
  detailDialog.addEventListener("click", (e) => {
    const rect = detailDialog.getBoundingClientRect();
    const inDialog =
      rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
    if (!inDialog) detailDialog.close();
  });

  // --------- Core: refresh ----------

  async function refreshAll({ showStatus }) {
    if (sheets.length === 0) {
      if (showStatus) setStatus("Drawer se sheet add karo.");
      return;
    }
    if (showStatus) setStatus("Refreshing all sheets…");

    await queueRefresh(async () => {
      // Important: gviz JSONP hook ek time par 1 request safe hai, isliye sequential.
      for (const s of sheets) {
        await refreshSheet(s).catch((e) => {
          if (showStatus) setStatus(`Refresh fail: ${s.name} (${e?.message || e})`);
        });
      }
    });

    updateLastUpdatedUI();
    void runSearchLive({ forceRefresh: false });
    if (showStatus) setStatus("Updated.");
  }

  async function refreshByKey(key, { showStatus }) {
    const s = getSheetByKey(key);
    if (!s) return;
    if (showStatus) setStatus(`Refreshing: ${s.name}…`);
    await queueRefresh(() => refreshSheet(s));
    updateLastUpdatedUI();
    void runSearchLive({ forceRefresh: false });
    if (showStatus) setStatus("Updated.");
  }

  async function refreshSheet(sheet) {
    const url = buildGvizUrl(sheet.id, sheet);
    const resp = await gvizRequest(url);
    if (resp?.status === "error") {
      const msg = resp?.errors?.[0]?.detailed_message || "GViz error";
      throw new Error(msg);
    }
    const parsed = parseGvizTable(resp?.table);
    const payload = { ...parsed, updatedAt: Date.now() };
    cacheMap.set(sheetKey(sheet), payload);
    localStorage.setItem(STORAGE_CACHE_PREFIX + sheetKey(sheet), JSON.stringify(payload));
  }

  // --------- Search ----------

  async function runSearchLive({ forceRefresh }) {
    const myRunId = ++searchRunId;
    const q = (searchInput.value || "").trim().toLowerCase();
    const scope = scopeSelect.value;

    const scopeKeys = getScopeSheetKeys(scope);
    if (scopeKeys.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Drawer se sheet add karo.";
      return;
    }

    const matches = [];
    if (q.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Search type karo…";
      return;
    }

    // Ensure data: cache miss / stale par sheet se fresh data lo
    setStatus("Sheet se data load ho raha hai…");
    await ensureFreshData(scopeKeys, { forceRefresh });
    if (myRunId !== searchRunId) return; // user ne naya type kar diya

    const availableKeys = scopeKeys.filter((k) => cacheMap.has(k));
    if (availableKeys.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Abhi data load nahi hua. Sheet access (Anyone with link) / Publish check karo, phir ⟳ dabao.";
      setStatus("Data load nahi hua.");
      return;
    }

    for (const key of availableKeys) {
      const sheet = getSheetByKey(key);
      const cached = cacheMap.get(key);
      if (!sheet || !cached) continue;
      const { headers, rows } = cached;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (rowStartsWith(row, q)) {
          matches.push({ key, sheetName: sheet.name, headers, row, index: i });
        }
      }
    }

    // UI render (limit for performance on mobile)
    const LIMIT = 250;
    const shown = matches.slice(0, LIMIT);
    resultsEl.innerHTML = shown.map(renderResult).join("");
    resultMeta.textContent =
      matches.length <= LIMIT ? `${matches.length} result(s)` : `${matches.length} result(s) — showing first ${LIMIT}`;

    // click handlers
    for (const li of resultsEl.querySelectorAll("li.result")) {
      li.addEventListener("click", () => {
        const key = li.getAttribute("data-key");
        const idx = Number(li.getAttribute("data-idx"));
        const m = matches.find((x) => x.key === key && x.index === idx);
        if (m) openDetail(m);
      });
    }

    setStatus("Ready");
  }

  async function ensureFreshData(keys, { forceRefresh }) {
    // sequential + queued for safety
    return queueRefresh(async () => {
      for (const key of keys) {
        const s = getSheetByKey(key);
        if (!s) continue;
        const cached = cacheMap.get(key);
        const age = cached?.updatedAt ? Date.now() - cached.updatedAt : Number.POSITIVE_INFINITY;
        // user ne bola: "search par sheet se hi uthao" → yaha live refresh.
        // BUT spam avoid: 20 sec me max 1 fetch (per sheet).
        const needLive = age > LIVE_REFRESH_GAP_MS;
        if (forceRefresh || needLive) {
          try {
            await refreshSheet(s);
          } catch (e) {
            // keep going for other sheets
          }
        }
      }
      updateLastUpdatedUI();
      renderSheets();
    });
  }

  function rowStartsWith(row, q) {
    // starts-with: kisi bhi cell ka beginning match
    for (const v of row) {
      const s = (v ?? "").toString().trim().toLowerCase();
      if (s.startsWith(q)) return true;
    }
    return false;
  }

  function renderResult(m) {
    const title = pickTitle(m.row);
    const sub = pickSubtitle(m.row);
    return `<li class="result" role="button" tabindex="0" data-key="${escapeHtml(m.key)}" data-idx="${m.index}">
      <div class="result__top">
        <div class="result__title">${escapeHtml(title)}</div>
        <div class="result__sheet">${escapeHtml(m.sheetName)}</div>
      </div>
      <div class="result__sub">${escapeHtml(sub)}</div>
    </li>`;
  }

  function pickTitle(row) {
    return (row.find((x) => (x ?? "").toString().trim()) || "(Row)").toString();
  }
  function pickSubtitle(row) {
    const vals = row.map((x) => (x ?? "").toString()).filter((x) => x.trim());
    return vals.slice(1, 4).join(" • ") || "—";
  }

  function openDetail(m) {
    detailTitle.textContent = `${m.sheetName} • Row ${m.index + 1}`;
    detailBody.innerHTML = m.row
      .map((v, i) => {
        const k = (m.headers[i] || `Col ${i + 1}`).trim() || `Col ${i + 1}`;
        return `<div class="kv"><div class="kv__k">${escapeHtml(k)}</div><div class="kv__v">${escapeHtml(String(v ?? ""))}</div></div>`;
      })
      .join("");
    detailDialog.showModal();
  }

  // --------- Drawer / Sheet List ----------

  function renderSheets() {
    sheetList.innerHTML = "";
    for (const s of sheets) {
      const key = sheetKey(s);
      const cached = cacheMap.get(key);
      const updated = cached?.updatedAt ? formatTime(cached.updatedAt) : "not cached";
      const meta = [s.tabName ? `tab: ${s.tabName}` : null, s.gid ? `gid: ${s.gid}` : null, `updated: ${updated}`]
        .filter(Boolean)
        .join(" • ");

      const li = document.createElement("li");
      li.className = "sheet-item";
      li.innerHTML = `
        <div>
          <div class="sheet-item__name">${escapeHtml(s.name)}</div>
          <div class="sheet-item__meta">${escapeHtml(meta)}</div>
        </div>
        <div class="sheet-item__actions">
          <button class="btn btn--ghost" data-action="refresh" data-key="${escapeHtml(key)}" type="button">⟳</button>
          ${LOCKED_SINGLE_SHEET_MODE ? "" : `<button class="btn btn--danger" data-action="remove" data-key="${escapeHtml(key)}" type="button">Del</button>`}
        </div>`;

      sheetList.appendChild(li);
    }

    // handlers
    sheetList.querySelectorAll("button[data-action='remove']").forEach((b) => {
      b.addEventListener("click", () => {
        if (LOCKED_SINGLE_SHEET_MODE) {
          alert("Locked mode: delete allowed nahi hai.");
          return;
        }
        const key = b.getAttribute("data-key");
        const s = getSheetByKey(key);
        if (!s) return;
        if (!confirm(`Remove "${s.name}"?`)) return;
        sheets = sheets.filter((x) => sheetKey(x) !== key);
        saveSheets();
        localStorage.removeItem(STORAGE_CACHE_PREFIX + key);
        cacheMap.delete(key);
        renderSheets();
        renderScopeOptions();
        updateLastUpdatedUI();
        void runSearchLive({ forceRefresh: false });
      });
    });

    sheetList.querySelectorAll("button[data-action='refresh']").forEach((b) => {
      b.addEventListener("click", async () => {
        const key = b.getAttribute("data-key");
        await refreshByKey(key, { showStatus: true }).catch((e) => setStatus(String(e?.message || e)));
        renderSheets();
      });
    });
  }

  function renderScopeOptions() {
    const prev = scopeSelect.value;
    const opts = [`<option value="__all__">All Sheets</option>`].concat(
      sheets.map((s) => `<option value="${escapeHtml(sheetKey(s))}">${escapeHtml(s.name)}</option>`)
    );
    scopeSelect.innerHTML = opts.join("");
    // restore previous selection if possible
    if ([...scopeSelect.options].some((o) => o.value === prev)) scopeSelect.value = prev;
  }

  function getScopeSheetKeys(scope) {
    if (scope === "__all__") return sheets.map(sheetKey);
    return sheets.some((s) => sheetKey(s) === scope) ? [scope] : [];
  }

  function sheetKey(sheet) {
    // same spreadsheet ko different tabName ke saath allow
    return `${sheet.id}|${sheet.tabName || ""}|${sheet.gid || ""}`;
  }
  function getSheetByKey(key) {
    return sheets.find((s) => sheetKey(s) === key) || null;
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    backdrop.hidden = false;
  }
  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    backdrop.hidden = true;
  }

  // --------- LocalStorage ----------

  function loadSheets() {
    try {
      const raw = localStorage.getItem(STORAGE_META);
      sheets = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(sheets)) sheets = [];
    } catch {
      sheets = [];
    }

    // DEFAULT_SHEETS se seed (locked mode me hamesha overwrite)
    if ((LOCKED_SINGLE_SHEET_MODE || !sheets || sheets.length === 0) && Array.isArray(DEFAULT_SHEETS) && DEFAULT_SHEETS.length > 0) {
      const seeded = [];
      for (const def of DEFAULT_SHEETS) {
        try {
          if (!def?.url) continue;
          const parsed = parseGoogleSheetUrl(String(def.url));
          const id = parsed.spreadsheetId;
          const gid = def.gid || parsed.gid || undefined;
          const tabName = def.tabName ? String(def.tabName) : undefined;
          const displayName = def.name ? String(def.name) : buildDefaultName(id, tabName || gid);
          seeded.push({
            id,
            url: String(def.url),
            name: displayName,
            tabName,
            gid,
            addedAt: Date.now(),
          });
        } catch {
          // ignore invalid default
        }
      }
      if (seeded.length) {
        sheets = seeded;
        // locked mode me localStorage me bhi force save karo (so list consistent rahe)
        saveSheets();
      }
    }
  }
  function saveSheets() {
    localStorage.setItem(STORAGE_META, JSON.stringify(sheets));
  }
  function loadCaches() {
    cacheMap.clear();
    for (const s of sheets) {
      const key = sheetKey(s);
      try {
        const raw = localStorage.getItem(STORAGE_CACHE_PREFIX + key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.rows && parsed?.headers) cacheMap.set(key, parsed);
      } catch {
        // ignore
      }
    }
  }

  function updateLastUpdatedUI() {
    const times = [];
    for (const key of cacheMap.keys()) {
      const t = cacheMap.get(key)?.updatedAt;
      if (t) times.push(t);
    }
    if (!times.length) {
      lastUpdatedEl.textContent = "No cache";
      return;
    }
    const newest = Math.max(...times);
    lastUpdatedEl.textContent = `Last: ${formatTime(newest)}`;
  }

  // --------- Google Sheet URL parsing + GViz fetch ----------

  function parseGoogleSheetUrl(url) {
    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) throw new Error("Invalid Google Sheet URL. Example: https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0");
    const spreadsheetId = m[1];

    const gid = (url.match(/[?#&]gid=([0-9]+)/) || [])[1] || (url.match(/#gid=([0-9]+)/) || [])[1] || "";
    return { spreadsheetId, gid };
  }

  function buildGvizUrl(spreadsheetId, sheet) {
    const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq`;
    const params = new URLSearchParams();
    // NOTE: tqx=out:json is always appended in gvizRequest
    if (sheet?.tabName) params.set("sheet", sheet.tabName);
    else if (sheet?.gid) params.set("gid", sheet.gid);
    return `${base}?${params.toString()}`;
  }

  // JSONP style: docs.google.com response executes google.visualization.Query.setResponse(...)
  async function gvizRequest(url) {
    return new Promise((resolve, reject) => {
      const timeoutMs = 15000;
      const t = setTimeout(() => cleanup(reject, new Error("Timeout while loading sheet")), timeoutMs);

      // ensure hook exists
      if (!window.google) window.google = {};
      if (!window.google.visualization) window.google.visualization = {};
      if (!window.google.visualization.Query) window.google.visualization.Query = {};

      const old = window.google.visualization.Query.setResponse;
      window.google.visualization.Query.setResponse = (resp) => cleanup(resolve, resp);

      const s = document.createElement("script");
      s.async = true;
      s.src = url + (url.includes("?") ? "&" : "?") + "tqx=out:json";
      s.onerror = () => cleanup(reject, new Error("Sheet load failed (permission/publish check karo)"));
      document.body.appendChild(s);

      function cleanup(done, value) {
        clearTimeout(t);
        try {
          s.remove();
        } catch {}
        // restore old handler (single-flight design)
        window.google.visualization.Query.setResponse = old;
        done(value);
      }
    });
  }

  function parseGvizTable(table) {
    if (!table) return { headers: [], rows: [] };
    const headers = (table.cols || []).map((c, idx) => (c?.label || c?.id || `Col ${idx + 1}`).toString());
    const rows = (table.rows || []).map((r) =>
      (r.c || []).map((cell) => {
        if (!cell) return "";
        if (cell.f != null) return String(cell.f);
        if (cell.v != null) return String(cell.v);
        return "";
      })
    );
    return { headers, rows };
  }

  function buildDefaultName(id, extra) {
    const tail = id.slice(-6);
    return extra ? `Sheet-${tail} (${extra})` : `Sheet-${tail}`;
  }

  // --------- Helpers ----------
  function $(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el;
  }

  function setStatus(msg) {
    statusLine.textContent = msg;
  }

  function debounce(fn, wait) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
    } catch {
      return String(ts);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
