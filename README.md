# ExcalidraftAI

ローカルLLM（llama.cpp / Ollama）を使って、テキストからダイアグラムを生成する Excalidraw ラッパーアプリ。

## 概要

[Excalidraw](https://excalidraw.com/) を Next.js でラップし、AIチャットパネルからテキスト指示で図を生成できるようにしたアプリケーションです。LLMが軽量な ExcalidrawElementSkeleton JSON を出力し、それをキャンバス上にレンダリングします。

## アーキテクチャ

```
ユーザー --テキスト入力--> AIChatPanel
  --> POST /api/chat (Next.js API Route, プロキシ+バリデーション)
    --> LLMサーバー (OpenAI互換API)
    <-- ExcalidrawElementSkeleton JSON
  --> convertToExcalidrawElements() でフル要素に変換
  --> Excalidraw キャンバスに描画
```

### コンポーネント構成

```
┌──────────────────────────────────────────────┐
│ page.tsx  (dynamic import, ssr: false)        │
│ ┌──────────────────────────────────────────┐ │
│ │ ExcalidrawApp.tsx  (統合コンポーネント)      │ │
│ │ ┌────────────────────┐ ┌───────────────┐ │ │
│ │ │ ExcalidrawWrapper  │ │ AIChatPanel   │ │ │
│ │ │ (キャンバス)         │ │ (チャットUI)   │ │ │
│ │ └────────────────────┘ └───────────────┘ │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **page.tsx** — `dynamic()` + `ssr: false` で Excalidraw をクライアントサイドのみで読み込む
- **ExcalidrawWrapper** — Excalidraw 本体をラップし、`excalidrawAPI` コールバックで ImperativeAPI を親に渡す
- **ExcalidrawApp** — ExcalidrawWrapper と AIChatPanel を横並びで配置。AI が生成したスケルトンを `convertToExcalidrawElements()` でフル要素に変換し、`updateScene()` でキャンバスに追加する
- **AIChatPanel** — チャット UI。ユーザーの入力を `/api/chat` に POST し、レスポンスの elements を親に通知する

### ExcalidrawElementSkeleton 方式

LLM にはフル要素（約30フィールド）ではなく、**Skeleton 形式**（`type`, `x`, `y`, `width`, `height`, `label` など4〜5フィールド）だけを生成させます。`convertToExcalidrawElements()` が `id`, `seed`, `version`, `roughness` などの残りフィールドを自動補完します。これにより LLM の出力トークン数を大幅に削減し、生成精度を向上させています。

### サーバーサイド API プロキシ

`/api/chat` はクライアントから直接 LLM にアクセスさせず、Next.js の API Route を経由します。

- LLM エンドポイントを非公開に保つ
- CORS の問題を回避
- レスポンスのバリデーション（JSON パース、`elements` 配列の存在確認）
- タイムアウト制御

## セットアップ

```bash
npm install
cp .env.example .env.local
```

`.env.local` を編集して LLM サーバーの接続先を設定:

```
LLM_BASE_URL=http://localhost:8080/v1
LLM_MODEL=gemma3
LLM_TIMEOUT_MS=120000
```

OpenAI 互換 API であればどのサーバーでも動作します（llama.cpp, Ollama, vLLM など）。

## 開発

```bash
npm run dev
```

http://localhost:3000 を開く。

## 使い方

1. 左側に Excalidraw キャンバス、右側に AI チャットパネルが表示される
2. チャットパネルに図の説明を入力して Send をクリック（例: 「ログインフローを描いて」）
3. LLM が図の要素を生成し、キャンバスに描画される
4. 生成された要素は Excalidraw のツールで自由に編集可能
5. 追加のプロンプトを送ると、既存の図を残したまま新しい要素が追加される

## ファイル構成

```
app/
  layout.tsx              ルートレイアウト
  page.tsx                dynamic import (ssr: false)
  globals.css             Tailwind CSS
  api/chat/route.ts       LLMプロキシAPI
components/
  ExcalidrawApp.tsx       メイン: キャンバス + AIパネル、シーン管理
  ExcalidrawWrapper.tsx   Excalidrawラッパー (client-only)
  AIChatPanel.tsx         チャットUI
lib/
  prompts.ts              システムプロンプト + few-shot例
```

## 技術スタック

- [Next.js](https://nextjs.org/) (App Router, Turbopack)
- [Excalidraw](https://github.com/excalidraw/excalidraw)
- [Tailwind CSS](https://tailwindcss.com/)
- TypeScript
