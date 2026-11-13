import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowsToObjects,
  parseFeed,
  articleId,
  sha256Hex,
  sha256HexPure,
  stripTags,
  summarize,
  decodeXmlEntities,
  toIsoDate,
  isTruthy,
  isAllowedIdTokenPayload,
  hashesEqual,
  isSessionExpired,
  prunePlan,
  filterArticles,
} from '../src/main.js';

test('rowsToObjects: ヘッダーをキーにし空行を飛ばす', () => {
  assert.deepEqual(
    rowsToObjects([
      ['id', 'title'],
      ['a', 'A'],
      ['', ''],
      ['b', 'B'],
    ]),
    [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ]
  );
  assert.deepEqual(rowsToObjects(null), []);
  assert.deepEqual(rowsToObjects([['id']]), []);
});

test('sha256HexPure: 既知ベクトル', () => {
  assert.equal(sha256HexPure(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256HexPure('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('日本語テスト'), sha256HexPure('日本語テスト'));
});

test('articleId: 安定し、フィードや対象が変われば変わる', () => {
  const a = articleId('zenn', 'https://zenn.dev/example');
  assert.equal(a, articleId('zenn', 'https://zenn.dev/example'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, articleId('nhk', 'https://zenn.dev/example'));
  assert.notEqual(a, articleId('zenn', 'https://zenn.dev/other'));
});

test('decodeXmlEntities / stripTags / summarize', () => {
  assert.equal(decodeXmlEntities('a &amp; b &lt; c &#65;'), 'a & b < c A');
  assert.equal(stripTags('<p>Hello <b>world</b></p>'), 'Hello world');
  assert.equal(summarize('&lt;p&gt;hi&lt;/p&gt;'), 'hi');
  const long = summarize('x'.repeat(600));
  assert.equal(long.length, 500);
});

test('toIsoDate: RSSの日付もISOになる。不正は空文字', () => {
  assert.equal(toIsoDate('Sat, 14 Nov 2026 01:00:00 GMT'), '2026-11-14T01:00:00.000Z');
  assert.equal(toIsoDate('not a date'), '');
  assert.equal(toIsoDate(''), '');
});

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Sample RSS2</title>
    <item>
      <title><![CDATA[最初の記事]]></title>
      <link>https://example.com/a1</link>
      <guid isPermaLink="false">urn:example:a1</guid>
      <pubDate>Sat, 14 Nov 2026 01:00:00 GMT</pubDate>
      <description>&lt;p&gt;要約 &lt;b&gt;テスト&lt;/b&gt;です&lt;/p&gt;</description>
      <dc:creator>Author One</dc:creator>
    </item>
    <item>
      <title>二件目</title>
      <link>https://example.com/a2</link>
      <pubDate>Fri, 13 Nov 2026 01:00:00 GMT</pubDate>
      <description>plain summary</description>
    </item>
  </channel>
</rss>`;

test('parseFeed: RSS 2.0', () => {
  const items = parseFeed(RSS2, { id: 'sample-rss2' });
  assert.equal(items.length, 2);
  assert.equal(items[0].guid, 'urn:example:a1');
  assert.equal(items[0].title, '最初の記事');
  assert.equal(items[0].link, 'https://example.com/a1');
  assert.equal(items[0].publishedAt, '2026-11-14T01:00:00.000Z');
  assert.equal(items[0].summary, '要約 テスト です');
  assert.equal(items[0].author, 'Author One');
  assert.equal(items[0].feedId, 'sample-rss2');
  // guid が無い場合は link がキーになる
  assert.equal(items[1].guid, 'https://example.com/a2');
});

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/">
    <title>Sample RDF</title>
  </channel>
  <item rdf:about="https://example.com/r1">
    <title>RDFの記事</title>
    <link>https://example.com/r1</link>
    <dc:date>2026-11-14T10:00:00+09:00</dc:date>
    <description>RDF summary &amp; more</description>
    <dc:creator>RDF Author</dc:creator>
  </item>
</rdf:RDF>`;

test('parseFeed: RSS 1.0 / RDF', () => {
  const items = parseFeed(RDF, { id: 'sample-rdf' });
  assert.equal(items.length, 1);
  assert.equal(items[0].guid, 'https://example.com/r1');
  assert.equal(items[0].title, 'RDFの記事');
  assert.equal(items[0].publishedAt, '2026-11-14T01:00:00.000Z');
  assert.equal(items[0].summary, 'RDF summary & more');
  assert.equal(items[0].author, 'RDF Author');
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample Atom</title>
  <entry>
    <title>Atomの記事</title>
    <link rel="self" href="https://example.com/feed" />
    <link rel="alternate" href="https://example.com/e1" />
    <id>tag:example.com,2026:e1</id>
    <published>2026-11-13T09:00:00Z</published>
    <updated>2026-11-14T09:00:00Z</updated>
    <summary type="html">&lt;p&gt;Atom summary&lt;/p&gt;</summary>
    <author><name>Atom Author</name></author>
  </entry>
</feed>`;

test('parseFeed: Atom (alternate リンクと published を優先)', () => {
  const items = parseFeed(ATOM, { id: 'sample-atom' });
  assert.equal(items.length, 1);
  assert.equal(items[0].guid, 'tag:example.com,2026:e1');
  assert.equal(items[0].link, 'https://example.com/e1');
  assert.equal(items[0].publishedAt, '2026-11-13T09:00:00.000Z');
  assert.equal(items[0].summary, 'Atom summary');
  assert.equal(items[0].author, 'Atom Author');
});

test('parseFeed: 空・不正な入力は空配列', () => {
  assert.deepEqual(parseFeed('', { id: 'x' }), []);
  assert.deepEqual(parseFeed('not xml at all', { id: 'x' }), []);
});

test('isTruthy: シートの真値表現', () => {
  assert.equal(isTruthy(true), true);
  assert.equal(isTruthy('TRUE'), true);
  assert.equal(isTruthy('FALSE'), false);
  assert.equal(isTruthy(''), false);
});

test('isAllowedIdTokenPayload: オーナーの検証済みトークンだけ許可', () => {
  const good = { email: 'zegenvs@gmail.com', email_verified: 'true', aud: 'client-1' };
  assert.equal(isAllowedIdTokenPayload(good, 'client-1'), true);
  assert.equal(isAllowedIdTokenPayload(good, null), true);
  assert.equal(isAllowedIdTokenPayload(good, 'other-client'), false);
  assert.equal(isAllowedIdTokenPayload({ ...good, email: 'someone@example.com' }, null), false);
  assert.equal(isAllowedIdTokenPayload({ ...good, email_verified: 'false' }, null), false);
  assert.equal(isAllowedIdTokenPayload(null, null), false);
});

test('hashesEqual / isSessionExpired', () => {
  const h = sha256HexPure('token');
  assert.equal(hashesEqual(h, h), true);
  assert.equal(hashesEqual(h, sha256HexPure('other')), false);
  assert.equal(hashesEqual('', h), false);
  assert.equal(isSessionExpired('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'), true);
  assert.equal(isSessionExpired('2027-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'), false);
  assert.equal(isSessionExpired('', '2026-06-01T00:00:00.000Z'), true);
});

test('prunePlan: 古い既読は削除、未読とスターは保持、孤児stateを掃除', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'old-read', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'old-unread', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'old-starred', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'old-nostate', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'new-read', published_at: '2026-11-13T00:00:00.000Z', fetched_at: '' },
  ];
  const states = [
    { article_id: 'old-read', is_read: true, is_starred: false },
    { article_id: 'old-unread', is_read: false, is_starred: false },
    { article_id: 'old-starred', is_read: true, is_starred: true },
    { article_id: 'new-read', is_read: true, is_starred: false },
    { article_id: 'ghost', is_read: true, is_starred: false },
    { article_id: 'ghost-starred', is_read: false, is_starred: true },
  ];
  const plan = prunePlan(articles, states, now);
  assert.deepEqual(plan.deleteArticleIds.sort(), ['old-nostate', 'old-read']);
  assert.ok(plan.deleteStateIds.includes('old-read'));
  assert.ok(plan.deleteStateIds.includes('ghost'));
  assert.ok(!plan.deleteStateIds.includes('ghost-starred'));
  assert.ok(!plan.deleteStateIds.includes('old-starred'));
});

test('prunePlan: 上限を超えた既読は新しい順を残して削除', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'a1', published_at: '2026-11-11T00:00:00.000Z', fetched_at: '' },
    { id: 'a2', published_at: '2026-11-12T00:00:00.000Z', fetched_at: '' },
    { id: 'a3', published_at: '2026-11-13T00:00:00.000Z', fetched_at: '' },
  ];
  const states = articles.map((a) => ({ article_id: a.id, is_read: true, is_starred: false }));
  const plan = prunePlan(articles, states, now, { maxArticles: 2, retentionDays: 3650 });
  assert.deepEqual(plan.deleteArticleIds, ['a1']);
});

test('filterArticles: フィルタと新しい順ソート', () => {
  const articles = [
    { id: '1', feedId: 'zenn', publishedAt: '2026-11-12T00:00:00.000Z', isRead: true, isStarred: false },
    { id: '2', feedId: 'nhk', publishedAt: '2026-11-13T00:00:00.000Z', isRead: false, isStarred: true },
    { id: '3', feedId: 'zenn', publishedAt: '2026-11-14T00:00:00.000Z', isRead: false, isStarred: false },
  ];
  assert.deepEqual(filterArticles(articles, {}).map((a) => a.id), ['3', '2', '1']);
  assert.deepEqual(filterArticles(articles, { filter: 'unread' }).map((a) => a.id), ['3', '2']);
  assert.deepEqual(filterArticles(articles, { filter: 'starred' }).map((a) => a.id), ['2']);
  assert.deepEqual(filterArticles(articles, { feedId: 'zenn' }).map((a) => a.id), ['3', '1']);
});
