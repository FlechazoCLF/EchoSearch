const vscode = acquireVsCodeApi();

const searchList = document.getElementById("searchList");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const addBtn = document.getElementById("addBtn");

let state = [];
let debounceTimer = null;
const MAX_SEARCH_BOXES = 10;

function postState() {
  vscode.postMessage({ type: "updateState", payload: state });
}

function debouncePost() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(postState, 120);
}

function render() {
  searchList.innerHTML = "";
  state.forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <label>
          <input data-id="${entry.id}" data-key="enabled" type="checkbox" ${entry.enabled ? "checked" : ""} />
        </label>
        <div class="label">Search ${index + 1} · ${entry.matchCount || 0} matches</div>
        <input class="color" data-id="${entry.id}" data-key="color" type="color" value="${entry.color}" />
      </div>
      <input class="query" data-id="${entry.id}" data-key="query" type="text" placeholder="Enter keyword or regex..." value="${escapeHtml(
        entry.query
      )}" />
      <div class="mini-actions">
        <button data-id="${entry.id}" data-action="clearOne" type="button">Clear</button>
        <button data-id="${entry.id}" data-action="removeOne" type="button">Delete</button>
        <button data-id="${entry.id}" data-action="prev" type="button">Prev</button>
        <button data-id="${entry.id}" data-action="next" type="button">Next</button>
      </div>
      <div class="opts">
        <select class="mode" data-id="${entry.id}" data-key="mode">
          <option value="plain" ${entry.mode === "plain" ? "selected" : ""}>Plain</option>
          <option value="regex" ${entry.mode === "regex" ? "selected" : ""}>Regex</option>
        </select>
        <label>
          <input data-id="${entry.id}" data-key="caseSensitive" type="checkbox" ${entry.caseSensitive ? "checked" : ""} />
          Case
        </label>
        <label>
          <input data-id="${entry.id}" data-key="wholeWord" type="checkbox" ${entry.wholeWord ? "checked" : ""} />
          Word
        </label>
      </div>
    `;
    searchList.appendChild(card);
  });
  if (addBtn) {
    addBtn.disabled = state.length >= MAX_SEARCH_BOXES;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateEntry(id, key, value) {
  const idx = state.findIndex((item) => item.id === id);
  if (idx < 0) {
    return;
  }
  const next = { ...state[idx], [key]: value };
  if (key === "query") {
    next.enabled = String(value).trim().length > 0;
  }
  state[idx] = next;
  debouncePost();
}

searchList.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  const id = target.dataset.id;
  const key = target.dataset.key;
  if (!id || !key) {
    return;
  }
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    updateEntry(id, key, target.checked);
    return;
  }
  updateEntry(id, key, target.value);
});

searchList.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  const id = target.dataset.id;
  const key = target.dataset.key;
  if (!id || !key) {
    return;
  }
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    updateEntry(id, key, target.checked);
    return;
  }
  updateEntry(id, key, target.value);
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
  const idx = state.findIndex((item) => item.id === id);
  if (idx < 0) {
    return;
  }

  if (action === "clearOne") {
    state[idx] = { ...state[idx], query: "", enabled: false };
    render();
    postState();
    return;
  }
  if (action === "removeOne") {
    state.splice(idx, 1);
    render();
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

refreshBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

clearBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "clearAll" });
});

if (addBtn) {
  addBtn.addEventListener("click", () => {
    if (state.length >= MAX_SEARCH_BOXES) {
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
    state.push({
      id,
      enabled: false,
      query: "",
      mode: "plain",
      caseSensitive: false,
      wholeWord: false,
      color: palette[state.length % palette.length],
      matchCount: 0
    });
    render();
    postState();
  });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "state" && Array.isArray(msg.payload)) {
    state = msg.payload;
    render();
  }
});
