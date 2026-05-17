"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
class EchoSearchController {
    constructor(context) {
        this.context = context;
        this.maxEntries = 10;
        this.maxHistory = 80;
        this.maxCombinedList = 100;
        this.history = [];
        this.combinedConfig = {
            enabled: false,
            mode: "ordered",
            maxGap: 3,
            collapsed: true
        };
        this.decorationById = new Map();
        this.entries = this.createDefaultEntries();
        this.combinedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: "rgba(255, 103, 103, 0.22)",
            border: "1px solid rgba(255, 103, 103, 0.85)",
            borderRadius: "3px",
            overviewRulerColor: "rgba(255, 103, 103, 0.95)",
            overviewRulerLane: vscode.OverviewRulerLane.Right
        });
        this.context.subscriptions.push(this.combinedDecoration);
        this.context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.refreshDecorationsForVisibleEditors();
        }), vscode.window.onDidChangeVisibleTextEditors(() => {
            this.refreshDecorationsForVisibleEditors();
        }), vscode.window.onDidChangeTextEditorSelection(() => {
            this.postState();
        }), vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === event.document.uri.toString());
            if (!editor) {
                return;
            }
            this.applyDecorations(editor);
            if (vscode.window.activeTextEditor &&
                vscode.window.activeTextEditor.document.uri.toString() === editor.document.uri.toString()) {
                this.postState();
            }
        }));
    }
    async initialize() {
        this.historyFilePath = this.resolveHistoryFilePath();
        await this.loadHistory();
        this.refreshDecorationsForVisibleEditors();
    }
    bindView(view) {
        this.view = view;
        this.view.webview.options = { enableScripts: true };
        this.view.webview.html = this.getWebviewHtml(view.webview);
        this.postState();
        this.view.webview.onDidReceiveMessage((msg) => {
            if (msg.type === "updateState") {
                this.onStateChanged(msg.payload);
            }
            else if (msg.type === "refresh") {
                this.refreshDecorationsForVisibleEditors();
            }
            else if (msg.type === "navigate") {
                this.navigateToMatch(msg.payload.id, msg.payload.direction);
            }
            else if (msg.type === "applyHistory") {
                this.applyHistoryQuery(msg.payload.id, msg.payload.query);
            }
            else if (msg.type === "deleteHistory") {
                this.deleteHistory(msg.payload.query);
            }
            else if (msg.type === "togglePinHistory") {
                this.togglePinHistory(msg.payload.query);
            }
            else if (msg.type === "updateCombinedConfig") {
                this.updateCombinedConfig(msg.payload);
            }
            else if (msg.type === "navigateCombined") {
                this.navigateCombined(msg.payload.direction);
            }
            else if (msg.type === "openLink") {
                void this.openExternalLink(msg.payload.target);
            }
        });
    }
    async openExternalLink(target) {
        const url = target === "github"
            ? "https://github.com/FlechazoCLF/EchoSearch"
            : "https://flechazo.mba";
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
    onStateChanged(incoming) {
        const sanitized = incoming
            .slice(0, this.maxEntries)
            .map((item, index) => this.sanitizeEntry(item, index));
        this.entries = sanitized;
        this.captureHistoryFromEntries();
        this.refreshDecorationsForVisibleEditors();
    }
    applyHistoryQuery(id, query) {
        const target = this.entries.find((entry) => entry.id === id);
        if (!target) {
            return;
        }
        target.query = query;
        target.enabled = query.trim().length > 0;
        this.captureHistory(query);
        this.refreshDecorationsForVisibleEditors();
    }
    updateCombinedConfig(patch) {
        const next = {
            ...this.combinedConfig,
            ...patch
        };
        next.mode = this.normalizeCombineMode(next.mode);
        next.maxGap = Number.isFinite(next.maxGap) ? Math.max(0, Math.min(200, Math.floor(next.maxGap))) : 3;
        next.enabled = Boolean(next.enabled);
        next.collapsed = Boolean(next.collapsed);
        this.combinedConfig = next;
        this.refreshDecorationsForVisibleEditors();
    }
    deleteHistory(query) {
        this.history = this.history.filter((item) => item.query !== query);
        void this.saveHistory();
        this.postState();
    }
    togglePinHistory(query) {
        const target = this.history.find((item) => item.query === query);
        if (!target) {
            return;
        }
        target.pinned = !target.pinned;
        this.sortHistory();
        void this.saveHistory();
        this.postState();
    }
    createDefaultEntries() {
        const result = [];
        for (let i = 0; i < 3; i += 1) {
            result.push({
                id: `slot-${i + 1}`,
                enabled: false,
                query: "",
                mode: "plain",
                caseSensitive: false,
                wholeWord: false,
                color: this.defaultColorAt(i)
            });
        }
        return result;
    }
    refreshDecorationsForVisibleEditors() {
        this.rebuildDecorationTypes();
        for (const editor of vscode.window.visibleTextEditors) {
            this.applyDecorations(editor);
        }
        this.postState();
    }
    rebuildDecorationTypes() {
        for (const oldDecoration of this.decorationById.values()) {
            oldDecoration.dispose();
        }
        this.decorationById.clear();
        for (const entry of this.entries) {
            const decoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: this.withAlpha(entry.color, 0.38),
                border: `1px solid ${this.withAlpha(entry.color, 0.95)}`,
                borderRadius: "3px",
                overviewRulerColor: this.withAlpha(entry.color, 0.92),
                overviewRulerLane: vscode.OverviewRulerLane.Right
            });
            this.decorationById.set(entry.id, decoration);
        }
    }
    applyDecorations(editor) {
        const text = editor.document.getText();
        for (const entry of this.entries) {
            const decoration = this.decorationById.get(entry.id);
            if (!decoration) {
                continue;
            }
            const ranges = this.collectRanges(text, editor.document, entry);
            editor.setDecorations(decoration, ranges);
        }
        const combined = this.runCombined(text, editor.document);
        editor.setDecorations(this.combinedDecoration, combined.ranges);
    }
    collectRanges(text, document, entry) {
        if (!entry.enabled || !entry.query.trim()) {
            return [];
        }
        let regex;
        try {
            regex = this.buildRegExp(entry);
        }
        catch {
            return [];
        }
        const ranges = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            const fullMatch = match[0];
            if (fullMatch.length === 0) {
                regex.lastIndex += 1;
                continue;
            }
            const start = document.positionAt(match.index);
            const end = document.positionAt(match.index + fullMatch.length);
            ranges.push(new vscode.Range(start, end));
        }
        return ranges;
    }
    navigateToMatch(id, direction) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const entry = this.entries.find((item) => item.id === id);
        if (!entry) {
            return;
        }
        const text = editor.document.getText();
        const ranges = this.collectRanges(text, editor.document, entry);
        if (ranges.length === 0) {
            return;
        }
        this.navigateByRanges(editor, ranges, direction);
        this.captureHistory(entry.query);
        this.postState();
    }
    navigateCombined(direction) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const combined = this.runCombined(editor.document.getText(), editor.document);
        if (combined.ranges.length === 0) {
            return;
        }
        this.navigateByRanges(editor, combined.ranges, direction);
        this.postState();
    }
    navigateByRanges(editor, ranges, direction) {
        const selectionStart = editor.document.offsetAt(editor.selection.start);
        const selectionEnd = editor.document.offsetAt(editor.selection.end);
        const points = ranges.map((range) => ({
            start: editor.document.offsetAt(range.start),
            end: editor.document.offsetAt(range.end)
        }));
        let targetIndex = 0;
        if (direction === "next") {
            const pivot = selectionEnd;
            targetIndex = points.findIndex((point) => point.start > pivot);
            if (targetIndex < 0) {
                targetIndex = 0;
            }
        }
        else {
            const pivot = selectionStart;
            targetIndex = -1;
            for (let i = points.length - 1; i >= 0; i -= 1) {
                if (points[i].end < pivot) {
                    targetIndex = i;
                    break;
                }
            }
            if (targetIndex < 0) {
                targetIndex = points.length - 1;
            }
        }
        const target = ranges[targetIndex];
        editor.selection = new vscode.Selection(target.start, target.end);
        editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    runCombined(text, document) {
        if (!this.combinedConfig.enabled) {
            return {
                ranges: [],
                list: [],
                tokens: [],
                reason: "Combined search is disabled."
            };
        }
        const tokens = this.extractCombinedTokens();
        if (tokens.length < 2) {
            return {
                ranges: [],
                list: [],
                tokens: tokens.map((item) => item.query.trim()),
                reason: "Need at least 2 enabled search boxes with non-empty queries."
            };
        }
        const rawWindows = this.combinedConfig.mode === "unordered"
            ? this.findUnorderedWindows(text, tokens, this.combinedConfig.maxGap)
            : this.findOrderedWindows(text, tokens, this.combinedConfig.maxGap, this.combinedConfig.mode === "adjacent");
        const merged = this.mergeTokenWindows(rawWindows);
        const ranges = merged.map((item) => new vscode.Range(document.positionAt(item.start), document.positionAt(item.end)));
        const list = merged.slice(0, this.maxCombinedList).map((item) => {
            const startPos = document.positionAt(item.start);
            const endPos = document.positionAt(item.end);
            return {
                startLine: startPos.line + 1,
                startCol: startPos.character + 1,
                endLine: endPos.line + 1,
                endCol: endPos.character + 1,
                preview: this.previewText(text, item.start, item.end)
            };
        });
        return {
            ranges,
            list,
            tokens: tokens.map((item) => item.query.trim()),
            reason: ranges.length > 0
                ? `Matched ${ranges.length} combined result(s).`
                : `No match with mode=${this.combinedConfig.mode} gap=${this.combinedConfig.maxGap}.`
        };
    }
    extractCombinedTokens() {
        return this.entries.filter((entry) => entry.enabled && entry.query.trim().length > 0);
    }
    findOrderedWindows(text, tokens, maxGap, strictAdjacent) {
        const perTokenMatches = tokens.map((token) => this.collectTokenMatches(text, token));
        if (perTokenMatches.some((list) => list.length === 0)) {
            return [];
        }
        const results = [];
        const first = perTokenMatches[0];
        for (const seed of first) {
            let current = seed;
            let failed = false;
            let totalLen = seed.end - seed.start;
            for (let i = 1; i < perTokenMatches.length; i += 1) {
                const candidates = perTokenMatches[i];
                const next = candidates.find((candidate) => {
                    if (candidate.start < current.end) {
                        return false;
                    }
                    if (strictAdjacent) {
                        const adjacentGap = candidate.start - current.end;
                        return adjacentGap <= maxGap;
                    }
                    return true;
                });
                if (!next) {
                    failed = true;
                    break;
                }
                totalLen += next.end - next.start;
                current = next;
            }
            if (!failed) {
                const totalSpan = current.end - seed.start;
                const gapBudget = Math.max(0, (tokens.length - 1) * maxGap);
                const actualGap = Math.max(0, totalSpan - totalLen);
                if (actualGap > gapBudget) {
                    continue;
                }
                results.push({ start: seed.start, end: current.end });
            }
        }
        return results;
    }
    findUnorderedWindows(text, tokens, maxGap) {
        const events = [];
        tokens.forEach((token, tokenIndex) => {
            const tokenMatches = this.collectTokenMatches(text, token);
            tokenMatches.forEach((match) => {
                events.push({
                    tokenIndex,
                    start: match.start,
                    end: match.end
                });
            });
        });
        if (events.length === 0) {
            return [];
        }
        events.sort((a, b) => a.start - b.start || a.end - b.end);
        const needKinds = tokens.length;
        const countByKind = new Map();
        let haveKinds = 0;
        let left = 0;
        const windows = [];
        for (let right = 0; right < events.length; right += 1) {
            const addKind = events[right].tokenIndex;
            const prev = countByKind.get(addKind) ?? 0;
            countByKind.set(addKind, prev + 1);
            if (prev === 0) {
                haveKinds += 1;
            }
            while (haveKinds === needKinds && left <= right) {
                const first = events[left];
                const last = events[right];
                const maxSpan = Math.max(0, (needKinds - 1) * maxGap) + needKinds;
                const span = last.end - first.start;
                if (span <= maxSpan) {
                    windows.push({
                        start: first.start,
                        end: last.end
                    });
                }
                const removeKind = first.tokenIndex;
                const removePrev = countByKind.get(removeKind) ?? 0;
                if (removePrev <= 1) {
                    countByKind.delete(removeKind);
                    haveKinds -= 1;
                }
                else {
                    countByKind.set(removeKind, removePrev - 1);
                }
                left += 1;
            }
        }
        return windows;
    }
    collectTokenMatches(text, token) {
        let regex;
        try {
            regex = this.buildRegExp(token);
        }
        catch {
            return [];
        }
        const matches = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
            const full = match[0];
            if (full.length === 0) {
                regex.lastIndex += 1;
                continue;
            }
            matches.push({
                start: match.index,
                end: match.index + full.length
            });
        }
        return matches;
    }
    mergeTokenWindows(items) {
        if (items.length === 0) {
            return [];
        }
        const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [sorted[0]];
        for (let i = 1; i < sorted.length; i += 1) {
            const current = sorted[i];
            const last = merged[merged.length - 1];
            if (current.start <= last.end) {
                last.end = Math.max(last.end, current.end);
            }
            else {
                merged.push({ ...current });
            }
        }
        return merged;
    }
    previewText(text, start, end) {
        const left = Math.max(0, start - 18);
        const right = Math.min(text.length, end + 36);
        const raw = text.slice(left, right).replace(/\r?\n/g, " ");
        return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
    }
    buildRegExp(entry) {
        const source = entry.mode === "regex" ? entry.query : this.escapeRegExp(entry.query);
        const wrapped = entry.wholeWord ? `\\b(?:${source})\\b` : source;
        const flags = `g${entry.caseSensitive ? "" : "i"}`;
        return new RegExp(wrapped, flags);
    }
    escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    withAlpha(hex, alpha) {
        const normalized = this.normalizeColor(hex);
        if (!normalized.startsWith("#") || normalized.length !== 7) {
            return normalized;
        }
        const r = parseInt(normalized.slice(1, 3), 16);
        const g = parseInt(normalized.slice(3, 5), 16);
        const b = parseInt(normalized.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    normalizeColor(color) {
        const value = String(color ?? "").trim();
        const isHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
        if (!isHex) {
            return "#ffde59";
        }
        if (value.length === 4) {
            const r = value[1];
            const g = value[2];
            const b = value[3];
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        return value.toLowerCase();
    }
    normalizeCombineMode(mode) {
        if (mode === "ordered" || mode === "unordered" || mode === "adjacent") {
            return mode;
        }
        return "ordered";
    }
    sanitizeEntry(item, index) {
        return {
            id: String(item.id || `slot-${index + 1}`),
            enabled: Boolean(item.enabled),
            query: String(item.query ?? ""),
            mode: item.mode === "regex" ? "regex" : "plain",
            caseSensitive: Boolean(item.caseSensitive),
            wholeWord: Boolean(item.wholeWord),
            color: this.normalizeColor(item.color || this.defaultColorAt(index))
        };
    }
    defaultColorAt(index) {
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
        return palette[index % palette.length];
    }
    buildStatePayload() {
        const activeEditor = vscode.window.activeTextEditor;
        const text = activeEditor?.document.getText() ?? "";
        const doc = activeEditor?.document;
        const entries = this.entries.map((entry) => ({
            ...entry,
            matchCount: doc ? this.collectRanges(text, doc, entry).length : 0
        }));
        const combined = doc
            ? this.runCombined(text, doc)
            : {
                ranges: [],
                list: [],
                tokens: [],
                reason: "No active editor."
            };
        return {
            entries,
            history: this.getSortedHistory(),
            canAdd: this.entries.length < this.maxEntries,
            maxEntries: this.maxEntries,
            combined: {
                ...this.combinedConfig,
                count: combined.ranges.length,
                results: combined.list,
                debug: {
                    tokens: combined.tokens,
                    reason: combined.reason
                }
            }
        };
    }
    postState() {
        if (!this.view) {
            return;
        }
        const message = {
            type: "state",
            payload: this.buildStatePayload()
        };
        this.view.webview.postMessage(message);
    }
    captureHistoryFromEntries() {
        for (const entry of this.entries) {
            if (entry.enabled && entry.query.trim().length > 0) {
                this.captureHistory(entry.query);
            }
        }
    }
    captureHistory(rawQuery) {
        const query = rawQuery.trim();
        if (!query) {
            return;
        }
        const existing = this.history.findIndex((item) => item.query === query);
        const wasPinned = existing >= 0 ? this.history[existing].pinned : false;
        if (existing >= 0) {
            this.history.splice(existing, 1);
        }
        this.history.unshift({
            query,
            usedAt: new Date().toISOString(),
            pinned: wasPinned
        });
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory);
        }
        this.sortHistory();
        void this.saveHistory();
    }
    sortHistory() {
        this.history.sort((a, b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }
            return b.usedAt.localeCompare(a.usedAt);
        });
    }
    getSortedHistory() {
        return [...this.history].sort((a, b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }
            return b.usedAt.localeCompare(a.usedAt);
        });
    }
    resolveHistoryFilePath() {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return undefined;
        }
        return path.join(root, ".echosearch", "history.json");
    }
    async loadHistory() {
        if (!this.historyFilePath) {
            this.history = [];
            return;
        }
        try {
            const raw = await fs.readFile(this.historyFilePath, "utf8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                this.history = [];
                return;
            }
            this.history = parsed
                .map((item) => {
                if (!item || typeof item !== "object") {
                    return undefined;
                }
                const query = String(item.query ?? "").trim();
                const usedAt = String(item.usedAt ?? "");
                const pinned = Boolean(item.pinned);
                if (!query) {
                    return undefined;
                }
                return {
                    query,
                    usedAt: usedAt || new Date().toISOString(),
                    pinned
                };
            })
                .filter((item) => Boolean(item))
                .slice(0, this.maxHistory);
            this.sortHistory();
        }
        catch {
            this.history = [];
        }
    }
    async saveHistory() {
        if (!this.historyFilePath) {
            return;
        }
        try {
            const dir = path.dirname(this.historyFilePath);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(this.historyFilePath, JSON.stringify(this.history, null, 2), "utf8");
        }
        catch {
            // Ignore persistence errors to keep UI responsive.
        }
    }
    getWebviewHtml(webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
        const websiteIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-website.svg"));
        const githubIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-github.svg"));
        const nonce = Date.now().toString(36);
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>EchoSearch</title>
</head>
<body>
  <div class="hero">
    <h1>EchoSearch Pro</h1>
    <p>Every focused search is a small step toward a clearer mind.</p>
    <div class="hero-links">
      <button id="openWebsiteBtn" class="icon-link" type="button" title="Open Website" aria-label="Open Website">
        <img src="${websiteIconUri}" alt="" />
      </button>
      <button id="openGithubBtn" class="icon-link" type="button" title="Open GitHub" aria-label="Open GitHub">
        <img src="${githubIconUri}" alt="" />
      </button>
    </div>
  </div>
  <div class="toolbar">
    <button id="addBtn" type="button">Add</button>
    <button id="refreshBtn" type="button">Refresh</button>
  </div>
  <div id="combinedPanel" class="combined-panel"></div>
  <div id="searchList" class="search-list"></div>
  <div class="history-wrap">
    <div class="history-title">History</div>
    <div id="historyList" class="history-list"></div>
  </div>
  <div id="debugPanel" class="debug-panel"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
class EchoSearchViewProvider {
    constructor(controller) {
        this.controller = controller;
    }
    resolveWebviewView(webviewView) {
        this.controller.bindView(webviewView);
    }
}
function activate(context) {
    const controller = new EchoSearchController(context);
    void controller.initialize();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("echosearch.sidebar", new EchoSearchViewProvider(controller)));
    context.subscriptions.push(vscode.commands.registerCommand("echosearch.focus", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.echoSearch");
        await vscode.commands.executeCommand("echosearch.sidebar.focus");
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map