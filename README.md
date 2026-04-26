# 🎵 るんるんぽぽび

プロアマクリエイターズコミュニティ「ぽん酢鯖」の音楽ボットです。TypeScript + Node.js で構築されています。5台のボット（1〜5号機）を一元管理する構成です。

## コマンド

| コマンド      | 説明                                                     |
| ------------- | -------------------------------------------------------- |
| `/play`       | 音楽を再生/キューに追加（URL または検索キーワード）      |
| `/skip`       | 現在の曲をスキップ                                       |
| `/stop`       | 再生を停止し、キューをクリア                             |
| `/queue`      | 現在のキューを表示                                       |
| `/nowplaying` | 再生中の曲の詳細を表示                                   |
| `/pause`      | 一時停止                                                 |
| `/resume`     | 再生再開                                                 |
| `/volume`     | 音量を設定（1〜200）、引数なしで現在の音量を表示         |
| `/filter`     | オーディオフィルターを設定（オフ / 低音強化 / 音量揃え） |
| `/reload`     | ボットを再起動                                           |

## 必要要件

- Node.js 20+
- **システムバイナリ**: `yt-dlp`, `ffmpeg`（PATH に設定済みであること）

## プロジェクト構成

```
src/
├── manager.ts          TUI ダッシュボード（npm start）
├── index.ts            ボットインスタンス（子プロセス）
├── types.ts            全型定義
├── ipc.ts              親↔子 IPC 通信
├── state.ts            キュー・VC/音量/再生状態の永続化
├── commands.ts         スラッシュコマンド定義 + ハンドラ
├── player.ts           再生ロジック（ダウンロード/ストリーミング/事前ダウンロード）
├── audio.ts            音声処理（LUFS 測定、歌詞取得）
├── ui.ts               Embed・ボタン・進捗バー・歌詞表示
├── interactions.ts     ボタン・セレクトメニューのハンドラ
├── tui/
│   ├── dashboard.ts    blessed TUI レイアウト
│   └── ascii.ts        ASCII アートバナー
├── lib/
│   └── defaultEmbed.ts カスタム EmbedBuilder
└── scripts/
    └── unregister_commands.ts  スラッシュコマンド一括削除
```

## ライセンスについて

Copyright (c) 2026 りね（ぽん酢鯖）, All Rights Reserved.

このリポジトリは、クリエイターズコミュニティサーバー「ぽん酢鯖」の透明性を上げる目的、及び作者「りね」のポートフォリオとしてソースコードを公開しているものです。
オープンソースライセンスは付与しておらず、すべての著作権は作者に帰属します。

**【許可されていること】**

- ソースコードの閲覧
- コードの書き方などの学習目的での参考

**【禁止されていること】**

- コードの一部または全部の無断使用、複製、改変、再配布
- ご自身のDiscordサーバー等への本ボットの導入・運用
- このコードを流用して作成した派生物の公開や商用利用

## 使用ライブラリ

- **[discord.js](https://discord.js.org/)** — Discord API ラッパー
- **[@discordjs/voice](https://github.com/discordjs/voice)** — ボイスチャンネル接続・音声再生
- **[@discordjs/opus](https://github.com/discordjs/opus)** — Opus コーデック
- **[yt-dlp-exec](https://github.com/dthree/yt-dlp-exec)** — yt-dlp の Node.js ラッパー
- **[blessed](https://github.com/chjj/blessed)** — TUI ダッシュボード
- **[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)** — ffmpeg バイナリ（フォールバック用）
- **[lrclib-api](https://github.com/niclasmattsson/lrclib-api)** — 歌詞取得
- **[dotenv](https://github.com/motdotla/dotenv)** — 環境変数管理
- **[TypeScript](https://www.typescriptlang.org/)** — 型安全な開発
