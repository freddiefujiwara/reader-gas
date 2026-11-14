# reader-gas

Web版RSSリーダー `/reader` のバックエンド (Google Apps Script Web App)。

- 毎時トリガー `fetchFeeds` が `feeds` シートの有効フィードを巡回し、新着記事を `articles` シートへ追記する
- フロントは `doPost` の JSON API で記事一覧と既読・スター状態を読み書きする
- 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、オーナー本人にだけセッションを発行する

## シート構成

スプレッドシートはスクリプトプロパティ `SPREADSHEET_ID` で指定する (コードにIDを直書きしない)。

| タブ | 内容 |
|---|---|
| `feeds` | フィード正本。初期データは `feeds-seed.csv` (dotfiles `.newsboat/urls` の18件) を取り込む |
| `articles` | 記事本体。`id` はフィードID＋guid/リンクの SHA-256 |
| `states` | 記事ごとの既読・スター状態 |
| `owner_sessions` | セッションのトークンハッシュだけを保存 (自動作成)。複数端末の同時セッション可。`role` が `owner` / `readonly` |

保持ルール: 既読でスターなし、または状態なしの記事は、60日経過または新しい順5,000件を超えた分を削除する。未読とスター付きは保持する。

## API (doPost, JSON)

| action | 引数 | 説明 |
|---|---|---|
| `exchange_session` | `idToken` | Google IDトークンを検証し、オーナーセッション (30日) を発行 |
| `exchange_share` | `shareToken` | 一時アクセスリンクを検証し、読み取り専用セッションを発行 (`list` のみ可) |
| `issue_share` | `sessionToken` (owner) | 一時アクセスリンクを発行。生トークンはこの応答で一度だけ返る。再発行で旧リンクは無効になる |
| `list` | `sessionToken`, `feedId?`, `filter=all\|unread\|starred`, `limit?`, `offset?` | 記事一覧 (状態マージ済み・新しい順)＋フィード一覧 (未読数付き) |
| `mark` | `sessionToken` (owner), `articleId`, `isRead?`, `isStarred?` | 既読・スターの付け外し。読み取り専用セッションは拒否 |
| `markAllRead` | `sessionToken` (owner), `feedId?` | まとめて既読化。読み取り専用セッションは拒否 |
| `listFeeds` | `sessionToken` (owner) | フィード管理用一覧 (無効フィードも含む全件、状態・最終取得・未読数付き)。読み取り専用セッションは拒否 |
| `saveFeed` | `sessionToken` (owner), `feed:{id,title,url,category,enabled,isPrivate}` | フィードの追加・更新。不正な入力は `{ok:false, error:"invalid", message}`。URL変更時は etag/last_modified を消して全件再取得させる |
| `deleteFeed` | `sessionToken` (owner), `feedId` | フィード行と、その記事・状態をまとめて削除。未知のIDは `{ok:false, error:"not_found"}` |

フィード管理のセキュリティ規則: `isPrivate` は入力値では決めず、URLのホストが `a.ze.gs` そのもののときだけ `true` に強制する (`A_ZE_GS_TOKEN` を第三者ホストへ送らないため)。

`doGet` は `{ok:true, service:"reader-gas"}` のヘルスチェックのみ。

認証に失敗した場合は `{ok:false, error:"unauthorized"}`、読み取り専用セッションでの書き込みは `{ok:false, error:"forbidden"}` を返す。

## セットアップ

### スクリプトプロパティ

| 名前 | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | 必須 | 本番シート `reader` (ステージングは `reader-staging`) のID |
| `A_ZE_GS_TOKEN` | 自前フィード用 | `is_private=TRUE` のフィード取得時に `X-Api-Token` ヘッダーで送るトークン。シート・コードには書かない |
| `GOOGLE_CLIENT_ID` | 任意 | 設定すると IDトークンの `aud` をピン留めする (tweet-gas と同じ) |
| `SHARE_TOKEN_HASH` / `SHARE_EXPIRES_AT` | 自動 | `issue_share` が書き込む。一時アクセスリンクのハッシュと期限 (30日) |

プロパティが設定画面で保存できない場合は、一時ファイルから `PropertiesService.getScriptProperties().setProperty(...)` を1回実行して設定し、設定画面を新しいタブで開き直して残っていることを確認する (既存の回避手順)。

### 初回だけ手動で実行する関数

1. `setupFetchTrigger` — `fetchFeeds` の毎時トリガーを (再) 登録する
2. 動作確認として `fetchFeeds` を1回実行し、`feeds` の `last_status` と `articles` の追記を確認する
3. デプロイ後は匿名アクセスで `/exec` (GET) が `{ok:true, service:"reader-gas"}` を返すことを必ず確認する (`appsscript.json` の `webapp.access` は `ANYONE_ANONYMOUS`)

### 一時アクセスリンクの発行

オーナーセッションで `issue_share` を呼ぶと生トークンが一度だけ返る。フロントの `#share=<トークン>` 形式で渡し、フロントが `exchange_share` で読み取り専用セッションに交換する。

## 開発

```sh
npm test   # node build.js && node --test test/main.test.js
npm run build
```

- `src/main.js` の最後の `export { ... };` は必ず1行で書く (`build.js` が正規表現で除去して `dist/Code.gs` を作る)
- フィード解析は XmlService を使わず純JS実装 (Node テストと同一コードで動く)

## CI

GitHub Secrets: `CLASPRC_JSON`, `SCRIPT_ID`, `DEPLOYMENT_ID`, `STAGING_SCRIPT_ID`, `STAGING_DEPLOYMENT_ID`

ワークフローファイル (`.github/workflows/`) は GitHub MCP では push できないため、このリポジトリには含めていない。`WORKFLOW-DRAFT.md` の内容を、ブラウザでワークフローファイルとして追加すること (既存の -gas リポジトリと同型: ブランチ push でステージングへ、main で本番へデプロイ)。
