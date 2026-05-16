const vscode = acquireVsCodeApi();

const searchList = document.getElementById("searchList");
const refreshBtn = document.getElementById("refreshBtn");
const addBtn = document.getElementById("addBtn");
const historyList = document.getElementById("historyList");
const combinedPanel = document.getElementById("combinedPanel");
const debugPanel = document.getElementById("debugPanel");

let state = {
  entries: [],
  history: [],
  canAdd: true,
  maxEntries: 10,
  combined: {
    enabled: false,
    mode: "ordered",
    maxGap: 3,
    collapsed: true,
    count: 0,
    results: [],
    debug: {
      tokens: [],
      reason: ""
    }
  }
};
let debounceTimer = null;
let activeHistoryTargetId = null;

function captureQueryFocus() {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) {
    return null;
  }
  if (!el.classList.contains("query")) {
    return null;
  }
  const id = el.dataset.id;
  if (!id) {
    return null;
  }
  return {
    id,
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? 0
  };
}

function restoreQueryFocus(snapshot) {
  if (!snapshot) {
    return;
  }
  const selector = `.query[data-id="${snapshot.id}"]`;
  const el = searchList.querySelector(selector);
  if (!(el instanceof HTMLInputElement)) {
    return;
  }
  el.focus();
  try {
    el.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    // Ignore selection restore failures.
  }
}

function postState() {
  const payload = state.entries.map((entry) => ({
    id: entry.id,
    enabled: entry.enabled,
    query: entry.query,
    mode: entry.mode,
    caseSensitive: entry.caseSensitive,
    wholeWord: entry.wholeWord,
    color: entry.color
  }));
  vscode.postMessage({ type: "updateState", payload });
}

function debouncePost() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(postState, 120);
}

function setEntry(id, patch) {
  const idx = state.entries.findIndex((item) => item.id === id);
  if (idx < 0) {
    return null;
  }
  const next = { ...state.entries[idx], ...patch };
  state.entries[idx] = next;
  return next;
}

function postCombinedConfig(patch) {
  state.combined = { ...state.combined, ...patch };
  vscode.postMessage({
    type: "updateCombinedConfig",
    payload: patch
  });
  renderCombined();
}

function renderAll() {
  const focus = captureQueryFocus();
  renderCombined();
  renderEntries();
  renderHistory();
  renderDebug();
  restoreQueryFocus(focus);
  if (addBtn) {
    addBtn.disabled = !state.canAdd;
    addBtn.title = state.canAdd ? "" : `Max ${state.maxEntries} search boxes`;
  }
}

function renderDebug() {
  if (!debugPanel) {
    return;
  }
  const c = state.combined || {};
  const dbg = c.debug || {};
  const tokens = Array.isArray(dbg.tokens) ? dbg.tokens : [];
  const reason = dbg.reason || "";
  const mode = c.mode || "ordered";
  const gap = Number(c.maxGap || 0);

  debugPanel.innerHTML = `
    <div class="debug-title">Combined Debug</div>
    <div class="debug-row"><strong>enabled:</strong> ${Boolean(c.enabled)}</div>
    <div class="debug-row"><strong>mode:</strong> ${escapeHtml(String(mode))}</div>
    <div class="debug-row"><strong>gap:</strong> ${gap}</div>
    <div class="debug-row"><strong>tokens:</strong> ${tokens.length ? tokens.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ") : "(none)"}</div>
    <div class="debug-row"><strong>reason:</strong> ${escapeHtml(String(reason))}</div>
  `;
}

function renderCombined() {
  const c = state.combined;
  const modeLabel =
    c.mode === "ordered" ? "Ordered" : c.mode === "unordered" ? "Unordered" : "Adjacent";
  const resultRows = (Array.isArray(c.results) ? c.results : [])
    .map(
      (item) => `
      <div class="combined-item">
        <div class="combined-pos">L${item.startLine}:${item.startCol} - L${item.endLine}:${item.endCol}</div>
        <div class="combined-preview">${escapeHtml(item.preview || "")}</div>
      </div>
    `
    )
    .join("");

  combinedPanel.innerHTML = `
    <div class="combined-head">
      <label class="combined-enable">
        <input id="combinedEnabled" type="checkbox" ${c.enabled ? "checked" : ""} />
        <span>Combined Search</span>
      </label>
      <span class="combined-count">${c.count || 0}</span>
    </div>
    <div class="combined-controls">
      <select id="combinedMode" class="mode-small">
        <option value="ordered" ${c.mode === "ordered" ? "selected" : ""}>Ordered</option>
        <option value="unordered" ${c.mode === "unordered" ? "selected" : ""}>Unordered</option>
        <option value="adjacent" ${c.mode === "adjacent" ? "selected" : ""}>Adjacent</option>
      </select>
      <label class="gap-wrap ${c.mode === "adjacent" ? "" : "hidden"}">
        Gap
        <input id="combinedGap" class="gap-input" type="number" min="0" max="200" value="${Number(c.maxGap || 0)}" />
      </label>
      <span class="mode-tag">${modeLabel}</span>
      <span class="spacer"></span>
      <button class="ghost icon" id="combinedPrev" type="button" title="Previous Combined Match">&#8593;</button>
      <button class="ghost icon" id="combinedNext" type="button" title="Next Combined Match">&#8595;</button>
      <button class="ghost mini" id="toggleCombinedCollapse" type="button">${c.collapsed ? "Expand" : "Collapse"}</button>
    </div>
    <div class="combined-results ${c.collapsed ? "hidden" : ""}">
      ${
        resultRows
          ? resultRows
          : '<div class="combined-empty">No combined matches in active file</div>'
      }
    </div>
  `;
}

function renderEntries() {
  searchList.innerHTML = "";
  state.entries.forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="card-head">
        <div class="label">Search ${index + 1} · ${entry.matchCount || 0}</div>
        <input class="color" data-id="${entry.id}" data-key="color" type="color" value="${entry.color}" />
      </div>
      <div class="query-row">
        <input class="query" data-id="${entry.id}" data-key="query" type="text" placeholder="Search..." value="${escapeHtml(
          entry.query
        )}" />
        <button class="ghost danger" data-id="${entry.id}" data-action="removeOne" type="button" title="Delete">x</button>
      </div>
      <div class="opts">
        <button class="ghost icon ${entry.mode === "regex" ? "active" : ""}" data-id="${
          entry.id
        }" data-action="toggleRegex" type="button" title="Use Regular Expression">.*</button>
        <button class="ghost icon ${entry.caseSensitive ? "active" : ""}" data-id="${
          entry.id
        }" data-action="toggleCase" type="button" title="Match Case">Aa</button>
        <button class="ghost icon ${entry.wholeWord ? "active" : ""}" data-id="${
          entry.id
        }" data-action="toggleWord" type="button" title="Match Whole Word">ab</button>
        <span class="spacer"></span>
        <button class="ghost icon" data-id="${entry.id}" data-action="prev" type="button" title="Previous Match">&#8593;</button>
        <button class="ghost icon" data-id="${entry.id}" data-action="next" type="button" title="Next Match">&#8595;</button>
      </div>
    `;
    searchList.appendChild(card);
  });
}

function renderHistory() {
  historyList.innerHTML = "";
  if (!Array.isArray(state.history) || state.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No history yet";
    historyList.appendChild(empty);
    return;
  }

  state.history.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";
    row.innerHTML = `
      <button type="button" class="history-btn history-use" data-query="${escapeHtmlAttr(
        item.query
      )}" title="${escapeHtmlAttr(item.query)}">${escapeHtml(item.query)}</button>
      <button type="button" class="ghost mini ${item.pinned ? "active" : ""}" data-action="pin" data-query="${escapeHtmlAttr(
        item.query
      )}" title="Pin or unpin">Pin</button>
      <button type="button" class="ghost mini danger" data-action="delete" data-query="${escapeHtmlAttr(
        item.query
      )}" title="Delete history">Del</button>
    `;
    historyList.appendChild(row);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

searchList.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const id = target.dataset.id;
  const key = target.dataset.key;
  if (!id || !key) {
    return;
  }
  if (key === "query") {
    const value = target.value;
    const next = setEntry(id, {
      query: value,
      enabled: value.trim().length > 0
    });
    if (next) {
      debouncePost();
    }
    return;
  }
  if (key === "color") {
    const next = setEntry(id, { color: target.value });
    if (next) {
      debouncePost();
    }
  }
});

searchList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const id = target.dataset.id;
  const action = target.dataset.action;
  if (!id || !action) {
    return;
  }
  const idx = state.entries.findIndex((item) => item.id === id);
  if (idx < 0) {
    return;
  }

  if (action === "removeOne") {
    state.entries.splice(idx, 1);
    renderEntries();
    postState();
    return;
  }
  if (action === "toggleRegex") {
    const entry = state.entries[idx];
    setEntry(id, { mode: entry.mode === "regex" ? "plain" : "regex" });
    renderEntries();
    postState();
    return;
  }
  if (action === "toggleCase") {
    const entry = state.entries[idx];
    setEntry(id, { caseSensitive: !entry.caseSensitive });
    renderEntries();
    postState();
    return;
  }
  if (action === "toggleWord") {
    const entry = state.entries[idx];
    setEntry(id, { wholeWord: !entry.wholeWord });
    renderEntries();
    postState();
    return;
  }
  if (action === "prev" || action === "next") {
    vscode.postMessage({
      type: "navigate",
      payload: { id, direction: action === "prev" ? "prev" : "next" }
    });
  }
});

searchList.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const id = target.dataset.id;
  const key = target.dataset.key;
  if (key === "query" && id) {
    activeHistoryTargetId = id;
  }
});

if (combinedPanel) {
  combinedPanel.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "combinedEnabled") {
      postCombinedConfig({ enabled: target.checked });
      return;
    }
    if (target instanceof HTMLSelectElement && target.id === "combinedMode") {
      postCombinedConfig({ mode: target.value });
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "combinedGap") {
      const value = Number(target.value);
      postCombinedConfig({ maxGap: Number.isFinite(value) ? value : 3 });
    }
  });

  combinedPanel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    if (target.id === "combinedPrev") {
      vscode.postMessage({ type: "navigateCombined", payload: { direction: "prev" } });
      return;
    }
    if (target.id === "combinedNext") {
      vscode.postMessage({ type: "navigateCombined", payload: { direction: "next" } });
      return;
    }
    if (target.id === "toggleCombinedCollapse") {
      postCombinedConfig({ collapsed: !state.combined.collapsed });
    }
  });
}

refreshBtn?.addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

addBtn?.addEventListener("click", () => {
  if (!state.canAdd) {
    return;
  }
  const id = `slot-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const palette = [
    "#ffde59",
    "#8be9fd",
    "#ff79c6",
    "#50fa7b",
    "#f1fa8c",
    "#bd93f9",
    "#ffb86c",
    "#a4ffff",
    "#f8f8f2",
    "#c0f5a9"
  ];
  state.entries.push({
    id,
    enabled: false,
    query: "",
    mode: "plain",
    caseSensitive: false,
    wholeWord: false,
    color: palette[state.entries.length % palette.length],
    matchCount: 0
  });
  renderEntries();
  postState();
});

historyList?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const query = target.dataset.query;
  if (!query) {
    return;
  }
  const action = target.dataset.action || "use";

  if (action === "delete") {
    state.history = state.history.filter((item) => item.query !== query);
    renderHistory();
    vscode.postMessage({ type: "deleteHistory", payload: { query } });
    return;
  }

  if (action === "pin") {
    const item = state.history.find((entry) => entry.query === query);
    if (item) {
      item.pinned = !item.pinned;
    }
    renderHistory();
    vscode.postMessage({ type: "togglePinHistory", payload: { query } });
    return;
  }

  const targetId = activeHistoryTargetId || state.entries[0]?.id;
  if (!targetId) {
    return;
  }
  const next = setEntry(targetId, { query, enabled: query.trim().length > 0 });
  if (!next) {
    return;
  }
  renderEntries();
  postState();
  vscode.postMessage({
    type: "applyHistory",
    payload: { id: targetId, query }
  });
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "state" && msg.payload) {
    state = msg.payload;
    renderAll();
  }
});
