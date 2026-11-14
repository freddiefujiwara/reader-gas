# reader-gas

Web版RSSリーダー `/reader` のバックエンド (Google Apps Script Web App)。

- 毎時トリガー `fetchFeeds` が YouTube フィードだけを Data API 経由で巡回し、新着記事を `articles` シートへ追記する (通常の RSS フィードは v2 でクライアント側が取得する)
- フロントは `doPost` の JSON API でフィード一覧と記事 (既読状態の初回取り込み用) を読み、フィード管理を行う
- 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、オーナー本人にだけセッションを発行する

## シート構成

スプレッドシートはスクリプトプロパティ `SPREADSHEET_ID` で指定する (コードにIDを直書きしない)。

| タブ | 内容 |
|---|---|
| `feeds` | フィード正本。管理はフロントの管理画面 (listFeeds / saveFeed / deleteFeed / reorderFeeds) から行う |
| `articles` | 記事本体。`id` はフィードID＋guid/リンクの SHA-256 |
| `states` | 記事ごとの既読状態 (v1 のサーバー側既読の名残。v2 では書き込まず、既読の初回取り込みと保持判定にだけ使う) |
| `owner_sessions` | セッションのトークンハッシュだけを保存 (自動作成)。複数端末の同時セッション可。`role` が `owner` / `readonly` |

保持ルール: 既読または状態なしの記事は、60日経過または新しい順5,000件を超えた分を削除する。未読は保持する。

## API (doPost, JSON)

| action | 引数 | 説明 |
|---|---|---|
| `exchange_session` | `idToken` | Google IDトークンを検証し、オーナーセッション (30日) を発行 |
| `exchange_share` | `shareToken` | 一時アクセスリンクを検証し、読み取り専用セッションを発行 |
| `list` | `sessionToken`, `limit?` (最大500) | 記事一覧 (既読マージ済み・新しい順)＋フィード一覧 (未読数・有効/無効付き)。v2 では既読状態の初回取り込みにだけ使う |
| `listFeeds` | `sessionToken` (owner) | フィード管理用一覧 (無効フィードも含む全件、最終取得・未読数付き)。読み取り専用セッションは拒否 |
| `saveFeed` | `sessionToken` (owner), `feed:{id,title,url,category,enabled,isPrivate}` | フィードの追加・更新。不正な入力は `{ok:false, error:"invalid", message}`。URL変更時は etag/last_modified を消す |
| `deleteFeed` | `sessionToken` (owner), `feedId` | フィード行と、その記事・状態をまとめて削除。未知のIDは `{ok:false, error:"not_found"}` |
| `reorderFeeds` | `sessionToken` (owner), `feedIds:[...]` | フィードの並び順を変更 (表示順＝feedsシートの行順なので、行を並び替えて一括で書き戻す)。現在の全フィードIDと集合が一致しない・重複する場合は `{ok:false, error:"invalid", message}` |

フィード管理のセキュリティ規則: `isPrivate` は入力値では決めず、URLのホストが `a.ze.gs` そのもののときだけ `true` に強制する (自前ホストのマーカーとしてだけ使う)。

`doGet` は `{ok:true, service:"reader-gas"}` のヘルスチェックと、YouTube フィードの RSS 2.0 出力 (`?rss=<フィードID>`、対象外のIDは `{ok:false, error:"feed_not_found"}`) を行う。

認証に失敗した場合は `{ok:false, error:"unauthorized"}`、読み取り専用セッションでの書き込みは `{ok:false, error:"forbidden"}` を返す。

## セットアップ

### スクリプトプロパティ

| 名前 | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | 必須 | 本番シート `reader` (ステージングは `reader-staging`) のID |
| `YOUTUBE_API_KEY` | YouTube用 | YouTube Data API v3 のキー。YouTube フィードの取り込みに必須 |
| `GOOGLE_CLIENT_ID` | 任意 | 設定すると IDトークンの `aud` をピン留めする (tweet-gas と同じ) |
| `SHARE_TOKEN_HASH` / `SHARE_EXPIRES_AT` | 既存リンク用 | 一時アクセスリンクのハッシュと期限。`exchange_share` が読む。発行手段 (`issue_share`) は廃止したため、既存リンクは期限まで有効だが新規発行はできない |

プロパティが設定画面で保存できない場合は、一時ファイルから `PropertiesService.getScriptProperties().setProperty(...)` を1回実行して設定し、設定画面を新しいタブで開き直して残っていることを確認する (既存の回避手順)。

### 初回だけ手動で実行する関数

1. `setupFetchTrigger` — `fetchFeeds` の毎時トリガーを (再) 登録する
2. 動作確認として `fetchFeeds` を1回実行し、`feeds` の `last_status` と `articles` の追記を確認する
3. デプロイ後は匿名アクセスで `/exec` (GET) が `{ok:true, service:"reader-gas"}` を返すことを必ず確認する (`appsscript.json` の `webapp.access` は `ANYONE_ANONYMOUS`)

### 一時アクセスリンク

既存のリンクは、フロントが `#share=<トークン>` で受け取り、`exchange_share` で読み取り専用セッションに交換する形で、`SHARE_EXPIRES_AT` の期限まで有効。新規発行の手段は無い (`issue_share` は廃止)。

## 開発

```sh
npm test   # node build.js && node --test test/main.test.js
npm run build
```

- `src/main.js` の最後の `export { ... };` は必ず1行で書く (`build.js` が正規表現で除去して `dist/Code.gs` を作る)
- サーバー側ではフィード XML を解析しない (RSS/Atom の解析はクライアント側)。YouTube は Data API の JSON を使う

## CI

GitHub Secrets: `CLASPRC_JSON`, `SCRIPT_ID`, `DEPLOYMENT_ID`, `STAGING_SCRIPT_ID`, `STAGING_DEPLOYMENT_ID`

ワークフローファイル (`.github/workflows/`) は GitHub MCP では push できないため、このリポジトリには含めていない。既存の -gas リポジトリと同型のワークフローをブラウザで追加すること (ブランチ push でステージングへ、main で本番へデプロイ)。
