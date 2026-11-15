# reader-gas

Web版RSSリーダー `/reader` のバックエンド (Google Apps Script Web App)。

- 毎時トリガー `fetchFeeds` が YouTube フィードだけを Data API 経由で巡回し、新着記事を `articles` シートへ追記する (通常の RSS フィードは v2 でクライアント側が取得する)
- YouTube のチャンネル登録 (購読) を正として、毎時巡回の記事取得より前に `syncYouTubeSubscriptions` が YouTube フィードを同期する (追加も削除も同期)。購読の取得は YouTube 連携サービス (Advanced Service、要 `youtube.readonly` スコープ) を所有者アカウントの権限で使う (動画取得の APIキー方式とは別経路)。同期対象はチャンネル正規形 URL (`/channel/UC...`) のフィードだけで、通常フィードには触らない。本人のチャンネル (`UCbiDZXbr391oT_vsRiqwPFg`、コード内 `YT_AUDIO_ALWAYS_CHANNEL_ID`) は購読に現れないため常に対象外 (ピン留め)。新規追加のジャンルは仮に `YouTube` とし (後から管理画面で変更できる)、タイトルは追加時にだけ購読側の名前を設定する (既存行のタイトルは手編集されうるため同期しない)。安全策: 購読の取得に失敗した・0件だった場合は同期を中止して何も変更せず、削除は1回5件が上限 (超えたら削除だけを中止して警告を残す)。同期の結果 (追加・削除・中止の件数と理由) は Logger に残る
- YouTube の音声は ogp と同じ非同期の形で扱う: 毎時巡回で各フィードの公開30日以内の最新3本ぶん、a.ze.gs の `yt-audio` コマンドへ音声ストリーム URL の抽出を依頼し (公開日時が読めない動画・30日を超えた動画は依頼しない。更新の止まったチャンネルは最新動画でも30日超なら対象外。ただしジャンルが「音楽」のフィードだけは特別扱いで、期間の縛りを付けず新しい順に最新10本まで依頼する)、ze 側が抽出結果を `https://a.ze.gs/audio-urls.json` (動画ID → `{url, ts, dur}`、`dur` は実尺・秒で無いエントリもある) として公開する。RSS 出力 (`?rss=`) はその JSON を読み、抽出から5時間以内のエントリがあるアイテムにだけ enclosure として付け、エントリに `dur` があれば整数秒に丸めた `<itunes:duration>` も付ける (音声ファイル自体はどこにも置かない)。スクリプトプロパティ `YT_PLAY_TOKEN` が設定されている場合は、enclosure の URL は抽出済みの直接 URL ではなく、ze の中継 URL (`https://y.ze.gs/<token>/<動画ID>`) になる (直接 URL は通常の GET が約31KB/秒まで絞られ、長編動画の再生開始が約40秒かかるため。中継は Range 取得で引き直して流すだけで、ファイルは置かない)。未設定・空なら従来どおり直接 URL のまま。実尺を RSS 側に持たせるのは、この音声ストリームが断片化 MP4 (fMP4) で長さ情報が二重に入るため、プレイヤー (特に iOS) が長さを二重に数えて実尺の2倍を表示してしまうからで、クライアントは `itunes:duration` を表示・シークの正として使う
- 例外として、本人のチャンネル「藤原史和 川口を歩くQAエンジニア」(`UCbiDZXbr391oT_vsRiqwPFg`、コード内 `YT_AUDIO_ALWAYS_CHANNEL_ID`) だけは常時対応とする: 30日制限も最新3本の上限も付けず、取得できた動画 (最大20本) を毎時すべて依頼し直す。ze 側のバッチは URL が4時間を超えたエントリを取り直すため、毎時キューに入れ直すことでこのチャンネルの音声 URL は失効前に更新され続け、常に再生可能な状態が保たれる (ze 側の変更は不要)。全体の発火キャップは 100件 (通常分 最大23フィード×3本=69 + 常時対応分 最大20本に余裕を持たせた値。音楽フィードの枠が増えて合計が100を超える場合は、フィード順の先頭から100件で打ち切る)
- フロントは `doPost` の JSON API でフィード一覧と記事を読み、フィード管理を行う (既読状態は端末ローカル管理で、サーバーは持たない)
- 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、オーナー本人にだけセッションを発行する

## シート構成

スプレッドシートはスクリプトプロパティ `SPREADSHEET_ID` で指定する (コードにIDを直書きしない)。

| タブ | 内容 |
|---|---|
| `feeds` | フィード正本。管理はフロントの管理画面 (listFeeds / saveFeed / deleteFeed / reorderFeeds) から行う |
| `articles` | 記事本体。`id` はフィードID＋guid/リンクの SHA-256 |
| `owner_sessions` | セッションのトークンハッシュだけを保存 (自動作成)。複数端末の同時セッション可。`role` が `owner` / `readonly` |

保持ルール: 記事は、取り込んでから60日経過または新しい順5,000件を超えた分を削除する。

## API (doPost, JSON)

| action | 引数 | 説明 |
|---|---|---|
| `exchange_session` | `idToken` | Google IDトークンを検証し、オーナーセッション (30日) を発行 |
| `exchange_share` | `shareToken` | 一時アクセスリンクを検証し、読み取り専用セッションを発行 |
| `list` | `sessionToken`, `limit?` (最大500) | 記事一覧 (新しい順。`isRead` は既読を端末ローカル管理にするため常に `false`)＋フィード一覧 (未読数付き＝サーバー側の記事数)。v2 では主にフィード一覧 (fetchUrl 付き) の取得に使う |
| `listFeeds` | `sessionToken` (owner) | フィード管理用一覧 (全件、最終取得・未読数付き)。読み取り専用セッションは拒否 |
| `saveFeed` | `sessionToken` (owner), `feed:{id,title,url,category,isPrivate}` | フィードの追加・更新。不正な入力は `{ok:false, error:"invalid", message}`。URL変更時は etag/last_modified を消す。YouTube はチャンネルページ URL (`/channel/UC...`・`/@handle`) で登録でき、保存時は `/channel/UC...` 形に寄せる (ハンドルは Data API で解決し、タイトルも補完する) |
| `deleteFeed` | `sessionToken` (owner), `feedId` | フィード行と、その記事をまとめて削除。未知のIDは `{ok:false, error:"not_found"}` |
| `reorderFeeds` | `sessionToken` (owner), `feedIds:[...]` | フィードの並び順を変更 (表示順＝feedsシートの行順なので、行を並び替えて一括で書き戻す)。現在の全フィードIDと集合が一致しない・重複する場合は `{ok:false, error:"invalid", message}` |
| `issueShareLink` | `sessionToken` (owner) | 一時アクセスリンクを発行し、`{ok:true, token, expiresAt}` を返す (TTL 30日)。保存はハッシュのみで、発行のたびに置き換わるため旧リンクは無効になる。平文トークンを返すのはこの応答だけ |
| `getShareLinkStatus` | `sessionToken` (owner) | 共有リンクの状態を `{ok:true, active, expiresAt}` で返す。有効なリンクが無い・期限切れなら `active:false`、`expiresAt:null` |
| `revokeShareLink` | `sessionToken` (owner) | 共有リンクの保存レコードを消して即時無効化し、`{ok:true}` を返す |

フィード管理のセキュリティ規則: `isPrivate` は入力値では決めず、URLのホストが `a.ze.gs` そのもののときだけ `true` に強制する (自前ホストのマーカーとしてだけ使う)。

`doGet` は `{ok:true, service:"reader-gas"}` のヘルスチェックと、YouTube フィードの RSS 2.0 出力 (`?rss=<フィードID>`、対象外のIDは `{ok:false, error:"feed_not_found"}`) を行う。

認証に失敗した場合は `{ok:false, error:"unauthorized"}`、読み取り専用セッションでの書き込みは `{ok:false, error:"forbidden"}` を返す。

## セットアップ

### スクリプトプロパティ

| 名前 | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | 必須 | 本番シート `reader` (ステージングは `reader-staging`) のID |
| `YOUTUBE_API_KEY` | YouTube用 | YouTube Data API v3 のキー。YouTube フィードの取り込みに必須 |
| `A_ZE_GS_TOKEN` | 音声用 | a.ze.gs のコマンド用トークン (`X-Api-Token`)。毎時巡回で音声抽出 (`yt-audio`) を依頼するときに使う。未設定なら依頼だけを省く |
| `YT_PLAY_TOKEN` | 音声用 | ze の音声中継 (`yt-play`) の合言葉。設定すると `?rss=` の enclosure が中継 URL (`https://y.ze.gs/<token>/<動画ID>`) になる。未設定・空なら従来の直接 URL のまま |
| `GOOGLE_CLIENT_ID` | 任意 | 設定すると IDトークンの `aud` をピン留めする (tweet-gas と同じ) |
| `SHARE_TOKEN_HASH` / `SHARE_EXPIRES_AT` | 発行時に自動 | 一時アクセスリンクのハッシュ (SHA-256) と期限。`exchange_share` の検証が読み、`issueShareLink` が書き、`revokeShareLink` が消す。手動で設定する必要はない |

プロパティが設定画面で保存できない場合は、一時ファイルから `PropertiesService.getScriptProperties().setProperty(...)` を1回実行して設定し、設定画面を新しいタブで開き直して残っていることを確認する (既存の回避手順)。

### 初回だけ手動で実行する関数

1. `setupFetchTrigger` — `fetchFeeds` の毎時トリガーを (再) 登録する
2. `syncYouTubeSubscriptions` — YouTube 連携サービスの初回認可としてエディタで1回実行し、YouTube スコープ (`youtube.readonly`) を許可する。認可が古いスコープ集合のまま残って連携サービスが権限エラーになる場合は、Google アカウントの「サードパーティ製のアプリとサービス」からこのプロジェクトの連携を一度削除し、再実行して許可し直す
3. 動作確認として `fetchFeeds` を1回実行し、`feeds` の `last_status` と `articles` の追記を確認する
4. デプロイ後は匿名アクセスで `/exec` (GET) が `{ok:true, service:"reader-gas"}` を返すことを必ず確認する (`appsscript.json` の `webapp.access` は `ANYONE_ANONYMOUS`)

### 一時アクセスリンク

オーナーが `issueShareLink` で発行する (TTL 30日)。フロントはリンクを `#share=<トークン>` で受け取り、`exchange_share` で読み取り専用セッションに交換する。保存はスクリプトプロパティ `SHARE_TOKEN_HASH` / `SHARE_EXPIRES_AT` の単一レコードで、トークンの平文は保存せず SHA-256 ハッシュだけを置く。発行のたびにレコードを置き換えるため旧リンクは無効になり、`revokeShareLink` で即時無効化もできる。状態は `getShareLinkStatus` で確認する。検証経路 (`exchange_share` → `validateShareToken`) は従来どおりで、保存形式も従来と同じプロパティのため、移行は不要で既存リンクもそのまま有効。

## 開発

```sh
npm test   # node build.js && node --test test/main.test.js
npm run build
npm run smoke   # 本番 /exec のスモークチェック (下記)
```

- `src/main.js` の最後の `export { ... };` は必ず1行で書く (`build.js` が正規表現で除去して `dist/Code.gs` を作る)
- サーバー側ではフィード XML を解析しない (RSS/Atom の解析はクライアント側)。YouTube は Data API の JSON を使う

### デプロイ後のスモークチェック

`npm run smoke` (`scripts/smoke.mjs`) が、デプロイ後の確認を担う。本番の `/exec` を匿名で叩き、ヘルス応答 (`{ok:true, service:"reader-gas"}`)、YouTube フィードの RSS 出力 (`?rss=85ce0e8df21fc1c6` (rakutentech のハッシュ ID) に item と guid があること)、実在する非 YouTube フィードと未知 ID の `feed_not_found`、セッション無し `list` の `unauthorized` を確認する。1件でも外れたら終了コード 1 で終わる。対象 URL は環境変数 `READER_GAS_EXEC_URL` で差し替えできる (未設定時は本番 URL)。

## CI

GitHub Secrets: `CLASPRC_JSON`, `SCRIPT_ID`, `DEPLOYMENT_ID`, `STAGING_SCRIPT_ID`, `STAGING_DEPLOYMENT_ID`

ワークフローは `.github/workflows/node.yaml` (他の -gas リポジトリと同型)。GitHub MCP では push できないため、変更が必要なときはブラウザで編集すること。main 以外のブランチへの push でステージングへ、main へのマージで本番へデプロイされる。
