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

  // ====== FIXED COLUMNS (sirf yehi columns rakhne/dikhane hai) ======
  // Sheet me chahe jitne columns ho, app sirf inhi ko nikaal ke rakhega -> fast + clean.
  const WANTED_COLUMNS = [
    "Workshop",
    "DIVISION",
    "SUBSTATION",
    "PLACE OF DAMAGE",
    "CAPACITY",
    "COMPLAIN NUMBER",
    "COMPLAIN DATE",
    "PR NO",
    "PR DATE",
    "JE Name",
    "ISSUED TO FIRM",
    "ISSUE DATE",
    "DRIVER NAME",
    "DRIVER MOBILE",
    "REPLACEMENT DATE",
  ];

  // ====== MONTH TABS ======
  // Ye sheet me har mahine ka apna tab hota hai (e.g. "JULY-2026", "AUG-2026 TOTAL").
  // Current mahine wale tab me "TOTAL" suffix hota hai; pichle mahine wale tab me nahi.
  // App khud dono tab dhoondh ke unka data jodta hai — kisi fix gid/tabName ki zaroorat nahi.
  const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const MONTH_FULL = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
  ];
  const TAB_RESOLVE_CACHE_KEY = "sheet-search-tab-resolve-v1";
  let tabResolveCache = loadTabResolveCache();

  // LOCK MODE: ek hi sheet rahegi, user add/remove/delete nahi kar sakta (UI level par).
  const LOCKED_SINGLE_SHEET_MODE = true;

  // ====== PERMANENT DEFAULT SHEET (shared HTML ke liye) ======
  // Yaha apna Google Sheet URL daal do. Jis bhi phone me ye HTML/PWA open hogi,
  // pehli baar automatically ye sheet "Added Sheets" me aa jayegi.
  // Example:
  // const DEFAULT_SHEETS = [{ url: "https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0", name: "COMPILE", tabName: "COMPILE" }];
  const DEFAULT_SHEETS = [
    {
      url: "https://docs.google.com/spreadsheets/d/1qjOJ879V4FGGQtf2RvqjtSH1eHzGXh4fARJZE0LtdnM/edit",
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

  // ====== SELECTED MONTH ======
  // Default hamesha CURRENT calendar month hai. Dropdown se user purane mahine bhi search kar sakta hai.
  const _now0 = new Date();
  let selectedYear = _now0.getFullYear();
  let selectedMonthIdx = _now0.getMonth();

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
  const searchCard = $("#searchCard");
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
  btnRefresh.addEventListener("click", () => {
    btnRefresh.classList.add("spinning");
    refreshAll({ showStatus: true }).finally(() => btnRefresh.classList.remove("spinning"));
  });

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
  scopeSelect.addEventListener("change", () => {
    const [y, m] = scopeSelect.value.split("-").map(Number);
    if (!Number.isNaN(y) && !Number.isNaN(m)) {
      selectedYear = y;
      selectedMonthIdx = m;
    }
    void runSearchLive({ forceRefresh: true });
  });

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
    const now = new Date();
    const isCurrentSelection = selectedYear === now.getFullYear() && selectedMonthIdx === now.getMonth();

    const resolved = await resolveMonthTab(sheet.id, selectedYear, selectedMonthIdx, { preferTotal: isCurrentSelection });
    if (!resolved || !resolved.table) {
      throw new Error("Is mahine ka tab nahi mila (tab naam check karo)");
    }

    const parsed = parseGvizTable(resolved.table, selectedYear, selectedMonthIdx);

    const payload = {
      headers: WANTED_COLUMNS.slice(),
      rows: parsed.rows,
      updatedAt: Date.now(),
      tab: resolved.tabName,
      forYear: selectedYear,
      forMonth: selectedMonthIdx,
    };
    cacheMap.set(sheetKey(sheet), payload);
    localStorage.setItem(STORAGE_CACHE_PREFIX + sheetKey(sheet), JSON.stringify(payload));
  }

  // ---- Month tab resolution (koi bhi naam-format try karta hai jab tak sahi tab na mil jaye) ----

  function loadTabResolveCache() {
    try {
      const raw = localStorage.getItem(TAB_RESOLVE_CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveTabResolveCache() {
    try {
      localStorage.setItem(TAB_RESOLVE_CACHE_KEY, JSON.stringify(tabResolveCache));
    } catch {}
  }

  function buildTabNameCandidates(year, month, { preferTotal }) {
    const y4 = String(year);
    const y2 = y4.slice(-2);
    const abbr = MONTH_ABBR[month];
    const full = MONTH_FULL[month];
    const bases = [`${abbr}-${y4}`, `${full}-${y4}`, `${abbr}-${y2}`, `${full}-${y2}`, `${abbr} ${y4}`, `${full} ${y4}`];
    const withTotal = bases.flatMap((b) => [`${b} TOTAL`, `${b}-TOTAL`]);
    const list = preferTotal ? [...withTotal, ...bases] : [...bases, ...withTotal];
    return Array.from(new Set(list));
  }

  async function resolveMonthTab(spreadsheetId, year, month, { preferTotal }) {
    const cacheKey = `${spreadsheetId}|${year}-${month}`;
    const cachedName = tabResolveCache[cacheKey];

    // pehle cached (pichli baar kaam kiya) tab name try karo — fast path
    if (cachedName) {
      const hit = await tryFetchTab(spreadsheetId, cachedName);
      if (hit) return hit;
      delete tabResolveCache[cacheKey]; // ab kaam nahi kiya, cache clear karo
    }

    const candidates = buildTabNameCandidates(year, month, { preferTotal });
    for (const name of candidates) {
      const hit = await tryFetchTab(spreadsheetId, name);
      if (hit) {
        tabResolveCache[cacheKey] = name;
        saveTabResolveCache();
        return hit;
      }
    }
    return null;
  }

  async function tryFetchTab(spreadsheetId, tabName) {
    try {
      const url = buildGvizUrl(spreadsheetId, { tabName });
      const resp = await gvizRequest(url);
      if (resp?.status === "error") return null;
      if (!resp?.table) return null;
      return { tabName, table: resp.table };
    } catch {
      return null;
    }
  }

  // --------- Search ----------

  async function runSearchLive({ forceRefresh }) {
    const myRunId = ++searchRunId;
    const q = (searchInput.value || "").trim().toLowerCase();

    const scopeKeys = sheets.map(sheetKey);
    if (scopeKeys.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Drawer se sheet add karo.";
      return;
    }

    const matches = [];
    if (q.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Search type karo… (dropdown se mahina badal sakte ho)";
      setSearchLoading(false);
      return;
    }

    // Ensure data: cache miss / stale par sheet se fresh data lo
    setSearchLoading(true);
    setStatus("Sheet se data load ho raha hai…");
    await ensureFreshData(scopeKeys, { forceRefresh });
    if (myRunId !== searchRunId) return; // user ne naya type kar diya

    const availableKeys = scopeKeys.filter((k) => cacheMap.has(k));
    if (availableKeys.length === 0) {
      resultsEl.innerHTML = "";
      resultMeta.textContent = "Abhi data load nahi hua. Sheet access (Anyone with link) / Publish check karo, phir ⟳ dabao.";
      setStatus("Data load nahi hua.");
      setSearchLoading(false);
      return;
    }

    for (const key of availableKeys) {
      const sheet = getSheetByKey(key);
      const cached = cacheMap.get(key);
      if (!sheet || !cached) continue;
      const { headers, rows } = cached;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (rowMatches(row, q)) {
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

    setSearchLoading(false);
    setStatus("Ready");
  }

  function setSearchLoading(isLoading) {
    searchCard.classList.toggle("is-loading", !!isLoading);
  }

  async function ensureFreshData(keys, { forceRefresh }) {
    // sequential + queued for safety
    return queueRefresh(async () => {
      for (const key of keys) {
        const s = getSheetByKey(key);
        if (!s) continue;
        const cached = cacheMap.get(key);
        const age = cached?.updatedAt ? Date.now() - cached.updatedAt : Number.POSITIVE_INFINITY;
        const monthMismatch = !cached || cached.forYear !== selectedYear || cached.forMonth !== selectedMonthIdx;
        // user ne bola: "search par sheet se hi uthao" → yaha live refresh.
        // BUT spam avoid: 20 sec me max 1 fetch (per sheet). Mahina switch hote hi turant refresh karo.
        const needLive = age > LIVE_REFRESH_GAP_MS;
        if (forceRefresh || needLive || monthMismatch) {
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

  function rowMatches(row, q) {
    // "contains anywhere" match — plus punctuation-stripped match taaki
    // "PU11082613121" jaise IDs me embedded date/number bhi mil jaye ("110826" jaisa search).
    const qAlnum = q.replace(/[^a-z0-9]/g, "");
    for (const v of row) {
      const s = (v ?? "").toString().trim().toLowerCase();
      if (!s) continue;
      if (s.includes(q)) return true;
      if (qAlnum) {
        const sAlnum = s.replace(/[^a-z0-9]/g, "");
        if (sAlnum.includes(qAlnum)) return true;
      }
    }
    return false;
  }

  function renderResult(m, i) {
    const title = pickTitle(m.headers, m.row);
    const sub = pickSubtitle(m.headers, m.row);
    const delay = Math.min(i, 20) * 22; // ms — pehle 20 items hi stagger, baaki turant
    return `<li class="result" role="button" tabindex="0" data-key="${escapeHtml(m.key)}" data-idx="${m.index}" style="animation-delay:${delay}ms">
      <div class="result__top">
        <div class="result__title">${escapeHtml(title)}</div>
        <div class="result__sheet">${escapeHtml(m.sheetName)}</div>
      </div>
      <div class="result__sub">${escapeHtml(sub)}</div>
    </li>`;
  }

  function pickTitle(headers, row) {
    const num = getVal(headers, row, "COMPLAIN NUMBER");
    if (num) return `Complain #${num}`;
    return (row.find((x) => (x ?? "").toString().trim()) || "(Row)").toString();
  }
  function pickSubtitle(headers, row) {
    const parts = [
      getVal(headers, row, "DIVISION"),
      getVal(headers, row, "SUBSTATION"),
      getVal(headers, row, "COMPLAIN DATE"),
    ].filter(Boolean);
    return parts.join(" • ") || "—";
  }

  function openDetail(m) {
    detailTitle.textContent = `${m.sheetName} • Row ${m.index + 1}`;

    const replacementDate = getVal(m.headers, m.row, "REPLACEMENT DATE");
    const isReplaced = !!replacementDate;

    const banner = isReplaced
      ? `<div class="replaced-banner">
          <span class="replaced-banner__emoji">🎉</span>
          <div>
            <div class="replaced-banner__title">Transformer Replace ho gaya!</div>
            <div class="replaced-banner__date">${escapeHtml(replacementDate)}</div>
          </div>
        </div>`
      : "";

    detailBody.innerHTML =
      banner +
      m.row
        .map((v, i) => {
          const k = (m.headers[i] || `Col ${i + 1}`).trim() || `Col ${i + 1}`;
          const delay = i * 30;
          return `<div class="kv" style="animation-delay:${delay}ms"><div class="kv__k">${escapeHtml(k)}</div><div class="kv__v">${escapeHtml(String(v ?? ""))}</div></div>`;
        })
        .join("");

    detailDialog.showModal();

    if (isReplaced) {
      requestAnimationFrame(() => triggerReplacementCelebration(detailDialog));
    }
  }

  function triggerReplacementCelebration(container) {
    const layer = document.createElement("div");
    layer.className = "confetti-layer";
    container.appendChild(layer);

    const colors = ["#22d3c8", "#a78bfa", "#fb7185", "#fbbf24", "#34d399", "#60a5fa"];
    const PIECE_COUNT = 50;
    for (let i = 0; i < PIECE_COUNT; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti-piece";
      const left = Math.random() * 100;
      const delay = Math.random() * 220;
      const duration = 1000 + Math.random() * 700;
      const rotate = (Math.random() * 2 - 1) * 540;
      const drift = (Math.random() - 0.5) * 160;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const isRound = Math.random() < 0.35;
      piece.style.left = left + "%";
      piece.style.background = color;
      piece.style.animationDelay = delay + "ms";
      piece.style.animationDuration = duration + "ms";
      piece.style.setProperty("--rot", rotate + "deg");
      piece.style.setProperty("--drift", drift + "px");
      if (isRound) piece.style.borderRadius = "50%";
      layer.appendChild(piece);
    }

    setTimeout(() => layer.remove(), 2000);
  }

  // --------- Drawer / Sheet List ----------

  function renderSheets() {
    sheetList.innerHTML = "";
    for (const s of sheets) {
      const key = sheetKey(s);
      const cached = cacheMap.get(key);
      const updated = cached?.updatedAt ? formatTime(cached.updatedAt) : "not cached";
      const meta = [cached?.tab ? `tab: ${cached.tab}` : null, `updated: ${updated}`].filter(Boolean).join(" • ");

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
    const now = new Date();
    const opts = [];
    for (let i = 0; i < 12; i++) {
      let m = now.getMonth() - i;
      let y = now.getFullYear();
      while (m < 0) {
        m += 12;
        y -= 1;
      }
      const label = titleCase(MONTH_FULL[m]) + " " + y;
      const text = i === 0 ? `Current — ${label}` : label;
      opts.push(`<option value="${y}-${m}">${escapeHtml(text)}</option>`);
    }
    scopeSelect.innerHTML = opts.join("");
    scopeSelect.value = `${selectedYear}-${selectedMonthIdx}`;
  }

  function titleCase(s) {
    return s.charAt(0) + s.slice(1).toLowerCase();
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

  function parseGvizTable(table, targetYear, targetMonth) {
    if (!table) return { headers: WANTED_COLUMNS.slice(), rows: [] };

    const rawHeaders = (table.cols || []).map((c, idx) => (c?.label || c?.id || `Col ${idx + 1}`).toString());
    const rawRows = (table.rows || []).map((r) => r.c || []);

    // sheet ke actual headers -> index (normalized, case/space/punctuation-insensitive match)
    const headerIndexMap = new Map();
    rawHeaders.forEach((h, idx) => {
      const key = normalizeHeader(h);
      if (key && !headerIndexMap.has(key)) headerIndexMap.set(key, idx);
    });

    // hamare fixed WANTED_COLUMNS ka sheet me actual index nikalo (jo na mile uska -1)
    // 1) exact normalized match  2) substring fallback (jaise "Workshop Name" -> "Workshop")
    const wantedIndices = WANTED_COLUMNS.map((name) => {
      const key = normalizeHeader(name);
      if (headerIndexMap.has(key)) return headerIndexMap.get(key);
      for (const [hKey, idx] of headerIndexMap.entries()) {
        if (hKey.includes(key) || key.includes(hKey)) return idx;
      }
      return -1;
    });

    const complainDatePos = WANTED_COLUMNS.findIndex((n) => normalizeHeader(n) === "COMPLAIN DATE");
    const complainDateColIdx = complainDatePos >= 0 ? wantedIndices[complainDatePos] : -1;

    // allowed calendar month: jis mahine ka data fetch ho raha hai, sirf usi ka
    const targetYm = targetYear * 12 + targetMonth;

    const rows = [];
    for (const cells of rawRows) {
      // "…TOTAL" jaisi summary/blank rows ko skip karo — ye actual complain nahi hai.
      if (rowContainsTotalMarker(cells)) continue;
      if (isRowEffectivelyBlank(cells)) continue;

      // Tab already us mahine ka scope karta hai, lekin agar us tab ke andar bhi
      // koi purani (e.g. January wali) pending complaint pड़ी ho, to use bhi hata do.
      // Date parse na ho paye (khaali/ajeeb format) to row ko safe rakho — hide mat karo.
      if (complainDateColIdx >= 0) {
        const dt = parseGvizDateValue(cells[complainDateColIdx]?.v ?? cells[complainDateColIdx]?.f);
        if (dt) {
          const ym = dt.getFullYear() * 12 + dt.getMonth();
          if (ym !== targetYm) continue;
        }
      }

      const outRow = wantedIndices.map((idx) => {
        if (idx < 0) return "";
        const cell = cells[idx];
        if (!cell) return "";
        if (cell.f != null) return String(cell.f);
        if (cell.v != null) {
          const dt = parseGvizDateValue(cell.v);
          if (dt && /^Date\(/.test(String(cell.v))) return formatDateOnly(dt);
          return String(cell.v);
        }
        return "";
      });
      rows.push(outRow);
    }

    return { headers: WANTED_COLUMNS.slice(), rows };
  }

  function rowContainsTotalMarker(cells) {
    for (const cell of cells) {
      if (!cell) continue;
      const text = (cell.f != null ? String(cell.f) : cell.v != null ? String(cell.v) : "").trim().toUpperCase();
      if (text.includes("TOTAL")) return true;
    }
    return false;
  }

  function isRowEffectivelyBlank(cells) {
    return !cells.some((cell) => {
      if (!cell) return false;
      const text = (cell.f != null ? String(cell.f) : cell.v != null ? String(cell.v) : "").trim();
      return text.length > 0;
    });
  }

  function normalizeHeader(s) {
    let t = String(s || "")
      .replace(/\(.*?\)/g, " ") // "(DD/MM/YYYY)" jaise notes hatao
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
    // "NUMBER"/"NUM"/"NO." jaise variants ko ek se canonical "NO" me convert karo
    t = t.replace(/\bNUMBER\b/g, "NO").replace(/\bNUM\b/g, "NO").replace(/\bNO\b/g, "NO");
    // MOBILE/PHONE/CONTACT ke "... NO" suffix ko ek canonical form me convert karo
    t = t.replace(/\b(MOBILE|PHONE|CONTACT)\s+NO\b/g, "MOBILE");
    return t.replace(/\s+/g, " ").trim();
  }

  function parseGvizDateValue(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;

    // GViz date cell format: Date(YYYY,M,D) ya Date(YYYY,M,D,H,Mi,S) — M yaha 0-indexed hota hai.
    let m = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (m) {
      const [, y, mo, d, h, mi, se] = m;
      return new Date(Number(y), Number(mo), Number(d), Number(h || 0), Number(mi || 0), Number(se || 0));
    }

    // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY (Indian convention; 2 ya 4 digit year)
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      const [, dd, mo, yy] = m;
      let year = Number(yy);
      if (year < 100) year += 2000;
      const dt = new Date(year, Number(mo) - 1, Number(dd));
      if (!isNaN(dt.getTime())) return dt;
    }

    // ISO format YYYY-MM-DD
    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) {
      const [, yy, mo, dd] = m;
      const dt = new Date(Number(yy), Number(mo) - 1, Number(dd));
      if (!isNaN(dt.getTime())) return dt;
    }

    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  function formatDateOnly(d) {
    try {
      return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    } catch {
      return d.toDateString();
    }
  }

  function getVal(headers, row, name) {
    const idx = headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(name));
    if (idx < 0) return "";
    return (row[idx] ?? "").toString().trim();
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
