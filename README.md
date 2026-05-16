# EchoSearch Pro VS Code Extension

EchoSearch Pro adds multiple in-editor search boxes, custom highlights, and searchable history in a sidebar view.

## 中文介绍

EchoSearch Pro 是一个面向 VS Code 的增强搜索插件。  
它不是替代原生 `Ctrl+F`，而是把“单条件单视角搜索”升级为“多条件并行搜索”。

你可以同时维护多组关键词或正则规则，每组规则有独立高亮颜色、命中计数、上下跳转和历史记录。  
这对代码排查、配置比对、日志定位、协议字段核对等场景更高效。

### 传统搜索 vs EchoSearch Pro

- 传统搜索（Ctrl+F）优势：
  - 上手快、路径短，适合临时查一个词。
  - 原生集成强，几乎零学习成本。

- 传统搜索（Ctrl+F）局限：
  - 一次通常只关注一个查询条件。
  - 切换关键词时上下文容易丢失。
  - 多规则并行分析时需要反复改关键词，操作成本高。

- EchoSearch Pro 优势：
  - 多搜索框并行：同屏观察多个关键词/正则，不来回切换。
  - 颜色分层高亮：不同规则可视化区分，阅读负担更低。
  - 每框独立命中计数与跳转：定位效率更高。
  - 搜索历史可回溯：支持置顶和删除，常用规则可复用。
  - 正则、大小写、整词开关独立：适合精细化匹配。

### 适用场景

- 代码审查时并行关注多个关键 API/变量。
- 协议解析时同时跟踪请求字段、响应字段、错误码。
- 日志定位时同时搜索 traceId、模块名、异常关键字。
- 迁移重构时并行检查旧实现和新实现的调用路径。

### 一句话总结

原生搜索适合“单点快查”，EchoSearch Pro 适合“多线并行分析”。

## Features

- Up to 10 parallel search boxes (starts with 3).
- Works on opened files (visible editors), similar to Ctrl+F highlight behavior.
- Per-search custom highlight color.
- Plain text mode and regex mode (`.*`).
- Case-sensitive (`Aa`) and whole-word (`ab`) matching.
- Previous/next navigation per search box.
- History persistence in `.echosearch/history.json`, including pin and delete.

## Architecture

- Extension host logic: `src/extension.ts`
- Webview UI logic: `media/main.js`
- Webview styles: `media/main.css`

### Core data models (`src/extension.ts`)

- `SearchEntry`: one search box state (`query`, `mode`, `caseSensitive`, `wholeWord`, `color`).
- `SearchEntryView`: `SearchEntry + matchCount`.
- `HistoryEntry`: history row (`query`, `usedAt`, `pinned`).
- `WebviewStatePayload`: data sent to webview (`entries`, `history`, `canAdd`, `maxEntries`).

### Main responsibilities (`src/extension.ts`)

- Owns source of truth for `entries` and `history`.
- Receives UI messages from webview and updates state.
- Rebuilds and applies editor decorations for all visible editors.
- Calculates match ranges with plain/regex logic.
- Handles previous/next match navigation from current cursor selection.
- Loads/saves history at workspace `.echosearch/history.json`.

### Main responsibilities (`media/main.js`)

- Renders cards for search boxes and history rows.
- Captures user input and posts debounced state updates (`120ms`).
- Sends action messages for toggle, navigation, history pin/delete/use.
- Preserves input focus/cursor when rerendering.

## Message flow

### Webview -> Extension

- `updateState`: send full search entries after user edits.
- `refresh`: request recomputation/highlight refresh.
- `navigate`: jump to previous/next match for one entry.
- `applyHistory`: apply one history query to one search entry.
- `deleteHistory`: remove a history item.
- `togglePinHistory`: pin/unpin a history item.

### Extension -> Webview

- `state`: send full UI state (`entries + matchCount`, `history`, `canAdd`, `maxEntries`).

## Search and highlight pipeline

1. User edits query/options in webview.
2. Webview sends `updateState` (debounced).
3. Extension sanitizes entries and captures history.
4. Extension rebuilds decorations and applies matches to visible editors.
5. Extension sends `state` back with fresh `matchCount` values.

## Navigation logic

- `Next`: find first match whose start offset is `>=` current selection end; wrap to first if none.
- `Prev`: find last match whose start offset is `<` current selection start; wrap to last if none.
- Selected match is revealed in editor viewport.

## History logic

- De-duplicated by `query`.
- Most recently used moves to front.
- `pinned` items are always sorted before non-pinned.
- Persisted as JSON in workspace:
  - `.echosearch/history.json`

## Run

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
