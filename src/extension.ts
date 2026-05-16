import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

type SearchMode = "plain" | "regex";
type NavDirection = "next" | "prev";
type CombineMode = "ordered" | "unordered" | "adjacent";

interface SearchEntry {
  id: string;
  enabled: boolean;
  query: string;
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  color: string;
}

interface SearchEntryView extends SearchEntry {
  matchCount: number;
}

interface HistoryEntry {
  query: string;
  usedAt: string;
  pinned: boolean;
}

interface CombinedConfig {
  enabled: boolean;
  mode: CombineMode;
  maxGap: number;
  collapsed: boolean;
}

interface CombinedResultItem {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  preview: string;
}

interface CombinedDebugView {
  tokens: string[];
  reason: string;
}

interface CombinedStateView extends CombinedConfig {
  count: number;
  results: CombinedResultItem[];
  debug: CombinedDebugView;
}

interface WebviewStatePayload {
  entries: SearchEntryView[];
  history: HistoryEntry[];
  canAdd: boolean;
  maxEntries: number;
  combined: CombinedStateView;
}

interface WebviewUpdateMessage {
  type: "state";
  payload: WebviewStatePayload;
}

interface WebviewStateMessage {
  type: "updateState";
  payload: SearchEntry[];
}

interface WebviewRefreshMessage {
  type: "refresh";
}

interface WebviewNavigateMessage {
  type: "navigate";
  payload: {
    id: string;
    direction: NavDirection;
  };
}

interface WebviewApplyHistoryMessage {
  type: "applyHistory";
  payload: {
    id: string;
    query: string;
  };
}

interface WebviewDeleteHistoryMessage {
  type: "deleteHistory";
  payload: {
    query: string;
  };
}

interface WebviewTogglePinHistoryMessage {
  type: "togglePinHistory";
  payload: {
    query: string;
  };
}

interface WebviewUpdateCombinedConfigMessage {
  type: "updateCombinedConfig";
  payload: Partial<CombinedConfig>;
}

interface WebviewNavigateCombinedMessage {
  type: "navigateCombined";
  payload: {
    direction: NavDirection;
  };
}

type IncomingMessage =
  | WebviewStateMessage
  | WebviewRefreshMessage
  | WebviewNavigateMessage
  | WebviewApplyHistoryMessage
  | WebviewDeleteHistoryMessage
  | WebviewTogglePinHistoryMessage
  | WebviewUpdateCombinedConfigMessage
  | WebviewNavigateCombinedMessage;

interface TokenMatch {
  start: number;
  end: number;
}

interface CombinedRunResult {
  ranges: vscode.Range[];
  list: CombinedResultItem[];
  tokens: string[];
  reason: string;
}

class EchoSearchController {
  private readonly maxEntries = 10;
  private readonly maxHistory = 80;
  private readonly maxCombinedList = 100;
  private readonly combinedDecoration: vscode.TextEditorDecorationType;
  private entries: SearchEntry[];
  private history: HistoryEntry[] = [];
  private combinedConfig: CombinedConfig = {
    enabled: false,
    mode: "ordered",
    maxGap: 3,
    collapsed: true
  };
  private decorationById = new Map<string, vscode.TextEditorDecorationType>();
  private view: vscode.WebviewView | undefined;
  private historyFilePath: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entries = this.createDefaultEntries();
    this.combinedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 103, 103, 0.22)",
      border: "1px solid rgba(255, 103, 103, 0.85)",
      borderRadius: "3px",
      overviewRulerColor: "rgba(255, 103, 103, 0.95)",
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });

    this.context.subscriptions.push(this.combinedDecoration);

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.refreshDecorationsForVisibleEditors();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshDecorationsForVisibleEditors();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.postState();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.visibleTextEditors.find(
          (item) => item.document.uri.toString() === event.document.uri.toString()
        );
        if (!editor) {
          return;
        }
        this.applyDecorations(editor);
        if (
          vscode.window.activeTextEditor &&
          vscode.window.activeTextEditor.document.uri.toString() === editor.document.uri.toString()
        ) {
          this.postState();
        }
      })
    );
  }

  public async initialize(): Promise<void> {
    this.historyFilePath = this.resolveHistoryFilePath();
    await this.loadHistory();
    this.refreshDecorationsForVisibleEditors();
  }

  public bindView(view: vscode.WebviewView): void {
    this.view = view;
    this.view.webview.options = { enableScripts: true };
    this.view.webview.html = this.getWebviewHtml(view.webview);
    this.postState();

    this.view.webview.onDidReceiveMessage((msg: IncomingMessage) => {
      if (msg.type === "updateState") {
        this.onStateChanged(msg.payload);
      } else if (msg.type === "refresh") {
        this.refreshDecorationsForVisibleEditors();
      } else if (msg.type === "navigate") {
        this.navigateToMatch(msg.payload.id, msg.payload.direction);
      } else if (msg.type === "applyHistory") {
        this.applyHistoryQuery(msg.payload.id, msg.payload.query);
      } else if (msg.type === "deleteHistory") {
        this.deleteHistory(msg.payload.query);
      } else if (msg.type === "togglePinHistory") {
        this.togglePinHistory(msg.payload.query);
      } else if (msg.type === "updateCombinedConfig") {
        this.updateCombinedConfig(msg.payload);
      } else if (msg.type === "navigateCombined") {
        this.navigateCombined(msg.payload.direction);
      }
    });
  }

  private onStateChanged(incoming: SearchEntry[]): void {
    const sanitized = incoming
      .slice(0, this.maxEntries)
      .map((item, index) => this.sanitizeEntry(item, index));
    this.entries = sanitized;
    this.captureHistoryFromEntries();
    this.refreshDecorationsForVisibleEditors();
  }

  private applyHistoryQuery(id: string, query: string): void {
    const target = this.entries.find((entry) => entry.id === id);
    if (!target) {
      return;
    }
    target.query = query;
    target.enabled = query.trim().length > 0;
    this.captureHistory(query);
    this.refreshDecorationsForVisibleEditors();
  }

  private updateCombinedConfig(patch: Partial<CombinedConfig>): void {
    const next: CombinedConfig = {
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

  private deleteHistory(query: string): void {
    this.history = this.history.filter((item) => item.query !== query);
    void this.saveHistory();
    this.postState();
  }

  private togglePinHistory(query: string): void {
    const target = this.history.find((item) => item.query === query);
    if (!target) {
      return;
    }
    target.pinned = !target.pinned;
    this.sortHistory();
    void this.saveHistory();
    this.postState();
  }

  private createDefaultEntries(): SearchEntry[] {
    const result: SearchEntry[] = [];
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

  private refreshDecorationsForVisibleEditors(): void {
    this.rebuildDecorationTypes();
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor);
    }
    this.postState();
  }

  private rebuildDecorationTypes(): void {
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

  private applyDecorations(editor: vscode.TextEditor): void {
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

  private collectRanges(
    text: string,
    document: vscode.TextDocument,
    entry: SearchEntry
  ): vscode.Range[] {
    if (!entry.enabled || !entry.query.trim()) {
      return [];
    }

    let regex: RegExp;
    try {
      regex = this.buildRegExp(entry);
    } catch {
      return [];
    }

    const ranges: vscode.Range[] = [];
    let match: RegExpExecArray | null;
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

  private navigateToMatch(id: string, direction: NavDirection): void {
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

  private navigateCombined(direction: NavDirection): void {
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

  private navigateByRanges(
    editor: vscode.TextEditor,
    ranges: vscode.Range[],
    direction: NavDirection
  ): void {
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
    } else {
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
  }

  private runCombined(text: string, document: vscode.TextDocument): CombinedRunResult {
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
      ? this.findUnorderedWindows(text, tokens)
      : this.findOrderedWindows(
          text,
          tokens,
          this.combinedConfig.mode === "adjacent" ? this.combinedConfig.maxGap : undefined
        );

    const merged = this.mergeTokenWindows(rawWindows);
    const ranges = merged.map(
      (item) =>
        new vscode.Range(
          document.positionAt(item.start),
          document.positionAt(item.end)
        )
    );

    const list: CombinedResultItem[] = merged.slice(0, this.maxCombinedList).map((item) => {
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
      reason:
        ranges.length > 0
          ? `Matched ${ranges.length} combined result(s).`
          : `No match with mode=${this.combinedConfig.mode}${
              this.combinedConfig.mode === "adjacent" ? ` gap=${this.combinedConfig.maxGap}` : ""
            }.`
    };
  }

  private extractCombinedTokens(): SearchEntry[] {
    return this.entries.filter((entry) => entry.enabled && entry.query.trim().length > 0);
  }

  private findOrderedWindows(
    text: string,
    tokens: SearchEntry[],
    maxGap?: number
  ): TokenMatch[] {
    const perTokenMatches = tokens.map((token) => this.collectTokenMatches(text, token));
    if (perTokenMatches.some((list) => list.length === 0)) {
      return [];
    }

    const results: TokenMatch[] = [];
    const first = perTokenMatches[0];
    for (const seed of first) {
      let current = seed;
      let failed = false;
      for (let i = 1; i < perTokenMatches.length; i += 1) {
        const candidates = perTokenMatches[i];
        const next = candidates.find((candidate) => {
          if (candidate.start < current.end) {
            return false;
          }
          if (typeof maxGap === "number") {
            const gap = candidate.start - current.end;
            return gap <= maxGap;
          }
          return true;
        });
        if (!next) {
          failed = true;
          break;
        }
        current = next;
      }
      if (!failed) {
        results.push({ start: seed.start, end: current.end });
      }
    }
    return results;
  }

  private findUnorderedWindows(text: string, tokens: SearchEntry[]): TokenMatch[] {
    const events: Array<{ tokenIndex: number; start: number; end: number }> = [];
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
    const countByKind = new Map<number, number>();
    let haveKinds = 0;
    let left = 0;
    const windows: TokenMatch[] = [];

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
        windows.push({
          start: first.start,
          end: last.end
        });

        const removeKind = first.tokenIndex;
        const removePrev = countByKind.get(removeKind) ?? 0;
        if (removePrev <= 1) {
          countByKind.delete(removeKind);
          haveKinds -= 1;
        } else {
          countByKind.set(removeKind, removePrev - 1);
        }
        left += 1;
      }
    }
    return windows;
  }

  private collectTokenMatches(text: string, token: SearchEntry): TokenMatch[] {
    let regex: RegExp;
    try {
      regex = this.buildRegExp(token);
    } catch {
      return [];
    }
    const matches: TokenMatch[] = [];
    let match: RegExpExecArray | null;
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

  private mergeTokenWindows(items: TokenMatch[]): TokenMatch[] {
    if (items.length === 0) {
      return [];
    }
    const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: TokenMatch[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      const current = sorted[i];
      const last = merged[merged.length - 1];
      if (current.start <= last.end) {
        last.end = Math.max(last.end, current.end);
      } else {
        merged.push({ ...current });
      }
    }
    return merged;
  }

  private previewText(text: string, start: number, end: number): string {
    const left = Math.max(0, start - 18);
    const right = Math.min(text.length, end + 36);
    const raw = text.slice(left, right).replace(/\r?\n/g, " ");
    return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  }

  private buildRegExp(entry: SearchEntry): RegExp {
    const source = entry.mode === "regex" ? entry.query : this.escapeRegExp(entry.query);
    const wrapped = entry.wholeWord ? `\\b(?:${source})\\b` : source;
    const flags = `g${entry.caseSensitive ? "" : "i"}`;
    return new RegExp(wrapped, flags);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private withAlpha(hex: string, alpha: number): string {
    const normalized = this.normalizeColor(hex);
    if (!normalized.startsWith("#") || normalized.length !== 7) {
      return normalized;
    }
    const r = parseInt(normalized.slice(1, 3), 16);
    const g = parseInt(normalized.slice(3, 5), 16);
    const b = parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private normalizeColor(color: string): string {
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

  private normalizeCombineMode(mode: unknown): CombineMode {
    if (mode === "ordered" || mode === "unordered" || mode === "adjacent") {
      return mode;
    }
    return "ordered";
  }

  private sanitizeEntry(item: SearchEntry, index: number): SearchEntry {
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

  private defaultColorAt(index: number): string {
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

  private buildStatePayload(): WebviewStatePayload {
    const activeEditor = vscode.window.activeTextEditor;
    const text = activeEditor?.document.getText() ?? "";
    const doc = activeEditor?.document;

    const entries = this.entries.map((entry) => ({
      ...entry,
      matchCount: doc ? this.collectRanges(text, doc, entry).length : 0
    }));

    const combined = doc
      ? this.runCombined(text, doc)
      : ({
          ranges: [],
          list: [],
          tokens: [],
          reason: "No active editor."
        } as CombinedRunResult);

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

  private postState(): void {
    if (!this.view) {
      return;
    }
    const message: WebviewUpdateMessage = {
      type: "state",
      payload: this.buildStatePayload()
    };
    this.view.webview.postMessage(message);
  }

  private captureHistoryFromEntries(): void {
    for (const entry of this.entries) {
      if (entry.enabled && entry.query.trim().length > 0) {
        this.captureHistory(entry.query);
      }
    }
  }

  private captureHistory(rawQuery: string): void {
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

  private sortHistory(): void {
    this.history.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return b.usedAt.localeCompare(a.usedAt);
    });
  }

  private getSortedHistory(): HistoryEntry[] {
    return [...this.history].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return b.usedAt.localeCompare(a.usedAt);
    });
  }

  private resolveHistoryFilePath(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return undefined;
    }
    return path.join(root, ".echosearch", "history.json");
  }

  private async loadHistory(): Promise<void> {
    if (!this.historyFilePath) {
      this.history = [];
      return;
    }
    try {
      const raw = await fs.readFile(this.historyFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        this.history = [];
        return;
      }
      this.history = parsed
        .map((item) => {
          if (!item || typeof item !== "object") {
            return undefined;
          }
          const query = String((item as { query?: unknown }).query ?? "").trim();
          const usedAt = String((item as { usedAt?: unknown }).usedAt ?? "");
          const pinned = Boolean((item as { pinned?: unknown }).pinned);
          if (!query) {
            return undefined;
          }
          return {
            query,
            usedAt: usedAt || new Date().toISOString(),
            pinned
          } as HistoryEntry;
        })
        .filter((item): item is HistoryEntry => Boolean(item))
        .slice(0, this.maxHistory);
      this.sortHistory();
    } catch {
      this.history = [];
    }
  }

  private async saveHistory(): Promise<void> {
    if (!this.historyFilePath) {
      return;
    }
    try {
      const dir = path.dirname(this.historyFilePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.historyFilePath, JSON.stringify(this.history, null, 2), "utf8");
    } catch {
      // Ignore persistence errors to keep UI responsive.
    }
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
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
    <h1>EchoSearch Pro</h1>
    <p>Every focused search is a small step toward a clearer mind.</p>
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

class EchoSearchViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly controller: EchoSearchController) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.controller.bindView(webviewView);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new EchoSearchController(context);
  void controller.initialize();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "echosearch.sidebar",
      new EchoSearchViewProvider(controller)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("echosearch.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.echoSearch");
      await vscode.commands.executeCommand("echosearch.sidebar.focus");
    })
  );
}

export function deactivate(): void {}
