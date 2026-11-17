# reader-gas

Web版RSSリーダー `/reader` のバックエンド (Google Apps Script Web App)。

- 毎時トリガー `fetchFeeds` が YouTube フィードだけを Data API 経由で巡回し、新着記事を `articles` シートへ追記する (通常の RSS フィードは v2 でクライアント側が取得する)
- フィードの並び (表示順 = `feeds` シートの行順) は、毎時 `fetchFeeds` の保守処理でカテゴリごとに安定グループ化する (カテゴリ同士の順番は現在の出現順、カテゴリ内の順番は現在の並びをそのまま維持)。新規フィードは末尾に追加されるため、放っておくとカテゴリが散らかる。順序が変わるときだけ全列の値を保持したまま行を一括で書き戻し、行の追加・削除はしない
- YouTube のチャンネル登録 (購読) を正として、毎時巡回の記事取得より前に `syncYouTubeSubscriptions` が YouTube フィードを同期する (追加も削除も同期)。購読の取得は YouTube 連携サービス (Advanced Service、要 `youtube.readonly` スコープ) を所有者アカウントの権限で使う (動画取得の APIキー方式とは別経路)。同期対象はチャンネル正規形 URL (`/channel/UC...`) のフィードだけで、通常フィードやプレイリストフィードには触らない。本人のチャンネル (`UCbiDZXbr391oT_vsRiqwPFg`、コード内 `YT_AUDIO_ALWAYS_CHANNEL_ID`) は購読に現れないため常に対象外 (ピン留め)。新規追加のジャンルは仮に `YouTube` とし (後から管理画面で変更できる)、タイトルは追加時にだけ購読側の名前を設定する (既存行のタイトルは手編集されうるため同期しない)。安全策: 購読の取得に失敗した・0件だった場合は同期を中止して何も変更せず、削除は1回5件が上限 (超えたら削除だけを中止して警告を残す)。同期の結果 (追加・削除・中止の件数と理由) は Logger に残る
- プレイリストフィード: YouTube のプレイリスト URL (`/playlist?list=...`、公開・限定公開どちらでも可) もフィードとして登録できる。プレイリスト ID は英数・ハイフン・アンダースコアで10文字以上を対象とし (クライアント側の検証規則と一致)、WL (後で見る)・LL (高評価) のような短い特殊 ID は弾く (公式 API では取得できないため)。LR (ラジオ)・RD (ミックス) で始まる自動生成プレイリストも、playlistItems が0件を返して取り込めないため登録時に弾く。毎時巡回で `playlistItems` (APIキー方式、最大2ページ＝100件) を取り込み、記事の並びはプレイリストへの追加順 (`published_at` には追加日時を入れる)。タイトルは `playlists.list` で補完する。プレイリストが正の削除同期を行う: 全ページの取得が成功し、かつ取得件数が1件以上のときだけ、取得集合に無い既存記事を削除する (取得失敗・0件では削除しない。1回の削除上限は20件で、超えたら削除だけを中止して警告を残す)。購読同期の対象ではない
- YouTube の音声は ogp と同じ非同期の形で扱う: 毎時巡回で各フィードの新しい順3本ぶん (デフォルトのスター判定。実際に依頼するのは実効スターの付いた動画だけ。スター制は下記参照)、自宅サーバーの公開ホスト (スクリプトプロパティ `A_ZE_GS_BASE_URL`) の `yt-audio` コマンドへ音声ストリーム URL の抽出を依頼する。期間制限は無く、公開日時が読めない動画だけは依頼しない。ただし長さが90秒未満と分かっている動画は数えない (Shorts・短尺クリップ対策。枠を消費せず次の動画が繰り上がる)。動画の長さは取り込み時に `videos.list` (`part=contentDetails`、候補をまとめて1回) で補い、`articles` の `duration_sec` 列へ保存する (既存記事へも埋め戻す)。長さが取れなかった動画は fail-open で通常どおり数える。ジャンルによる特別扱いはしない (旧来のジャンル「音楽」の特別ルール〈期間なし・新しい順20本〉は廃止し、音楽チャンネルも通常の3本に戻した。過去分を広く再生したい用途はプレイリストフィードでカバーする)。自宅サーバー側が抽出結果を `<A_ZE_GS_BASE_URL>/audio-urls.json` (動画ID → `{url, ts, dur}`、`dur` は実尺・秒で無いエントリもある) として公開する。RSS 出力 (`?rss=`) はその JSON を読み、抽出から5時間以内のエントリがあるアイテムにだけ enclosure として付け、エントリに `dur` があれば整数秒に丸めた `<itunes:duration>` も付ける (音声ファイル自体はどこにも置かない)。スクリプトプロパティ `YT_PLAY_TOKEN` が設定されている場合は、enclosure の URL は抽出済みの直接 URL ではなく、自宅サーバーの中継 URL (`<Y_ZE_GS_BASE_URL>/<token>/<動画ID>`) になる (直接 URL は通常の GET が約31KB/秒まで絞られ、長編動画の再生開始が約40秒かかるため。中継は Range 取得で引き直して流すだけで、ファイルは置かない)。未設定・空なら従来どおり直接 URL のまま。実尺を RSS 側に持たせるのは、この音声ストリームが断片化 MP4 (fMP4) で長さ情報が二重に入るため、プレイヤー (特に iOS) が長さを二重に数えて実尺の2倍を表示してしまうからで、クライアントは `itunes:duration` を表示・シークの正として使う
- 例外 (全件クラス) は2種類で、最新3本の上限も90秒未満の除外も付けない: 本人のチャンネル「藤原史和 川口を歩くQAエンジニア」(`UCbiDZXbr391oT_vsRiqwPFg`、コード内 `YT_AUDIO_ALWAYS_CHANNEL_ID`) は常時対応とし、取得できた動画 (最大20本) を毎時すべて依頼し直す。自宅サーバー側のバッチは URL が4時間を超えたエントリを取り直すため、毎時キューに入れ直すことでこのチャンネルの音声 URL は失効前に更新され続け、常に再生可能な状態が保たれる (自宅サーバー側の変更は不要)。もう1種類はプレイリストフィードで、本人が手で選んだ動画の集まりのため、取り込んだ記事すべてを対象にする (手で選んだものを長さで落とさない)。全体の発火キャップは 200件 (計画合計の内訳は通常分 (3本/フィード) + 全件クラス分。旧上限の100件では合計が超過し、フィード順の後ろのフィードが毎回締め出されていたため引き上げた。200を超える場合はフィード順の先頭から200件で打ち切るが、手動スターは計画側で先頭に寄せるため上限では落ちない)
- 再生対象はスター制: 実際に抽出を依頼し、RSS に enclosure を付けるのは「実効スター」が付いた動画だけ。`articles` タブの `star_override` 列には手動オーバーライドだけを保存し (`on` = 手動で付けた / `off` = 手動で外した / 空 = 自動判定に任せる)、実効スターはオーバーライドがあればそれ、無ければ上記のデフォルトルールを現在の記事集合に対して評価した結果で決める。デフォルトのランキングはオーバーライドの有無に関係なく記事集合全体で評価するため、手動で外した動画の枠に次の動画が繰り上がることはない。付け外しは `set_star` アクション (オーナー専用) で行い、付けた場合はその場で抽出も依頼する。発火計画では手動で付けた分を全体の先頭に並べる (フィード順・新しい順) ため、手動スターが全体キャップで締め出されることはない。`list` の各記事には `star_state` (オーバーライド値) と `starred` (実効スター) が付く。列が無いシートでは全行が自動判定になるため、移行なしで従来の挙動と一致する
- 視聴ログ: クライアントが `log_events` (オーナー専用) で送るイベント (`feed_view` = フィードを開いた / `article_open` = 記事を開いた / `play` = 再生し、停止時点で聴いた秒数を伴う / `scroll` = そのフィードのタイムラインをスクロールした。クリックより弱いシグナルで、クライアントが訪問ごとに最大1回だけ送る / `expand` = 記事カードの要約を「もっと見る」で展開した。記事への興味の強さを示すシグナル) を `events` タブへ一括追記する。週次集計 (`weekly_stats` タブ、週の開始日は月曜・Asia/Tokyo) への畳み込みと90日超の生ログの間引きは、毎時 `fetchFeeds` に相乗りして週1回だけ走る (最終実行はスクリプトプロパティ `WEEKLY_ROLLUP_LAST_RUN_AT` で判定し、新しいトリガーは作らない)。集計は無期限に残り、`stats` アクションで直近26週分＋今週の未集計分を返す
- フロントは `doPost` の JSON API でフィード一覧と記事を読み、フィード管理を行う (既読状態は端末ローカル管理で、サーバーは持たない)
- 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、オーナー本人にだけセッションを発行する

## シート構成

スプレッドシートはスクリプトプロパティ `SPREADSHEET_ID` で指定する (コードにIDを直書きしない)。

| タブ | 内容 |
|---|---|
| `feeds` | フィード正本。管理はフロントの管理画面 (listFeeds / saveFeed / deleteFeed / reorderFeeds) から行う |
| `articles` | 記事本体。`id` はフィードID＋guid/リンクの SHA-256。`star_override` 列にスターの手動オーバーライドだけを保存する (空 = 自動判定)。`duration_sec` 列に YouTube 動画の長さ (秒) を保存する (スター判定で90秒未満を除く材料。空 = 不明で fail-open 側に倒れる。列が無い既存タブには巡回時にヘッダーを遅延追加する) |
| `owner_sessions` | セッションのトークンハッシュだけを保存 (自動作成)。複数端末の同時セッション可。`role` が `owner` / `readonly` |
| `events` | 視聴ログの生イベント (自動作成)。列は `ts, type, feed_id, feed_title, article_id, article_title, seconds` (`seconds` は `play` のみ)。保持は90日 |
| `weekly_stats` | 週次集計 (自動作成)。列は `week` (月曜・Asia/Tokyo の開始日), `feed_id, feed_title, views, opens, plays, seconds, scrolls, expands`。無期限に残す。`scrolls` / `expands` は末尾に後付けした列で、列の無い既存タブには集計の追記時にヘッダーを遅延追加する (既存行は0件扱い) |

保持ルール: 記事は、取り込んでから60日経過または新しい順5,000件を超えた分を削除する。イベントの生ログは、週次集計へ畳んだうえで90日を超えた分を削除する (集計は残る)。

## API (doPost, JSON)

| action | 引数 | 説明 |
|---|---|---|
| `exchange_session` | `idToken` | Google IDトークンを検証し、オーナーセッション (30日) を発行 |
| `exchange_share` | `shareToken` | 一時アクセスリンクを検証し、読み取り専用セッションを発行 |
| `list` | `sessionToken`, `limit?` (最大500) | 記事一覧 (新しい順。`isRead` は既読を端末ローカル管理にするため常に `false`。各記事に `star_state` と `starred` が付く)＋フィード一覧 (未読数付き＝サーバー側の記事数)。v2 では主にフィード一覧 (fetchUrl 付き) の取得に使う |
| `listFeeds` | `sessionToken` (owner) | フィード管理用一覧 (全件、最終取得・未読数付き)。読み取り専用セッションは拒否 |
| `saveFeed` | `sessionToken` (owner), `feed:{id,title,url,category}` | フィードの追加・更新。不正な入力は `{ok:false, error:"invalid", message}`。URL変更時は etag/last_modified を消す。YouTube はチャンネルページ URL (`/channel/UC...`・`/@handle`) で登録でき、保存時は `/channel/UC...` 形に寄せる (ハンドルは Data API で解決し、タイトルも補完する)。プレイリスト URL (`/playlist?list=...`) でも登録でき、保存時は余分なクエリを落とした正規形に寄せる |
| `deleteFeed` | `sessionToken` (owner), `feedId` | フィード行と、その記事をまとめて削除。未知のIDは `{ok:false, error:"not_found"}` |
| `reorderFeeds` | `sessionToken` (owner), `feedIds:[...]` | フィードの並び順を変更 (表示順＝feedsシートの行順なので、行を並び替えて一括で書き戻す)。現在の全フィードIDと集合が一致しない・重複する場合は `{ok:false, error:"invalid", message}` |
| `set_star` | `sessionToken` (owner), `id`, `on` | 記事のスターの手動オーバーライドを保存する。`on:true` で付け (その場で音声抽出も依頼する)、`on:false` で外す。未知のIDは `{ok:false, error:"not_found"}` |
| `log_events` | `sessionToken` (owner), `events:[{type, feed_id, feed_title?, article_id?, article_title?, seconds?, ts?}]` | 視聴イベントを `events` タブへ一括追記し、`{ok:true, saved}` (保存できた件数) を返す。検証 (type は `feed_view` / `article_open` / `play` / `scroll` / `expand` のみ、文字列は ID 128字・タイトル200字で切り捨て、`play` の `seconds` は0以上の数値必須、1リクエスト最大50件) で落ちた行は捨てる。`ts` は解釈できればそれを、無ければ受付時刻を使う |
| `stats` | `sessionToken` (owner) | `{ok:true, weekly, currentWeek, current}` を返す。`weekly` は `weekly_stats` の直近26週分、`current` は今週分を `events` からその場で集計したもの (どちらも週×フィードの `views` / `opens` / `plays` / `seconds` / `scrolls` / `expands`) |
| `issueShareLink` | `sessionToken` (owner) | 一時アクセスリンクを発行し、`{ok:true, token, expiresAt}` を返す (TTL 30日)。保存はハッシュのみで、発行のたびに置き換わるため旧リンクは無効になる。平文トークンを返すのはこの応答だけ |
| `getShareLinkStatus` | `sessionToken` (owner) | 共有リンクの状態を `{ok:true, active, expiresAt}` で返す。有効なリンクが無い・期限切れなら `active:false`、`expiresAt:null` |
| `revokeShareLink` | `sessionToken` (owner) | 共有リンクの保存レコードを消して即時無効化し、`{ok:true}` を返す |

非公開フラグ (`isPrivate` / feeds タブの `is_private` 列) は廃止した。フロントは表示・取得の分岐に使っておらず、入力値も無視されていたため、計算・保存・応答のすべてを取り除き、feeds タブは9列 (id, title, url, category, etag, last_modified, last_fetched_at, last_status, last_error) にした。

`doGet` は `{ok:true, service:"reader-gas"}` のヘルスチェックと、YouTube フィードの RSS 2.0 出力 (`?rss=<フィードID>`、対象外のIDは `{ok:false, error:"feed_not_found"}`) を行う。

`?rss=` は CacheService (スクリプトキャッシュ) で高速化している。生成済みの RSS 本文をフィード別に TTL 20分で載せ、ヒット時はシートを読まずに返す。スターの付け外し (`set_star`)・フィードの保存/削除では対象フィード分を即時に無効化する。あわせて `audio-urls.json` の本文 (実測100KB超のため、1値100KB制限に収まるよう文字列をチャンク分割する) も TTL 10分で載せ、フィードをまたいで取得を使い回す。キャッシュが無い・壊れている環境では従来どおり生成・取得にフォールバックし、応答内容は変わらない。

認証に失敗した場合は `{ok:false, error:"unauthorized"}`、読み取り専用セッションでの書き込みは `{ok:false, error:"forbidden"}` を返す。

## セットアップ

### スクリプトプロパティ

| 名前 | 必須 | 内容 |
|---|---|---|
| `SPREADSHEET_ID` | 必須 | 本番シート `reader` (ステージングは `reader-staging`) のID |
| `YOUTUBE_API_KEY` | YouTube用 | YouTube Data API v3 のキー。YouTube フィードの取り込みに必須 |
| `A_ZE_GS_TOKEN` | 音声用 | 自宅サーバーの公開ホストのコマンド用トークン (`X-Api-Token`)。毎時巡回で音声抽出 (`yt-audio`) を依頼するときに使う。未設定なら依頼だけを省く |
| `YT_PLAY_TOKEN` | 音声用 | 自宅サーバーの音声中継 (`yt-play`) の合言葉。設定すると `?rss=` の enclosure が中継 URL (`<Y_ZE_GS_BASE_URL>/<token>/<動画ID>`) になる。未設定・空なら従来の直接 URL のまま |
| `A_ZE_GS_BASE_URL` | 音声用 | 自宅サーバーの公開ホスト (音声用) のベース URL (末尾スラッシュなし)。`audio-urls.json` の取得と音声抽出 (`yt-audio`) の依頼先。ホスト名はコードに直書きせずこのプロパティから読む。未設定なら取得・依頼とも省き、RSS は enclosure 無しで配信する |
| `Y_ZE_GS_BASE_URL` | 音声用 | 自宅サーバーの公開ホスト (中継用) のベース URL (末尾スラッシュなし)。音声中継 URL の組み立てに使う。未設定なら中継 URL を組み立てず、直接 URL のままにする |
| `GOOGLE_CLIENT_ID` | 任意 | 設定すると IDトークンの `aud` をピン留めする (tweet-gas と同じ) |
| `SHARE_TOKEN_HASH` / `SHARE_EXPIRES_AT` | 発行時に自動 | 一時アクセスリンクのハッシュ (SHA-256) と期限。`exchange_share` の検証が読み、`issueShareLink` が書き、`revokeShareLink` が消す。手動で設定する必要はない |
| `WEEKLY_ROLLUP_LAST_RUN_AT` | 自動 | 視聴ログの週次集計の最終実行時刻 (ミリ秒)。`fetchFeeds` に相乗りする集計ゲートが読み書きする。手動で設定する必要はない |

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
