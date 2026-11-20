// 異常系テスト: YouTube Data API の応答 JSON や audio-urls.json、
// シート行のような「外から来る入力」が壊れている・想定外の型で来ても、
// 変換処理が例外で死なず、壊れた要素だけを落として健全な要素は生かす
// ことを固定する。通常系は test/main.test.js が担う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeXmlEntities,
  escapeXml,
  stripTags,
  summarize,
  toIsoDate,
  parseYouTubePlaylistItems,
  parseYouTubeDurations,
  parseYouTubeChannelTitle,
  parseYouTubePlaylistTitle,
  parseChannelLookupResponse,
  parseAudioUrlsMap,
  buildRssXml,
  videoIdFromLink,
} from '../src/main.js';

// JSON 由来で実際に起こりうる「文字列化できないオブジェクト」
// (toString が関数でない)。String() に渡すと TypeError になる。
const evil = () => JSON.parse('{"toString":[]}');

const FEED = { id: 'f1', title: 'テストチャンネル', url: 'https://www.youtube.com/channel/UC1234567890ab' };
const itemJson = (snippet) => JSON.stringify({ items: [{ snippet }] });
const goodSnippet = {
  resourceId: { videoId: 'abc12345678' },
  title: '通常の動画',
  description: '説明',
  channelTitle: 'チャンネル',
  publishedAt: '2026-01-01T00:00:00Z',
};

// XML 1.0 として不正な文字 (C0 制御文字の一部・単独サロゲート・
// U+FFFE/U+FFFF) が混ざっていないことの検査。
function assertXmlClean(xml) {
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml), 'C0 制御文字等が残っている');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml), '単独サロゲートが残っている');
}

// --- decodeXmlEntities ---

test('decodeXmlEntities異常系: 範囲外の数値文字参照は例外でなく置換文字になる', () => {
  assert.equal(decodeXmlEntities('a &#x110000; b'), 'a \uFFFD b');
  assert.equal(decodeXmlEntities('a &#1114112; b'), 'a \uFFFD b');
  assert.equal(decodeXmlEntities('a &#99999999999999999999; b'), 'a \uFFFD b');
});

test('decodeXmlEntities異常系: サロゲートや NUL を指す参照は置換文字になる', () => {
  assert.equal(decodeXmlEntities('a &#xD800; b'), 'a \uFFFD b');
  assert.equal(decodeXmlEntities('a &#55296; b'), 'a \uFFFD b');
  assert.equal(decodeXmlEntities('a &#0; b'), 'a \uFFFD b');
});

test('decodeXmlEntities異常系: 範囲内の参照は従来どおり復号される', () => {
  assert.equal(decodeXmlEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeXmlEntities('&#x1F389;'), '\u{1F389}');
});

test('decodeXmlEntities異常系: 文字列化できない入力は空文字として扱う', () => {
  assert.equal(decodeXmlEntities(evil()), '');
});

// --- escapeXml ---

test('escapeXml異常系: 文字列化できない値・オブジェクト・配列は空文字になる', () => {
  assert.equal(escapeXml(evil()), '');
  assert.equal(escapeXml({}), '');
  assert.equal(escapeXml([1, 2]), '');
});

test('escapeXml異常系: 数値と真値は従来どおり文字列化される', () => {
  assert.equal(escapeXml(42), '42');
  assert.equal(escapeXml(true), 'true');
});

test('escapeXml異常系: XML 1.0 で不正な制御文字は置換文字になり、タブ・改行は残る', () => {
  assert.equal(escapeXml('a\u0001b\u001Fc'), 'a\uFFFDb\uFFFDc');
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('escapeXml異常系: 単独サロゲートは置換文字になり、正しいペアはそのまま残る', () => {
  assert.equal(escapeXml('a\uD800b'), 'a\uFFFDb');
  assert.equal(escapeXml('a\uDC00b'), 'a\uFFFDb');
  assert.equal(escapeXml('a\u{1F389}b'), 'a\u{1F389}b');
});

// --- stripTags / summarize ---

test('stripTags異常系: 文字列化できない入力は空文字として扱う', () => {
  assert.equal(stripTags(evil()), '');
});

test('summarize異常系: 範囲外の文字参照を含む説明でも例外にならない', () => {
  assert.equal(summarize('x &#x110000; y'), 'x \uFFFD y');
});

test('summarize異常系: 切り詰めでサロゲートペアを割らない', () => {
  const text = 'x'.repeat(499) + '\u{1F389}' + 'y'.repeat(10);
  const out = summarize(text, 500);
  assert.equal(out, 'x'.repeat(499));
  assert.ok(!/[\uD800-\uDBFF]$/.test(out));
});

// --- toIsoDate ---

test('toIsoDate異常系: 文字列化できない値は空文字として扱う', () => {
  assert.equal(toIsoDate(evil()), '');
});

test('toIsoDate異常系: 存在しない日付 (繰り上がり) は空文字になる', () => {
  assert.equal(toIsoDate('2026-02-30T00:00:00Z'), '');
  assert.equal(toIsoDate('2026-02-29T00:00:00Z'), ''); // 2026年はうるう年でない
  assert.equal(toIsoDate('2026-04-31T00:00:00Z'), '');
  assert.equal(toIsoDate('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00.000Z'); // 実在するうるう日
});

// --- parseYouTubePlaylistItems ---

test('parseYouTubePlaylistItems異常系: タイトルが文字列化できない item は落とし、残りは取り込む', () => {
  const json = JSON.stringify({
    items: [
      { snippet: { ...goodSnippet, title: evil() } },
      { snippet: goodSnippet },
    ],
  });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].guid, 'abc12345678');
});

test('parseYouTubePlaylistItems異常系: videoId が文字列化できない item は落とす', () => {
  const json = itemJson({ ...goodSnippet, resourceId: { videoId: evil() } });
  assert.deepEqual(parseYouTubePlaylistItems(json, { id: 'f1' }), []);
});

test('parseYouTubePlaylistItems異常系: channelTitle が壊れていても author を空にして取り込む', () => {
  const json = itemJson({ ...goodSnippet, channelTitle: evil() });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].author, '');
});

test('parseYouTubePlaylistItems異常系: 説明に範囲外の文字参照があっても取り込む', () => {
  const json = itemJson({ ...goodSnippet, description: 'x &#x110000; y' });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, 'x \uFFFD y');
});

test('parseYouTubePlaylistItems異常系: publishedAt が存在しない日付なら公開日時は空になる', () => {
  const json = itemJson({ ...goodSnippet, publishedAt: '2026-02-30T00:00:00Z' });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].publishedAt, '');
});

test('parseYouTubePlaylistItems異常系: snippet がオブジェクトでない item は落とす', () => {
  const json = JSON.stringify({ items: [{ snippet: '文字列' }, { snippet: 42 }, { snippet: goodSnippet }] });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
});

test('parseYouTubePlaylistItems異常系: タイトルが数値なら文字列化して取り込む', () => {
  const json = itemJson({ ...goodSnippet, title: 42 });
  const entries = parseYouTubePlaylistItems(json, { id: 'f1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, '42');
});

// --- parseYouTubeDurations ---

test('parseYouTubeDurations異常系: duration が文字列化できない item は省き、残りは読む', () => {
  const json = JSON.stringify({
    items: [
      { id: 'v1', contentDetails: { duration: evil() } },
      { id: 'v2', contentDetails: { duration: 'PT1H2M3S' } },
    ],
  });
  assert.deepEqual(parseYouTubeDurations(json), { v2: 3723 });
});

test('parseYouTubeDurations異常系: 読めない duration は不明 (欠落) のままにする', () => {
  const json = JSON.stringify({
    items: [
      { id: 'v1', contentDetails: { duration: 'PT1.5S' } },
      { id: 'v2', contentDetails: { duration: 'PT' } },
      { id: 'v3', contentDetails: { duration: 3723 } },
      { id: 'v4', contentDetails: {} },
    ],
  });
  assert.deepEqual(parseYouTubeDurations(json), {});
});

// --- タイトル取得 (channels.list / playlists.list / ハンドル解決) ---

test('タイトル取得異常系: snippet.title が文字列化できなくても例外にならない', () => {
  const json = JSON.stringify({ items: [{ snippet: { title: evil() } }] });
  assert.equal(parseYouTubeChannelTitle(json), '');
  assert.equal(parseYouTubePlaylistTitle(json), '');
});

test('parseChannelLookupResponse異常系: id が文字列化できない場合は解決失敗 (null)', () => {
  const json = JSON.stringify({ items: [{ id: evil(), snippet: { title: 't' } }] });
  assert.equal(parseChannelLookupResponse(json), null);
});

test('parseChannelLookupResponse異常系: title が壊れていても id が読めれば解決する', () => {
  const json = JSON.stringify({ items: [{ id: 'UC1234567890ab', snippet: { title: evil() } }] });
  assert.deepEqual(parseChannelLookupResponse(json), { channelId: 'UC1234567890ab', title: '' });
});

// --- parseAudioUrlsMap ---

const NOW_SEC = Math.floor(Date.now() / 1000);

test('parseAudioUrlsMap異常系: url が文字列化できないエントリは落とし、残りは残す', () => {
  const json = JSON.stringify({
    v1: { url: evil(), ts: NOW_SEC },
    v2: { url: 'https://example.com/a.m4a', ts: NOW_SEC },
  });
  const map = parseAudioUrlsMap(json);
  assert.deepEqual(Object.keys(map), ['v2']);
});

test('parseAudioUrlsMap異常系: ts が真値や配列なら数として扱わずエントリを落とす', () => {
  const json = JSON.stringify({
    v1: { url: 'https://example.com/a.m4a', ts: true },
    v2: { url: 'https://example.com/a.m4a', ts: [NOW_SEC] },
    v3: { url: 'https://example.com/a.m4a', ts: NOW_SEC },
    v4: { url: 'https://example.com/a.m4a', ts: String(NOW_SEC) },
  });
  const map = parseAudioUrlsMap(json);
  assert.deepEqual(Object.keys(map).sort(), ['v3', 'v4']);
  assert.equal(map.v4.ts, NOW_SEC);
});

test('parseAudioUrlsMap異常系: dur が真値や配列なら実尺として保持しない', () => {
  const json = JSON.stringify({
    v1: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur: true },
    v2: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur: [65] },
    v3: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur: 180 },
    v4: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur: '180' },
  });
  const map = parseAudioUrlsMap(json);
  assert.equal(map.v1.dur, undefined);
  assert.equal(map.v2.dur, undefined);
  assert.equal(map.v3.dur, 180);
  assert.equal(map.v4.dur, 180);
});

// --- buildRssXml ---

const RSS_ROW = {
  title: '動画タイトル',
  link: 'https://www.youtube.com/watch?v=abc12345678',
  published_at: '2026-01-01T00:00:00Z',
  fetched_at: '',
  summary: '要約',
};

test('buildRssXml異常系: null やオブジェクトでない行が混ざっても健全な行は出す', () => {
  const xml = buildRssXml(FEED, [null, '文字列', 42, RSS_ROW]);
  assert.equal((xml.match(/<item>/g) || []).length, 1);
  assert.ok(xml.includes('動画タイトル'));
});

test('buildRssXml異常系: articleRows が配列でなくても例外にならず0件で出す', () => {
  for (const rows of ['junk', 42, {}, null, undefined]) {
    const xml = buildRssXml(FEED, rows);
    assert.equal((xml.match(/<item>/g) || []).length, 0);
    assertXmlClean(xml);
  }
});

test('buildRssXml異常系: フィードのタイトルが文字列化できなくても例外にならない', () => {
  const xml = buildRssXml({ title: evil(), url: FEED.url }, [RSS_ROW]);
  assert.ok(xml.includes('<title></title>'));
  assert.equal((xml.match(/<item>/g) || []).length, 1);
});

test('buildRssXml異常系: feed が null でも例外にならない', () => {
  const xml = buildRssXml(null, [RSS_ROW]);
  assert.equal((xml.match(/<item>/g) || []).length, 1);
});

test('buildRssXml異常系: published_at が文字列化できない行は pubDate なしで出す', () => {
  const xml = buildRssXml(FEED, [{ ...RSS_ROW, published_at: evil() }]);
  assert.equal((xml.match(/<item>/g) || []).length, 1);
  assert.ok(!xml.includes('<pubDate>'));
});

test('buildRssXml異常系: published_at が不正な Date でも例外にならない', () => {
  const xml = buildRssXml(FEED, [{ ...RSS_ROW, published_at: new Date(NaN) }]);
  assert.equal((xml.match(/<item>/g) || []).length, 1);
  assert.ok(!xml.includes('<pubDate>'));
});

test('buildRssXml異常系: タイトルの制御文字や単独サロゲートは RSS を壊さない', () => {
  const xml = buildRssXml(FEED, [{ ...RSS_ROW, title: 'a\u0001b\uD800c', summary: 'x\uDC00y' }]);
  assertXmlClean(xml);
  assert.ok(xml.includes('a\uFFFDb\uFFFDc'));
});

test('buildRssXml異常系: enclosure の url が文字列化できない場合は付けない', () => {
  const audioUrls = { abc12345678: { url: evil(), ts: NOW_SEC } };
  const xml = buildRssXml(FEED, [RSS_ROW], audioUrls, '', null);
  assert.ok(!xml.includes('<enclosure'));
});

test('buildRssXml異常系: enclosure の ts が読めない場合は新鮮とみなさず付けない', () => {
  const audioUrls = { abc12345678: { url: 'https://example.com/a.m4a', ts: 'abc' } };
  const xml = buildRssXml(FEED, [RSS_ROW], audioUrls, '', null);
  assert.ok(!xml.includes('<enclosure'));
});

test('buildRssXml異常系: dur が真値や配列なら itunes:duration を付けない', () => {
  for (const dur of [true, [65], 'abc', {}]) {
    const audioUrls = { abc12345678: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur } };
    const xml = buildRssXml(FEED, [RSS_ROW], audioUrls, '', null);
    assert.ok(xml.includes('<enclosure'), 'enclosure 自体は付く');
    assert.ok(!xml.includes('itunes:duration'), 'dur=' + JSON.stringify(dur) + ' で duration を付けない');
  }
});

test('buildRssXml異常系: dur が数値文字列なら従来どおり整数秒で付ける', () => {
  const audioUrls = { abc12345678: { url: 'https://example.com/a.m4a', ts: NOW_SEC, dur: '180' } };
  const xml = buildRssXml(FEED, [RSS_ROW], audioUrls, '', null);
  assert.ok(xml.includes('<itunes:duration>180</itunes:duration>'));
});

test('buildRssXml異常系: 極端に長いタイトルでもそのまま出せる', () => {
  const longTitle = 'あ'.repeat(100000);
  const xml = buildRssXml(FEED, [{ ...RSS_ROW, title: longTitle }]);
  assert.ok(xml.includes(longTitle));
});

// --- videoIdFromLink ---

test('videoIdFromLink異常系: 文字列化できないリンクは空文字として扱う', () => {
  assert.equal(videoIdFromLink(evil()), '');
});
