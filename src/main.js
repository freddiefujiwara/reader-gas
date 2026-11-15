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
// YouTube の保存形はチャンネルページ URL (/channel/UC...) に統一する。
// /@handle 形で登録されても保存時に正規形へ寄せる
// (handleSaveFeed)。ハンドルは channels.list の forHandle で解決し、
// タイトルも補完する。既存行の videos.xml 形は移行済みで、互換は持たない。

const ALLOWED_EMAIL = 'zegenvs@gmail.com';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const OWNER_SHEET_NAME = 'owner_sessions';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TOKEN_HASH_PROP = 'SHARE_TOKEN_HASH';
const SHARE_EXPIRES_AT_PROP = 'SHARE_EXPIRES_AT';
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_HEADERS = ['token_hash', 'issued_at', 'expires_at', 'revoked_at', 'access_count', 'last_accessed_at', 'role'];
const FEEDS_HEADERS = ['id', 'title', 'url', 'category', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
const ARTICLES_HEADERS = ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'];
const RETENTION_DAYS = 60;
const MAX_ARTICLES = 5000;
const SUMMARY_MAX_CHARS = 500;

// --- Sheets helpers (xuexi-gas と同型) ---

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.every((c) => c === '' || c === null || c === undefined)) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] === undefined ? '' : row[idx];
    });
    out.push(obj);
  }
  return out;
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
  if (value instanceof Date) return value.toISOString();
  return String(value);
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

function decodeXmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  // Decode first so escaped markup (&lt;p&gt;...) is stripped as markup too,
  // then strip real tags. Plain-text entities survive the tag pass.
  const decoded = decodeXmlEntities(String(html || ''));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function summarize(html, maxChars) {
  const limit = maxChars || SUMMARY_MAX_CHARS;
  const text = stripTags(html);
  return text.length > limit ? text.slice(0, limit) : text;
}

function toIsoDate(value) {
  if (!value) return '';
  const t = Date.parse(String(value).trim());
  if (!t && t !== 0) return '';
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

// playlistItems の応答 JSON をエントリ配列へ正規化する。
// 削除・非公開動画 (タイトルが Deleted video / Private video) は取り込まない。
function parseYouTubePlaylistItems(jsonText, feed) {
  const feedId = feed && feed.id ? String(feed.id) : '';
  let data;
  try { data = JSON.parse(String(jsonText || '')); } catch (e) { return []; }
  const items = data && Array.isArray(data.items) ? data.items : [];
  const entries = [];
  items.forEach((item) => {
    const sn = (item && item.snippet) || {};
    const videoId = sn.resourceId && sn.resourceId.videoId ? String(sn.resourceId.videoId) : '';
    const title = String(sn.title || '').trim();
    if (!videoId || !title || title === 'Deleted video' || title === 'Private video') return;
    entries.push({
      guid: videoId,
      title,
      link: 'https://www.youtube.com/watch?v=' + videoId,
      publishedAt: toIsoDate(sn.publishedAt),
      summary: summarize(sn.description || ''),
      author: String(sn.channelTitle || '').trim(),
      feedId,
    });
  });
  return entries;
}

// channels.list の応答からチャンネル名を取り出す。タイトル未設定の
// YouTube フィード (登録時に空で入る) の補完に使う。取れなければ空文字。
function parseYouTubeChannelTitle(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText || '')); } catch (e) { return ''; }
  const items = data && Array.isArray(data.items) ? data.items : [];
  const sn = (items[0] && items[0].snippet) || {};
  return String(sn.title || '').trim();
}

// channels.list の応答から { channelId, title } を取り出す (登録時の
// ハンドル解決用)。先頭の item の id と snippet.title を使い、
// item が無い・id が無い・JSON が壊れている場合は null。
function parseChannelLookupResponse(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText || '')); } catch (e) { return null; }
  const items = data && Array.isArray(data.items) ? data.items : [];
  const first = items[0] || null;
  const channelId = first ? String(first.id || '').trim() : '';
  if (!channelId) return null;
  const sn = (first && first.snippet) || {};
  return { channelId, title: String(sn.title || '').trim() };
}

// ハンドルから channels.list?forHandle= でチャンネルを引く (登録時専用)。
// APIキーが無い・HTTPエラー・該当なし・例外はすべて null (解決失敗) とする。
// handleSaveFeed からは差し替え可能な resolver として呼ばれる。
function lookupYouTubeChannelByHandle(handle) {
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
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

// --- YouTube 音声ストリーム URL の配布 (ogp 方式) ---
// 音声ファイルはどこにも置かない。reader-gas が毎時巡回で yt-audio
// トリガー (後述) を叩くと、ze 側のバッチがストリーム URL を非同期に
// 抽出し、a.ze.gs/audio-urls.json に videoId -> { url, ts, dur } の形で
// 公開する (dur は実尺・秒で、エントリによっては無い)。?rss= の出力では
// この JSON を読み、抽出から5時間以内のエントリがあるアイテムにだけ、
// その URL を enclosure として付ける (ストリーム URL は短命なので、
// 古いエントリには付けない)。中継の合言葉 (YT_PLAY_TOKEN) があれば
// enclosure は中継 URL になる (ytPlayUrl のコメント参照)。dur が
// あれば itunes:duration としても付ける (理由は buildRssXml の
// コメント参照)。

const AUDIO_URLS_JSON_URL = 'https://a.ze.gs/audio-urls.json';
const AUDIO_URL_FRESH_MS = 5 * 60 * 60 * 1000;

// audio-urls.json の本文を videoId -> { url, ts, dur? } のマップとして
// 読む (純関数)。JSON でない・オブジェクトでない場合は空マップにする。
// 値の形が想定と違うエントリは落とす。ts は抽出時刻 (epoch 秒)。
// dur は実尺 (秒) で、正の数値として読めるときだけ保持する
// (読めないエントリも enclosure 自体は従来どおり付ける)。
function parseAudioUrlsMap(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText || '')); } catch (e) { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const map = {};
  Object.keys(data).forEach((videoId) => {
    const entry = data[videoId];
    if (!entry || typeof entry !== 'object') return;
    const url = String(entry.url || '');
    const ts = Number(entry.ts);
    if (!url || !Number.isFinite(ts)) return;
    const parsed = { url, ts };
    const dur = Number(entry.dur);
    if (Number.isFinite(dur) && dur > 0) parsed.dur = dur;
    map[videoId] = parsed;
  });
  return map;
}

// 実行内だけの簡易キャッシュ (GAS の実行ごとにリセットされる)。
// 取得に成功したときだけ保持し、失敗時は毎回引き直す。
let audioUrlsMapCache = null;

// a.ze.gs/audio-urls.json を取得する。失敗 (HTTPエラー・例外・
// UrlFetchApp 自体が無い環境) はすべて空マップとして扱い、
// RSS 出力自体は enclosure 無しで続ける。
function fetchAudioUrlsMap() {
  if (audioUrlsMapCache) return audioUrlsMapCache;
  try {
    const res = UrlFetchApp.fetch(AUDIO_URLS_JSON_URL, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return {};
    audioUrlsMapCache = parseAudioUrlsMap(res.getContentText());
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
  if (now - entry.ts * 1000 > AUDIO_URL_FRESH_MS) return null;
  if (!String(entry.url || '')) return null;
  return entry;
}

// --- YouTube 音声の中継 URL (yt-play) ---
// 抽出済みストリーム URL (googlevideo) は通常の GET が約31KB/秒まで
// 絞られるため、長編動画では再生開始まで約40秒かかる問題がある。
// その対策として ze には中継 (yt-play) があり、Range 取得で
// ストリームを引き直してそのまま流す (ファイルは置かない)。
// スクリプトプロパティ YT_PLAY_TOKEN (中継の合言葉) が設定されて
// いれば、?rss= の enclosure は直接 URL ではなく中継 URL
// (https://y.ze.gs/<token>/<videoId>) にする。中継側も
// audio-urls.json の鮮度をもとに実 URL を解決する前提のため、
// enclosure を付ける条件 (抽出から5時間以内のエントリがあること)
// は従来どおり。プロパティ未設定・空なら従来の直接 URL のまま。

const YT_PLAY_BASE_URL = 'https://y.ze.gs/';

// 中継 URL の組み立て (純関数)。token が空、または videoId が
// 無ければ空文字 (= 中継しない) を返す。
function ytPlayUrl(token, videoId) {
  const t = String(token || '').trim();
  const id = String(videoId || '');
  if (!t || !id) return '';
  return YT_PLAY_BASE_URL + encodeURIComponent(t) + '/' + encodeURIComponent(id);
}

// --- YouTube RSS 出力 (v2: 取得をクライアントへ寄せるための出口) ---
// YouTube フィードの記事を RSS 2.0 で返す。クライアントはこの URL を
// 通常のフィード URL と同じ経路で取得する (YouTube 専用の形式は作らない)。
// guid は動画IDにし、記事IDの互換 (feed_id + guid) を保つ。

function escapeXml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function videoIdFromLink(link) {
  const m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(String(link || ''));
  return m ? m[1] : '';
}

function toRfc822(isoString) {
  const t = Date.parse(cellIso(isoString) || String(isoString || ''));
  if (Number.isNaN(t)) return '';
  return new Date(t).toUTCString();
}

const RSS_MAX_ITEMS = 50;

// articleRows は articles タブの行オブジェクト (ARTICLES_HEADERS のキー)。
// published_at (無ければ fetched_at) の新しい順に最大 RSS_MAX_ITEMS 件。
// audioUrls は audio-urls.json のマップ (videoId -> { url, ts, dur? })。
// 省略時・該当エントリが古い/無いアイテムには enclosure を付けない。
// ytPlayToken (中継の合言葉) があれば、enclosure の URL は直接の
// ストリーム URL ではなく中継 URL になる (ytPlayUrl 参照)。
function buildRssXml(feed, articleRows, audioUrls, ytPlayToken) {
  const f = feed || {};
  const title = String(f.title || '');
  const channelId = youtubeChannelIdFromUrl(f.url);
  const sorted = (articleRows || []).slice().sort((a, b) => {
    const ta = Date.parse(cellIso(a.published_at) || cellIso(a.fetched_at) || '') || 0;
    const tb = Date.parse(cellIso(b.published_at) || cellIso(b.fetched_at) || '') || 0;
    return tb - ta;
  }).slice(0, RSS_MAX_ITEMS);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    '  <channel>',
    '    <title>' + escapeXml(title) + '</title>',
    '    <link>' + escapeXml('https://www.youtube.com/channel/' + channelId) + '</link>',
    '    <description>' + escapeXml(title) + '</description>',
  ];
  sorted.forEach((a) => {
    const link = String(a.link || '');
    const videoId = videoIdFromLink(link);
    const pubDate = toRfc822(cellIso(a.published_at) || cellIso(a.fetched_at));
    lines.push('    <item>');
    lines.push('      <title>' + escapeXml(a.title) + '</title>');
    lines.push('      <link>' + escapeXml(link) + '</link>');
    lines.push('      <guid isPermaLink="false">' + escapeXml(videoId) + '</guid>');
    // 音声ストリーム URL の enclosure。新鮮なエントリがあるときだけ付ける。
    // 中継の合言葉があれば、直接 URL ではなく中継 URL を出す。
    const audioEntry = freshAudioEntry(audioUrls, videoId);
    const directUrl = audioEntry ? String(audioEntry.url || '') : '';
    const audioUrl = (directUrl && ytPlayUrl(ytPlayToken, videoId)) || directUrl;
    if (audioUrl) {
      lines.push('      <enclosure url="' + escapeXml(audioUrl) + '" type="audio/x-m4a" length="0"/>');
      // 実尺の passthrough: このストリームは断片化 MP4 (fMP4) で、長さ
      // 情報が init セグメントと断片の両方に入るため、プレイヤー
      // (特に iOS) が長さを二重に数えて実尺のちょうど2倍を表示して
      // しまう。エントリに実尺 (dur・秒) があれば整数秒に丸めて
      // itunes:duration として付け、クライアントが表示・シークの
      // 正として使えるようにする。dur の無いエントリには付けない。
      const dur = Number(audioEntry.dur);
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
  const sorted = (articles || []).slice().sort((a, b) => {
    const ta = Date.parse(cellIso(a.published_at) || cellIso(a.fetched_at) || '') || 0;
    const tb = Date.parse(cellIso(b.published_at) || cellIso(b.fetched_at) || '') || 0;
    return tb - ta;
  });
  const keepRank = {};
  sorted.forEach((a, idx) => { keepRank[a.id] = idx < maxArticles; });
  const deleteArticleIds = [];
  sorted.forEach((a) => {
    // 経過日数は「取り込んだ日」から数える (公開日が古い動画などを
    // 取り込んだ瞬間に消してしまわないため)。
    const t = Date.parse(cellIso(a.fetched_at) || cellIso(a.published_at) || '') || 0;
    const tooOld = t > 0 && now - t > retentionMs;
    const beyondCap = !keepRank[a.id];
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
  const remaining = [values[0]];
  if (!ids || !ids.length) {
    for (let i = 1; i < values.length; i++) remaining.push(values[i]);
    return remaining;
  }
  const target = {};
  ids.forEach((id) => { target[String(id)] = true; });
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
  sheet.clearContents();
  sheet.getRange(1, 1, remaining.length, remaining[0].length).setValues(remaining);
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

// --- Auth (tweet-gas pattern, simplified for reader) ---

function isAllowedIdTokenPayload(json, clientId) {
  if (!json) return false;
  const verified = json.email_verified === true || json.email_verified === 'true';
  if (!verified) return false;
  if (json.email !== ALLOWED_EMAIL) return false;
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
  const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
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
  const hash = sha256Hex(String(token));
  const nowIso = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!hashesEqual(row[hashIdx], hash)) continue;
    const expiresAt = cellIso(row[expIdx]);
    if (isSessionExpired(expiresAt, nowIso)) return null;
    const accessIdx = headers.indexOf('access_count');
    const lastIdx = headers.indexOf('last_accessed_at');
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
function appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt) {
  let added = 0;
  (entries || []).forEach((entry) => {
    const id = articleId(feed.id, entry.guid || entry.link);
    if (existingIds[id]) return;
    existingIds[id] = true;
    articlesSheet.appendRow([id, feed.id, entry.title, entry.link, entry.publishedAt, fetchedAt, entry.summary, entry.author]);
    added++;
  });
  return added;
}

// サーバー側で巡回する対象を選ぶ。v2 では RSS フィードの巡回は
// クライアント側で行うため、対象は YouTube フィードだけになる。
// 非 YouTube フィードは行の更新も含めて一切触らない。
// 有効/無効の概念は廃止したため、対象は YouTube フィードかどうかだけで決まる。
function selectFetchTargets(feeds) {
  return (feeds || []).filter((f) => f && f.id && f.url && youtubeChannelIdFromUrl(f.url));
}

// --- YouTube 音声抽出トリガー (ze 連携) ---
// ogp のフォールバックと同じ形: reader-gas が a.ze.gs の altd コマンド
// yt-audio を叩くと ze 側のキューに積まれ、ze のバッチが音声ストリーム
// URL を抽出して audio-urls.json として公開する (非同期)。
// ?rss= はその JSON の新鮮なエントリを enclosure として配信する。
// 発火対象は各 YouTube フィードの「公開から30日以内」の動画のうち
// 最新3本で、新着かどうかは問わない (ze 側が抽出済みのものは
// 重複排除するため、毎時叩き直しても安い)。更新の止まった
// チャンネルは最新動画でも30日を超えていれば何も発火しない。
// 例外は2種類ある:
// - YT_AUDIO_ALWAYS_CHANNEL_ID のチャンネルは、30日制限も最新3本の
//   上限も付けず、取得できた動画を毎時すべて依頼し直して常時再生
//   可能な状態を保つ (下の定数のコメント参照)。
// - ジャンルが「音楽」 (YT_AUDIO_TRIGGER_MUSIC_CATEGORY) のフィードは、
//   30日制限を付けず、新しい順に最新20本までを対象にする。音楽は
//   更新頻度が低くても過去分を再生したいため (本人の決定)。
//   20本は YouTube の1回の取得上限 (最新20本) と揃えた値。
// 失敗しても巡回自体は失敗にしない (fire-and-forget)。

const YT_AUDIO_TRIGGER_BASE_URL = 'https://a.ze.gs/yt-audio/';
const YT_AUDIO_TRIGGER_PER_FEED = 3;
// 音楽ジャンルの特別扱い: このジャンルのフィードだけ、期間の縛りを
// 外して新しい順に YT_AUDIO_TRIGGER_MUSIC_PER_FEED 本まで選ぶ。
const YT_AUDIO_TRIGGER_MUSIC_CATEGORY = '音楽';
const YT_AUDIO_TRIGGER_MUSIC_PER_FEED = 20;
// 全体キャップ。通常分 (最大23フィード×3本=69) と常時対応分
// (最大20本) の合計89本に余裕を持たせた値。音楽フィードの枠が
// 増えた分だけ合計が100を超える場合は、従来どおりフィード順の
// 先頭から100件で打ち切る (後ろのフィードから省かれる)。
const YT_AUDIO_TRIGGER_MAX_PER_RUN = 100;
const YT_AUDIO_TRIGGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// 常時対応チャンネル (本人のチャンネル「藤原史和 川口を歩くQAエンジニア」)。
// reader-gas が毎時、このチャンネルの動画をすべて yt-audio のキューへ
// 入れ直し、ze 側のバッチは URL が4時間を超えたエントリを取り直す。
// そのため、このチャンネルの音声 URL は失効前に更新され続け、
// 常に新鮮な enclosure が付く (= 常に再生可能)。ze 側の変更は不要。
const YT_AUDIO_ALWAYS_CHANNEL_ID = 'UCbiDZXbr391oT_vsRiqwPFg';

// 発火対象を選ぶ純関数: フィードごとに、まず公開日時が読めて
// 30日以内 (ちょうど30日前を含む) の動画だけに絞り、その中で
// 新しい順に最大 YT_AUDIO_TRIGGER_PER_FEED 本を選び、動画IDで
// 重複を除いて並べる。公開日時が読めない動画は安全側で対象外。
// 例外は2種類:
// - 常時対応チャンネル (YT_AUDIO_ALWAYS_CHANNEL_ID) のフィードは、
//   公開日時や件数に関係なく、動画IDのある全件を選ぶ
//   (公開日時が読めない動画も対象。常時再生可能を保つため)。
// - 音楽ジャンル (YT_AUDIO_TRIGGER_MUSIC_CATEGORY) のフィードは、
//   期間では絞らず (公開日時が読めない動画は最も古いものとして
//   並べる)、新しい順に最大 YT_AUDIO_TRIGGER_MUSIC_PER_FEED 本を選ぶ。
// 上限件数の適用は発火側 (fireYouTubeAudioTriggers) で行う。
// nowMs はテスト用の差し込み口 (省略時は現在時刻)。
// feedVideos はフィードごとの { videoId, publishedAt, channelId,
// category } の配列の配列 (channelId は常時対応チャンネルの判定用、
// category は音楽ジャンルの判定用)。
function planYouTubeAudioTriggers(feedVideos, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const seen = {};
  const ids = [];
  (feedVideos || []).forEach((videos) => {
    const list = videos || [];
    if (list.some((v) => v && v.channelId === YT_AUDIO_ALWAYS_CHANNEL_ID)) {
      // 常時対応チャンネル: 取得できた順 (新しい順) に全件を選ぶ。
      list.forEach((v) => {
        const videoId = String((v && v.videoId) || '');
        if (!videoId || seen[videoId]) return;
        seen[videoId] = true;
        ids.push(videoId);
      });
      return;
    }
    const isMusic = list.some((v) => v && v.category === YT_AUDIO_TRIGGER_MUSIC_CATEGORY);
    const candidates = list.filter((v) => {
      // 動画IDの無いものは件数上限の枠も使わないよう、最初に除く。
      if (!v || !String(v.videoId || '')) return false;
      // 音楽ジャンルは期間の縛りなし (30日より古い動画も対象)。
      if (isMusic) return true;
      const ts = Date.parse(v.publishedAt || '');
      return !isNaN(ts) && now - ts <= YT_AUDIO_TRIGGER_MAX_AGE_MS;
    });
    const sorted = candidates.slice().sort((a, b) => {
      const tb = Date.parse((b && b.publishedAt) || '') || 0;
      const ta = Date.parse((a && a.publishedAt) || '') || 0;
      return tb - ta;
    });
    const perFeed = isMusic ? YT_AUDIO_TRIGGER_MUSIC_PER_FEED : YT_AUDIO_TRIGGER_PER_FEED;
    sorted.slice(0, perFeed).forEach((v) => {
      const videoId = String((v && v.videoId) || '');
      if (!videoId || seen[videoId]) return;
      seen[videoId] = true;
      ids.push(videoId);
    });
  });
  return ids;
}

// 実際のトリガー発火 (1件分)。応答は待たない (muteHttpExceptions)。
function fireYouTubeAudioTrigger(videoId, token) {
  UrlFetchApp.fetch(YT_AUDIO_TRIGGER_BASE_URL + encodeURIComponent(String(videoId || '')), {
    method: 'get',
    headers: { 'X-Api-Token': String(token || '') },
    muteHttpExceptions: true,
  });
}

// 発火対象ぶんのトリガーをまとめて発火し、発火件数を返す。
// A_ZE_GS_TOKEN が未設定なら何もしない (エラーにもしない)。
// 1回の巡回では最大 YT_AUDIO_TRIGGER_MAX_PER_RUN 件までとし、
// 残りはログに残して省く。fireTrigger はテスト用の差し込み口
// (省略時は fireYouTubeAudioTrigger)。時間ベーストリガーから呼ばれる
// fetchFeeds 経由ではイベントオブジェクトが渡ってくるため、関数で
// なければ既定実装に落とす。nowMs は30日判定用のテスト差し込み口。
function fireYouTubeAudioTriggers(feedVideos, fireTrigger, nowMs) {
  const token = PropertiesService.getScriptProperties().getProperty('A_ZE_GS_TOKEN');
  if (!token) return 0;
  const fire = typeof fireTrigger === 'function' ? fireTrigger : fireYouTubeAudioTrigger;
  const planned = planYouTubeAudioTriggers(feedVideos, nowMs);
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
  for (let i = 1; i < feedValues.length; i++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = feedValues[i][idx]; });
    if (obj.id) rowNumById[obj.id] = i + 1;
  }
  const youtubeFeeds = selectFetchTargets(feeds);
  const existingIds = {};
  readSheetAsObjects(ss, 'articles').forEach((a) => { existingIds[a.id] = true; });
  const fetchedAt = new Date().toISOString();
  let addedTotal = 0;
  // フィードごとの動画一覧 (音声抽出トリガーの発火対象の選定用)。
  const feedVideos = [];
  // YouTube フィードは公式APIから取り込む (RSS は 404 のため)。
  const youtubeApiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  youtubeFeeds.forEach((feed) => {
    const rowNum = rowNumById[feed.id];
    try {
      if (!youtubeApiKey) throw new Error('YOUTUBE_API_KEY is not set');
      // タイトル未設定なら channels.list でチャンネル名を補完する
      // (YouTube フィードは登録時にタイトルを自動取得できないため空で入る)。
      // 補完の失敗は巡回自体の失敗にせず、タイトルは空のまま続ける。
      if (!String(feed.title || '').trim()) {
        try {
          const channelUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet'
            + '&id=' + encodeURIComponent(youtubeChannelIdFromUrl(feed.url))
            + '&key=' + encodeURIComponent(youtubeApiKey);
          const channelRes = UrlFetchApp.fetch(channelUrl, { method: 'get', muteHttpExceptions: true });
          if (channelRes.getResponseCode() === 200) {
            const channelTitle = parseYouTubeChannelTitle(channelRes.getContentText());
            if (channelTitle) {
              updateFeedRow(feedsSheet, headers, rowNum, { title: channelTitle });
              feed.title = channelTitle;
            }
          }
        } catch (titleErr) {
          // 補完できなくても記事の取り込みは続ける。
        }
      }
      const playlistId = youtubeUploadsPlaylistId(youtubeChannelIdFromUrl(feed.url));
      const apiUrl = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20'
        + '&playlistId=' + encodeURIComponent(playlistId)
        + '&key=' + encodeURIComponent(youtubeApiKey);
      const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code !== 200) throw new Error('YouTube API HTTP ' + code + youtubeApiErrorDetail(res.getContentText()));
      const entries = parseYouTubePlaylistItems(res.getContentText(), feed);
      addedTotal += appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt);
      feedVideos.push(entries.map((entry) => ({
        videoId: String(entry.guid || '') || videoIdFromLink(entry.link),
        publishedAt: entry.publishedAt || '',
        channelId: youtubeChannelIdFromUrl(feed.url),
        // 音楽ジャンルの特別扱いの判定用にフィードのジャンルも渡す。
        category: String(feed.category || ''),
      })).filter((v) => v.videoId));
      updateFeedRow(feedsSheet, headers, rowNum, { last_fetched_at: fetchedAt, last_status: '200', last_error: '' });
    } catch (err) {
      updateFeedRow(feedsSheet, headers, rowNum, {
        last_fetched_at: fetchedAt,
        last_status: 'error',
        last_error: String((err && err.message) || err).slice(0, 500),
      });
    }
  });
  // 各フィードの公開30日以内の最新3本 (音楽ジャンルは期間なしの
  // 最新20本、常時対応チャンネルは全件) の音声抽出を ze へ依頼する
  // (記事の保存が済んでから発火する)。
  // トリガーの成否は巡回結果に影響させない。
  try {
    fireYouTubeAudioTriggers(feedVideos, fireTrigger);
  } catch (e) {
    // 依頼できなくても記事の取り込みは成功として扱う。
  }
  pruneArticles();
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
  out.sort((a, b) => {
    const ta = Date.parse(a.publishedAt || a.fetchedAt || '') || 0;
    const tb = Date.parse(b.publishedAt || b.fetchedAt || '') || 0;
    return tb - ta;
  });
  return out;
}

function buildListPayload(body) {
  const ss = openDataSpreadsheet();
  const feeds = readSheetAsObjects(ss, 'feeds');
  const feedById = {};
  feeds.forEach((f) => { feedById[f.id] = f; });
  const merged = readSheetAsObjects(ss, 'articles').map((a) => {
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
    };
  });
  const unreadByFeed = {};
  merged.forEach((a) => {
    if (!a.isRead) unreadByFeed[a.feedId] = (unreadByFeed[a.feedId] || 0) + 1;
  });
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
  const title = String(input.title === undefined || input.title === null ? '' : input.title).trim();
  if (!title && !youtubeChannelIdFromUrl(parsed.url)) return { ok: false, message: 'title is required' };
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

// クライアントが実際に取得する URL。YouTube フィードは reader-gas の RSS
// 出力 (?rss=<feedId>) を指し、それ以外はフィードの URL そのまま。
function buildFetchUrl(feed, serviceUrl) {
  const f = feed || {};
  const url = String(f.url || '');
  const id = String(f.id || '');
  const base = String(serviceUrl || '');
  if (id && base && youtubeChannelIdFromUrl(url)) {
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
    if (channelRef && channelRef.kind === 'handle') {
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
  const result = validateFeedInput(input);
  if (!result.ok) return { ok: false, error: 'invalid', message: result.message };
  const feed = result.feed;
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0] : FEEDS_HEADERS;
  const idIdx = headers.indexOf('id');
  const urlIdx = headers.indexOf('url');
  const rowAt = (i) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[i][idx]; });
    return obj;
  };
  let existing = null;
  let rowNum = -1;
  // 1) id の指定があり、その行があればその行を更新する (管理画面の編集経路。
  //    移行前の slug ID の行もそのまま扱う)。
  if (feed.id && idIdx >= 0) {
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIdx]) === feed.id) { existing = rowAt(i); rowNum = i + 1; break; }
    }
  }
  // 2) 同じ URL の行があれば、その行の更新として扱う (再追加の冪等化)。
  //    行の ID は維持する。
  if (!existing && urlIdx >= 0) {
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][urlIdx]) === feed.url) { existing = rowAt(i); rowNum = i + 1; break; }
    }
  }
  // 2b) YouTube は、入力形が違っても (/@handle で登録 → 保存形で保存済み等)
  //     チャンネルIDが一致すれば同じ行の更新として扱う (クロスフォームな
  //     重複を作らないため)。行の ID は維持し、URL は正規形へ書き換わる。
  if (!existing && urlIdx >= 0) {
    const feedChannelId = youtubeChannelIdFromUrl(feed.url);
    if (feedChannelId) {
      for (let i = 1; i < values.length; i++) {
        if (youtubeChannelIdFromUrl(values[i][urlIdx]) === feedChannelId) { existing = rowAt(i); rowNum = i + 1; break; }
      }
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
    if (idIdx >= 0) {
      for (let i = 1; i < values.length; i++) {
        if (String(values[i][idIdx]) === feed.id) {
          return { ok: false, error: 'conflict', message: 'feed id collision for url: ' + feed.url };
        }
      }
    }
  }
  const rowObj = buildFeedRow(feed, existing);
  const rowValues = feedRowValues(rowObj, headers);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, headers.length).setValues([rowValues]);
  else sheet.appendRow(rowValues);
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
  let rowNum = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idIdx]) === feedId) { rowNum = i + 1; break; }
  }
  if (rowNum < 0) return { ok: false, error: 'not_found' };
  deleteRowsById(ss, 'articles', 'feed_id', [feedId]);
  sheet.deleteRow(rowNum);
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
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    if (reordered[i] !== values[i]) { changed = true; break; }
  }
  if (changed) {
    sheet.clearContents();
    sheet.getRange(1, 1, reordered.length, reordered[0].length).setValues(reordered);
  }
  return { ok: true };
}

// --- Web App entry points ---

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const rssFeedId = e && e.parameter ? String(e.parameter.rss || '') : '';
  if (rssFeedId) {
    const ss = openDataSpreadsheet();
    const feed = readSheetAsObjects(ss, 'feeds').filter((f) => String(f.id) === rssFeedId)[0] || null;
    if (!feed || !youtubeChannelIdFromUrl(feed.url)) {
      return jsonOutput({ ok: false, error: 'feed_not_found' });
    }
    const rows = readSheetAsObjects(ss, 'articles').filter((a) => String(a.feed_id) === rssFeedId);
    // MIME は付けない (取得側はプロキシ経由で本文だけを読むため)。
    // YT_PLAY_TOKEN が設定されていれば enclosure は中継 URL になる。
    const ytPlayToken = PropertiesService.getScriptProperties().getProperty('YT_PLAY_TOKEN');
    return ContentService.createTextOutput(buildRssXml(feed, rows, fetchAudioUrlsMap(), ytPlayToken));
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
    if (action === 'listFeeds') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(buildListFeedsPayload());
    }
    if (action === 'saveFeed') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(handleSaveFeed(body));
    }
    if (action === 'deleteFeed') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(handleDeleteFeed(body));
    }
    if (action === 'reorderFeeds') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(handleReorderFeeds(body));
    }
    if (action === 'issueShareLink') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(issueShareLink());
    }
    if (action === 'getShareLinkStatus') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(getShareLinkStatus());
    }
    if (action === 'revokeShareLink') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(revokeShareLink());
    }
    if (action === 'list') {
      return jsonOutput(buildListPayload(body));
    }
    return jsonOutput({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String((err && err.message) || err) });
  }
}
export { rowsToObjects, articleId, feedIdFromUrl, sha256Hex, sha256HexPure, stripTags, summarize, decodeXmlEntities, toIsoDate, isTruthy, isAllowedIdTokenPayload, hashesEqual, isSessionExpired, prunePlan, filterArticles, buildListPayload, selectFetchTargets, youtubeChannelIdFromUrl, youtubeFeedUrlFromChannelId, parseYouTubeChannelUrl, youtubeUploadsPlaylistId, parseYouTubePlaylistItems, parseYouTubeChannelTitle, parseChannelLookupResponse, lookupYouTubeChannelByHandle, youtubeApiErrorDetail, parseAudioUrlsMap, fetchAudioUrlsMap, ytPlayUrl, planYouTubeAudioTriggers, fireYouTubeAudioTriggers, escapeXml, videoIdFromLink, toRfc822, buildRssXml, buildFetchUrl, parseFeedUrl, validateFeedInput, buildFeedRow, feedRowValues, feedToApiShape, countUnreadByFeed, remainingRowsAfterDelete, reorderRowsByIds, validateFeedOrder, appendNewEntries, parseYouTubeSubscriptionsPage, fetchMyYouTubeSubscriptions, planYouTubeSubscriptionSync, syncYouTubeSubscriptions, fetchFeeds, issueSession, validateSession, validateShareToken, shareLinkStatus, issueShareLink, getShareLinkStatus, revokeShareLink, handleSaveFeed, handleDeleteFeed, doGet, doPost };
