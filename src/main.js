// reader-gas: Web版RSSリーダー /reader のバックエンドAPI (Google Apps Script)。
// 正本は Google Sheets (feeds / articles / owner_sessions の3タブ)。
// スプレッドシートIDはスクリプトプロパティ SPREADSHEET_ID から読む (コードに直書きしない)。
// 毎時トリガー fetchFeeds が YouTube フィードだけを巡回して articles へ追記する (v2)。
// 既読状態は v2 から端末ローカル管理のため、サーバー側に states タブは持たない
// (doPost の list が返す isRead は常に false。フィード管理も doPost で行う)。
// フィード管理 (listFeeds / saveFeed / deleteFeed / reorderFeeds) はオーナー専用とする。
// 非公開フラグ (is_private) は廃止し、feeds タブの列自体も撤去した (全9列)。
// フロントは表示・取得の分岐に使っておらず、入力値も無視されていた。
// 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、
// オーナー本人 (ALLOWED_EMAIL) にだけ30日セッションを発行する。
// セッションは owner_sessions タブにトークンの SHA-256 ハッシュだけを保存し、
// 複数端末の同時セッションを妨げない。
// 一時アクセスリンク (share) は読み取り専用: exchange_share で検証し、
// role=readonly のセッションを発行する。書き込み系の操作は readonly を拒否する。
// 共有リンクの保存はスクリプトプロパティ SHARE_TOKEN_HASH (SHA-256 ハッシュ
// のみ) と SHARE_EXPIRES_AT の単一レコードで、発行・状態確認・無効化は
// オーナー専用アクション (issueShareLink / getShareLinkStatus /
// revokeShareLink) で行う。発行のたびにレコードを置き換えるため、
// 旧リンクはその時点で無効になる (TTL は30日)。
// v2 では RSS フィードの巡回はクライアント側 (url-fetch-gas 経由) で行うため、
// サーバー側の巡回は YouTube だけを対象にする。A_ZE_GS_TOKEN は
// 音声抽出トリガー (yt-audio コマンド) を叩くときにだけ読む。
// v3 フェーズ1: フィードIDは URL のハッシュ (feedIdFromUrl) で決め、タイトルは
// 自動取得のみとする (YouTube は登録時に空で受け、fetchFeeds が補完する)。
// 既存シートの ID 付け替え (slug → ハッシュ) は完了済みで、現在の行はすべてハッシュ ID。
// 有効/無効 (enabled) は廃止し、feeds タブの列自体も撤去した。
// 巡回・一覧・保存のどこでも参照しない。
// YouTube の保存形はチャンネルページ URL (/channel/UC...) と
// プレイリスト URL (/playlist?list=...) に統一する。
// /@handle 形で登録されても保存時に正規形へ寄せる
// (handleSaveFeed)。ハンドルは channels.list の forHandle で解決し、
// タイトルも補完する。既存行の videos.xml 形は移行済みで、互換は持たない。
// 視聴ログは events / weekly_stats の2タブに貯める (どちらも遅延
// 作成)。クライアントが log_events (オーナー専用) で送るイベントを
// events に一括追記し、週次集計 (weekly_stats) と90日超の生ログの
// 間引きを、毎時 fetchFeeds に相乗りして週1回だけ行う。
// feeds の並び (表示順 = 行順) も毎時 fetchFeeds の保守処理で
// カテゴリごとに安定グループ化する。新規フィードは末尾に付くため
// 放っておくとカテゴリが散らかる。順序が変わるときだけ書き戻す
// ので、相乗りしても通常は読み取り1回で済む。
// 再生対象 (音声抽出トリガーと RSS の enclosure) はスター制:
// 実効スターが付いた YouTube 動画だけを対象にする。シートに保存
// するのは articles タブの star_override 列 (手動オーバーライド:
// '' = 自動判定に任せる、'on' = 手動で付けた、'off' = 手動で外した)
// だけで、実効スターはオーバーライドがあればそれを優先し、無ければ
// デフォルトルール (従来の planYouTubeAudioTriggers の選定規則) を
// 現在の記事集合に対して評価した結果で決める。列が無いシートでは
// 全行が '' 扱いになるため、移行なしで従来の挙動と一致する。

const ALLOWED_EMAIL_PROP = 'ALLOWED_EMAIL';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const OWNER_SHEET_NAME = 'owner_sessions';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TOKEN_HASH_PROP = 'SHARE_TOKEN_HASH';
const SHARE_EXPIRES_AT_PROP = 'SHARE_EXPIRES_AT';
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_HEADERS = ['token_hash', 'issued_at', 'expires_at', 'revoked_at', 'access_count', 'last_accessed_at', 'role'];
const FEEDS_HEADERS = ['id', 'title', 'url', 'category', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
const ARTICLES_HEADERS = ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author', 'star_override', 'duration_sec'];
const RETENTION_DAYS = 60;
const MAX_ARTICLES = 5000;
const SUMMARY_MAX_CHARS = 500;
// 視聴ログ (log_events / stats): クライアントが送るイベントを events
// タブへ貯め、週次集計を weekly_stats タブへ畳む (どちらも遅延作成)。
// 生ログは90日保持し、集計は無期限に残す。集計と間引きは毎時
// fetchFeeds に相乗りし、最終実行 (スクリプトプロパティ
// WEEKLY_ROLLUP_LAST_RUN_AT) から7日以上空いたときだけ走る。
// 新しいトリガーは作らない。weekly_stats の scrolls / expands 列は
// 末尾に後付けした列で、列の無い既存タブには集計の追記時にヘッダーを
// 遅延追加する (articles の star_override と同じ移行パターン)。
// 既存行の scrolls / expands は空 = 0 件扱いになる。
const EVENTS_SHEET_NAME = 'events';
const WEEKLY_STATS_SHEET_NAME = 'weekly_stats';
const EVENTS_HEADERS = ['ts', 'type', 'feed_id', 'feed_title', 'article_id', 'article_title', 'seconds'];
const WEEKLY_STATS_HEADERS = ['week', 'feed_id', 'feed_title', 'views', 'opens', 'plays', 'seconds', 'scrolls', 'expands'];
const EVENT_TYPES = {
  feed_view: true, article_open: true, play: true, scroll: true, expand: true,
  preload_error: true, advance_swap: true, advance_load: true, stall: true, recover: true,
  deck_overlap: true,
  play_rejected_not_allowed: true, play_rejected_not_supported: true, play_rejected_other: true,
  start_retry: true, start_fallback: true, start_failed: true,
  route_offline: true, route_online: true, route_reload: true,
};
// 件数だけを数えるイベント種別と、weekly_stats 側のフィールド名の対応。
const EVENT_COUNTER_FIELDS = { feed_view: 'views', article_open: 'opens', scroll: 'scrolls', expand: 'expands' };
const EVENT_LOG_MAX_PER_REQUEST = 50;
const EVENT_ID_MAX_CHARS = 128;
const EVENT_TITLE_MAX_CHARS = 200;
const EVENT_RETENTION_DAYS = 90;
const WEEKLY_ROLLUP_PROP = 'WEEKLY_ROLLUP_LAST_RUN_AT';
const WEEKLY_ROLLUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_STATS_MAX_WEEKS = 26;

// --- Sheets helpers (xuexi-gas と同型) ---

// 値配列の1行をヘッダー名キーのオブジェクトにする。行に無いセルは ''。
function rowObject(headers, row) {
  const obj = {};
  (headers || []).forEach((h, idx) => {
    obj[h] = row && row[idx] !== undefined ? row[idx] : '';
  });
  return obj;
}

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.every((c) => c === '' || c === null || c === undefined)) continue;
    out.push(rowObject(headers, row));
  }
  return out;
}

// データ行 (添字1始まり) から条件に合う最初の行の添字を探す。無ければ -1。
function findDataRowIndex(values, pred) {
  for (let i = 1; i < (values || []).length; i++) {
    if (pred(values[i])) return i;
  }
  return -1;
}

// シートの全内容を値配列で置き換える (残す行だけを書き戻す削除や、
// 行順の書き換えで使う)。
function replaceSheetValues(sheet, values) {
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
}

// 行順だけが違う値配列への書き換え。行参照の同一性で「並びが
// 変わったか」を判定し、変わったときだけ書き戻して true を返す。
function rewriteRowsIfChanged(sheet, current, next) {
  for (let i = 0; i < current.length; i++) {
    if (next[i] !== current[i]) {
      replaceSheetValues(sheet, next);
      return true;
    }
  }
  return false;
}

// ヘッダーに列が無ければ末尾へ遅延追加し、その列位置 (0始まり) を
// 返す (star_override / duration_sec と同じ移行パターン)。
function ensureColumnIndex(sheet, headers, name) {
  let idx = headers.indexOf(name);
  if (idx < 0) {
    idx = headers.length;
    sheet.getRange(1, idx + 1).setValue(name);
  }
  return idx;
}

// スクリプトプロパティを1件読む (単一読み取り箇所の共通形)。
function scriptProperty(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function readSheetAsObjects(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  return rowsToObjects(values);
}

function getSheetOrCreate(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers && headers.length) sheet.appendRow(headers);
  }
  return sheet;
}

function openDataSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not set in script properties');
  return SpreadsheetApp.openById(id);
}

function isTruthy(value) {
  return value === true || value === 1 || value === 'TRUE' || value === 'true' || value === '1';
}

function cellIso(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return asText(value);
}

// 外部由来の値を安全にテキストとして読む。文字列はそのまま、
// 数値・真値は文字列化し、それ以外 (オブジェクト・配列・null 等) は
// 空文字にする。素の String() は、toString が関数でないオブジェクト
// (JSON 由来で起こりうる) で例外になるため、入力の境界ではこちらを使う。
function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// 外部由来の数値フィールドを読む。数値と数値文字列だけを数として
// 認め、それ以外は NaN (= 読めない) にする。素の Number() は
// true を 1、[65] を 65 に化けさせるため、時刻や実尺の判定には使わない。
function asNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

// --- SHA-256 ---
// GAS では Utilities.computeDigest を優先し、無い環境 (Node テスト) では
// 純JS実装にフォールバックする。どちらも同じ16進文字列を返す。

function utf8Bytes(str) {
  const bytes = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

function sha256HexPure(str) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes = utf8Bytes(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit length: inputs here are far below 2^32 bits, high word is 0.
  bytes.push(0, 0, 0, 0);
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const w = new Array(64);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      const i = block + t * 4;
      w[t] = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map((x) => ('0000000' + x.toString(16)).slice(-8)).join('');
}

function sha256Hex(str) {
  if (typeof Utilities !== 'undefined' && Utilities.computeDigest) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
    return digest.map((b) => ('0' + ((b & 0xff).toString(16))).slice(-2)).join('');
  }
  return sha256HexPure(str);
}

function articleId(feedId, guidOrLink) {
  return sha256Hex(String(feedId) + '\n' + String(guidOrLink));
}

// フィードIDは URL の SHA-256 (16進・小文字) の先頭16文字で決める (v3)。
// フロント側も同じ規則で算出するため、入力は検証・整形済みの URL 文字列
// (シートに保存される文字列) そのままでなければならない。
function feedIdFromUrl(url) {
  return sha256Hex(String(url || '')).slice(0, 16);
}

function hashesEqual(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function isSessionExpired(expiresAt, now) {
  const exp = Date.parse(cellIso(expiresAt));
  if (!exp) return true;
  const n = now ? Date.parse(cellIso(now)) : Date.now();
  return exp <= n;
}

// --- XML entities ---
// decodeXmlEntities は stripTags (要約のプレーン化) から使う。
// フィード XML のパースは v2 でクライアント側へ移ったため、サーバー側には残っていない。

// 数値文字参照の復号。範囲外・サロゲート・NUL はブラウザと同様に
// 置換文字 (U+FFFD) にし、String.fromCodePoint の例外を出さない。
function charFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

function decodeXmlEntities(text) {
  if (!text) return '';
  return asText(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => charFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => charFromCodePoint(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  // Decode first so escaped markup (&lt;p&gt;...) is stripped as markup too,
  // then strip real tags. Plain-text entities survive the tag pass.
  const decoded = decodeXmlEntities(asText(html));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function summarize(html, maxChars) {
  const limit = maxChars || SUMMARY_MAX_CHARS;
  const text = stripTags(html);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  // サロゲートペアの途中で切れた場合は、ぶら下がった上位サロゲートを落とす。
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function toIsoDate(value) {
  if (!value) return '';
  const s = asText(value).trim();
  if (!s) return '';
  // ISO 形 (YYYY-MM-DD...) の入力は、書かれた日付が実在するか確認する。
  // Date.parse は 2026-02-30 のような日付を 3月2日へ繰り上げて解釈する
  // ため、そのままでは存在しない日付が本物らしく化けてしまう。
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (dm) {
    const y = Number(dm[1]);
    const mo = Number(dm[2]);
    const d = Number(dm[3]);
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return '';
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}

// --- YouTube (Data API v3) ---
// 公式RSS (feeds/videos.xml) が 404 を返すため、YouTube のチャンネルフィードは
// Data API v3 の uploads プレイリストから取り込む。フィード行の保存形は
// チャンネルページ URL (/channel/UC...) に統一する (旧来の videos.xml 形の
// 行は移行済みで、互換は持たない)。

// 保存形 (/channel/UC...) から channel_id を抜く。巡回振り分け・?rss= 出力・
// buildFetchUrl・タイトル空の例外判定はすべてこの関数経由で判定する。
function youtubeChannelIdFromUrl(url) {
  const s = String(url || '');
  const page = /^https:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{10,})/.exec(s);
  return page ? page[1] : '';
}

// 保存形 (/playlist?list=...) からプレイリスト ID を抜く
// (youtubeChannelIdFromUrl と対になる判定関数)。巡回振り分け・?rss=
// 出力・buildFetchUrl・タイトル空の例外判定・スター計算はすべて
// この関数経由で判定する。登録時の入力 (余分なクエリ付き) からも
// 抜けるよう、list= はクエリのどこにあっても拾う。
// ID は英数・ハイフン・アンダースコアで10文字以上とする (クライアント
// 側の検証規則に合わせたもの)。WL (後で見る) や LL (高評価) のような
// 短い特殊 ID は、これで弾かれる (公式 API では取得できないため)。
// LR (ラジオ) や RD (ミックス) のような自動生成 ID は抽出はするが、
// validateFeedInput が保存時に弾く (この関数は巡回判定にも使うため、
// 抽出の挙動自体は変えない)。
function youtubePlaylistIdFromUrl(url) {
  const s = String(url || '');
  if (!/^https:\/\/(?:www\.)?youtube\.com\/playlist\?/.test(s)) return '';
  const m = /[?&]list=([\w-]{10,})/.exec(s.split('#')[0]);
  return m ? m[1] : '';
}

// シートに保存する正規形のプレイリストフィード URL をプレイリスト ID
// から組み立てる (youtubeFeedUrlFromChannelId と対)。
function youtubeFeedUrlFromPlaylistId(playlistId) {
  return 'https://www.youtube.com/playlist?list=' + String(playlistId || '');
}

// URL が YouTube フィード (チャンネル・プレイリスト) かどうかの判定。
// 巡回対象の選定・fetchUrl の組み立て・?rss= の検証はすべてこれで揃える。
function isYouTubeFeedUrl(url) {
  return !!(youtubeChannelIdFromUrl(url) || youtubePlaylistIdFromUrl(url));
}

// シートに保存する正規形の YouTube フィード URL (チャンネルページ URL) を
// チャンネルIDから組み立てる。フィードID (URL のハッシュ) はこの形から
// 決めるため、登録経路が違っても保存形は必ずこれに寄せる。
function youtubeFeedUrlFromChannelId(channelId) {
  return 'https://www.youtube.com/channel/' + String(channelId || '');
}

// YouTube のチャンネルページ URL を判別する (登録時の入力専用)。
//   https://www.youtube.com/channel/UC...  -> { kind:'id', channelId }
//   https://www.youtube.com/@handle        -> { kind:'handle', handle } (先頭の @ は含めない)
// ハンドルは末尾のパス (/videos 等) や末尾スラッシュを落として正規化する。
// 旧来の /c/ や /user/ 形式は解決手段が無いため対象外とし、null を返す
// (呼び出し側では通常の URL 検証に落ちて従来どおり弾かれる)。
// チャンネルページでない URL は null。
function parseYouTubeChannelUrl(url) {
  const s = String(url || '').trim();
  const idMatch = /^https:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{10,})(?:\/[^?#]*)?(?:[?#][\s\S]*)?$/.exec(s);
  if (idMatch) return { kind: 'id', channelId: idMatch[1] };
  const handleMatch = /^https:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9._-]+)(?:\/[^?#]*)?(?:[?#][\s\S]*)?$/.exec(s);
  if (handleMatch) return { kind: 'handle', handle: handleMatch[1] };
  return null;
}

// YouTube API のエラー応答から、原因が分かる短い文言だけを取り出す
// (APIキー自体は応答に含まれない)。
function youtubeApiErrorDetail(bodyText) {
  try {
    const body = JSON.parse(String(bodyText || ''));
    const err = body && body.error ? body.error : null;
    if (!err) return '';
    const msg = String(err.message || '').trim();
    const reason = err.errors && err.errors[0] ? String(err.errors[0].reason || '').trim() : '';
    const detail = msg || reason;
    return detail ? ' - ' + detail.slice(0, 200) : '';
  } catch (e) {
    return '';
  }
}

function youtubeUploadsPlaylistId(channelId) {
  const id = String(channelId || '');
  return id.startsWith('UC') ? 'UU' + id.slice(2) : '';
}

// YouTube API の応答 JSON から items 配列を取り出す共通処理。
// JSON が壊れている・items が配列でない場合は空配列にする。
function jsonItems(jsonText) {
  try {
    const data = JSON.parse(String(jsonText || ''));
    return data && Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    return [];
  }
}

// playlistItems の応答 JSON をエントリ配列へ正規化する。
// 削除・非公開動画 (タイトルが Deleted video / Private video) は取り込まない。
function parseYouTubePlaylistItems(jsonText, feed) {
  const feedId = feed && feed.id ? String(feed.id) : '';
  const items = jsonItems(jsonText);
  const entries = [];
  items.forEach((item) => {
    const sn = (item && item.snippet) || {};
    const videoId = sn.resourceId ? asText(sn.resourceId.videoId) : '';
    const title = asText(sn.title).trim();
    if (!videoId || !title || title === 'Deleted video' || title === 'Private video') return;
    entries.push({
      guid: videoId,
      title,
      link: 'https://www.youtube.com/watch?v=' + videoId,
      publishedAt: toIsoDate(sn.publishedAt),
      summary: summarize(sn.description || ''),
      author: asText(sn.channelTitle).trim(),
      feedId,
    });
  });
  return entries;
}

// playlistItems の応答から nextPageToken を取り出す (プレイリスト
// フィードのページング用)。無ければ・壊れていれば空文字。
function parseYouTubeNextPageToken(jsonText) {
  try {
    const data = JSON.parse(String(jsonText || ''));
    return data && data.nextPageToken ? String(data.nextPageToken) : '';
  } catch (e) {
    return '';
  }
}

// ISO 8601 duration (YouTube の contentDetails.duration 形式:
// PT1H2M3S / PT45S / P1DT2H 等) を秒へ変換する (純関数)。
// 読めなければ 0 (= 長さ不明)。
function iso8601DurationToSec(text) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(asText(text).trim());
  if (!m) return 0;
  return (Number(m[1]) || 0) * 86400 + (Number(m[2]) || 0) * 3600
    + (Number(m[3]) || 0) * 60 + (Number(m[4]) || 0);
}

// videos.list (part=contentDetails) の応答から { videoId: 秒 } を
// 取り出す (純関数)。長さが読めない動画は含めない (= 不明のまま)。
function parseYouTubeDurations(jsonText) {
  const map = {};
  jsonItems(jsonText).forEach((item) => {
    const videoId = asText(item && item.id);
    const sec = iso8601DurationToSec(item && item.contentDetails ? item.contentDetails.duration : '');
    if (videoId && sec > 0) map[videoId] = sec;
  });
  return map;
}

// チャンネル取り込みのエントリへ動画の長さを videos.list で補う
// (スター判定で90秒未満を除くため)。取得は候補をまとめて1回
// (最大50本)。失敗しても例外を出さず、長さは不明のままにする
// (fail-open: 判定側は不明を通常どおり数える)。
function attachYouTubeDurations(entries, apiKey) {
  try {
    const ids = [];
    (entries || []).forEach((entry) => {
      if (entry && entry.guid) ids.push(entry.guid);
    });
    if (!ids.length || !apiKey) return;
    const apiUrl = 'https://www.googleapis.com/youtube/v3/videos?part=contentDetails'
      + '&id=' + encodeURIComponent(ids.slice(0, 50).join(','))
      + '&key=' + encodeURIComponent(apiKey);
    const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    const durations = parseYouTubeDurations(res.getContentText());
    (entries || []).forEach((entry) => {
      if (entry && durations[entry.guid]) entry.durationSec = durations[entry.guid];
    });
  } catch (e) {
    // 長さが補えなくても取り込みは続ける (fail-open)。
  }
}

// channels.list / playlists.list の応答から、先頭 item の
// snippet.title を取り出す共通処理。取れなければ空文字。
function firstSnippetTitle(jsonText) {
  const items = jsonItems(jsonText);
  const sn = (items[0] && items[0].snippet) || {};
  return asText(sn.title).trim();
}

// channels.list の応答からチャンネル名を取り出す。タイトル未設定の
// YouTube フィード (登録時に空で入る) の補完に使う。取れなければ空文字。
function parseYouTubeChannelTitle(jsonText) {
  return firstSnippetTitle(jsonText);
}

// playlists.list の応答からプレイリスト名を取り出す
// (parseYouTubeChannelTitle と対)。タイトル未設定のプレイリスト
// フィードの補完に使う。取れなければ空文字。
function parseYouTubePlaylistTitle(jsonText) {
  return firstSnippetTitle(jsonText);
}

// channels.list の応答から { channelId, title } を取り出す (登録時の
// ハンドル解決用)。先頭の item の id と snippet.title を使い、
// item が無い・id が無い・JSON が壊れている場合は null。
function parseChannelLookupResponse(jsonText) {
  const items = jsonItems(jsonText);
  const first = items[0] || null;
  const channelId = first ? asText(first.id).trim() : '';
  if (!channelId) return null;
  const sn = (first && first.snippet) || {};
  return { channelId, title: asText(sn.title).trim() };
}

// ハンドルから channels.list?forHandle= でチャンネルを引く (登録時専用)。
// APIキーが無い・HTTPエラー・該当なし・例外はすべて null (解決失敗) とする。
// handleSaveFeed からは差し替え可能な resolver として呼ばれる。
function lookupYouTubeChannelByHandle(handle) {
  try {
    const apiKey = scriptProperty('YOUTUBE_API_KEY');
    if (!apiKey) return null;
    const apiUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet'
      + '&forHandle=' + encodeURIComponent('@' + String(handle || ''))
      + '&key=' + encodeURIComponent(apiKey);
    const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return parseChannelLookupResponse(res.getContentText());
  } catch (e) {
    return null;
  }
}

// --- CacheService による読み取りキャッシュ (?rss= の高速化) ---
// ?rss= はリクエストのたびに、スプレッドシート全件読み (feeds と
// 全フィード分の articles)・全フィード分のスター再計算・
// audio-urls.json の外部取得・プロパティ参照 (enclosure のある
// アイテムごとに中継ベース URL を引き直す) をやり直しており、
// 応答が 7〜31KB と小さい割に実測 4〜10秒かかっていた。データが
// 変わるのは毎時巡回 (fetchFeeds) と set_star / saveFeed /
// deleteFeed のアクションだけなので、生成済みの RSS 本文と
// audio-urls.json の本文をスクリプトキャッシュに載せて読み取りを
// 飛ばす。キャッシュが無い・壊れている環境では従来どおり生成に
// フォールバックし、応答内容は現行と同一に保つ。

// CacheService の1値は100KBまで。文字数ではなく UTF-8 バイト数で
// 数える (日本語は1文字3バイト)。上限に余裕を持たせた値。
const CACHE_VALUE_MAX_BYTES = 90000;

function utf8ByteLength(text) {
  const s = String(text || '');
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xFFFF) { bytes += 4; i++; }
    else if (cp > 0x7FF) bytes += 3;
    else if (cp > 0x7F) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

// スクリプトキャッシュの取得。CacheService が無い環境 (Node
// テスト等) や取得自体が失敗した場合は null を返し、呼び出し側は
// キャッシュ無しとして従来どおり動く。
function scriptCache() {
  try {
    if (typeof CacheService === 'undefined' || !CacheService) return null;
    return CacheService.getScriptCache() || null;
  } catch (e) {
    return null;
  }
}

const RSS_CACHE_KEY_PREFIX = 'rss:v1:';

// RSS 本文の TTL (秒)。フィードのデータ自体は毎時巡回でしか
// 変わらないが、enclosure は巡回後に非同期 (自宅サーバー側の
// 10分間隔バッチ) で抽出される音声 URL に依存するため、丸ごと
// 1時間は載せず20分に留める (再生ボタンが出るまでの遅れは
// 抽出バッチの間隔と同程度に収まる)。スターの付け外し・
// フィードの保存/削除は各ハンドラが即時に無効化するため、
// この TTL の影響を受けない。
const RSS_CACHE_TTL_SEC = 1200;

function rssCacheKey(feedId) {
  return RSS_CACHE_KEY_PREFIX + String(feedId || '');
}

// フィードのデータが変わるアクション (スター付け外し・保存・
// 削除) から呼ぶ。キャッシュが無い環境では何もしない。
function invalidateRssCache(feedId) {
  if (!feedId) return;
  const cache = scriptCache();
  if (!cache) return;
  try { cache.remove(rssCacheKey(feedId)); } catch (e) { /* 落とせなくても TTL で切れる */ }
}

// audio-urls.json 本文の TTL (秒)。エントリの鮮度 (抽出から
// 5時間) は RSS 生成時に各エントリの ts で判定するため、
// キャッシュが古くても鮮度判定自体は正しい。新規エントリの
// 反映は最大でこの TTL だけ遅れる。
const AUDIO_URLS_CACHE_TTL_SEC = 600;

// audio-urls.json は実測で100KBを超える (2026-11-17 時点で
// 約105KB・88エントリ) ため、1値には収まらない。本文を文字列の
// まま等分して複数値に分け、個数を別キーに持つ。1チャンクは、
// 全て3バイト文字でも CACHE_VALUE_MAX_BYTES に収まる文字数。
const AUDIO_URLS_CACHE_KEY_PREFIX = 'audiomap:v1:';
const AUDIO_URLS_CACHE_CHUNK_CHARS = 30000;
const AUDIO_URLS_CACHE_MAX_CHUNKS = 20;

// audio-urls.json の本文をチャンク分割でキャッシュへ書く。
// 失敗は無視する (キャッシュは最適化専用で、書けなければ
// 次回も取得し直すだけ)。
function putAudioUrlsMapCache(cache, jsonText) {
  try {
    const text = String(jsonText || '');
    if (!text) return;
    const count = Math.ceil(text.length / AUDIO_URLS_CACHE_CHUNK_CHARS);
    if (count < 1 || count > AUDIO_URLS_CACHE_MAX_CHUNKS) return;
    for (let i = 0; i < count; i++) {
      cache.put(
        AUDIO_URLS_CACHE_KEY_PREFIX + i,
        text.slice(i * AUDIO_URLS_CACHE_CHUNK_CHARS, (i + 1) * AUDIO_URLS_CACHE_CHUNK_CHARS),
        AUDIO_URLS_CACHE_TTL_SEC
      );
    }
    cache.put(AUDIO_URLS_CACHE_KEY_PREFIX + 'count', String(count), AUDIO_URLS_CACHE_TTL_SEC);
  } catch (e) { /* 書けなくても応答には影響しない */ }
}

// キャッシュから audio-urls.json のマップを復元する。欠け・
// 壊れ・想定外の形なら null (= ミスとして取得し直す)。
// 検証は取得時と同じ parseAudioUrlsMap を通す。
function getAudioUrlsMapFromCache(cache) {
  try {
    const count = Number(cache.get(AUDIO_URLS_CACHE_KEY_PREFIX + 'count'));
    if (!Number.isFinite(count) || count < 1 || count > AUDIO_URLS_CACHE_MAX_CHUNKS) return null;
    let text = '';
    for (let i = 0; i < count; i++) {
      const part = cache.get(AUDIO_URLS_CACHE_KEY_PREFIX + i);
      if (typeof part !== 'string' || part === '') return null;
      text += part;
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return audioUrlsMapFromData(data);
  } catch (e) {
    return null;
  }
}

// --- YouTube 音声ストリーム URL の配布 (ogp 方式) ---
// 音声ファイルはどこにも置かない。reader-gas が毎時巡回で yt-audio
// トリガー (後述) を叩くと、自宅サーバー側のバッチがストリーム URL を
// 非同期に抽出し、自宅サーバーの公開ホスト上の audio-urls.json に
// videoId -> { url, ts, dur } の形で
// 公開する (dur は実尺・秒で、エントリによっては無い)。?rss= の出力では
// この JSON を読み、抽出から5時間以内のエントリがあるアイテムにだけ、
// その URL を enclosure として付ける (ストリーム URL は短命なので、
// 古いエントリには付けない)。中継の合言葉 (YT_PLAY_TOKEN) があれば
// enclosure は中継 URL になる (ytPlayUrl のコメント参照)。dur が
// あれば itunes:duration としても付ける (理由は buildRssXml の
// コメント参照)。

const AUDIO_URL_FRESH_MS = 5 * 60 * 60 * 1000;

// スクリプトプロパティに置いたベース URL (末尾スラッシュなし) を読む。
// 自宅サーバーの公開ホスト名はコードに直書きせず、プロパティ
// A_ZE_GS_BASE_URL / Y_ZE_GS_BASE_URL から読む。未設定・空・
// PropertiesService 自体が無い環境では空文字を返し、呼び出し側は
// 機能だけを穏当に無効化する (トークン未設定時と同じ扱い)。
function scriptBaseUrl(propName) {
  try {
    const value = PropertiesService.getScriptProperties().getProperty(propName);
    return String(value || '').trim().replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// audio-urls.json の URL。ベース URL が未設定なら空文字 (= 取得しない)。
function audioUrlsJsonUrl() {
  const base = scriptBaseUrl('A_ZE_GS_BASE_URL');
  return base ? base + '/audio-urls.json' : '';
}

// audio-urls.json の本文を videoId -> { url, ts, dur? } のマップとして
// 読む (純関数)。JSON でない・オブジェクトでない場合は空マップにする。
// 値の形が想定と違うエントリは落とす。ts は抽出時刻 (epoch 秒)。
// dur は実尺 (秒) で、正の数値として読めるときだけ保持する
// (読めないエントリも enclosure 自体は従来どおり付ける)。
function parseAudioUrlsMap(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText || '')); } catch (e) { return {}; }
  return audioUrlsMapFromData(data);
}

// パース済みの audio-urls.json オブジェクトをマップ化する
// (parseAudioUrlsMap の本体。キャッシュ復元側はパース済みの
// オブジェクトをそのまま渡し、二重パースを避ける)。
function audioUrlsMapFromData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const map = {};
  Object.keys(data).forEach((videoId) => {
    const entry = data[videoId];
    if (!entry || typeof entry !== 'object') return;
    const url = asText(entry.url);
    const ts = asNumber(entry.ts);
    if (!url || !Number.isFinite(ts)) return;
    const parsed = { url, ts };
    const dur = asNumber(entry.dur);
    if (Number.isFinite(dur) && dur > 0) parsed.dur = dur;
    map[videoId] = parsed;
  });
  return map;
}

// 実行内だけの簡易キャッシュ (GAS の実行ごとにリセットされる)。
// 取得に成功したときだけ保持し、失敗時は毎回引き直す。
let audioUrlsMapCache = null;

// 自宅サーバーの公開ホスト上の audio-urls.json を取得する。
// ベース URL (A_ZE_GS_BASE_URL) が未設定なら取得自体を省いて空マップ。
// 失敗 (HTTPエラー・例外・UrlFetchApp 自体が無い環境) もすべて
// 空マップとして扱い、RSS 出力自体は enclosure 無しで続ける。
// 取得に成功した本文はスクリプトキャッシュにも載せ、TTL 内の
// 後続リクエスト (別フィードの ?rss= 等) は取得を省く。
function fetchAudioUrlsMap() {
  if (audioUrlsMapCache) return audioUrlsMapCache;
  const jsonUrl = audioUrlsJsonUrl();
  if (!jsonUrl) return {};
  const cache = scriptCache();
  if (cache) {
    const cached = getAudioUrlsMapFromCache(cache);
    if (cached) {
      audioUrlsMapCache = cached;
      return audioUrlsMapCache;
    }
  }
  try {
    const res = UrlFetchApp.fetch(jsonUrl, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return {};
    const text = res.getContentText();
    audioUrlsMapCache = parseAudioUrlsMap(text);
    if (cache) putAudioUrlsMapCache(cache, text);
    return audioUrlsMapCache;
  } catch (e) {
    return {};
  }
}

// マップに新鮮な (抽出から5時間以内) エントリがあればそのエントリを
// 返し、無ければ null。nowMs はテスト用の差し込み口。
function freshAudioEntry(audioUrls, videoId, nowMs) {
  const entry = (audioUrls || {})[String(videoId || '')];
  if (!entry) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const ts = asNumber(entry.ts);
  if (!Number.isFinite(ts)) return null;
  if (now - ts * 1000 > AUDIO_URL_FRESH_MS) return null;
  if (!asText(entry.url)) return null;
  return entry;
}

// --- YouTube 音声の中継 URL (yt-play) ---
// 抽出済みストリーム URL (googlevideo) は通常の GET が約31KB/秒まで
// 絞られるため、長編動画では再生開始まで約40秒かかる問題がある。
// その対策として自宅サーバーには中継 (yt-play) があり、Range 取得で
// ストリームを引き直してそのまま流す (ファイルは置かない)。
// スクリプトプロパティ YT_PLAY_TOKEN (中継の合言葉) が設定されて
// いれば、?rss= の enclosure は直接 URL ではなく中継 URL
// (<Y_ZE_GS_BASE_URL>/<token>/<videoId>) にする。中継側も
// audio-urls.json の鮮度をもとに実 URL を解決する前提のため、
// enclosure を付ける条件 (抽出から5時間以内のエントリがあること)
// は従来どおり。プロパティ未設定・空なら従来の直接 URL のまま。
// 中継ホストのベース URL (Y_ZE_GS_BASE_URL) が未設定の場合も
// 中継 URL は組み立てず、直接 URL にフォールバックする。

// 中継 URL の組み立て。token が空、videoId が無い、または
// ベース URL (Y_ZE_GS_BASE_URL) が未設定なら空文字
// (= 中継しない) を返す。
function ytPlayUrl(token, videoId) {
  const t = String(token || '').trim();
  const id = String(videoId || '');
  const base = scriptBaseUrl('Y_ZE_GS_BASE_URL');
  if (!t || !id || !base) return '';
  return base + '/' + encodeURIComponent(t) + '/' + encodeURIComponent(id);
}

// --- YouTube RSS 出力 (v2: 取得をクライアントへ寄せるための出口) ---
// YouTube フィードの記事を RSS 2.0 で返す。クライアントはこの URL を
// 通常のフィード URL と同じ経路で取得する (YouTube 専用の形式は作らない)。
// guid は動画IDにし、記事IDの互換 (feed_id + guid) を保つ。

function escapeXml(s) {
  return asText(s)
    // XML 1.0 で使えない文字 (一部の C0 制御文字・U+FFFE/U+FFFF) と
    // 単独サロゲートは置換文字にし、壊れたタイトルでも RSS 全体を
    // パース不能にしない。タブ・改行・復帰は XML でも有効なので残す。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '\uFFFD')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function videoIdFromLink(link) {
  const m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(asText(link));
  return m ? m[1] : '';
}

function toRfc822(isoString) {
  const t = Date.parse(cellIso(isoString));
  if (Number.isNaN(t)) return '';
  return new Date(t).toUTCString();
}

// 記事の新しい順ソートに使う時刻 (公開日時を優先し、無ければ
// 取り込み日時)。読めない場合は 0 (= 最も古い扱い)。
// 引数はシート行の snake_case でも list 応答の camelCase でも同じ。
function articleTimeMs(published, fetched) {
  return Date.parse(cellIso(published) || cellIso(fetched) || '') || 0;
}

const RSS_MAX_ITEMS = 50;

// articleRows は articles タブの行オブジェクト (ARTICLES_HEADERS のキー)。
// published_at (無ければ fetched_at) の新しい順に最大 RSS_MAX_ITEMS 件。
// audioUrls は audio-urls.json のマップ (videoId -> { url, ts, dur? })。
// 省略時・該当エントリが古い/無いアイテムには enclosure を付けない。
// ytPlayToken (中継の合言葉) があれば、enclosure の URL は直接の
// ストリーム URL ではなく中継 URL になる (ytPlayUrl 参照)。
// starredVideoIds (動画ID -> 真値のマップ) を渡した場合は、実効スター
// の付いたアイテムにだけ enclosure を付ける (スター制)。省略時は
// 従来どおり、スターに関係なく新鮮なエントリがあれば付ける。
function buildRssXml(feed, articleRows, audioUrls, ytPlayToken, starredVideoIds) {
  const f = feed || {};
  const title = asText(f.title);
  const channelId = youtubeChannelIdFromUrl(f.url);
  const playlistId = youtubePlaylistIdFromUrl(f.url);
  // チャンネルのリンクはフィード自身のページ (チャンネルページ or
  // プレイリストページ) を指す。
  const feedPageUrl = playlistId
    ? youtubeFeedUrlFromPlaylistId(playlistId)
    : 'https://www.youtube.com/channel/' + channelId;
  const sorted = (Array.isArray(articleRows) ? articleRows : [])
    .filter((a) => a && typeof a === 'object')
    .slice()
    .sort((a, b) => articleTimeMs(b.published_at, b.fetched_at) - articleTimeMs(a.published_at, a.fetched_at))
    .slice(0, RSS_MAX_ITEMS);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    '  <channel>',
    '    <title>' + escapeXml(title) + '</title>',
    '    <link>' + escapeXml(feedPageUrl) + '</link>',
    '    <description>' + escapeXml(title) + '</description>',
  ];
  sorted.forEach((a) => {
    const link = asText(a.link);
    const videoId = videoIdFromLink(link);
    const pubDate = toRfc822(cellIso(a.published_at) || cellIso(a.fetched_at));
    lines.push('    <item>');
    lines.push('      <title>' + escapeXml(a.title) + '</title>');
    lines.push('      <link>' + escapeXml(link) + '</link>');
    lines.push('      <guid isPermaLink="false">' + escapeXml(videoId) + '</guid>');
    // 音声ストリーム URL の enclosure。新鮮なエントリがあるときだけ付ける。
    // スター制のマップが渡されていれば、実効スターの付いたアイテムだけ。
    // 中継の合言葉があれば、直接 URL ではなく中継 URL を出す。
    const audioEntry = starredVideoIds && !starredVideoIds[videoId]
      ? null
      : freshAudioEntry(audioUrls, videoId);
    const directUrl = audioEntry ? asText(audioEntry.url) : '';
    const audioUrl = (directUrl && ytPlayUrl(ytPlayToken, videoId)) || directUrl;
    if (audioUrl) {
      lines.push('      <enclosure url="' + escapeXml(audioUrl) + '" type="audio/x-m4a" length="0"/>');
      // 実尺の passthrough: このストリームは断片化 MP4 (fMP4) で、長さ
      // 情報が init セグメントと断片の両方に入るため、プレイヤー
      // (特に iOS) が長さを二重に数えて実尺のちょうど2倍を表示して
      // しまう。エントリに実尺 (dur・秒) があれば整数秒に丸めて
      // itunes:duration として付け、クライアントが表示・シークの
      // 正として使えるようにする。dur の無いエントリには付けない。
      const dur = asNumber(audioEntry.dur);
      if (Number.isFinite(dur) && dur > 0) {
        lines.push('      <itunes:duration>' + Math.round(dur) + '</itunes:duration>');
      }
    }
    if (pubDate) lines.push('      <pubDate>' + pubDate + '</pubDate>');
    lines.push('      <description>' + escapeXml(a.summary) + '</description>');
    lines.push('      <author>' + escapeXml(title) + '</author>');
    lines.push('    </item>');
  });
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

// --- Retention (pure decision logic) ---
// Prune when older than RETENTION_DAYS, or beyond the newest MAX_ARTICLES.
// 既読は端末ローカル管理のため、サーバー側では既読かどうかで保護しない
// (v1 の states による未読保護は廃止した)。

function prunePlan(articles, nowIso, options) {
  const opts = options || {};
  const retentionMs = (opts.retentionDays || RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const maxArticles = opts.maxArticles || MAX_ARTICLES;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const sorted = (articles || []).slice()
    .sort((a, b) => articleTimeMs(b.published_at, b.fetched_at) - articleTimeMs(a.published_at, a.fetched_at));
  const deleteArticleIds = [];
  sorted.forEach((a, idx) => {
    // 経過日数は「取り込んだ日」から数える (公開日が古い動画などを
    // 取り込んだ瞬間に消してしまわないため)。
    const t = Date.parse(cellIso(a.fetched_at) || cellIso(a.published_at) || '') || 0;
    const tooOld = t > 0 && now - t > retentionMs;
    const beyondCap = idx >= maxArticles;
    if (tooOld || beyondCap) deleteArticleIds.push(a.id);
  });
  return { deleteArticleIds };
}

function pruneArticles() {
  const ss = openDataSpreadsheet();
  const articles = readSheetAsObjects(ss, 'articles');
  const plan = prunePlan(articles, new Date().toISOString());
  deleteRowsById(ss, 'articles', 'id', plan.deleteArticleIds);
  return plan;
}

function remainingRowsAfterDelete(values, keyIdx, ids) {
  if (!values || !values.length) return values;
  const target = {};
  (ids || []).forEach((id) => { target[String(id)] = true; });
  const remaining = [values[0]];
  for (let i = 1; i < values.length; i++) {
    if (!target[String(values[i][keyIdx])]) remaining.push(values[i]);
  }
  return remaining;
}

function deleteRowsById(ss, sheetName, keyHeader, ids) {
  if (!ids || !ids.length) return;
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const keyIdx = values[0].indexOf(keyHeader);
  if (keyIdx < 0) return;
  const remaining = remainingRowsAfterDelete(values, keyIdx, ids);
  if (remaining.length === values.length) return;
  // deleteRow を行ごとに呼ぶと数十〜数百回になると極端に遅いため、
  // 残す行だけを一括で書き戻す。
  replaceSheetValues(sheet, remaining);
}

// Rearranges the data rows of a sheet-values array to follow feedIds order.
// The header row stays first and row contents are never touched. feedIds is
// expected to be a validated permutation of the sheet ids; defensively, rows
// not named in feedIds are appended in their original order so that no row is
// ever dropped or duplicated.
function reorderRowsByIds(values, idIdx, feedIds) {
  if (!values || !values.length) return values;
  const rowIndexById = {};
  for (let i = 1; i < values.length; i++) {
    rowIndexById[String(values[i][idIdx])] = i;
  }
  const used = {};
  const reordered = [values[0]];
  (feedIds || []).forEach((id) => {
    const idx = rowIndexById[String(id)];
    if (idx !== undefined && !used[idx]) {
      used[idx] = true;
      reordered.push(values[idx]);
    }
  });
  for (let i = 1; i < values.length; i++) {
    if (!used[i]) reordered.push(values[i]);
  }
  return reordered;
}

// Validates a reorderFeeds request: feedIds must be an array of unique id
// strings whose set exactly equals the current feed ids in the sheet.
function validateFeedOrder(feedIds, currentIds) {
  if (!Array.isArray(feedIds)) return { ok: false, message: 'feedIds must be an array' };
  const seen = {};
  for (let i = 0; i < feedIds.length; i++) {
    const id = feedIds[i];
    if (typeof id !== 'string' || !id) return { ok: false, message: 'feedIds must contain feed id strings' };
    if (seen[id]) return { ok: false, message: 'feedIds contains a duplicate id: ' + id };
    seen[id] = true;
  }
  const current = currentIds || [];
  if (feedIds.length !== current.length) {
    return { ok: false, message: 'feedIds must list every current feed id exactly once' };
  }
  const currentSet = {};
  current.forEach((id) => { currentSet[String(id)] = true; });
  for (let i = 0; i < feedIds.length; i++) {
    if (!currentSet[feedIds[i]]) return { ok: false, message: 'unknown feed id: ' + feedIds[i] };
  }
  return { ok: true };
}

// Stably groups the data rows of a sheet-values array by category: rows
// sharing a category become one contiguous block, blocks follow the
// order in which each category first appears in the current rows, and
// rows inside a block keep their current relative order. A feed in a
// brand-new category therefore stays on the tail side (its block takes
// the position where the category first appeared). The header row stays
// first and row arrays are reused untouched, so callers can detect
// "no change" by row identity (same convention as reorderRowsByIds).
// Defensively, a missing category column (categoryIdx < 0) and inputs
// with fewer than 2 rows are returned unchanged.
function groupRowsByCategory(values, categoryIdx) {
  if (!values || values.length < 2 || categoryIdx < 0) return values;
  const order = [];
  const rowsByCategory = new Map();
  for (let i = 1; i < values.length; i++) {
    const category = String(values[i][categoryIdx] || '');
    if (!rowsByCategory.has(category)) {
      rowsByCategory.set(category, []);
      order.push(category);
    }
    rowsByCategory.get(category).push(values[i]);
  }
  const grouped = [values[0]];
  order.forEach((category) => {
    rowsByCategory.get(category).forEach((row) => grouped.push(row));
  });
  return grouped;
}

// --- Auth (tweet-gas pattern, simplified for reader) ---

// オーナーのメールアドレスはコードに直書きせず、スクリプトプロパティ
// ALLOWED_EMAIL から読む。未設定・空・PropertiesService 自体が無い環境
// では空文字を返し、どのメールも一致しない (fail-closed)。
function allowedEmail() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(ALLOWED_EMAIL_PROP) || '').trim();
  } catch (e) {
    return '';
  }
}

function isAllowedIdTokenPayload(json, clientId) {
  if (!json) return false;
  const verified = json.email_verified === true || json.email_verified === 'true';
  if (!verified) return false;
  const allowed = allowedEmail();
  if (!allowed || json.email !== allowed) return false;
  if (clientId && json.aud !== clientId) return false;
  return true;
}

function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch(TOKENINFO_URL + '?id_token=' + encodeURIComponent(String(idToken)), {
    method: 'get',
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  let json = null;
  try { json = JSON.parse(res.getContentText()); } catch (e) { return null; }
  const clientId = scriptProperty('GOOGLE_CLIENT_ID');
  if (!isAllowedIdTokenPayload(json, clientId)) return null;
  return json;
}

function generateRawToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function issueSession(role) {
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, OWNER_SHEET_NAME, SESSION_HEADERS);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const token = generateRawToken();
  // Multiple concurrent sessions: issuing never revokes the others.
  sheet.appendRow([sha256Hex(token), nowIso, expiresIso, '', 0, '', role]);
  return { sessionToken: token, expiresAt: expiresIso, role };
}

function validateSession(token) {
  if (!token) return null;
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, OWNER_SHEET_NAME, SESSION_HEADERS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0];
  const hashIdx = headers.indexOf('token_hash');
  const expIdx = headers.indexOf('expires_at');
  const roleIdx = headers.indexOf('role');
  const accessIdx = headers.indexOf('access_count');
  const lastIdx = headers.indexOf('last_accessed_at');
  const hash = sha256Hex(String(token));
  const nowIso = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!hashesEqual(row[hashIdx], hash)) continue;
    const expiresAt = cellIso(row[expIdx]);
    if (isSessionExpired(expiresAt, nowIso)) return null;
    if (accessIdx >= 0) sheet.getRange(i + 1, accessIdx + 1).setValue(Number(row[accessIdx] || 0) + 1);
    if (lastIdx >= 0) sheet.getRange(i + 1, lastIdx + 1).setValue(nowIso);
    const role = roleIdx >= 0 && row[roleIdx] ? String(row[roleIdx]) : 'owner';
    return { role, expiresAt };
  }
  return null;
}

function validateShareToken(token) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  const expectedHash = props.getProperty(SHARE_TOKEN_HASH_PROP);
  const expiresAt = props.getProperty(SHARE_EXPIRES_AT_PROP);
  if (!expectedHash || !expiresAt) return false;
  if (isSessionExpired(expiresAt, new Date().toISOString())) return false;
  return hashesEqual(sha256Hex(String(token)), expectedHash);
}

// 共有リンクの保存値から状態応答を作る純関数。レコードが無い・
// 期限切れなら active: false とし、expiresAt は返さない。
function shareLinkStatus(hash, expiresAt, nowIso) {
  if (!hash || !expiresAt || isSessionExpired(expiresAt, nowIso)) {
    return { active: false, expiresAt: null };
  }
  return { active: true, expiresAt };
}

// 共有リンクを発行する (オーナー専用アクション issueShareLink の本体)。
// トークンはセッションと同じ生成器で作り、保存は SHA-256 ハッシュのみ。
// 単一レコードを置き換えるため、発行した時点で旧リンクは無効になる。
// 平文トークンを返すのはこの応答だけ。
function issueShareLink() {
  const expiresAt = new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString();
  const token = generateRawToken();
  const props = PropertiesService.getScriptProperties();
  props.setProperty(SHARE_TOKEN_HASH_PROP, sha256Hex(token));
  props.setProperty(SHARE_EXPIRES_AT_PROP, expiresAt);
  return { ok: true, token, expiresAt };
}

function getShareLinkStatus() {
  const props = PropertiesService.getScriptProperties();
  const status = shareLinkStatus(
    props.getProperty(SHARE_TOKEN_HASH_PROP),
    props.getProperty(SHARE_EXPIRES_AT_PROP),
    new Date().toISOString()
  );
  return { ok: true, active: status.active, expiresAt: status.expiresAt };
}

// 共有リンクを即時無効化する。保存レコード自体を消すため、
// validateShareToken はその直後から false を返す。
function revokeShareLink() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(SHARE_TOKEN_HASH_PROP);
  props.deleteProperty(SHARE_EXPIRES_AT_PROP);
  return { ok: true };
}

// --- Feed fetching (hourly trigger) ---

function updateFeedRow(sheet, headers, rowNum, patch) {
  Object.keys(patch).forEach((key) => {
    const idx = headers.indexOf(key);
    if (idx >= 0) sheet.getRange(rowNum, idx + 1).setValue(patch[key]);
  });
}

// 正規化済みエントリを articles へ未登録分だけ追加し、追加件数を返す。
// durationColIdx (>= 0) が渡されたら、エントリの長さ (durationSec) を
// その列へ一緒に書く (列の位置はヘッダー名から決めるため、既存シートの
// 列構成に依存しない)。長さ不明のエントリは空のまま。
function appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt, durationColIdx) {
  let added = 0;
  (entries || []).forEach((entry) => {
    const id = articleId(feed.id, entry.guid || entry.link);
    if (existingIds[id]) return;
    existingIds[id] = true;
    const row = [id, feed.id, entry.title, entry.link, entry.publishedAt, fetchedAt, entry.summary, entry.author];
    if (typeof durationColIdx === 'number' && durationColIdx >= row.length) {
      while (row.length < durationColIdx) row.push('');
      row.push(entry.durationSec > 0 ? entry.durationSec : '');
    }
    articlesSheet.appendRow(row);
    added++;
  });
  return added;
}

// 既存の記事行のうち長さ (duration_sec) が空のものへ、今回取得した
// 長さを埋め戻す。取り込みは既存記事を再追加しないため、これが無いと
// 機能追加前に取り込んだ動画の長さが永久に不明のままになる。
// durationColIdx は列位置 (0始まり)。対象が無ければ何もしない。
function backfillArticleDurations(articlesSheet, feed, entries, durationColIdx) {
  if (typeof durationColIdx !== 'number' || durationColIdx < 0) return;
  const wanted = {};
  (entries || []).forEach((entry) => {
    if (entry && entry.guid && entry.durationSec > 0) {
      wanted[articleId(feed.id, entry.guid)] = entry.durationSec;
    }
  });
  if (!Object.keys(wanted).length) return;
  const values = articlesSheet.getDataRange().getValues();
  if (!values.length) return;
  const idIdx = values[0].indexOf('id');
  if (idIdx < 0) return;
  for (let i = 1; i < values.length; i++) {
    const sec = wanted[String(values[i][idIdx])];
    if (sec && !(Number(values[i][durationColIdx]) > 0)) {
      articlesSheet.getRange(i + 1, durationColIdx + 1).setValue(sec);
    }
  }
}

// サーバー側で巡回する対象を選ぶ。v2 では RSS フィードの巡回は
// クライアント側で行うため、対象は YouTube フィードだけになる。
// 非 YouTube フィードは行の更新も含めて一切触らない。
// 有効/無効の概念は廃止したため、対象は YouTube フィードかどうかだけで決まる。
// YouTube フィードにはチャンネル (保存形 /channel/UC...) とプレイリスト
// (保存形 /playlist?list=...) の2種がある。
function selectFetchTargets(feeds) {
  return (feeds || []).filter((f) => f && f.id && f.url && isYouTubeFeedUrl(f.url));
}

// --- YouTube 音声抽出トリガー (自宅サーバー連携) ---
// ogp のフォールバックと同じ形: reader-gas が自宅サーバーの公開ホストの
// altd コマンド yt-audio を叩くと自宅サーバー側のキューに積まれ、
// 自宅サーバーのバッチが音声ストリーム
// URL を抽出して audio-urls.json として公開する (非同期)。
// ?rss= はその JSON の新鮮なエントリを enclosure として配信する。
// 発火対象は各 YouTube フィードの新しい順3本で、期間制限は無く、
// 新着かどうかも問わない (自宅サーバー側が抽出済みのものは重複排除
// するため、毎時叩き直しても安い)。ただし長さが90秒未満と分かって
// いる動画は数えない (Shorts・短尺クリップ対策。本人の決定)。
// 長さは取り込み時に videos.list で補って記事行へ保存しておき、
// 長さ不明の動画は fail-open で通常どおり数える。
// ジャンルによる特別扱いはしない (旧来のジャンル「音楽」の特別
// ルールは廃止した。本人の決定。過去分を広く再生したい用途は、
// 下記のプレイリストフィードでカバーする)。
// 例外は「全件クラス」の2種類で、最新3本の上限も90秒未満の除外も付けない:
// - YT_AUDIO_ALWAYS_CHANNEL_ID のチャンネルは、取得できた動画を
//   毎時すべて依頼し直して常時再生可能な状態を保つ (下の定数の
//   コメント参照)。
// - プレイリストフィードは、本人が手で選んだ動画の集まりなので、
//   取り込んだ記事すべてを対象にする (本人の決定)。
// 失敗しても巡回自体は失敗にしない (fire-and-forget)。
// スター制の導入後は、この選定規則は「デフォルトのスター判定」と
// して computeStarredArticleIds / planStarredAudioTriggers から
// 使われ、実際の発火対象は実効スターの付いた動画だけになる。

const YT_AUDIO_TRIGGER_PER_FEED = 3;
// 全体キャップ。計画合計は通常フィード分 (3本/フィード) + 全件
// クラス分 (常時対応チャンネルとプレイリスト) で増えうるため、
// 余裕を持たせて200とする (旧上限の100では合計が超過し、フィード
// 順の後ろのフィードが毎回締め出されていた)。200を超える場合は
// フィード順の先頭から打ち切るが、手動スターは計画側
// (planStarredAudioTriggers) で先頭に寄せるため、上限では落ちない。
const YT_AUDIO_TRIGGER_MAX_PER_RUN = 200;
// 通常クラスで「短尺」として数えない長さの下限 (秒)。長さがこの値
// 未満と分かっている動画は最新3本の枠に入れない。ちょうどこの値の
// 動画は対象 (未満だけを除く)。
const YT_AUDIO_TRIGGER_MIN_DURATION_SEC = 90;
// 常時対応チャンネル (本人のチャンネル「藤原史和 川口を歩くQAエンジニア」)。
// reader-gas が毎時、このチャンネルの動画をすべて yt-audio のキューへ
// 入れ直し、自宅サーバー側のバッチは URL が4時間を超えたエントリを
// 取り直す。
// そのため、このチャンネルの音声 URL は失効前に更新され続け、
// 常に新鮮な enclosure が付く (= 常に再生可能)。自宅サーバー側の変更は不要。
const YT_AUDIO_ALWAYS_CHANNEL_ID = 'UCbiDZXbr391oT_vsRiqwPFg';

// 発火対象を選ぶ純関数: フィードごとに、公開日時が読める動画を
// 新しい順に並べ、長さが YT_AUDIO_TRIGGER_MIN_DURATION_SEC 未満と
// 分かっている動画を数えずに (枠を消費せず次の動画へ進む)、最大
// YT_AUDIO_TRIGGER_PER_FEED 本を選び、動画IDで重複を除いて並べる。
// 期間制限は無い。公開日時が読めない動画は安全側で対象外。
// 長さ不明 (durationSec が 0 以下・欠落) の動画は fail-open で
// 通常どおり数える (長さを補う取得に失敗した回でも、通常の
// 新しい順3本に倒れる)。
// ジャンルによる特別扱いはしない (音楽ジャンルの特別ルールは廃止)。
// 例外は「全件クラス」の2種類で、どちらも公開日時や件数・長さに
// 関係なく動画IDのある全件を選ぶ (公開日時が読めない動画も対象):
// - 常時対応チャンネル (YT_AUDIO_ALWAYS_CHANNEL_ID) のフィード
//   (常時再生可能を保つため)。
// - プレイリストフィード (playlist フラグ。本人が手で選んだ動画
//   の集まりのため。手で選んだものを長さで落とさない)。
// 上限件数の適用は発火側 (fireYouTubeAudioTriggers) で行う。
// nowMs は呼び出し側の互換のため残す (期間制限の廃止後は未使用)。
// feedVideos はフィードごとの { videoId, publishedAt, channelId,
// playlist, durationSec } の配列の配列 (channelId は常時対応
// チャンネルの判定用、playlist はプレイリストフィードの印、
// durationSec は動画の長さ (秒)。0以下・欠落は不明)。
function planYouTubeAudioTriggers(feedVideos, nowMs) {
  const seen = {};
  const ids = [];
  const push = (v) => {
    const videoId = String((v && v.videoId) || '');
    if (!videoId || seen[videoId]) return;
    seen[videoId] = true;
    ids.push(videoId);
  };
  (feedVideos || []).forEach((videos) => {
    const list = videos || [];
    if (list.some((v) => v && (v.channelId === YT_AUDIO_ALWAYS_CHANNEL_ID || v.playlist))) {
      // 全件クラス: 取得できた順 (新しい順) に全件を選ぶ。
      list.forEach(push);
      return;
    }
    const candidates = list.filter((v) => {
      // 動画IDの無いものは件数上限の枠も使わないよう、最初に除く。
      if (!v || !String(v.videoId || '')) return false;
      const ts = Date.parse(v.publishedAt || '');
      return !isNaN(ts);
    });
    // candidates は filter の新規配列なので、そのまま並べ替えてよい。
    const sorted = candidates.sort((a, b) => {
      const tb = Date.parse((b && b.publishedAt) || '') || 0;
      const ta = Date.parse((a && a.publishedAt) || '') || 0;
      return tb - ta;
    });
    let picked = 0;
    for (const v of sorted) {
      if (picked >= YT_AUDIO_TRIGGER_PER_FEED) break;
      const sec = Number(v.durationSec) || 0;
      // 短尺と分かっている動画は数えない (枠を消費しない)。
      if (sec > 0 && sec < YT_AUDIO_TRIGGER_MIN_DURATION_SEC) continue;
      push(v);
      picked += 1;
    }
  });
  return ids;
}

// --- YouTube 再生対象のスター制 ---
// 実効スターの計算 (純関数)。デフォルトルールの評価は
// planYouTubeAudioTriggers をフィード単位でそのまま使う。
// ランキングはオーバーライドの有無に関係なくフィードの記事集合
// 全体で評価するため、手動で外した動画の枠に次の動画が繰り上がる
// ことはない (繰り上げたい場合は次の動画にも手動で付ける)。

// 記事行の手動オーバーライドを取り出す (純関数)。'on' / 'off'
// 以外 (空・欠落・想定外の値) はすべて '' (= 自動判定) として扱う。
function starOverrideOf(article) {
  const v = String((article && article.star_override) || '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : '';
}

// デフォルト評価の材料をフィード単位にまとめる (内部ヘルパー)。
// 対象は YouTube フィード (チャンネル・プレイリスト) の記事だけで、
// フィードの並び (シートの行順) と記事の並び (シートの行順) を保つ。
function groupStarCandidates(feeds, articles) {
  const order = [];
  const byFeedId = {};
  (feeds || []).forEach((f) => {
    if (!f || !f.id) return;
    const channelId = youtubeChannelIdFromUrl(f.url);
    const playlistId = youtubePlaylistIdFromUrl(f.url);
    if (!channelId && !playlistId) return;
    const key = String(f.id);
    if (byFeedId[key]) return;
    byFeedId[key] = { feed: f, channelId, playlistId, videos: [], infos: [] };
    order.push(key);
  });
  (articles || []).forEach((a) => {
    if (!a) return;
    const group = byFeedId[String(a.feed_id)];
    if (!group) return;
    const videoId = videoIdFromLink(a.link);
    const publishedAt = cellIso(a.published_at);
    group.videos.push({
      videoId,
      publishedAt,
      channelId: group.channelId,
      playlist: !!group.playlistId,
      // 記事行に保存した動画の長さ (秒)。空・不正は 0 = 不明。
      durationSec: Number(a.duration_sec) || 0,
    });
    group.infos.push({
      articleId: String(a.id || ''),
      videoId,
      publishedAt,
      override: starOverrideOf(a),
    });
  });
  return { order, byFeedId };
}

// 実効スターが付いた記事IDを { articleId: true } で返す (純関数)。
// feeds / articles はシート行オブジェクト (snake_case キー)。
// nowMs はテスト用の差し込み口 (省略時は現在時刻)。
function computeStarredArticleIds(feeds, articles, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const { order, byFeedId } = groupStarCandidates(feeds, articles);
  const starred = {};
  order.forEach((feedId) => {
    const group = byFeedId[feedId];
    const defaultIds = {};
    planYouTubeAudioTriggers([group.videos], now).forEach((videoId) => { defaultIds[videoId] = true; });
    group.infos.forEach((info) => {
      if (!info.articleId) return;
      if (info.override === 'on') starred[info.articleId] = true;
      else if (info.override === 'off') return;
      else if (info.videoId && defaultIds[info.videoId]) starred[info.articleId] = true;
    });
  });
  return starred;
}

// 抽出トリガーの発火計画 (純関数): 実効スターが付いた動画IDを返す。
// 並びは、手動で付けた分 (star_override='on') を全体の先頭に寄せ
// (フィード順・フィード内は新しい順)、続いてデフォルト分を
// フィード順に並べる (デフォルトの並びは planYouTubeAudioTriggers
// のまま。手動で外した分は除く)。全体キャップ
// (YT_AUDIO_TRIGGER_MAX_PER_RUN) は発火側
// (fireYouTubeAudioTriggers) で付けるが、手動スターが先頭に
// あるため上限で落ちることはない。
function planStarredAudioTriggers(feeds, articles, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const { order, byFeedId } = groupStarCandidates(feeds, articles);
  // フィードごとの材料 (デフォルト計画と動画ID→記事情報) を先に揃える。
  const perFeed = order.map((feedId) => {
    const group = byFeedId[feedId];
    const infoByVideoId = {};
    group.infos.forEach((info) => {
      if (info.videoId && !infoByVideoId[info.videoId]) infoByVideoId[info.videoId] = info;
    });
    return { group, infoByVideoId, defaultIds: planYouTubeAudioTriggers([group.videos], now) };
  });
  const seen = {};
  const ids = [];
  const push = (videoId) => {
    if (!videoId || seen[videoId]) return;
    seen[videoId] = true;
    ids.push(videoId);
  };
  // 1パス目: 手動で付けた分を先頭へ (フィード順・新しい順)。
  perFeed.forEach(({ group }) => {
    group.infos
      .filter((info) => info.override === 'on' && info.videoId)
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
      .forEach((info) => { push(info.videoId); });
  });
  // 2パス目: デフォルト分をフィード順に (手動で外した分は除く。
  // 手動で付けた分は seen 済みのため重複しない)。
  perFeed.forEach(({ infoByVideoId, defaultIds }) => {
    defaultIds.forEach((videoId) => {
      const info = infoByVideoId[videoId];
      if (info && info.override === 'off') return;
      push(videoId);
    });
  });
  return ids;
}

// テスト用の差し込み口 (fireTrigger) の解決: 関数でなければ
// 既定実装に落とす。時間ベーストリガーから呼ばれる経路では
// イベントオブジェクトが渡ってくるため、この判定が要る。
function resolveFireTrigger(fireTrigger) {
  return typeof fireTrigger === 'function' ? fireTrigger : fireYouTubeAudioTrigger;
}

// 実際のトリガー発火 (1件分)。応答は待たない (muteHttpExceptions)。
// ベース URL (A_ZE_GS_BASE_URL) が未設定なら何もしない。
function fireYouTubeAudioTrigger(videoId, token) {
  const base = scriptBaseUrl('A_ZE_GS_BASE_URL');
  if (!base) return;
  UrlFetchApp.fetch(base + '/yt-audio/' + encodeURIComponent(String(videoId || '')), {
    method: 'get',
    headers: { 'X-Api-Token': String(token || '') },
    muteHttpExceptions: true,
  });
}

// 発火対象ぶんのトリガーをまとめて発火し、発火件数を返す。
// A_ZE_GS_TOKEN が未設定なら何もしない (エラーにもしない)。
// ベース URL (A_ZE_GS_BASE_URL) が未設定の場合も同様に省く。
// 1回の巡回では最大 YT_AUDIO_TRIGGER_MAX_PER_RUN 件までとし、
// 残りはログに残して省く。fireTrigger はテスト用の差し込み口
// (省略時は fireYouTubeAudioTrigger)。時間ベーストリガーから呼ばれる
// fetchFeeds 経由ではイベントオブジェクトが渡ってくるため、関数で
// なければ既定実装に落とす。nowMs は30日判定用のテスト差し込み口。
// plannedIds (動画IDの配列) を渡した場合は feedVideos からの計画を
// 省いてそれを発火対象にする (スター制の計画はこちらで渡す)。
function fireYouTubeAudioTriggers(feedVideos, fireTrigger, nowMs, plannedIds) {
  const token = scriptProperty('A_ZE_GS_TOKEN');
  if (!token) return 0;
  if (!scriptBaseUrl('A_ZE_GS_BASE_URL')) return 0;
  const fire = resolveFireTrigger(fireTrigger);
  const planned = Array.isArray(plannedIds) ? plannedIds : planYouTubeAudioTriggers(feedVideos, nowMs);
  const targets = planned.slice(0, YT_AUDIO_TRIGGER_MAX_PER_RUN);
  if (planned.length > targets.length) {
    console.log('yt-audio: triggers capped at ' + targets.length + ' of ' + planned.length + ' videos');
  }
  let fired = 0;
  targets.forEach((videoId) => {
    try {
      fire(videoId, token);
      fired++;
    } catch (e) {
      // 1件の失敗で残りや巡回全体を止めない。
    }
  });
  return fired;
}

// --- YouTube チャンネル登録 (購読) とフィードの同期 ---
// YouTube のチャンネル登録を正として、リーダーの YouTube フィードを
// 毎時巡回 (fetchFeeds) の記事取得より前に同期する (追加も削除も同期)。
// 購読の取得は Apps Script の YouTube 連携サービス (Advanced Service、
// appsscript.json の enabledAdvancedServices) を所有者アカウントの
// 権限で使う。動画取得の APIキー方式 (YOUTUBE_API_KEY) とは別経路で、
// 連携サービスには oauthScopes の youtube.readonly が要る。
// 同期対象は URL がチャンネル正規形 (/channel/UC...) のフィードだけ
// で、通常フィードには触らない。本人のチャンネル
// (YT_AUDIO_ALWAYS_CHANNEL_ID) は購読に現れないため、常に同期対象
// から外す (ピン留め。追加も削除もしない)。
// タイトルは追加時にだけ購読側の名前を設定し、既存フィードの
// タイトルは同期しない (管理画面で手編集されうるため)。

// 同期で新規追加するフィードに仮で入れるジャンル (後から管理画面で
// 変更できる前提)。
const YT_SUBSCRIPTION_SYNC_CATEGORY = 'YouTube';
// 1回の同期で削除する件数の上限。超える場合は削除だけを中止する
// (購読側の一時的な異常で大量削除になる事故を防ぐ)。
const YT_SUBSCRIPTION_SYNC_MAX_DELETES = 5;
// 購読一覧のページング上限 (50件 × 20ページ = 最大1,000チャンネル)。
// 上限を超えたら一覧が不完全な可能性があるため、同期自体を中止する。
const YT_SUBSCRIPTION_SYNC_MAX_PAGES = 20;

// 同期の経過・結果のログ。Apps Script では Logger に残し、
// Node テスト環境 (Logger が無い) では console に落とす。
function logSubscriptionSync(message) {
  if (typeof Logger !== 'undefined' && Logger.log) Logger.log(message);
  else if (typeof console !== 'undefined' && console.log) console.log(message);
}

// subscriptions.list の応答 (連携サービスの戻りオブジェクト) の
// 1ページ分を { channels: [{ channelId, title }], nextPageToken } へ
// 正規化する (純関数)。channelId が読めない item は落とす。
function parseYouTubeSubscriptionsPage(response) {
  const res = response || {};
  const items = Array.isArray(res.items) ? res.items : [];
  const channels = [];
  items.forEach((item) => {
    const sn = (item && item.snippet) || {};
    const resourceId = sn.resourceId || {};
    const channelId = String(resourceId.channelId || '').trim();
    if (!channelId) return;
    channels.push({ channelId, title: String(sn.title || '').trim() });
  });
  return { channels, nextPageToken: String(res.nextPageToken || '') };
}

// 連携サービスで購読1ページ分を取得する (薄いラッパー)。
// 連携サービスが有効でない環境 (Node テスト等) では例外にする。
function listMyYouTubeSubscriptionsPage(pageToken) {
  if (typeof YouTube === 'undefined' || !YouTube.Subscriptions || !YouTube.Subscriptions.list) {
    throw new Error('YouTube advanced service is not enabled');
  }
  const params = { mine: true, maxResults: 50 };
  if (pageToken) params.pageToken = pageToken;
  return YouTube.Subscriptions.list('snippet', params);
}

// 購読全件を [{ channelId, title }] で取得する。取得失敗・ページング
// 上限超過は例外として呼び出し側 (同期の中止) に伝える。
function fetchMyYouTubeSubscriptions() {
  const channels = [];
  let pageToken = '';
  for (let page = 0; page < YT_SUBSCRIPTION_SYNC_MAX_PAGES; page++) {
    const parsed = parseYouTubeSubscriptionsPage(listMyYouTubeSubscriptionsPage(pageToken));
    parsed.channels.forEach((c) => { channels.push(c); });
    if (!parsed.nextPageToken) return channels;
    pageToken = parsed.nextPageToken;
  }
  throw new Error('YouTube subscriptions paging exceeded ' + YT_SUBSCRIPTION_SYNC_MAX_PAGES + ' pages');
}

// 購読と feeds の差分を計算する (純関数)。
// 購読が配列でない・有効なチャンネルが0件なら { ok:false, reason }
// を返し、同期は中止になる (何も変更しない)。
// ok の場合の toAdd は [{ channelId, title, url, id }] (id は URL の
// ハッシュ)、toDelete は [{ id, channelId, url }]。削除候補が上限を
// 超えたら deleteBlocked が立ち、削除だけが中止される。
// 対象は URL からチャンネルIDが抜けるフィード (正規形) だけで、
// ピン留め (YT_AUDIO_ALWAYS_CHANNEL_ID) は追加・削除ともに対象外。
function planYouTubeSubscriptionSync(feeds, subscriptions) {
  const none = { toAdd: [], toDelete: [], deleteBlocked: false };
  if (!Array.isArray(subscriptions)) return { ok: false, reason: 'invalid', ...none };
  // 購読はチャンネルIDで一意化する (タイトルは最初に現れたものを採用)。
  const subByChannel = {};
  subscriptions.forEach((s) => {
    const channelId = String((s && s.channelId) || '').trim();
    if (!channelId || subByChannel[channelId]) return;
    subByChannel[channelId] = { channelId, title: String((s && s.title) || '').trim() };
  });
  if (!Object.keys(subByChannel).length) return { ok: false, reason: 'empty', ...none };
  const existingChannelIds = {};
  const existingFeedIds = {};
  (feeds || []).forEach((f) => {
    if (!f) return;
    if (f.id) existingFeedIds[String(f.id)] = true;
    const channelId = youtubeChannelIdFromUrl(f.url);
    if (channelId) existingChannelIds[channelId] = true;
  });
  const toAdd = [];
  Object.keys(subByChannel).forEach((channelId) => {
    if (channelId === YT_AUDIO_ALWAYS_CHANNEL_ID) return;
    if (existingChannelIds[channelId]) return;
    const url = youtubeFeedUrlFromChannelId(channelId);
    const id = feedIdFromUrl(url);
    // 別 URL の既存行が同じ ID を持っていたらハッシュ衝突として、
    // そのチャンネルの追加だけを省く (handleSaveFeed と同じ扱い)。
    if (existingFeedIds[id]) return;
    existingFeedIds[id] = true;
    toAdd.push({ channelId, title: subByChannel[channelId].title, url, id });
  });
  const toDelete = [];
  const deleteSeen = {};
  (feeds || []).forEach((f) => {
    if (!f || !f.id) return;
    const channelId = youtubeChannelIdFromUrl(f.url);
    if (!channelId) return;
    if (channelId === YT_AUDIO_ALWAYS_CHANNEL_ID) return;
    if (subByChannel[channelId]) return;
    if (deleteSeen[String(f.id)]) return;
    deleteSeen[String(f.id)] = true;
    toDelete.push({ id: String(f.id), channelId, url: String(f.url || '') });
  });
  return {
    ok: true,
    toAdd,
    toDelete,
    deleteBlocked: toDelete.length > YT_SUBSCRIPTION_SYNC_MAX_DELETES,
  };
}

// 購読同期の本体。例外はすべて握って結果オブジェクトで返し、
// 呼び出し側 (fetchFeeds やエディタでの手動実行) を失敗させない。
// エディタから直接実行もできる (初回の YouTube スコープ認可用)。
function syncYouTubeSubscriptions() {
  let subscriptions;
  try {
    subscriptions = fetchMyYouTubeSubscriptions();
  } catch (e) {
    logSubscriptionSync('youtube-subscription-sync: aborted (fetch_failed): ' + String((e && e.message) || e));
    return { ok: false, reason: 'fetch_failed', added: 0, deleted: 0, deleteBlocked: false };
  }
  let added = 0;
  let deleted = 0;
  let deleteBlocked = false;
  try {
    const ss = openDataSpreadsheet();
    const feeds = readSheetAsObjects(ss, 'feeds');
    const plan = planYouTubeSubscriptionSync(feeds, subscriptions);
    if (!plan.ok) {
      logSubscriptionSync('youtube-subscription-sync: aborted (' + plan.reason + ')');
      return { ok: false, reason: plan.reason, added: 0, deleted: 0, deleteBlocked: false };
    }
    deleteBlocked = plan.deleteBlocked;
    if (plan.toAdd.length) {
      const sheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
      const values = sheet.getDataRange().getValues();
      const headers = values.length ? values[0] : FEEDS_HEADERS;
      plan.toAdd.forEach((item) => {
        const rowObj = buildFeedRow({
          id: item.id,
          title: item.title,
          url: item.url,
          category: YT_SUBSCRIPTION_SYNC_CATEGORY,
        }, null);
        sheet.appendRow(feedRowValues(rowObj, headers));
        added++;
      });
    }
    if (plan.deleteBlocked) {
      logSubscriptionSync('youtube-subscription-sync: deletes skipped: ' + plan.toDelete.length
        + ' candidates exceed the cap of ' + YT_SUBSCRIPTION_SYNC_MAX_DELETES);
    } else {
      plan.toDelete.forEach((item) => {
        // 削除は既存のフィード削除と同じカスケード (articles も消す)。
        const result = handleDeleteFeed({ feedId: item.id });
        if (result && result.ok) deleted++;
      });
    }
    logSubscriptionSync('youtube-subscription-sync: subscriptions=' + subscriptions.length
      + ' added=' + added + ' deleted=' + deleted + ' deleteBlocked=' + deleteBlocked);
    return { ok: true, added, deleted, deleteBlocked, subscriptionCount: subscriptions.length };
  } catch (e) {
    logSubscriptionSync('youtube-subscription-sync: aborted (error): ' + String((e && e.message) || e));
    return { ok: false, reason: 'error', added, deleted, deleteBlocked };
  }
}

// channels.list / playlists.list で名前を引く共通処理 (タイトル
// 未設定の YouTube フィードの補完用)。endpoint は 'channels' か
// 'playlists'。取れなければ空文字で、失敗は例外にしない
// (補完できなくても記事の取り込みは続けるため)。
function lookupYouTubeTitle(endpoint, id, apiKey) {
  try {
    const apiUrl = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?part=snippet'
      + '&id=' + encodeURIComponent(id)
      + '&key=' + encodeURIComponent(apiKey);
    const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    return firstSnippetTitle(res.getContentText());
  } catch (e) {
    return '';
  }
}

// --- プレイリストフィードの取り込みと削除同期 ---
// プレイリストフィードは「プレイリストが正」: 巡回で取り込むだけで
// なく、プレイリストから外れた動画の記事は削除する (購読同期と
// 同じ思想)。安全策も購読同期に倣う:
// - 全ページの取得が成功し、取得できた動画が1件以上あるときだけ
//   削除を検討する。取得失敗 (例外) は呼び出し側で巡回エラーとして
//   扱われ、その回は削除しない。取得0件は「プレイリストが空」と
//   「取得異常 (非公開化など)」を区別できないため削除しない。
// - 削除候補が1回の上限 (YT_PLAYLIST_SYNC_MAX_DELETES) を超えたら
//   削除だけを中止し、警告ログを残す (追加は行う)。

// プレイリスト1件の取り込み上限: 50件 × 最大2ページ = 100件。
const YT_PLAYLIST_FETCH_MAX_PAGES = 2;
// 1回の巡回でプレイリスト同期として削除する件数の上限。
const YT_PLAYLIST_SYNC_MAX_DELETES = 20;

// 削除同期の計画 (純関数)。existingArticles はそのフィードの既存
// 記事行 (id / link を持つ行オブジェクト)、fetchedVideoIds は今回の
// 取得で得た動画ID。取得集合に無い既存記事が削除候補で、上限を
// 超えたら blocked を立てて deleteIds は空にする (削除しない)。
// 取得集合が空なら (0件取得) 削除は検討しない。
function planPlaylistArticleDeletions(existingArticles, fetchedVideoIds) {
  const fetched = {};
  (fetchedVideoIds || []).forEach((id) => {
    const videoId = String(id || '');
    if (videoId) fetched[videoId] = true;
  });
  if (!Object.keys(fetched).length) return { deleteIds: [], blocked: false, candidates: 0 };
  const deleteIds = [];
  (existingArticles || []).forEach((a) => {
    if (!a || !a.id) return;
    const videoId = videoIdFromLink(a.link);
    if (videoId && !fetched[videoId]) deleteIds.push(String(a.id));
  });
  if (deleteIds.length > YT_PLAYLIST_SYNC_MAX_DELETES) {
    return { deleteIds: [], blocked: true, candidates: deleteIds.length };
  }
  return { deleteIds, blocked: false, candidates: deleteIds.length };
}

// プレイリストフィード1件の取り込み (記事の追加＋削除同期＋長さの
// 保存) を行い、追加件数を返す。取得の HTTP エラーは例外として
// 呼び出し側 (fetchFeeds の巡回エラー処理) へ伝える。
// existingArticleRows は巡回開始時点の articles 全行 (削除候補の
// 母集団。今回の追加分は取得集合に含まれるため候補にならない)。
function fetchYouTubePlaylistFeed(ss, articlesSheet, feed, playlistId, apiKey, existingIds, existingArticleRows, fetchedAt, durationColIdx) {
  // 既存記事の長さの有無 (長さ取得の対象を絞る材料)。記事IDは
  // フィードIDから決まるため、このフィードの行だけが一致する。
  const knownDurationById = {};
  (existingArticleRows || []).forEach((a) => {
    if (a && a.id) knownDurationById[String(a.id)] = Number(a.duration_sec) || 0;
  });
  const entries = [];
  let pageToken = '';
  for (let page = 0; page < YT_PLAYLIST_FETCH_MAX_PAGES; page++) {
    const apiUrl = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50'
      + '&playlistId=' + encodeURIComponent(playlistId)
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '')
      + '&key=' + encodeURIComponent(apiKey);
    const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code !== 200) throw new Error('YouTube API HTTP ' + code + youtubeApiErrorDetail(res.getContentText()));
    const bodyText = res.getContentText();
    const pageEntries = parseYouTubePlaylistItems(bodyText, feed);
    // 動画の長さを videos.list で補う (チャンネル取り込みと対)。
    // 単位数節約のため、対象は新規行と長さが空の既存行だけに絞り、
    // ページ単位 (最大50件) でまとめて引く。失敗しても長さ不明の
    // まま取り込みは続ける (fail-open)。
    attachYouTubeDurations(pageEntries.filter((entry) => {
      const id = articleId(feed.id, entry.guid);
      return !existingIds[id] || !(knownDurationById[id] > 0);
    }), apiKey);
    pageEntries.forEach((entry) => { entries.push(entry); });
    pageToken = parseYouTubeNextPageToken(bodyText);
    if (!pageToken) break;
  }
  const added = appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt, durationColIdx);
  // 既存記事 (再追加されない) の長さも埋め戻す (チャンネル側と対)。
  backfillArticleDurations(articlesSheet, feed, entries, durationColIdx);
  // 削除同期: ここまで例外なく来た = 全ページの取得が成功している。
  const ownArticles = (existingArticleRows || []).filter((a) => String(a.feed_id) === String(feed.id));
  const plan = planPlaylistArticleDeletions(ownArticles, entries.map((e) => e.guid));
  if (plan.blocked) {
    console.log('youtube-playlist-sync: deletes skipped for feed ' + feed.id + ': '
      + plan.candidates + ' candidates exceed the cap of ' + YT_PLAYLIST_SYNC_MAX_DELETES);
  } else if (plan.deleteIds.length) {
    deleteRowsById(ss, 'articles', 'id', plan.deleteIds);
    // 消えた記事が RSS キャッシュから出続けないように落とす。
    invalidateRssCache(feed.id);
  }
  return added;
}

// fireTrigger はテスト用の差し込み口 (音声抽出トリガー用)。
// 時間ベーストリガーからは引数なし (実際はイベントオブジェクト) で呼ばれる。
function fetchFeeds(fireTrigger) {
  // 記事取得より前に、YouTube のチャンネル登録 (購読) とフィードを
  // 同期する (購読が正。追加も削除も同期)。同期は失敗しても例外を
  // 握る設計だが、念のためここでも握って巡回自体は従来どおり続ける。
  try {
    syncYouTubeSubscriptions();
  } catch (e) {
    logSubscriptionSync('youtube-subscription-sync: unexpected error: ' + String((e && e.message) || e));
  }
  const ss = openDataSpreadsheet();
  const feedsSheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
  const articlesSheet = getSheetOrCreate(ss, 'articles', ARTICLES_HEADERS);
  const feedValues = feedsSheet.getDataRange().getValues();
  if (feedValues.length < 2) return { ok: true, fetched: 0 };
  const headers = feedValues[0];
  const feeds = rowsToObjects(feedValues);
  // Map feed id -> 1-based sheet row number (header is row 1).
  const rowNumById = {};
  const idIdx = headers.indexOf('id');
  for (let i = 1; i < feedValues.length; i++) {
    const id = feedValues[i][idIdx];
    if (id) rowNumById[id] = i + 1;
  }
  const youtubeFeeds = selectFetchTargets(feeds);
  const existingArticleRows = readSheetAsObjects(ss, 'articles');
  const existingIds = {};
  existingArticleRows.forEach((a) => { existingIds[a.id] = true; });
  // duration_sec 列 (動画の長さ。スター判定で90秒未満を除く材料) の
  // 位置を決める。既存シートに無ければ遅延追加する (star_override と
  // 同じ移行パターン)。
  const articleValuesForDuration = articlesSheet.getDataRange().getValues();
  const articleHeaders = articleValuesForDuration.length ? articleValuesForDuration[0] : ARTICLES_HEADERS;
  const durationColIdx = ensureColumnIndex(articlesSheet, articleHeaders, 'duration_sec');
  const fetchedAt = new Date().toISOString();
  let addedTotal = 0;
  // YouTube フィードは公式APIから取り込む (RSS は 404 のため)。
  const youtubeApiKey = scriptProperty('YOUTUBE_API_KEY');
  youtubeFeeds.forEach((feed) => {
    const rowNum = rowNumById[feed.id];
    try {
      if (!youtubeApiKey) throw new Error('YOUTUBE_API_KEY is not set');
      const channelId = youtubeChannelIdFromUrl(feed.url);
      const playlistId = youtubePlaylistIdFromUrl(feed.url);
      // タイトル未設定なら API で名前を補完する (YouTube フィードは
      // 登録時にタイトルを自動取得できないため空で入る。チャンネルは
      // channels.list、プレイリストは playlists.list で引く)。
      // 補完の失敗は巡回自体の失敗にせず、タイトルは空のまま続ける。
      if (!String(feed.title || '').trim()) {
        const foundTitle = channelId
          ? lookupYouTubeTitle('channels', channelId, youtubeApiKey)
          : lookupYouTubeTitle('playlists', playlistId, youtubeApiKey);
        if (foundTitle) {
          updateFeedRow(feedsSheet, headers, rowNum, { title: foundTitle });
          feed.title = foundTitle;
        }
      }
      if (channelId) {
        const uploadsId = youtubeUploadsPlaylistId(channelId);
        const apiUrl = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20'
          + '&playlistId=' + encodeURIComponent(uploadsId)
          + '&key=' + encodeURIComponent(youtubeApiKey);
        const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
        const code = res.getResponseCode();
        if (code !== 200) throw new Error('YouTube API HTTP ' + code + youtubeApiErrorDetail(res.getContentText()));
        const entries = parseYouTubePlaylistItems(res.getContentText(), feed);
        // 候補動画の長さを videos.list で補う (90秒未満の除外判定用)。
        // 失敗時は長さ不明のまま取り込む (fail-open)。
        attachYouTubeDurations(entries, youtubeApiKey);
        addedTotal += appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt, durationColIdx);
        // 既存記事 (再追加されない) の長さも埋め戻す。
        backfillArticleDurations(articlesSheet, feed, entries, durationColIdx);
      } else {
        // プレイリストフィード: 取り込み＋削除同期 (プレイリストが正)。
        addedTotal += fetchYouTubePlaylistFeed(
          ss, articlesSheet, feed, playlistId, youtubeApiKey, existingIds, existingArticleRows, fetchedAt, durationColIdx
        );
      }
      updateFeedRow(feedsSheet, headers, rowNum, { last_fetched_at: fetchedAt, last_status: '200', last_error: '' });
    } catch (err) {
      updateFeedRow(feedsSheet, headers, rowNum, {
        last_fetched_at: fetchedAt,
        last_status: 'error',
        last_error: String((err && err.message) || err).slice(0, 500),
      });
    }
  });
  // 音声抽出は、実効スターの付いた動画だけを ze へ依頼する
  // (スター制)。実効スターはシートの現在状態 (手動オーバーライド＋
  // デフォルトルール) から計算するため、記事の保存が済んでから
  // シートを読み直して計画する。
  // トリガーの成否は巡回結果に影響させない。
  try {
    const planned = planStarredAudioTriggers(feeds, readSheetAsObjects(ss, 'articles'));
    fireYouTubeAudioTriggers(null, fireTrigger, undefined, planned);
  } catch (e) {
    // 依頼できなくても記事の取り込みは成功として扱う。
  }
  pruneArticles();
  // 視聴ログの週次集計と間引きは週1回だけ、この巡回に相乗りする
  // (新しいトリガーは作らない)。失敗しても巡回結果に影響させない。
  try {
    maybeRollupWeeklyEvents();
  } catch (e) {
    // 集計できなくても記事の取り込みは成功として扱う。
  }
  // feeds の並び (表示順) をカテゴリごとにまとめる保守処理も、この
  // 巡回に相乗りする (新しいトリガーは作らない)。巡回の最後に置く
  // ことで、購読同期の追加・タイトル補完・行更新が済んだ最終状態を
  // まとめ直す。順序が変わるときだけ書き戻すため、まとまっている
  // 間は読み取り1回で済む。失敗しても巡回結果に影響させない。
  try {
    regroupFeedsByCategory();
  } catch (e) {
    // まとめ直しができなくても記事の取り込みは成功として扱う。
  }
  return { ok: true, fetched: youtubeFeeds.length, added: addedTotal };
}

function setupFetchTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'fetchFeeds') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fetchFeeds').timeBased().everyHours(1).create();
}

// --- Article listing ---

// list 用: 記事を新しい順に並べるだけにする
// (フィード/カテゴリ/未読の絞り込みは v2 ではクライアント側で行う)。
function filterArticles(articles) {
  const out = (articles || []).slice();
  out.sort((a, b) => articleTimeMs(b.publishedAt, b.fetchedAt) - articleTimeMs(a.publishedAt, a.fetchedAt));
  return out;
}

function buildListPayload(body) {
  const ss = openDataSpreadsheet();
  const feeds = readSheetAsObjects(ss, 'feeds');
  const feedById = {};
  feeds.forEach((f) => { feedById[f.id] = f; });
  const articleRows = readSheetAsObjects(ss, 'articles');
  // スター制: 手動オーバーライド (star_state) と実効スター (starred)
  // を記事ごとに付ける。実効スターは feeds と記事集合から計算する。
  const starredIds = computeStarredArticleIds(feeds, articleRows);
  const merged = articleRows.map((a) => {
    const feed = feedById[a.feed_id];
    return {
      id: a.id,
      feedId: a.feed_id,
      feedTitle: feed ? String(feed.title || '') : '',
      title: String(a.title || ''),
      link: String(a.link || ''),
      publishedAt: cellIso(a.published_at),
      fetchedAt: cellIso(a.fetched_at),
      summary: String(a.summary || ''),
      // 既読は端末ローカル管理のため、サーバーは常に未読として返す
      // (フロントの既読の初回取り込みは「何も取り込まない」形で完了する)。
      isRead: false,
      star_state: starOverrideOf(a),
      starred: !!starredIds[String(a.id)],
    };
  });
  // isRead は常に false (既読は端末ローカル管理) のため、未読数は
  // そのまま記事数になる。
  const unreadByFeed = countUnreadByFeed(merged);
  const sorted = filterArticles(merged);
  let limit = Number(body.limit || 100);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);
  const serviceUrl = getServiceUrl();
  return {
    ok: true,
    articles: sorted.slice(0, limit),
    feeds: feeds.filter((f) => f.id).map((f) => ({
      id: f.id,
      title: String(f.title || ''),
      url: String(f.url || ''),
      fetchUrl: buildFetchUrl(f, serviceUrl),
      category: String(f.category || ''),
      unreadCount: unreadByFeed[f.id] || 0,
    })),
  };
}

// --- Feed management (owner only) ---
// フィードの追加・編集・削除をフロントの管理画面から行うためのAPI。
// 純関数のバリデーション/整形を Node テスト対象にし、シート操作は薄く保つ。

const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Pure-JS https URL check (Apps Script には URL コンストラクタが無いため正規表現で分解する)。
// Returns { ok:true, url, host } or { ok:false, message }.
function parseFeedUrl(rawUrl) {
  const url = String(rawUrl === undefined || rawUrl === null ? '' : rawUrl).trim();
  if (!url) return { ok: false, message: 'url is required' };
  if (/\s/.test(url)) return { ok: false, message: 'url is invalid' };
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([\s\S]*)$/.exec(url);
  if (!m) return { ok: false, message: 'url is invalid' };
  if (m[1].toLowerCase() !== 'https') return { ok: false, message: 'url must use https' };
  let authority = m[2];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority;
  const colon = authority.lastIndexOf(':');
  if (colon >= 0) {
    host = authority.slice(0, colon);
    if (!/^\d+$/.test(authority.slice(colon + 1))) return { ok: false, message: 'url is invalid' };
  }
  host = host.toLowerCase();
  const labels = host.split('.');
  const hostOk = host.length > 0 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
  if (!hostOk) return { ok: false, message: 'url is invalid' };
  return { ok: true, url, host };
}

// Validates/normalizes a feed input object.
// Returns { ok:true, feed:{id,title,url,category} } or { ok:false, message }.
// enabled / isPrivate は廃止したため入力にあっても無視し、正規化結果にも含めない。
// id は任意: 指定があれば形式だけを検証する。追加時の実 ID は URL のハッシュで
// 決めるため、id は「どの行を更新するか」の指定としてだけ使う (handleSaveFeed)。
// title は原則必須だが、YouTube 疑似フィードだけは空を許す (登録時に自動取得
// できないため。fetchFeeds が Data API から補完する)。
function validateFeedInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, message: 'feed is required' };
  const id = String(input.id === undefined || input.id === null ? '' : input.id).trim();
  if (id && !FEED_ID_PATTERN.test(id)) return { ok: false, message: 'id must be a slug (lowercase letters, digits, hyphens)' };
  const parsed = parseFeedUrl(input.url);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const playlistId = youtubePlaylistIdFromUrl(parsed.url);
  // 自動生成プレイリスト (LR = ラジオ、RD = ミックス) は playlistItems が
  // 0件を返して取り込めないため、保存時に弾く。巡回側の判定
  // (youtubePlaylistIdFromUrl の抽出) には影響させない。
  if (/^(?:LR|RD)/.test(playlistId)) {
    return { ok: false, message: '自動生成プレイリスト（ラジオ／ミックス）は取得できないため登録できません' };
  }
  const title = String(input.title === undefined || input.title === null ? '' : input.title).trim();
  if (!title && !isYouTubeFeedUrl(parsed.url)) {
    return { ok: false, message: 'title is required' };
  }
  let category = '';
  if (input.category !== undefined && input.category !== null) {
    if (typeof input.category !== 'string') return { ok: false, message: 'category must be a string' };
    category = input.category.trim();
  }
  return {
    ok: true,
    feed: {
      id,
      title,
      url: parsed.url,
      category,
    },
  };
}

// Builds the feeds-tab row object (snake_case keys) for a normalized feed.
// On update, etag/last_modified/last_fetched_at/last_status/last_error are preserved,
// except that a URL change clears etag/last_modified so the next fetch is a full fetch.
function buildFeedRow(feed, existing) {
  const prev = existing || null;
  const urlChanged = !!prev && String(prev.url || '') !== feed.url;
  const keepCache = !!prev && !urlChanged;
  return {
    id: feed.id,
    title: feed.title,
    url: feed.url,
    category: feed.category,
    etag: keepCache ? String(prev.etag || '') : '',
    last_modified: keepCache ? String(prev.last_modified || '') : '',
    last_fetched_at: prev ? cellIso(prev.last_fetched_at) : '',
    last_status: prev ? String(prev.last_status || '') : '',
    last_error: prev ? String(prev.last_error || '') : '',
  };
}

function feedRowValues(rowObj, headers) {
  return (headers || FEEDS_HEADERS).map((h) => (rowObj[h] === undefined ? '' : rowObj[h]));
}

// Web App の公開 URL (RSS 出力の fetchUrl 組み立て用)。Apps Script 以外の
// 環境 (Node テスト) では空文字を返す。
function getServiceUrl() {
  if (typeof ScriptApp === 'undefined' || !ScriptApp.getService) return '';
  try { return String(ScriptApp.getService().getUrl() || ''); } catch (e) { return ''; }
}

// クライアントが実際に取得する URL。YouTube フィード (チャンネル・
// プレイリスト) は reader-gas の RSS 出力 (?rss=<feedId>) を指し、
// それ以外はフィードの URL そのまま。
function buildFetchUrl(feed, serviceUrl) {
  const f = feed || {};
  const url = String(f.url || '');
  const id = String(f.id || '');
  const base = String(serviceUrl || '');
  if (id && base && isYouTubeFeedUrl(url)) {
    return base + '?rss=' + encodeURIComponent(id);
  }
  return url;
}

// Shapes a feeds-tab object (or a buildFeedRow result) into the API feed item.
function feedToApiShape(feedObj, unreadCount, serviceUrl) {
  const f = feedObj || {};
  const base = serviceUrl !== undefined ? String(serviceUrl || '') : getServiceUrl();
  const fetched = f.last_fetched_at !== undefined ? f.last_fetched_at : f.lastFetchedAt;
  const status = f.last_status !== undefined ? f.last_status : f.lastStatus;
  const error = f.last_error !== undefined ? f.last_error : f.lastError;
  return {
    id: String(f.id || ''),
    title: String(f.title || ''),
    url: String(f.url || ''),
    fetchUrl: buildFetchUrl(f, base),
    category: String(f.category || ''),
    lastStatus: String(status || ''),
    lastError: String(error || ''),
    lastFetchedAt: cellIso(fetched),
    unreadCount: unreadCount || 0,
  };
}

// サーバー側に既読状態は無い (端末ローカル管理) ため、未読数は記事数として数える。
// タイムラインはこの値を使わず端末内で数え直す。管理画面の表示用。
function countUnreadByFeed(articles) {
  const counts = {};
  (articles || []).forEach((a) => {
    const feedId = a.feed_id !== undefined ? a.feed_id : a.feedId;
    if (!feedId) return;
    counts[feedId] = (counts[feedId] || 0) + 1;
  });
  return counts;
}

function buildListFeedsPayload() {
  const ss = openDataSpreadsheet();
  const feeds = readSheetAsObjects(ss, 'feeds');
  const articleRows = readSheetAsObjects(ss, 'articles');
  const unreadByFeed = countUnreadByFeed(articleRows);
  return {
    ok: true,
    feeds: feeds.filter((f) => f.id).map((f) => feedToApiShape(f, unreadByFeed[f.id] || 0)),
  };
}

// resolveHandle はテスト用の差し込み口 (省略時は Data API で引く
// lookupYouTubeChannelByHandle)。ハンドル -> { channelId, title } | null。
function handleSaveFeed(body, resolveHandle) {
  const input = body && body.feed && typeof body.feed === 'object' ? { ...body.feed } : (body ? body.feed : null);
  // YouTube の入力は、検証の前に保存形 (/channel/UC...) へ寄せる。
  // /channel/ 形は URL から直接 ID を抜けるためネットワーク不要。
  // /@handle 形だけ Data API で解決し、失敗したら何も書かずに弾く。
  // 保存形を一本化することで、どの形で再登録しても重複判定が同じ行に
  // 当たるようになる。
  const channelRef = input ? parseYouTubeChannelUrl(input.url) : null;
  if (channelRef) {
    let channelId = channelRef.kind === 'id' ? channelRef.channelId : '';
    let resolvedTitle = '';
    if (channelRef.kind === 'handle') {
      const resolve = resolveHandle || lookupYouTubeChannelByHandle;
      const found = resolve(channelRef.handle);
      if (!found || !String(found.channelId || '').trim()) {
        return { ok: false, error: 'invalid', message: 'YouTube チャンネルが見つかりませんでした' };
      }
      channelId = String(found.channelId).trim();
      resolvedTitle = String(found.title || '').trim();
    }
    input.url = youtubeFeedUrlFromChannelId(channelId);
    if (resolvedTitle && !String(input.title || '').trim()) input.title = resolvedTitle;
  }
  // プレイリストの入力も保存形 (/playlist?list=...) へ寄せる
  // (list= 以外のクエリは落とす)。保存形を一本化することで、
  // 余分なクエリ付きで再登録しても重複判定が同じ行に当たる。
  if (input && !channelRef) {
    const playlistId = youtubePlaylistIdFromUrl(input.url);
    if (playlistId) input.url = youtubeFeedUrlFromPlaylistId(playlistId);
  }
  const result = validateFeedInput(input);
  if (!result.ok) return { ok: false, error: 'invalid', message: result.message };
  const feed = result.feed;
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0] : FEEDS_HEADERS;
  const idIdx = headers.indexOf('id');
  const urlIdx = headers.indexOf('url');
  const rowAt = (i) => rowObject(headers, values[i]);
  // データ行 (1始まりの添字) から条件に合う最初の行を探す。無ければ -1。
  const findRow = (pred) => findDataRowIndex(values, pred);
  let existing = null;
  let rowNum = -1;
  const takeRow = (i) => { existing = rowAt(i); rowNum = i + 1; };
  // 1) id の指定があり、その行があればその行を更新する (管理画面の編集経路。
  //    移行前の slug ID の行もそのまま扱う)。
  if (feed.id && idIdx >= 0) {
    const i = findRow((row) => String(row[idIdx]) === feed.id);
    if (i >= 0) takeRow(i);
  }
  // 2) 同じ URL の行があれば、その行の更新として扱う (再追加の冪等化)。
  //    行の ID は維持する。
  if (!existing && urlIdx >= 0) {
    const i = findRow((row) => String(row[urlIdx]) === feed.url);
    if (i >= 0) takeRow(i);
  }
  // 2b) YouTube は、入力形が違っても (/@handle で登録 → 保存形で保存済み等)
  //     チャンネルIDが一致すれば同じ行の更新として扱う (クロスフォームな
  //     重複を作らないため)。行の ID は維持し、URL は正規形へ書き換わる。
  if (!existing && urlIdx >= 0) {
    const feedChannelId = youtubeChannelIdFromUrl(feed.url);
    if (feedChannelId) {
      const i = findRow((row) => youtubeChannelIdFromUrl(row[urlIdx]) === feedChannelId);
      if (i >= 0) takeRow(i);
    }
  }
  if (existing) {
    feed.id = String(existing.id || '');
    // タイトル未指定 (YouTube の空タイトル) の更新では既存タイトルを消さない。
    if (!feed.title) feed.title = String(existing.title || '');
  } else {
    // 3) 新規追加: ID はクライアント指定を無視し、URL のハッシュで決める。
    //    同じ ID の行が別 URL で存在したらハッシュ衝突として弾く
    //    (同じ URL の行は手順2で拾われているため、ここには来ない)。
    feed.id = feedIdFromUrl(feed.url);
    if (idIdx >= 0 && findRow((row) => String(row[idIdx]) === feed.id) >= 0) {
      return { ok: false, error: 'conflict', message: 'feed id collision for url: ' + feed.url };
    }
  }
  const rowObj = buildFeedRow(feed, existing);
  const rowValues = feedRowValues(rowObj, headers);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, headers.length).setValues([rowValues]);
  else sheet.appendRow(rowValues);
  // タイトルは RSS 本文に、カテゴリはスターのデフォルト判定に
  // 影響するため、そのフィードの RSS キャッシュを落とす。
  invalidateRssCache(feed.id);
  const unreadByFeed = countUnreadByFeed(readSheetAsObjects(ss, 'articles'));
  return { ok: true, feed: feedToApiShape(rowObj, existing ? (unreadByFeed[feed.id] || 0) : 0) };
}

function handleDeleteFeed(body) {
  const feedId = String((body && (body.feedId || body.feed_id)) || '');
  const ss = openDataSpreadsheet();
  const sheet = ss.getSheetByName('feeds');
  if (!sheet) return { ok: false, error: 'not_found' };
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: 'not_found' };
  const headers = values[0];
  const idIdx = headers.indexOf('id');
  if (idIdx < 0) return { ok: false, error: 'not_found' };
  const found = findDataRowIndex(values, (row) => String(row[idIdx]) === feedId);
  if (found < 0) return { ok: false, error: 'not_found' };
  const rowNum = found + 1;
  deleteRowsById(ss, 'articles', 'feed_id', [feedId]);
  sheet.deleteRow(rowNum);
  // 消えたフィードの RSS がキャッシュから出続けないように落とす
  // (購読同期の削除もこのハンドラ経由)。
  invalidateRssCache(feedId);
  return { ok: true };
}

// Display order = feeds sheet row order (both list and listFeeds follow it),
// so reordering means rewriting the feeds rows in the requested order.
function handleReorderFeeds(body) {
  const sheet = openDataSpreadsheet().getSheetByName('feeds');
  const values = sheet ? sheet.getDataRange().getValues() : [];
  const headers = values.length ? values[0] : FEEDS_HEADERS;
  const idIdx = headers.indexOf('id');
  if (idIdx < 0) return { ok: false, error: 'invalid', message: 'feeds sheet has no id column' };
  const currentIds = [];
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][idIdx] || '');
    if (id) currentIds.push(id);
  }
  const check = validateFeedOrder(body ? body.feedIds : null, currentIds);
  if (!check.ok) return { ok: false, error: 'invalid', message: check.message };
  if (!sheet || values.length < 2) return { ok: true };
  const reordered = reorderRowsByIds(values, idIdx, body.feedIds);
  // 並びが変わらない場合は書き戻しを省く (行参照の同一性で判定できる)。
  rewriteRowsIfChanged(sheet, values, reordered);
  return { ok: true };
}

// feeds の並び (表示順 = 行順) をカテゴリごとにまとめる保守処理
// (fetchFeeds から相乗り)。新規フィードは末尾に追加されるため、
// 放っておくとカテゴリが散らかったままになる。行の全列の値を
// 保持したまま行順だけを変え (行の追加・削除はしない)、すでに
// まとまっている場合は書き戻しを省く (行参照の同一性で判定する)。
function regroupFeedsByCategory() {
  const sheet = openDataSpreadsheet().getSheetByName('feeds');
  if (!sheet) return { ok: true, changed: false };
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: true, changed: false };
  const categoryIdx = values[0].indexOf('category');
  if (categoryIdx < 0) return { ok: true, changed: false };
  const grouped = groupRowsByCategory(values, categoryIdx);
  const changed = rewriteRowsIfChanged(sheet, values, grouped);
  return { ok: true, changed };
}

// スターの手動オーバーライドを保存する (オーナー専用アクション
// set_star の本体)。保存先は articles タブの star_override 列だけで、
// 列が無いシート (移行前) ではヘッダーへ遅延追加する (既存行のセルは
// 空のまま = '' 扱い)。on=true では保存に加えて、その動画の音声抽出
// をその場で ze へ依頼する (毎時巡回を待たない)。依頼は
// fire-and-forget で、失敗しても保存は成功として返す。
// fireTrigger はテスト用の差し込み口 (省略時は fireYouTubeAudioTrigger)。
function handleSetStar(body, fireTrigger) {
  const id = String((body && body.id) || '');
  if (!id) return { ok: false, error: 'invalid', message: 'id is required' };
  const on = isTruthy(body && body.on);
  const ss = openDataSpreadsheet();
  const sheet = ss.getSheetByName('articles');
  if (!sheet) return { ok: false, error: 'not_found' };
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: 'not_found' };
  const headers = values[0];
  const idIdx = headers.indexOf('id');
  if (idIdx < 0) return { ok: false, error: 'not_found' };
  const found = findDataRowIndex(values, (row) => String(row[idIdx]) === id);
  if (found < 0) return { ok: false, error: 'not_found' };
  const rowNum = found + 1;
  const starIdx = ensureColumnIndex(sheet, headers, 'star_override');
  sheet.getRange(rowNum, starIdx + 1).setValue(on ? 'on' : 'off');
  // スター状態は ?rss= の enclosure に直結するため、その記事の
  // フィードの RSS キャッシュを即時に落とす (次回 ?rss= で再生成)。
  const feedIdx = headers.indexOf('feed_id');
  invalidateRssCache(feedIdx >= 0 ? String(values[rowNum - 1][feedIdx] || '') : '');
  if (on) {
    const linkIdx = headers.indexOf('link');
    const videoId = linkIdx >= 0 ? videoIdFromLink(values[rowNum - 1][linkIdx]) : '';
    const token = scriptProperty('A_ZE_GS_TOKEN');
    if (videoId && token) {
      const fire = resolveFireTrigger(fireTrigger);
      try {
        fire(videoId, token);
      } catch (e) {
        // 依頼できなくてもオーバーライドの保存は成功として扱う。
      }
    }
  }
  return { ok: true, id, star_state: on ? 'on' : 'off', starred: on };
}

// --- Usage events (視聴ログ) ---
// クライアントが log_events で送るイベントを events タブへ貯める。
// 種類は feed_view (フィードを開いた) / article_open (記事を開いた) /
// play (再生。停止時点で聴いた秒数を伴う) / scroll (そのフィードの
// タイムラインをスクロールした。クリックより弱いシグナルで、
// クライアントが訪問ごとに最大1回だけ送る) / expand (記事カードの
// 要約を「もっと見る」で展開した。記事への興味の強さを示すシグナル)
// の5つだけ。週次集計は weekly_stats タブへ畳み、生ログは90日で間引く。
// 再生診断の15種も同じ経路で受ける (週次集計の対象外で、生ログとして
// だけ残る): preload_error (次曲の先読みでエラーが起きた) /
// advance_swap (曲の終了で、待機側への役割交代で次へ進んだ) /
// advance_load (曲の終了で、従来経路の新規読み込みで次へ進んだ) /
// stall (再生中に位置が進まない状態を検知した。seconds は止まった
// 位置) / recover (フォアグラウンド復帰時の回復が、止まっていた
// 再生を再開・前進させた) / deck_overlap (待機側の要素が再生状態
// になっているのをクライアントが検出して止めた。対象は待機側に
// 載っていた曲、seconds は待機側の止めた位置) /
// play_rejected_not_allowed / play_rejected_not_supported /
// play_rejected_other (play() が拒否された。理由 (エラーの name)
// を種別で区別する) / start_retry (遷移直後の開始チェックが
// play() を再発行した) / start_fallback (開始チェックが、直前
// まで鳴っていた要素へ読み直して再生するフォールバックを行った)
// / start_failed (再発行・フォールバックでも始まらなかった) /
// route_offline・route_online (回線イベントを受けた。対象はその
// 時点で再生中の曲) / route_reload (回線切り替わりで、再生中の
// 曲を現在位置から読み直した。seconds は読み直し位置)。

// Asia/Tokyo (UTC+9、夏時間なし) で見た週の開始日 (月曜) を
// 'YYYY-MM-DD' で返す。文字列の辞書順がそのまま日付順になる。
function weekStartKey(timeMs) {
  const jst = new Date(timeMs + 9 * 60 * 60 * 1000);
  const dow = jst.getUTCDay();
  const monday = new Date(Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate() - ((dow + 6) % 7)
  ));
  return monday.toISOString().slice(0, 10);
}

// イベント1件を検証して events タブの行 (配列) にする。不正なら null。
// ts はクライアント値が解釈できればそれを ISO に正規化し、無ければ
// 受付時刻 (nowIso) を使う。文字列は上限で切り、play と stall と
// deck_overlap と route_reload 以外の seconds は保存しない (空)。
// play と stall の seconds が0以上の数値でない行は捨てる
// (deck_overlap と route_reload の seconds は任意で、数値でなければ
// 空にする)。
function sanitizeEvent(raw, nowIso) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  if (!EVENT_TYPES[type]) return null;
  const feedId = String(raw.feed_id || raw.feedId || '').slice(0, EVENT_ID_MAX_CHARS);
  if (!feedId) return null;
  const feedTitle = String(raw.feed_title || raw.feedTitle || '').slice(0, EVENT_TITLE_MAX_CHARS);
  const articleId = String(raw.article_id || raw.articleId || '').slice(0, EVENT_ID_MAX_CHARS);
  const articleTitle = String(raw.article_title || raw.articleTitle || '').slice(0, EVENT_TITLE_MAX_CHARS);
  const secondsValue = Number(raw.seconds);
  let seconds = '';
  if (type === 'play' || type === 'stall') {
    if (!Number.isFinite(secondsValue) || secondsValue < 0) return null;
    seconds = Math.floor(secondsValue);
  } else if ((type === 'deck_overlap' || type === 'route_reload') && Number.isFinite(secondsValue) && secondsValue >= 0) {
    seconds = Math.floor(secondsValue);
  }
  let ts = nowIso;
  const parsed = Date.parse(String(raw.ts || ''));
  if (Number.isFinite(parsed)) ts = new Date(parsed).toISOString();
  return [ts, type, feedId, feedTitle, articleId, articleTitle, seconds];
}

// 1リクエスト分 (最大 EVENT_LOG_MAX_PER_REQUEST 件) を検証し、
// 保存できる行だけを返す。
function sanitizeEventBatch(input, nowIso) {
  if (!Array.isArray(input)) return [];
  const now = nowIso || new Date().toISOString();
  const rows = [];
  input.slice(0, EVENT_LOG_MAX_PER_REQUEST).forEach((raw) => {
    const row = sanitizeEvent(raw, now);
    if (row) rows.push(row);
  });
  return rows;
}

// log_events アクションの本体: 検証を通った行を events タブへ
// setValues で一括追記し、保存できた件数を返す。
function handleLogEvents(body, nowIso) {
  const rows = sanitizeEventBatch(body && body.events, nowIso);
  if (!rows.length) return { ok: true, saved: 0 };
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, EVENTS_SHEET_NAME, EVENTS_HEADERS);
  const startRow = sheet.getDataRange().getValues().length + 1;
  sheet.getRange(startRow, 1, rows.length, EVENTS_HEADERS.length).setValues(rows);
  return { ok: true, saved: rows.length };
}

// events を (週, フィード) 単位に集計する純関数。weekFilter が
// あたえられた週だけを対象にする (null なら全週)。
// 戻り値は { map, order }: map は 'week\nfeed_id' → 集計オブジェクト、
// order は出現順のキー配列。feed_title は最後に現れた非空の値を使う。
function aggregateEventsByWeekFeed(events, weekFilter) {
  const map = {};
  const order = [];
  (events || []).forEach((ev) => {
    const t = Date.parse(cellIso(ev && ev.ts) || '');
    if (!Number.isFinite(t)) return;
    const week = weekStartKey(t);
    if (weekFilter && week !== weekFilter) return;
    const feedId = String((ev && ev.feed_id) || '');
    const key = week + '\n' + feedId;
    if (!map[key]) {
      map[key] = { week, feed_id: feedId, feed_title: '', views: 0, opens: 0, plays: 0, seconds: 0, scrolls: 0, expands: 0 };
      order.push(key);
    }
    const agg = map[key];
    const title = String(ev.feed_title || '');
    if (title) agg.feed_title = title;
    // 単純な件数カウンタは種別→フィールドの対応表で数え、play だけ
    // 秒数の加算も伴うため分ける (doPost と同じく hasOwnProperty で
    // 判定し、継承プロパティ名の種別が来ても数えない)。
    if (Object.prototype.hasOwnProperty.call(EVENT_COUNTER_FIELDS, ev.type)) {
      agg[EVENT_COUNTER_FIELDS[ev.type]] += 1;
    } else if (ev.type === 'play') {
      agg.plays += 1;
      agg.seconds += Math.max(0, Number(ev.seconds) || 0);
    }
  });
  return { map, order };
}

// 週次集計の計画を立てる純関数。完了した週 (現在の週より前の週) で
// weekly_stats にまだ (week, feed_id) が無い分だけを集計し、
// 追記行と、間引き対象の events 行インデックス (events 配列の
// 0始まり) を返す。間引きは集計済みの週に属し、保持期間
// (EVENT_RETENTION_DAYS) を過ぎた行だけ。
function planWeeklyRollup(events, existingStats, nowIso) {
  const nowMs = Date.parse(nowIso || '') || Date.now();
  const currentWeek = weekStartKey(nowMs);
  const existingKeys = {};
  (existingStats || []).forEach((s) => {
    existingKeys[String(s.week || '') + '\n' + String(s.feed_id || '')] = true;
  });
  const completed = (events || []).filter((ev) => {
    const t = Date.parse(cellIso(ev && ev.ts) || '');
    return Number.isFinite(t) && weekStartKey(t) < currentWeek;
  });
  const aggregated = aggregateEventsByWeekFeed(completed, null);
  const rowsToAppend = [];
  const aggregatedKeys = { ...existingKeys };
  aggregated.order.forEach((key) => {
    if (existingKeys[key]) return;
    const a = aggregated.map[key];
    rowsToAppend.push([a.week, a.feed_id, a.feed_title, a.views, a.opens, a.plays, a.seconds, a.scrolls, a.expands]);
    aggregatedKeys[key] = true;
  });
  const cutoffMs = nowMs - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruneIndexes = [];
  (events || []).forEach((ev, i) => {
    const t = Date.parse(cellIso(ev && ev.ts) || '');
    if (!Number.isFinite(t) || t >= cutoffMs) return;
    const key = weekStartKey(t) + '\n' + String((ev && ev.feed_id) || '');
    if (aggregatedKeys[key]) pruneIndexes.push(i);
  });
  return { rowsToAppend, pruneIndexes, currentWeek };
}

// 週次集計と間引きを実行する。events の読みは行インデックスの対応を
// 保つため、空行を飛ばす rowsToObjects ではなく値配列から直接作る。
function rollupWeeklyEvents(nowIso) {
  const now = nowIso || new Date().toISOString();
  const ss = openDataSpreadsheet();
  const eventsSheet = ss.getSheetByName(EVENTS_SHEET_NAME);
  if (!eventsSheet) return { ok: true, appended: 0, pruned: 0 };
  const values = eventsSheet.getDataRange().getValues();
  if (values.length < 2) return { ok: true, appended: 0, pruned: 0 };
  const headers = values[0];
  const events = values.slice(1).map((row) => rowObject(headers, row));
  const stats = readSheetAsObjects(ss, WEEKLY_STATS_SHEET_NAME);
  const plan = planWeeklyRollup(events, stats, now);
  if (plan.rowsToAppend.length) {
    const statsSheet = getSheetOrCreate(ss, WEEKLY_STATS_SHEET_NAME, WEEKLY_STATS_HEADERS);
    const statsValues = statsSheet.getDataRange().getValues();
    // scrolls / expands 列の無い既存タブ (列追加前) では、追記の前に
    // ヘッダーへ遅延追加する (articles の star_override と同じ移行
    // パターン)。新規作成時は getSheetOrCreate が全列のヘッダーを
    // 入れるので何もしない。
    const statsHeaders = statsValues[0] || [];
    if (statsValues.length) {
      ['scrolls', 'expands'].forEach((name) => {
        if (statsHeaders.indexOf(name) < 0) {
          statsSheet.getRange(1, WEEKLY_STATS_HEADERS.indexOf(name) + 1).setValue(name);
        }
      });
    }
    const startRow = statsValues.length + 1;
    statsSheet.getRange(startRow, 1, plan.rowsToAppend.length, WEEKLY_STATS_HEADERS.length)
      .setValues(plan.rowsToAppend);
  }
  if (plan.pruneIndexes.length) {
    const drop = {};
    plan.pruneIndexes.forEach((i) => { drop[i] = true; });
    const remaining = [values[0]];
    for (let i = 1; i < values.length; i++) {
      if (!drop[i - 1]) remaining.push(values[i]);
    }
    replaceSheetValues(eventsSheet, remaining);
  }
  return { ok: true, appended: plan.rowsToAppend.length, pruned: plan.pruneIndexes.length };
}

// 最終実行から WEEKLY_ROLLUP_INTERVAL_MS 以上空いているときだけ
// rollupWeeklyEvents を走らせるゲート (fetchFeeds から相乗り)。
function maybeRollupWeeklyEvents(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty(WEEKLY_ROLLUP_PROP) || 0);
  if (Number.isFinite(last) && last > 0 && now - last < WEEKLY_ROLLUP_INTERVAL_MS) return false;
  rollupWeeklyEvents(new Date(now).toISOString());
  props.setProperty(WEEKLY_ROLLUP_PROP, String(now));
  return true;
}

// stats アクションの本体: weekly_stats の直近 WEEKLY_STATS_MAX_WEEKS
// 週分と、今週分 (未集計) を events からその場で集計したものを返す。
function buildStatsPayload(nowIso) {
  const now = nowIso || new Date().toISOString();
  const ss = openDataSpreadsheet();
  const stats = readSheetAsObjects(ss, WEEKLY_STATS_SHEET_NAME);
  const weeksDesc = [...new Set(stats.map((s) => String(s.week || '')).filter(Boolean))].sort().reverse();
  const keepWeeks = {};
  weeksDesc.slice(0, WEEKLY_STATS_MAX_WEEKS).forEach((w) => { keepWeeks[w] = true; });
  const normalize = (s) => ({
    week: String(s.week || ''),
    feed_id: String(s.feed_id || ''),
    feed_title: String(s.feed_title || ''),
    views: Number(s.views) || 0,
    opens: Number(s.opens) || 0,
    plays: Number(s.plays) || 0,
    seconds: Number(s.seconds) || 0,
    scrolls: Number(s.scrolls) || 0,
    expands: Number(s.expands) || 0,
  });
  const weekly = stats
    .filter((s) => keepWeeks[String(s.week || '')])
    .map(normalize)
    .sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
  const currentWeek = weekStartKey(Date.parse(now) || Date.now());
  const currentAgg = aggregateEventsByWeekFeed(readSheetAsObjects(ss, EVENTS_SHEET_NAME), currentWeek);
  const current = currentAgg.order.map((key) => currentAgg.map[key]);
  return { ok: true, weekly, currentWeek, current };
}

// --- Web App entry points ---

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const rssFeedId = e && e.parameter ? String(e.parameter.rss || '') : '';
  if (rssFeedId) {
    // 生成済み RSS 本文のキャッシュ。ヒット時はシートを読まずに
    // そのまま返す (スター変更・フィード保存/削除では無効化済み。
    // RSS_CACHE_TTL_SEC のコメント参照)。キャッシュ側の障害時は
    // 通常生成にフォールバックする。
    const cache = scriptCache();
    if (cache) {
      try {
        const hit = cache.get(rssCacheKey(rssFeedId));
        if (hit) return ContentService.createTextOutput(hit);
      } catch (err) { /* 通常生成へ */ }
    }
    const ss = openDataSpreadsheet();
    const feeds = readSheetAsObjects(ss, 'feeds');
    const feed = feeds.filter((f) => String(f.id) === rssFeedId)[0] || null;
    if (!feed || !isYouTubeFeedUrl(feed.url)) {
      return jsonOutput({ ok: false, error: 'feed_not_found' });
    }
    const allArticles = readSheetAsObjects(ss, 'articles');
    const rows = allArticles.filter((a) => String(a.feed_id) === rssFeedId);
    // enclosure は実効スターの付いた動画にだけ付ける (スター制)。
    const starredIds = computeStarredArticleIds(feeds, allArticles);
    const starredVideoIds = {};
    rows.forEach((a) => {
      if (!starredIds[String(a.id)]) return;
      const videoId = videoIdFromLink(a.link);
      if (videoId) starredVideoIds[videoId] = true;
    });
    // MIME は付けない (取得側はプロキシ経由で本文だけを読むため)。
    // YT_PLAY_TOKEN が設定されていれば enclosure は中継 URL になる。
    const ytPlayToken = scriptProperty('YT_PLAY_TOKEN');
    const xml = buildRssXml(feed, rows, fetchAudioUrlsMap(), ytPlayToken, starredVideoIds);
    if (cache) {
      try {
        if (utf8ByteLength(xml) <= CACHE_VALUE_MAX_BYTES) {
          cache.put(rssCacheKey(rssFeedId), xml, RSS_CACHE_TTL_SEC);
        }
      } catch (err) { /* 入らなければ次回も生成するだけ */ }
    }
    return ContentService.createTextOutput(xml);
  }
  return jsonOutput({ ok: true, service: 'reader-gas' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ ok: false, error: 'bad_request' });
  }
  try {
    const action = String(body.action || '');
    if (action === 'exchange_session') {
      const identity = verifyIdToken(body.idToken);
      if (!identity) return jsonOutput({ ok: false, error: 'unauthorized' });
      const issued = issueSession('owner');
      return jsonOutput({ ok: true, sessionToken: issued.sessionToken, expiresAt: issued.expiresAt, role: 'owner' });
    }
    if (action === 'exchange_share') {
      if (!validateShareToken(body.shareToken)) return jsonOutput({ ok: false, error: 'unauthorized' });
      const issued = issueSession('readonly');
      return jsonOutput({ ok: true, sessionToken: issued.sessionToken, expiresAt: issued.expiresAt, role: 'readonly', readonly: true });
    }
    const sessionToken = body.sessionToken || body.session_token || '';
    const session = validateSession(sessionToken);
    if (!session) return jsonOutput({ ok: false, error: 'unauthorized' });
    // オーナー専用アクション (readonly セッションは一律 forbidden)。
    const ownerActions = {
      listFeeds: () => buildListFeedsPayload(),
      saveFeed: () => handleSaveFeed(body),
      deleteFeed: () => handleDeleteFeed(body),
      reorderFeeds: () => handleReorderFeeds(body),
      issueShareLink: () => issueShareLink(),
      getShareLinkStatus: () => getShareLinkStatus(),
      revokeShareLink: () => revokeShareLink(),
      set_star: () => handleSetStar(body),
      log_events: () => handleLogEvents(body),
      stats: () => buildStatsPayload(),
    };
    if (Object.prototype.hasOwnProperty.call(ownerActions, action)) {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(ownerActions[action]());
    }
    if (action === 'list') {
      return jsonOutput(buildListPayload(body));
    }
    return jsonOutput({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String((err && err.message) || err) });
  }
}
export { rowsToObjects, articleId, feedIdFromUrl, sha256Hex, sha256HexPure, stripTags, summarize, decodeXmlEntities, toIsoDate, isTruthy, isAllowedIdTokenPayload, verifyIdToken, hashesEqual, isSessionExpired, prunePlan, filterArticles, buildListPayload, selectFetchTargets, youtubeChannelIdFromUrl, youtubeFeedUrlFromChannelId, youtubePlaylistIdFromUrl, youtubeFeedUrlFromPlaylistId, parseYouTubeChannelUrl, youtubeUploadsPlaylistId, parseYouTubePlaylistItems, parseYouTubeNextPageToken, parseYouTubeChannelTitle, parseYouTubePlaylistTitle, parseYouTubeDurations, parseChannelLookupResponse, lookupYouTubeChannelByHandle, youtubeApiErrorDetail, parseAudioUrlsMap, utf8ByteLength, scriptCache, rssCacheKey, invalidateRssCache, getAudioUrlsMapFromCache, putAudioUrlsMapCache, scriptBaseUrl, fetchAudioUrlsMap, ytPlayUrl, planYouTubeAudioTriggers, computeStarredArticleIds, planStarredAudioTriggers, fireYouTubeAudioTriggers, escapeXml, videoIdFromLink, toRfc822, buildRssXml, buildFetchUrl, parseFeedUrl, validateFeedInput, buildFeedRow, feedRowValues, feedToApiShape, countUnreadByFeed, remainingRowsAfterDelete, reorderRowsByIds, validateFeedOrder, groupRowsByCategory, regroupFeedsByCategory, appendNewEntries, parseYouTubeSubscriptionsPage, fetchMyYouTubeSubscriptions, planYouTubeSubscriptionSync, syncYouTubeSubscriptions, planPlaylistArticleDeletions, fetchFeeds, issueSession, validateSession, validateShareToken, shareLinkStatus, issueShareLink, getShareLinkStatus, revokeShareLink, handleSaveFeed, handleDeleteFeed, handleSetStar, weekStartKey, sanitizeEvent, sanitizeEventBatch, handleLogEvents, aggregateEventsByWeekFeed, planWeeklyRollup, rollupWeeklyEvents, maybeRollupWeeklyEvents, buildStatsPayload, doGet, doPost };
