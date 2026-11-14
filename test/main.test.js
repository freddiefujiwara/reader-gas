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
  feedIdsForCategory,
  toFeedBool,
  parseFeedUrl,
  validateFeedInput,
  buildFeedRow,
  feedRowValues,
  feedToApiShape,
  countUnreadByFeed,
  remainingRowsAfterDelete,
  reorderRowsByIds,
  validateFeedOrder,
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

test('toFeedBool: 真偽値と文字列形式、未指定はフォールバック', () => {
  assert.equal(toFeedBool(true, false), true);
  assert.equal(toFeedBool(false, true), false);
  assert.equal(toFeedBool('TRUE', false), true);
  assert.equal(toFeedBool('FALSE', true), false);
  assert.equal(toFeedBool('true', false), true);
  assert.equal(toFeedBool(undefined, true), true);
  assert.equal(toFeedBool(null, false), false);
  assert.equal(toFeedBool('', true), true);
});

test('parseFeedUrl: https のみ許可しホストを返す', () => {
  assert.deepEqual(parseFeedUrl('https://zenn.dev/feed'), { ok: true, url: 'https://zenn.dev/feed', host: 'zenn.dev' });
  assert.equal(parseFeedUrl('https://a.ze.gs:443/mfcf.xml').host, 'a.ze.gs');
  assert.equal(parseFeedUrl('http://example.com/feed').ok, false);
  assert.equal(parseFeedUrl('ftp://example.com/feed').ok, false);
  assert.equal(parseFeedUrl('not a url').ok, false);
  assert.equal(parseFeedUrl('https://').ok, false);
  assert.equal(parseFeedUrl('https://exa mple.com/feed').ok, false);
  assert.equal(parseFeedUrl('').ok, false);
  assert.equal(parseFeedUrl('https://example.com/feed').ok, true);
});

test('validateFeedInput: 正常系は正規化し、既定値を補う', () => {
  const r = validateFeedInput({ id: 'zenn', title: '  Zenn  ', url: 'https://zenn.dev/feed' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.feed, {
    id: 'zenn',
    title: 'Zenn',
    url: 'https://zenn.dev/feed',
    category: '',
    enabled: true,
    isPrivate: false,
  });
  const r2 = validateFeedInput({ id: 'nhk', title: 'NHK', url: 'https://www3.nhk.or.jp/rss/news/cat0.xml', category: ' news ', enabled: 'FALSE', isPrivate: false });
  assert.equal(r2.feed.category, 'news');
  assert.equal(r2.feed.enabled, false);
});

test('validateFeedInput: 不正な入力は ok:false と理由を返す', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  // id (slug)
  assert.equal(validateFeedInput({ ...base, id: '' }).ok, false);
  assert.equal(validateFeedInput({ ...base, id: 'Bad Slug' }).ok, false);
  assert.equal(validateFeedInput({ ...base, id: '-leading-hyphen' }).ok, false);
  assert.equal(validateFeedInput({ ...base, id: 'under_score' }).ok, false);
  assert.equal(validateFeedInput({ ...base, id: 'a'.repeat(65) }).ok, false);
  assert.equal(validateFeedInput({ ...base, id: 'a'.repeat(64) }).ok, true);
  // title
  assert.equal(validateFeedInput({ ...base, title: '' }).ok, false);
  assert.equal(validateFeedInput({ ...base, title: '   ' }).ok, false);
  // url
  assert.equal(validateFeedInput({ ...base, url: '' }).ok, false);
  assert.equal(validateFeedInput({ ...base, url: 'http://example.com/feed' }).ok, false);
  assert.match(validateFeedInput({ ...base, url: 'http://example.com/feed' }).message, /https/);
  assert.equal(validateFeedInput({ ...base, url: 'example.com/feed' }).ok, false);
  // feed 自体が無い
  assert.equal(validateFeedInput(null).ok, false);
  assert.equal(validateFeedInput(undefined).ok, false);
});

test('validateFeedInput: isPrivate は a.ze.gs のときだけ強制的に true、それ以外は常に false', () => {
  // 自前ホスト: 入力が false でも true になる
  const priv = validateFeedInput({ id: 'mfcf', title: 'MF', url: 'https://a.ze.gs/mfcf.xml', isPrivate: false });
  assert.equal(priv.ok, true);
  assert.equal(priv.feed.isPrivate, true);
  // 第三者ホスト: 入力が true でも false になる (トークン漏洩防止)
  const pub = validateFeedInput({ id: 'evil', title: 'Evil', url: 'https://example.com/feed', isPrivate: true });
  assert.equal(pub.ok, true);
  assert.equal(pub.feed.isPrivate, false);
  // サブドメインや類似ホストは対象外
  assert.equal(validateFeedInput({ id: 'sub', title: 'S', url: 'https://x.a.ze.gs/feed', isPrivate: true }).feed.isPrivate, false);
  assert.equal(validateFeedInput({ id: 'look', title: 'L', url: 'https://a.ze.gs.example.com/feed', isPrivate: true }).feed.isPrivate, false);
});

test('buildFeedRow: 新規はキャッシュ欄が空、更新は保持、URL変更で etag/last_modified だけ消える', () => {
  const feed = { id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech', enabled: true, isPrivate: false };
  const created = buildFeedRow(feed, null);
  assert.deepEqual(created, {
    id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech',
    enabled: true, is_private: false,
    etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '',
  });
  const existing = {
    id: 'zenn', title: 'Old', url: 'https://zenn.dev/feed', category: '',
    enabled: 'TRUE', is_private: 'FALSE',
    etag: '"abc"', last_modified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    last_fetched_at: '2026-11-14T00:00:00.000Z', last_status: '200', last_error: '',
  };
  const updated = buildFeedRow({ ...feed, title: 'Zenn 2' }, existing);
  assert.equal(updated.title, 'Zenn 2');
  assert.equal(updated.etag, '"abc"');
  assert.equal(updated.last_modified, 'Wed, 01 Jan 2026 00:00:00 GMT');
  assert.equal(updated.last_fetched_at, '2026-11-14T00:00:00.000Z');
  assert.equal(updated.last_status, '200');
  const moved = buildFeedRow({ ...feed, url: 'https://zenn.dev/rss' }, existing);
  assert.equal(moved.etag, '');
  assert.equal(moved.last_modified, '');
  assert.equal(moved.last_fetched_at, '2026-11-14T00:00:00.000Z');
  assert.equal(moved.last_status, '200');
});

test('feedRowValues: ヘッダー順に並べ、未知ヘッダーは空文字', () => {
  const row = buildFeedRow({ id: 'a', title: 'A', url: 'https://example.com/f', category: '', enabled: false, isPrivate: false }, null);
  assert.deepEqual(feedRowValues(row, ['id', 'url', 'enabled', 'etag']), ['a', 'https://example.com/f', false, '']);
});

test('feedToApiShape: シート表現をAPI形式へ変換する', () => {
  const shaped = feedToApiShape({
    id: 'x-freddie', title: 'X freddie', url: 'https://a.ze.gs/x.freddie.xml', category: 'private',
    enabled: 'TRUE', is_private: 'TRUE',
    last_status: '200', last_error: '', last_fetched_at: new Date('2026-11-14T00:15:30.088Z'),
  }, 7);
  assert.deepEqual(shaped, {
    id: 'x-freddie', title: 'X freddie', url: 'https://a.ze.gs/x.freddie.xml', category: 'private',
    enabled: true, isPrivate: true,
    lastStatus: '200', lastError: '', lastFetchedAt: '2026-11-14T00:15:30.088Z', unreadCount: 7,
  });
  assert.equal(feedToApiShape({ id: 'x' }).unreadCount, 0);
  assert.equal(feedToApiShape({ id: 'x' }).enabled, false);
});

test('countUnreadByFeed: 状態なしと未読を数え、既読は数えない', () => {
  const articles = [
    { id: 'a1', feed_id: 'zenn' },
    { id: 'a2', feed_id: 'zenn' },
    { id: 'a3', feed_id: 'zenn' },
    { id: 'b1', feed_id: 'nhk' },
    { id: 'b2', feed_id: 'nhk' },
  ];
  const states = [
    { article_id: 'a1', is_read: true, is_starred: false },
    { article_id: 'a2', is_read: 'FALSE', is_starred: false },
    { article_id: 'b1', is_read: 'TRUE', is_starred: false },
  ];
  assert.deepEqual(countUnreadByFeed(articles, states), { zenn: 2, nhk: 1 });
  assert.deepEqual(countUnreadByFeed([], []), {});
});

test('remainingRowsAfterDelete: 一致した行だけを取り除き、ヘッダーは残す', () => {
  const values = [
    ['id', 'title'],
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ];
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['b']), [
    ['id', 'title'],
    ['a', 'A'],
    ['c', 'C'],
  ]);
  // 複数 id
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['a', 'c']), [
    ['id', 'title'],
    ['b', 'B'],
  ]);
  // 全行削除でもヘッダーは残る
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['a', 'b', 'c']), [['id', 'title']]);
});

test('remainingRowsAfterDelete: id は String() で比較する（数値セル・数値 id）', () => {
  const values = [
    ['id', 'title'],
    [123, 'A'],
    ['456', 'B'],
  ];
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['123']), [
    ['id', 'title'],
    ['456', 'B'],
  ]);
  assert.deepEqual(remainingRowsAfterDelete(values, 0, [456]), [
    ['id', 'title'],
    [123, 'A'],
  ]);
});

test('remainingRowsAfterDelete: 一致なし・空 ids では元の行をそのまま返す', () => {
  const values = [
    ['id', 'title'],
    ['a', 'A'],
    ['b', 'B'],
  ];
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['zzz']), values);
  assert.deepEqual(remainingRowsAfterDelete(values, 0, []), values);
  assert.deepEqual(remainingRowsAfterDelete(values, 0, null), values);
  assert.deepEqual(remainingRowsAfterDelete(values, 0, undefined), values);
});

test('remainingRowsAfterDelete: keyIdx で指定した列で照合する', () => {
  const values = [
    ['feed_id', 'id'],
    ['zenn', 'a1'],
    ['nhk', 'a2'],
    ['zenn', 'a3'],
  ];
  assert.deepEqual(remainingRowsAfterDelete(values, 0, ['zenn']), [
    ['feed_id', 'id'],
    ['nhk', 'a2'],
  ]);
  assert.deepEqual(remainingRowsAfterDelete(values, 1, ['a2']), [
    ['feed_id', 'id'],
    ['zenn', 'a1'],
    ['zenn', 'a3'],
  ]);
});

test('reorderRowsByIds: feedIds の順に行を並び替え、ヘッダーは先頭のまま', () => {
  const values = [
    ['id', 'title'],
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ];
  assert.deepEqual(reorderRowsByIds(values, 0, ['c', 'a', 'b']), [
    ['id', 'title'],
    ['c', 'C'],
    ['a', 'A'],
    ['b', 'B'],
  ]);
});

test('reorderRowsByIds: 全件の順列では全行が1回ずつ残り、行の中身は無変更', () => {
  const values = [
    ['id', 'title', 'url', 'enabled'],
    ['a', 'A', 'https://a.example/feed', true],
    ['b', 'B', 'https://b.example/feed', false],
    ['c', 'C', 'https://c.example/feed', true],
    ['d', 'D', 'https://d.example/feed', false],
  ];
  const result = reorderRowsByIds(values, 0, ['d', 'c', 'b', 'a']);
  assert.deepEqual(result, [
    ['id', 'title', 'url', 'enabled'],
    ['d', 'D', 'https://d.example/feed', false],
    ['c', 'C', 'https://c.example/feed', true],
    ['b', 'B', 'https://b.example/feed', false],
    ['a', 'A', 'https://a.example/feed', true],
  ]);
  // 行そのものは同じ参照 (列の欠落・重複・書き換えがない)
  assert.equal(result[1], values[4]);
  assert.equal(result[4], values[1]);
});

test('reorderRowsByIds: 同じ順序なら入力と同一内容 (no-op)、idIdx の列で照合する', () => {
  const values = [
    ['title', 'id'],
    ['A', 'a'],
    ['B', 'b'],
  ];
  assert.deepEqual(reorderRowsByIds(values, 1, ['a', 'b']), values);
  assert.deepEqual(reorderRowsByIds(values, 1, ['b', 'a']), [
    ['title', 'id'],
    ['B', 'b'],
    ['A', 'a'],
  ]);
});

test('validateFeedOrder: 現在の全IDと集合が一致する順列だけを通す', () => {
  const current = ['a', 'b', 'c'];
  assert.deepEqual(validateFeedOrder(['c', 'a', 'b'], current), { ok: true });
  assert.deepEqual(validateFeedOrder(['a', 'b', 'c'], current), { ok: true });
  assert.deepEqual(validateFeedOrder([], []), { ok: true });
  // 配列でない・未指定
  assert.equal(validateFeedOrder(null, current).ok, false);
  assert.equal(validateFeedOrder('a,b,c', current).ok, false);
  // 重複
  assert.equal(validateFeedOrder(['a', 'a', 'b'], current).ok, false);
  // 欠け・余分・未知のID
  assert.equal(validateFeedOrder(['a', 'b'], current).ok, false);
  assert.equal(validateFeedOrder(['a', 'b', 'c', 'd'], current).ok, false);
  assert.equal(validateFeedOrder(['a', 'b', 'zzz'], current).ok, false);
  // 文字列でない要素・空文字
  assert.equal(validateFeedOrder(['a', 'b', 3], current).ok, false);
  assert.equal(validateFeedOrder(['a', 'b', ''], current).ok, false);
});

test('feedIdsForCategory: カテゴリに属する id を返す', () => {
  const feeds = [
    { id: 'a', category: '楽天' },
    { id: 'b', category: '投資・FIRE' },
    { id: 'c', category: '楽天' },
    { id: 'd', category: '' },
  ];
  assert.deepEqual(feedIdsForCategory(feeds, '楽天'), ['a', 'c']);
  assert.deepEqual(feedIdsForCategory(feeds, ''), []);
  assert.deepEqual(feedIdsForCategory(feeds, '無し'), []);
});

test('filterArticles: feedIds でカテゴリ単位に絞る', () => {
  const articles = [
    { id: '1', feedId: 'a', publishedAt: '2026-01-03T00:00:00.000Z', isRead: false, isStarred: false },
    { id: '2', feedId: 'b', publishedAt: '2026-01-02T00:00:00.000Z', isRead: false, isStarred: false },
    { id: '3', feed_id: 'c', publishedAt: '2026-01-01T00:00:00.000Z', isRead: false, isStarred: false },
  ];
  assert.deepEqual(filterArticles(articles, { feedIds: ['a', 'c'] }).map((x) => x.id), ['1', '3']);
  assert.deepEqual(filterArticles(articles, { feedIds: [] }), []);
});
