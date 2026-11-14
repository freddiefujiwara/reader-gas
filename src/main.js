// reader-gas: Web版RSSリーダー /reader のバックエンドAPI (Google Apps Script)。
// 正本は Google Sheets (feeds / articles / states / owner_sessions の4タブ)。
// スプレッドシートIDはスクリプトプロパティ SPREADSHEET_ID から読む (コードに直書きしない)。
// 毎時トリガー fetchFeeds が18フィードを巡回して articles へ追記し、
// フロントは doPost の list / mark / markAllRead で既読・スターを同期する。
// フィード管理 (listFeeds / saveFeed / deleteFeed / reorderFeeds) はオーナー専用とし、
// is_private は URL のホストが a.ze.gs のときだけ立てる (トークン漏洩防止)。
// 認証は tweet-gas と同型: Google IDトークンをサーバー側で検証し、
// オーナー本人 (ALLOWED_EMAIL) にだけ30日セッションを発行する。
// セッションは owner_sessions タブにトークンの SHA-256 ハッシュだけを保存し、
// 複数端末の同時セッションを妨げない。
// 一時アクセスリンク (share) は読み取り専用: exchange_share で検証し、
// role=readonly のセッションを発行する。mark 系は readonly を拒否する。
// 自前フィード (is_private) の取得トークンはスクリプトプロパティ
// A_ZE_GS_TOKEN を X-Api-Token ヘッダーで送るだけにし、シートにもコードにも書かない。

const ALLOWED_EMAIL = 'zegenvs@gmail.com';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const OWNER_SHEET_NAME = 'owner_sessions';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_HEADERS = ['token_hash', 'issued_at', 'expires_at', 'revoked_at', 'access_count', 'last_accessed_at', 'role'];
const FEEDS_HEADERS = ['id', 'title', 'url', 'category', 'enabled', 'is_private', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
const ARTICLES_HEADERS = ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'];
const STATES_HEADERS = ['article_id', 'is_read', 'is_starred', 'read_at', 'starred_at', 'updated_at'];
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

// --- Minimal XML layer (pure JS, no XmlService, no dependencies) ---
// Sufficient for well-formed RSS 2.0 / RSS 1.0 (RDF) / Atom documents.
// Node: { name (local, lowercase), attrs, children, text }

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

function localName(tag) {
  const raw = String(tag || '').trim();
  const idx = raw.indexOf(':');
  return (idx >= 0 ? raw.slice(idx + 1) : raw).toLowerCase();
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    attrs[localName(m[1])] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
    attrs[m[1]] = attrs[localName(m[1])];
  }
  return attrs;
}

function parseXml(xmlText) {
  const src = String(xmlText || '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const pushText = (raw, isCdata) => {
    if (!raw) return;
    stack[stack.length - 1].text += isCdata ? raw : decodeXmlEntities(raw);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i), false); break; }
    if (lt > i) pushText(src.slice(i, lt), false);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      pushText(end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end), true);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;
    const inside = src.slice(lt + 1, gt);
    if (inside.startsWith('/')) {
      const name = localName(inside.slice(1));
      // Pop back to the matching open element (tolerates minor mis-nesting).
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break; }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = inside.endsWith('/');
    const bodyText = selfClosing ? inside.slice(0, -1) : inside;
    const spaceIdx = bodyText.search(/[\s]/);
    const tagName = spaceIdx < 0 ? bodyText : bodyText.slice(0, spaceIdx);
    const attrText = spaceIdx < 0 ? '' : bodyText.slice(spaceIdx + 1);
    const node = { name: localName(tagName), attrs: parseAttrs(attrText), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function childNodes(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.name === name);
}

function firstChildNode(node, name) {
  const found = childNodes(node, name);
  return found.length ? found[0] : null;
}

function nodeText(node) {
  if (!node) return '';
  // Element text plus descendants' text (covers Atom summary/content nesting).
  let out = node.text || '';
  node.children.forEach((c) => { out += nodeText(c); });
  return out.trim();
}

function childText(node, name) {
  return nodeText(firstChildNode(node, name));
}

function findAllNodes(node, name, out) {
  const acc = out || [];
  if (!node) return acc;
  node.children.forEach((c) => {
    if (c.name === name) acc.push(c);
    findAllNodes(c, name, acc);
  });
  return acc;
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
// Data API v3 の uploads プレイリストから取り込む。フィード行の URL は従来どおり
// videos.xml の形を保ち、ここで channel_id を抜き出して振り分ける。

function youtubeChannelIdFromUrl(url) {
  const m = /^https:\/\/(?:www\.)?youtube\.com\/feeds\/videos\.xml\?[^#]*\bchannel_id=(UC[\w-]{10,})/.exec(String(url || ''));
  return m ? m[1] : '';
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

// playlistItems の応答 JSON を parseFeed と同形のエントリ配列へ正規化する。
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
function buildRssXml(feed, articleRows) {
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
    '<rss version="2.0">',
    '  <channel>',
    '    <title>' + escapeXml(title) + '</title>',
    '    <link>' + escapeXml('https://www.youtube.com/channel/' + channelId) + '</link>',
    '    <description>' + escapeXml(title) + '</description>',
  ];
  sorted.forEach((a) => {
    const link = String(a.link || '');
    const pubDate = toRfc822(cellIso(a.published_at) || cellIso(a.fetched_at));
    lines.push('    <item>');
    lines.push('      <title>' + escapeXml(a.title) + '</title>');
    lines.push('      <link>' + escapeXml(link) + '</link>');
    lines.push('      <guid isPermaLink="false">' + escapeXml(videoIdFromLink(link)) + '</guid>');
    if (pubDate) lines.push('      <pubDate>' + pubDate + '</pubDate>');
    lines.push('      <description>' + escapeXml(a.summary) + '</description>');
    lines.push('      <author>' + escapeXml(title) + '</author>');
    lines.push('    </item>');
  });
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

function parseFeed(xmlText, feed) {
  const feedId = feed && feed.id ? String(feed.id) : '';
  const root = parseXml(xmlText);
  const items = [];
  const pushItem = (guid, title, link, publishedAt, summarySource, author) => {
    const key = guid || link;
    if (!key || !link) return;
    items.push({
      guid: String(key),
      title: String(title || '').trim() || '(no title)',
      link: String(link).trim(),
      publishedAt: toIsoDate(publishedAt),
      summary: summarize(summarySource || ''),
      author: String(author || '').trim(),
      feedId,
    });
  };
  // RSS 2.0: rss > channel > item
  findAllNodes(root, 'channel').forEach((channel) => {
    childNodes(channel, 'item').forEach((item) => {
      pushItem(
        childText(item, 'guid') || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'pubdate') || childText(item, 'date'),
        childText(item, 'description') || childText(item, 'encoded'),
        childText(item, 'author') || childText(item, 'creator')
      );
    });
  });
  // RSS 1.0 / RDF: item elements that are direct children of the root element.
  const docEl = root.children.length ? root.children[0] : null;
  if (docEl) {
    childNodes(docEl, 'item').forEach((item) => {
      pushItem(
        item.attrs.about || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'date'),
        childText(item, 'description'),
        childText(item, 'creator')
      );
    });
  }
  // Atom: entry elements anywhere under the feed root.
  findAllNodes(root, 'entry').forEach((entry) => {
    const links = childNodes(entry, 'link');
    let href = '';
    links.forEach((l) => {
      if (!href && (!l.attrs.rel || l.attrs.rel === 'alternate')) href = l.attrs.href || '';
    });
    if (!href && links.length) href = links[0].attrs.href || '';
    const authorNode = firstChildNode(entry, 'author');
    pushItem(
      childText(entry, 'id') || href,
      nodeText(firstChildNode(entry, 'title')),
      href,
      childText(entry, 'published') || childText(entry, 'updated'),
      childText(entry, 'summary') || childText(entry, 'content'),
      authorNode ? childText(authorNode, 'name') : ''
    );
  });
  return items;
}

// --- Retention (pure decision logic) ---
// Eligible for pruning: no state, or read and not starred.
// Prune when older than RETENTION_DAYS, or beyond the newest MAX_ARTICLES.

function prunePlan(articles, states, nowIso, options) {
  const opts = options || {};
  const retentionMs = (opts.retentionDays || RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const maxArticles = opts.maxArticles || MAX_ARTICLES;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const stateById = {};
  (states || []).forEach((s) => { stateById[s.article_id] = s; });
  const sorted = (articles || []).slice().sort((a, b) => {
    const ta = Date.parse(cellIso(a.published_at) || cellIso(a.fetched_at) || '') || 0;
    const tb = Date.parse(cellIso(b.published_at) || cellIso(b.fetched_at) || '') || 0;
    return tb - ta;
  });
  const keepRank = {};
  sorted.forEach((a, idx) => { keepRank[a.id] = idx < maxArticles; });
  const deleteArticleIds = [];
  sorted.forEach((a) => {
    const st = stateById[a.id];
    const starred = st ? isTruthy(st.is_starred) : false;
    if (starred) return;
    const eligible = !st || isTruthy(st.is_read);
    if (!eligible) return;
    // 経過日数は「取り込んだ日」から数える (公開日が古い動画などを
    // 取り込んだ瞬間に消してしまわないため)。
    const t = Date.parse(cellIso(a.fetched_at) || cellIso(a.published_at) || '') || 0;
    const tooOld = t > 0 && now - t > retentionMs;
    const beyondCap = !keepRank[a.id];
    if (tooOld || beyondCap) deleteArticleIds.push(a.id);
  });
  const deleteSet = {};
  deleteArticleIds.forEach((id) => { deleteSet[id] = true; });
  const articleSet = {};
  (articles || []).forEach((a) => { articleSet[a.id] = true; });
  const deleteStateIds = [];
  (states || []).forEach((s) => {
    if (isTruthy(s.is_starred)) return;
    if (deleteSet[s.article_id] || !articleSet[s.article_id]) deleteStateIds.push(s.article_id);
  });
  return { deleteArticleIds, deleteStateIds };
}

function pruneArticles() {
  const ss = openDataSpreadsheet();
  const articles = readSheetAsObjects(ss, 'articles');
  const states = readSheetAsObjects(ss, 'states');
  const plan = prunePlan(articles, states, new Date().toISOString());
  deleteRowsById(ss, 'articles', 'id', plan.deleteArticleIds);
  deleteRowsById(ss, 'states', 'article_id', plan.deleteStateIds);
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
  const revIdx = headers.indexOf('revoked_at');
  const roleIdx = headers.indexOf('role');
  const hash = sha256Hex(String(token));
  const nowIso = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!hashesEqual(row[hashIdx], hash)) continue;
    if (revIdx >= 0 && cellIso(row[revIdx])) return null;
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

function issueShareLink() {
  const props = PropertiesService.getScriptProperties();
  const token = generateRawToken();
  const expiresIso = new Date(Date.now() + SHARE_TTL_SECONDS * 1000).toISOString();
  // Re-issuing overwrites the stored hash, which invalidates the old link.
  props.setProperties({
    SHARE_TOKEN_HASH: sha256Hex(token),
    SHARE_EXPIRES_AT: expiresIso,
  }, false);
  return { shareToken: token, expiresAt: expiresIso };
}

function validateShareToken(token) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  const expectedHash = props.getProperty('SHARE_TOKEN_HASH');
  const expiresAt = props.getProperty('SHARE_EXPIRES_AT');
  if (!expectedHash || !expiresAt) return false;
  if (isSessionExpired(expiresAt, new Date().toISOString())) return false;
  return hashesEqual(sha256Hex(String(token)), expectedHash);
}

// --- Feed fetching (hourly trigger) ---

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) return String(headers[keys[i]] || '');
  }
  return '';
}

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

function fetchFeeds() {
  const ss = openDataSpreadsheet();
  const feedsSheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
  const articlesSheet = getSheetOrCreate(ss, 'articles', ARTICLES_HEADERS);
  getSheetOrCreate(ss, 'states', STATES_HEADERS);
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
  const allEnabledFeeds = feeds.filter((f) => f.id && f.url && isTruthy(f.enabled));
  const enabledFeeds = allEnabledFeeds.filter((f) => !youtubeChannelIdFromUrl(f.url));
  const youtubeFeeds = allEnabledFeeds.filter((f) => youtubeChannelIdFromUrl(f.url));
  const apiToken = PropertiesService.getScriptProperties().getProperty('A_ZE_GS_TOKEN');
  const requests = enabledFeeds.map((feed) => {
    const reqHeaders = {};
    if (feed.etag) reqHeaders['If-None-Match'] = String(feed.etag);
    if (feed.last_modified) reqHeaders['If-Modified-Since'] = String(feed.last_modified);
    if (isTruthy(feed.is_private) && apiToken) reqHeaders['X-Api-Token'] = apiToken;
    return { url: String(feed.url), method: 'get', headers: reqHeaders, muteHttpExceptions: true };
  });
  const responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
  const existingIds = {};
  readSheetAsObjects(ss, 'articles').forEach((a) => { existingIds[a.id] = true; });
  const fetchedAt = new Date().toISOString();
  let addedTotal = 0;
  enabledFeeds.forEach((feed, idx) => {
    const rowNum = rowNumById[feed.id];
    try {
      if (isTruthy(feed.is_private) && !apiToken) throw new Error('A_ZE_GS_TOKEN is not set');
      const res = responses[idx];
      const code = res.getResponseCode();
      if (code === 304) {
        updateFeedRow(feedsSheet, headers, rowNum, { last_fetched_at: fetchedAt, last_status: '304', last_error: '' });
        return;
      }
      if (code !== 200) throw new Error('HTTP ' + code);
      const resHeaders = typeof res.getHeaders === 'function' ? res.getHeaders() : {};
      const entries = parseFeed(res.getContentText(), feed);
      addedTotal += appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt);
      updateFeedRow(feedsSheet, headers, rowNum, {
        last_fetched_at: fetchedAt,
        last_status: '200',
        last_error: '',
        etag: headerValue(resHeaders, 'ETag') || String(feed.etag || ''),
        last_modified: headerValue(resHeaders, 'Last-Modified') || String(feed.last_modified || ''),
      });
    } catch (err) {
      // Per-feed errors are isolated: record and continue with the rest.
      updateFeedRow(feedsSheet, headers, rowNum, {
        last_fetched_at: fetchedAt,
        last_status: 'error',
        last_error: String((err && err.message) || err).slice(0, 500),
      });
    }
  });
  // YouTube フィードは公式APIから取り込む (RSS は 404 のため)。
  const youtubeApiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  youtubeFeeds.forEach((feed) => {
    const rowNum = rowNumById[feed.id];
    try {
      if (!youtubeApiKey) throw new Error('YOUTUBE_API_KEY is not set');
      const playlistId = youtubeUploadsPlaylistId(youtubeChannelIdFromUrl(feed.url));
      const apiUrl = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=20'
        + '&playlistId=' + encodeURIComponent(playlistId)
        + '&key=' + encodeURIComponent(youtubeApiKey);
      const res = UrlFetchApp.fetch(apiUrl, { method: 'get', muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code !== 200) throw new Error('YouTube API HTTP ' + code + youtubeApiErrorDetail(res.getContentText()));
      const entries = parseYouTubePlaylistItems(res.getContentText(), feed);
      addedTotal += appendNewEntries(articlesSheet, feed, entries, existingIds, fetchedAt);
      updateFeedRow(feedsSheet, headers, rowNum, { last_fetched_at: fetchedAt, last_status: '200', last_error: '' });
    } catch (err) {
      updateFeedRow(feedsSheet, headers, rowNum, {
        last_fetched_at: fetchedAt,
        last_status: 'error',
        last_error: String((err && err.message) || err).slice(0, 500),
      });
    }
  });
  pruneArticles();
  return { ok: true, fetched: allEnabledFeeds.length, added: addedTotal };
}

function setupFetchTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'fetchFeeds') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fetchFeeds').timeBased().everyHours(1).create();
}

// --- Article listing / state changes ---

// カテゴリに属するフィードの id 一覧 (カテゴリ絞り込み用)。
function feedIdsForCategory(feeds, category) {
  const target = String(category || '').trim();
  if (!target) return [];
  return (feeds || [])
    .filter((f) => String(f.category || '').trim() === target)
    .map((f) => String(f.id || ''))
    .filter((id) => id);
}

function filterArticles(articles, options) {
  const opts = options || {};
  let out = (articles || []).slice();
  if (opts.feedId) out = out.filter((a) => a.feed_id === opts.feedId || a.feedId === opts.feedId);
  if (Array.isArray(opts.feedIds)) {
    const allowed = {};
    opts.feedIds.forEach((id) => { allowed[id] = true; });
    out = out.filter((a) => allowed[a.feed_id || a.feedId]);
  }
  if (opts.filter === 'unread') out = out.filter((a) => !a.isRead);
  if (opts.filter === 'starred') out = out.filter((a) => a.isStarred);
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
  const stateById = {};
  readSheetAsObjects(ss, 'states').forEach((s) => { stateById[s.article_id] = s; });
  const merged = readSheetAsObjects(ss, 'articles').map((a) => {
    const st = stateById[a.id];
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
      author: String(a.author || ''),
      isRead: st ? isTruthy(st.is_read) : false,
      isStarred: st ? isTruthy(st.is_starred) : false,
    };
  });
  const unreadByFeed = {};
  const starredByFeed = {};
  merged.forEach((a) => {
    if (!a.isRead) unreadByFeed[a.feedId] = (unreadByFeed[a.feedId] || 0) + 1;
    if (a.isStarred) starredByFeed[a.feedId] = (starredByFeed[a.feedId] || 0) + 1;
  });
  const category = body.category ? String(body.category).trim() : '';
  const filtered = filterArticles(merged, {
    feedId: body.feedId ? String(body.feedId) : '',
    feedIds: category ? feedIdsForCategory(feeds, category) : null,
    filter: ['unread', 'starred'].indexOf(body.filter) >= 0 ? body.filter : 'all',
  });
  let limit = Number(body.limit || 100);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);
  let offset = Number(body.offset || 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const serviceUrl = getServiceUrl();
  return {
    ok: true,
    articles: filtered.slice(offset, offset + limit),
    total: filtered.length,
    feeds: feeds.filter((f) => f.id).map((f) => ({
      id: f.id,
      title: String(f.title || ''),
      url: String(f.url || ''),
      fetchUrl: buildFetchUrl(f, serviceUrl),
      category: String(f.category || ''),
      isPrivate: isTruthy(f.is_private),
      unreadCount: unreadByFeed[f.id] || 0,
      starredCount: starredByFeed[f.id] || 0,
    })),
    generatedAt: new Date().toISOString(),
  };
}

function upsertState(ss, articleIdValue, patch) {
  const sheet = getSheetOrCreate(ss, 'states', STATES_HEADERS);
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0] : STATES_HEADERS;
  const nowIso = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== String(articleIdValue)) continue;
    const current = {};
    headers.forEach((h, idx) => { current[h] = values[i][idx]; });
    const next = {
      is_read: patch.isRead !== undefined ? patch.isRead : isTruthy(current.is_read),
      is_starred: patch.isStarred !== undefined ? patch.isStarred : isTruthy(current.is_starred),
      read_at: patch.isRead !== undefined ? (patch.isRead ? nowIso : '') : cellIso(current.read_at),
      starred_at: patch.isStarred !== undefined ? (patch.isStarred ? nowIso : '') : cellIso(current.starred_at),
      updated_at: nowIso,
    };
    headers.forEach((h, idx) => {
      if (h === 'article_id') return;
      if (next[h] !== undefined) sheet.getRange(i + 1, idx + 1).setValue(next[h]);
    });
    return next;
  }
  const row = [String(articleIdValue),
    patch.isRead !== undefined ? patch.isRead : false,
    patch.isStarred !== undefined ? patch.isStarred : false,
    patch.isRead ? nowIso : '',
    patch.isStarred ? nowIso : '',
    nowIso];
  sheet.appendRow(row);
  return { is_read: row[1], is_starred: row[2] };
}

function handleMark(body) {
  const ss = openDataSpreadsheet();
  const articleIdValue = String(body.articleId || '');
  if (!articleIdValue) return { ok: false, error: 'bad_request' };
  const exists = readSheetAsObjects(ss, 'articles').some((a) => String(a.id) === articleIdValue);
  if (!exists) return { ok: false, error: 'not_found' };
  const patch = {};
  if (body.isRead !== undefined) patch.isRead = body.isRead === true;
  if (body.isStarred !== undefined) patch.isStarred = body.isStarred === true;
  upsertState(ss, articleIdValue, patch);
  return { ok: true, articleId: articleIdValue, isRead: patch.isRead, isStarred: patch.isStarred };
}

function handleMarkAllRead(body) {
  const ss = openDataSpreadsheet();
  const feedId = body.feedId ? String(body.feedId) : '';
  const category = body.category ? String(body.category).trim() : '';
  let categoryIds = null;
  if (category) {
    categoryIds = {};
    feedIdsForCategory(readSheetAsObjects(ss, 'feeds'), category).forEach((id) => { categoryIds[id] = true; });
  }
  const articles = readSheetAsObjects(ss, 'articles').filter((a) =>
    (!feedId || a.feed_id === feedId) && (!categoryIds || categoryIds[a.feed_id]));
  let count = 0;
  articles.forEach((a) => { upsertState(ss, a.id, { isRead: true }); count++; });
  return { ok: true, marked: count };
}

// --- Feed management (owner only) ---
// フィードの追加・編集・削除をフロントの管理画面から行うためのAPI。
// 純関数のバリデーション/整形を Node テスト対象にし、シート操作は薄く保つ。

const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRIVATE_FEED_HOST = 'a.ze.gs';

function toFeedBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toUpperCase();
    if (v === 'TRUE' || v === '1') return true;
    if (v === 'FALSE' || v === '0') return false;
  }
  return fallback;
}

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
// Returns { ok:true, feed:{id,title,url,category,enabled,isPrivate} } or { ok:false, message }.
// SECURITY: isPrivate は A_ZE_GS_TOKEN ヘッダーの送信先を決めるため、入力値では決めず
// URL のホストが a.ze.gs そのもののときだけ true に強制する (トークンの外部漏洩防止)。
function validateFeedInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, message: 'feed is required' };
  const id = String(input.id === undefined || input.id === null ? '' : input.id).trim();
  if (!id) return { ok: false, message: 'id is required' };
  if (!FEED_ID_PATTERN.test(id)) return { ok: false, message: 'id must be a slug (lowercase letters, digits, hyphens)' };
  const title = String(input.title === undefined || input.title === null ? '' : input.title).trim();
  if (!title) return { ok: false, message: 'title is required' };
  const parsed = parseFeedUrl(input.url);
  if (!parsed.ok) return { ok: false, message: parsed.message };
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
      enabled: toFeedBool(input.enabled, true),
      isPrivate: parsed.host === PRIVATE_FEED_HOST,
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
    enabled: feed.enabled,
    is_private: feed.isPrivate,
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
function feedToApiShape(feedObj, unreadCount, starredCount, serviceUrl) {
  const f = feedObj || {};
  const base = serviceUrl !== undefined ? String(serviceUrl || '') : getServiceUrl();
  const priv = f.is_private !== undefined ? f.is_private : f.isPrivate;
  const fetched = f.last_fetched_at !== undefined ? f.last_fetched_at : f.lastFetchedAt;
  const status = f.last_status !== undefined ? f.last_status : f.lastStatus;
  const error = f.last_error !== undefined ? f.last_error : f.lastError;
  return {
    id: String(f.id || ''),
    title: String(f.title || ''),
    url: String(f.url || ''),
    fetchUrl: buildFetchUrl(f, base),
    category: String(f.category || ''),
    enabled: isTruthy(f.enabled),
    isPrivate: isTruthy(priv),
    lastStatus: String(status || ''),
    lastError: String(error || ''),
    lastFetchedAt: cellIso(fetched),
    unreadCount: unreadCount || 0,
    starredCount: starredCount || 0,
  };
}

// Unread = articles without a read state (no state row, or is_read falsy).
function countUnreadByFeed(articles, states) {
  const readById = {};
  (states || []).forEach((s) => { readById[s.article_id] = isTruthy(s.is_read); });
  const counts = {};
  (articles || []).forEach((a) => {
    const feedId = a.feed_id !== undefined ? a.feed_id : a.feedId;
    if (!feedId) return;
    if (!readById[a.id]) counts[feedId] = (counts[feedId] || 0) + 1;
  });
  return counts;
}

// Starred = articles whose state row has is_starred truthy.
function countStarredByFeed(articles, states) {
  const starredById = {};
  (states || []).forEach((s) => { starredById[s.article_id] = isTruthy(s.is_starred); });
  const counts = {};
  (articles || []).forEach((a) => {
    if (!a || !a.id) return;
    const feedId = a.feed_id !== undefined ? a.feed_id : a.feedId;
    if (!feedId) return;
    if (starredById[a.id]) counts[feedId] = (counts[feedId] || 0) + 1;
  });
  return counts;
}

function buildListFeedsPayload() {
  const ss = openDataSpreadsheet();
  const feeds = readSheetAsObjects(ss, 'feeds');
  const articleRows = readSheetAsObjects(ss, 'articles');
  const stateRows = readSheetAsObjects(ss, 'states');
  const unreadByFeed = countUnreadByFeed(articleRows, stateRows);
  const starredByFeed = countStarredByFeed(articleRows, stateRows);
  return {
    ok: true,
    feeds: feeds.filter((f) => f.id).map((f) => feedToApiShape(f, unreadByFeed[f.id] || 0, starredByFeed[f.id] || 0)),
  };
}

function handleSaveFeed(body) {
  const result = validateFeedInput(body ? body.feed : null);
  if (!result.ok) return { ok: false, error: 'invalid', message: result.message };
  const feed = result.feed;
  const ss = openDataSpreadsheet();
  const sheet = getSheetOrCreate(ss, 'feeds', FEEDS_HEADERS);
  const values = sheet.getDataRange().getValues();
  const headers = values.length ? values[0] : FEEDS_HEADERS;
  const idIdx = headers.indexOf('id');
  let existing = null;
  let rowNum = -1;
  if (idIdx >= 0) {
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idIdx]) !== feed.id) continue;
      existing = {};
      headers.forEach((h, idx) => { existing[h] = values[i][idx]; });
      rowNum = i + 1;
      break;
    }
  }
  const rowObj = buildFeedRow(feed, existing);
  const rowValues = feedRowValues(rowObj, headers);
  if (rowNum > 0) sheet.getRange(rowNum, 1, 1, headers.length).setValues([rowValues]);
  else sheet.appendRow(rowValues);
  const unreadByFeed = countUnreadByFeed(readSheetAsObjects(ss, 'articles'), readSheetAsObjects(ss, 'states'));
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
  const articleIds = readSheetAsObjects(ss, 'articles')
    .filter((a) => String(a.feed_id) === feedId)
    .map((a) => String(a.id));
  deleteRowsById(ss, 'states', 'article_id', articleIds);
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
    return ContentService.createTextOutput(buildRssXml(feed, rows));
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
    if (action === 'issue_share') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      const link = issueShareLink();
      return jsonOutput({ ok: true, shareToken: link.shareToken, expiresAt: link.expiresAt });
    }
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
    if (action === 'list') {
      return jsonOutput(buildListPayload(body));
    }
    if (action === 'mark') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(handleMark(body));
    }
    if (action === 'markAllRead') {
      if (session.role !== 'owner') return jsonOutput({ ok: false, error: 'forbidden' });
      return jsonOutput(handleMarkAllRead(body));
    }
    return jsonOutput({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOutput({ ok: false, error: String((err && err.message) || err) });
  }
}
export { rowsToObjects, parseFeed, articleId, sha256Hex, sha256HexPure, stripTags, summarize, decodeXmlEntities, parseXml, toIsoDate, isTruthy, isAllowedIdTokenPayload, hashesEqual, isSessionExpired, prunePlan, filterArticles, feedIdsForCategory, youtubeChannelIdFromUrl, youtubeUploadsPlaylistId, parseYouTubePlaylistItems, youtubeApiErrorDetail, escapeXml, videoIdFromLink, toRfc822, buildRssXml, buildFetchUrl, toFeedBool, parseFeedUrl, validateFeedInput, buildFeedRow, feedRowValues, feedToApiShape, countUnreadByFeed, countStarredByFeed, remainingRowsAfterDelete, reorderRowsByIds, validateFeedOrder };
