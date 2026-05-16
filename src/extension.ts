import * as vscode from "vscode";

type SearchMode = "plain" | "regex";

interface SearchEntry {
  id: string;
  enabled: boolean;
  query: string;
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  color: string;
}

interface WebviewUpdateMessage {
  type: "state";
  payload: SearchEntry[];
}

interface WebviewStateMessage {
  type: "updateState";
  payload: SearchEntry[];
}

interface WebviewRefreshMessage {
  type: "refresh";
}

interface WebviewClearMessage {
  type: "clearAll";
}

type IncomingMessage = WebviewStateMessage | WebviewRefreshMessage | WebviewClearMessage;

class EchoSearchController {
  private readonly entries: SearchEntry[];
  private decorationById = new Map<string, vscode.TextEditorDecorationType>();
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entries = this.createDefaultEntries();
    this.refreshDecorationsForVisibleEditors();

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.refreshDecorationsForVisibleEditors();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.refreshDecorationsForVisibleEditors();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.visibleTextEditors.find(
          (item) => item.document.uri.toString() === event.document.uri.toString()
        );
        if (editor) {
          this.applyDecorations(editor);
        }
      }),
      vscode.commands.registerCommand("echosearch.clearAll", () => {
        this.clearAllEntries();
      })
    );
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
      } else if (msg.type === "clearAll") {
        this.clearAllEntries();
      }
    });
  }

  public focusView(): void {
    vscode.commands.executeCommand("echosearch.sidebar.focus");
  }

  private clearAllEntries(): void {
    for (const entry of this.entries) {
      entry.query = "";
      entry.enabled = false;
    }
    this.refreshDecorationsForVisibleEditors();
    this.postState();
  }

  private onStateChanged(incoming: SearchEntry[]): void {
    const incomingById = new Map(incoming.map((item) => [item.id, item]));
    for (const entry of this.entries) {
      const next = incomingById.get(entry.id);
      if (!next) {
        continue;
      }
      entry.enabled = Boolean(next.enabled);
      entry.query = String(next.query ?? "");
      entry.mode = next.mode === "regex" ? "regex" : "plain";
      entry.caseSensitive = Boolean(next.caseSensitive);
      entry.wholeWord = Boolean(next.wholeWord);
      entry.color = this.normalizeColor(next.color);
    }
    this.refreshDecorationsForVisibleEditors();
    this.postState();
  }

  private createDefaultEntries(): SearchEntry[] {
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
    const result: SearchEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      result.push({
        id: `slot-${i + 1}`,
        enabled: false,
        query: "",
        mode: "plain",
        caseSensitive: false,
        wholeWord: false,
        color: palette[i]
      });
    }
    return result;
  }

  private refreshDecorationsForVisibleEditors(): void {
    this.rebuildDecorationTypes();
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyDecorations(editor);
    }
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

  private postState(): void {
    if (!this.view) {
      return;
    }
    const message: WebviewUpdateMessage = {
      type: "state",
      payload: this.entries
    };
    this.view.webview.postMessage(message);
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
  <div class="toolbar">
    <button id="refreshBtn" type="button">Refresh</button>
    <button id="clearBtn" type="button">Clear</button>
  </div>
  <div id="searchList" class="search-list"></div>
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
      controller.focusView();
    })
  );
}

export function deactivate(): void {}
