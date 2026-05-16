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
        this.history = [];
        this.decorationById = new Map();
        this.entries = this.createDefaultEntries();
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
        });
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
        const selectionStart = editor.document.offsetAt(editor.selection.start);
        const selectionEnd = editor.document.offsetAt(editor.selection.end);
        const starts = ranges.map((range) => editor.document.offsetAt(range.start));
        let targetIndex = 0;
        if (direction === "next") {
            const pivot = selectionEnd;
            targetIndex = starts.findIndex((offset) => offset >= pivot);
            if (targetIndex < 0) {
                targetIndex = 0;
            }
        }
        else {
            const pivot = selectionStart;
            targetIndex = -1;
            for (let i = starts.length - 1; i >= 0; i -= 1) {
                if (starts[i] < pivot) {
                    targetIndex = i;
                    break;
                }
            }
            if (targetIndex < 0) {
                targetIndex = starts.length - 1;
            }
        }
        const target = ranges[targetIndex];
        editor.selection = new vscode.Selection(target.start, target.end);
        editor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.captureHistory(entry.query);
        this.postState();
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
        return {
            entries,
            history: this.history,
            canAdd: this.entries.length < this.maxEntries,
            maxEntries: this.maxEntries
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
        if (existing >= 0) {
            this.history.splice(existing, 1);
        }
        this.history.unshift({
            query,
            usedAt: new Date().toISOString()
        });
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(0, this.maxHistory);
        }
        void this.saveHistory();
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
                if (!query) {
                    return undefined;
                }
                return {
                    query,
                    usedAt: usedAt || new Date().toISOString()
                };
            })
                .filter((item) => Boolean(item))
                .slice(0, this.maxHistory);
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
        const nonce = Date.now().toString(36);
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>EchoSearch</title>
</head>
<body>
  <div class="hero">
    <h1>EchoSearch</h1>
    <p>Every focused search is a small step toward a clearer mind.</p>
  </div>
  <div class="toolbar">
    <button id="addBtn" type="button">Add</button>
    <button id="refreshBtn" type="button">Refresh</button>
  </div>
  <div id="searchList" class="search-list"></div>
  <div class="history-wrap">
    <div class="history-title">History</div>
    <div id="historyList" class="history-list"></div>
  </div>
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