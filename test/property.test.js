// プロパティベーステスト (fast-check): 外部入力の変換処理について、
// 個別ケースではなく「どんな入力でも成り立つ性質」を固定する。
// 異常系の具体例は test/abnormal.test.js が担う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import {
  decodeXmlEntities,
  escapeXml,
  summarize,
  sha256HexPure,
  toIsoDate,
  parseYouTubePlaylistItems,
  parseYouTubeDurations,
  parseAudioUrlsMap,
  buildRssXml,
} from '../src/main.js';

const NUM_RUNS = 100;

// 文字列の生成ドメイン: YouTube API やシートから来る実文字列は
// 常に整形式の Unicode (単独サロゲートを含まない)。そのため生成は
// 「意味のある単位」の列から組み立て、単独サロゲートは生成しない
// (単独サロゲートへの振る舞いは abnormal.test.js の明示ケースで固定)。
const UNIT = fc.constantFrom(
  'a', 'Z', '0', ' ', '\n', '\t', '&', '<', '>', '"', "'", '&amp;',
  'あ', '漢', 'é', 'e\u0301', '\u{1F389}', '\u{1F600}', '〜', '・',
);
const text = (maxLen = 60) => fc.array(UNIT, { maxLength: maxLen }).map((xs) => xs.join(''));

// JSON 由来の値ドメイン + 「文字列化できないオブジェクト」。
const evil = () => JSON.parse('{"toString":[]}');
const jsonish = fc.oneof(
  fc.jsonValue(),
  fc.constant(evil()),
);

function assertXmlClean(xml) {
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml), 'C0 制御文字等が残っている');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml), '単独サロゲートが残っている');
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(xml), '生の & が残っている');
}

test('性質: escapeXml と decodeXmlEntities は整形式テキストで往復する', () => {
  fc.assert(fc.property(text(), (s) => {
    assert.equal(decodeXmlEntities(escapeXml(s)), s);
  }), { numRuns: NUM_RUNS });
});

test('性質: escapeXml は JSON ドメインのどんな値でも例外なく XML 安全な文字列を返す', () => {
  fc.assert(fc.property(jsonish, (v) => {
    const out = escapeXml(v);
    assert.equal(typeof out, 'string');
    assertXmlClean(out);
  }), { numRuns: NUM_RUNS });
});

test('性質: decodeXmlEntities は数値参照の混ざった入力でも例外なく、NUL と単独サロゲートを出さない', () => {
  const fragment = fc.oneof(
    UNIT,
    fc.integer({ min: 0, max: 0x200000 }).map((n) => '&#' + n + ';'),
    fc.integer({ min: 0, max: 0x200000 }).map((n) => '&#x' + n.toString(16) + ';'),
    fc.constantFrom('&lt;', '&gt;', '&amp;', '&quot;', '&apos;'),
  );
  fc.assert(fc.property(fc.array(fragment, { maxLength: 40 }).map((xs) => xs.join('')), (s) => {
    const out = decodeXmlEntities(s);
    assert.ok(!out.includes('\u0000'));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out));
  }), { numRuns: NUM_RUNS });
});

test('性質: sha256HexPure は Node の SHA-256 と一致する', () => {
  fc.assert(fc.property(text(200), (s) => {
    assert.equal(sha256HexPure(s), createHash('sha256').update(s, 'utf8').digest('hex'));
  }), { numRuns: NUM_RUNS });
});

test('性質: summarize は上限以内で、本文の接頭辞であり、サロゲートペアを割らない', () => {
  // タグも実体参照も空白も含まないドメインでは stripTags は恒等になるため、
  // 「接頭辞」の性質をそのまま検証できる。
  const plainUnit = fc.constantFrom('a', 'Z', '0', 'あ', '漢', '\u{1F389}', 'e\u0301');
  fc.assert(fc.property(
    fc.array(plainUnit, { maxLength: 300 }).map((xs) => xs.join('')),
    fc.integer({ min: 1, max: 700 }),
    (s, limit) => {
      const out = summarize(s, limit);
      assert.ok(s.startsWith(out));
      assert.ok(out.length <= limit || out === s);
      if (s.length <= limit) assert.equal(out, s);
      assert.ok(!/[\uD800-\uDBFF]$/.test(out) || out === s);
    },
  ), { numRuns: NUM_RUNS });
});

test('性質: toIsoDate は ISO 形の日付について、実在する日付だけを通す', () => {
  const pad = (n, w) => String(n).padStart(w, '0');
  fc.assert(fc.property(
    fc.integer({ min: 1970, max: 2100 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 31 }),
    (y, m, d) => {
      const input = pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2) + 'T00:00:00Z';
      const chk = new Date(Date.UTC(y, m - 1, d));
      const exists = chk.getUTCFullYear() === y && chk.getUTCMonth() === m - 1 && chk.getUTCDate() === d;
      const out = toIsoDate(input);
      if (exists) assert.equal(out, pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2) + 'T00:00:00.000Z');
      else assert.equal(out, '');
    },
  ), { numRuns: NUM_RUNS });
});

test('性質: toIsoDate はどんな値でも例外にならず、返すのは空文字か解釈可能な日付だけ', () => {
  fc.assert(fc.property(jsonish, (v) => {
    const out = toIsoDate(v);
    assert.ok(out === '' || !Number.isNaN(Date.parse(out)));
  }), { numRuns: NUM_RUNS });
});

test('性質: parseYouTubePlaylistItems はどんな items でも例外にならず、整形式の item はすべて取り込む', () => {
  const goodItem = fc.record({
    videoId: fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
    title: text(30).filter((t) => t.trim() !== '' && t.trim() !== 'Deleted video' && t.trim() !== 'Private video'),
  }).map(({ videoId, title }) => ({
    snippet: {
      resourceId: { videoId },
      title,
      description: '説明',
      channelTitle: 'ch',
      publishedAt: '2026-01-01T00:00:00Z',
    },
  }));
  const anyItem = fc.oneof(
    goodItem,
    fc.record({ snippet: fc.jsonValue() }),
    fc.jsonValue(),
    fc.constant(null),
  );
  fc.assert(fc.property(fc.array(anyItem, { maxLength: 12 }), (items) => {
    const json = JSON.stringify({ items });
    const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
    assert.ok(entries.length <= items.length);
    for (const e of entries) {
      assert.ok(e.guid !== '' && e.title !== '');
      assert.equal(e.link, 'https://www.youtube.com/watch?v=' + e.guid);
      assert.ok(e.publishedAt === '' || !Number.isNaN(Date.parse(e.publishedAt)));
    }
    // 整形式の item (snippet が想定形でタイトルが有効) はすべて残る。
    const goodIds = items
      .filter((it) => it && typeof it === 'object' && it.snippet && typeof it.snippet === 'object'
        && it.snippet.resourceId && typeof it.snippet.resourceId.videoId === 'string'
        && it.snippet.resourceId.videoId !== ''
        && typeof it.snippet.title === 'string' && it.snippet.title.trim() !== ''
        && it.snippet.title.trim() !== 'Deleted video' && it.snippet.title.trim() !== 'Private video')
      .map((it) => it.snippet.resourceId.videoId);
    assert.deepEqual(entries.map((e) => e.guid).sort(), goodIds.sort());
  }), { numRuns: NUM_RUNS });
});

test('性質: parseYouTubeDurations は正しい ISO 8601 duration を正確な秒へ変換する', () => {
  fc.assert(fc.property(
    fc.nat({ max: 3650 }), fc.nat({ max: 100 }), fc.nat({ max: 1000 }), fc.nat({ max: 10000 }),
    (d, h, m, s) => {
      const duration = 'P' + (d ? d + 'D' : '') + 'T' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : '');
      const total = d * 86400 + h * 3600 + m * 60 + s;
      const map = parseYouTubeDurations(JSON.stringify({ items: [{ id: 'v', contentDetails: { duration } }] }));
      if (total > 0) assert.equal(map.v, total);
      else assert.deepEqual(map, {});
    },
  ), { numRuns: NUM_RUNS });
});

test('性質: parseAudioUrlsMap はどんなマップでも例外にならず、保持する値は型が揃っている', () => {
  const entry = fc.record({
    url: jsonish,
    ts: jsonish,
    dur: jsonish,
  }, { requiredKeys: [] });
  fc.assert(fc.property(fc.dictionary(fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/), entry), (data) => {
    const map = parseAudioUrlsMap(JSON.stringify(data));
    for (const [id, e] of Object.entries(map)) {
      assert.equal(typeof e.url, 'string');
      assert.notEqual(e.url, '');
      assert.ok(Number.isFinite(e.ts));
      if ('dur' in e) assert.ok(Number.isFinite(e.dur) && e.dur > 0);
      // 整形式のエントリ (文字列 URL・数値 ts) は必ず残る。
      const src = data[id];
      if (src && typeof src.url === 'string' && src.url !== '' && typeof src.ts === 'number' && Number.isFinite(src.ts)) {
        assert.equal(e.url, src.url);
        assert.equal(e.ts, src.ts);
      }
    }
  }), { numRuns: NUM_RUNS });
});

test('性質: buildRssXml はどんな行でも例外にならず、整った RSS を返し件数と順序を保つ', () => {
  const datePool = fc.constantFrom(
    '2026-01-01T00:00:00Z', '2026-06-15T12:00:00Z', '2025-12-31T23:59:59Z',
    '2026-02-30T00:00:00Z', 'not a date', '', '2026-11-20T05:00:00Z',
  );
  const row = fc.record({
    title: jsonish,
    link: jsonish,
    published_at: fc.oneof(datePool, jsonish),
    fetched_at: fc.oneof(datePool, jsonish),
    summary: jsonish,
  }, { requiredKeys: [] });
  const anyRow = fc.oneof(row, fc.constant(null), fc.string(), fc.integer());
  const feed = fc.record({ title: jsonish, url: fc.constantFrom('', 'https://www.youtube.com/channel/UC1234567890ab', 'https://www.youtube.com/playlist?list=PL1234567890ab') });
  fc.assert(fc.property(feed, fc.array(anyRow, { maxLength: 60 }), (f, rows) => {
    const xml = buildRssXml(f, rows);
    assertXmlClean(xml);
    const objectRows = rows.filter((r) => r && typeof r === 'object');
    assert.equal((xml.match(/<item>/g) || []).length, Math.min(objectRows.length, 50));
    // pubDate が出ている箇所はすべて実在する日時で、新しい順を保つ。
    const pubDates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => Date.parse(m[1]));
    for (const t of pubDates) assert.ok(!Number.isNaN(t));
    for (let i = 1; i < pubDates.length; i++) assert.ok(pubDates[i - 1] >= pubDates[i]);
  }), { numRuns: NUM_RUNS });
});
