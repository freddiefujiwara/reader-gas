import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  rowsToObjects,
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
  buildListPayload,
  selectFetchTargets,
  youtubeChannelIdFromUrl,
  youtubeUploadsPlaylistId,
  parseYouTubePlaylistItems,
  youtubeApiErrorDetail,
  escapeXml,
  videoIdFromLink,
  toRfc822,
  buildRssXml,
  buildFetchUrl,
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
  appendNewEntries,
  fetchFeeds,
  issueSession,
  validateSession,
  validateShareToken,
  handleDeleteFeed,
  doGet,
  doPost,
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

test('prunePlan: 古い既読は削除、未読は保持、孤児stateを掃除', () => {
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
  assert.deepEqual(plan.deleteArticleIds.sort(), ['old-nostate', 'old-read', 'old-starred']);
  assert.ok(plan.deleteStateIds.includes('old-read'));
  assert.ok(plan.deleteStateIds.includes('old-starred'));
  assert.ok(plan.deleteStateIds.includes('ghost'));
  assert.ok(plan.deleteStateIds.includes('ghost-starred'));
  assert.ok(!plan.deleteStateIds.includes('old-unread'));
});

test('prunePlan: 公開日が古くても取り込みが新しい未読は保持する', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    // YouTube の過去動画のようなケース: 公開は数年前、取り込みは最近。
    { id: 'yt-old-video', published_at: '2022-06-01T00:00:00.000Z', fetched_at: '2026-11-14T00:00:00.000Z' },
    // 取り込み自体も古い未読は従来どおり掃除する。
    { id: 'stale-nostate', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '2026-08-01T00:00:00.000Z' },
  ];
  const plan = prunePlan(articles, [], now);
  assert.deepEqual(plan.deleteArticleIds, ['stale-nostate']);
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

test('filterArticles: 新しい順にソートする (publishedAt 優先、無ければ fetchedAt)', () => {
  const articles = [
    { id: '1', feedId: 'zenn', publishedAt: '2026-11-12T00:00:00.000Z', fetchedAt: '', isRead: true },
    { id: '2', feedId: 'nhk', publishedAt: '2026-11-13T00:00:00.000Z', fetchedAt: '', isRead: false },
    { id: '3', feedId: 'zenn', publishedAt: '', fetchedAt: '2026-11-14T00:00:00.000Z', isRead: false },
  ];
  assert.deepEqual(filterArticles(articles).map((a) => a.id), ['3', '2', '1']);
  assert.deepEqual(filterArticles([]), []);
  assert.deepEqual(filterArticles(null), []);
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
    id: 'x-freddie', title: 'X freddie', url: 'https://a.ze.gs/x.freddie.xml', fetchUrl: 'https://a.ze.gs/x.freddie.xml', category: 'private',
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

test('youtubeChannelIdFromUrl: videos.xml の URL から channel_id を抜く', () => {
  assert.equal(
    youtubeChannelIdFromUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A'),
    'UCxNfaRC6MbAnwSR1Dqqv69A'
  );
  assert.equal(youtubeChannelIdFromUrl('https://example.com/feed.xml'), '');
  assert.equal(youtubeChannelIdFromUrl('https://www.youtube.com/feeds/videos.xml?user=someone'), '');
});

test('selectFetchTargets: 有効な YouTube フィードだけを巡回対象にする', () => {
  const yt = (id, enabled) => ({
    id,
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A',
    enabled,
  });
  const feeds = [
    yt('yt-on', true),
    yt('yt-str', 'TRUE'),
    yt('yt-off', false),
    { id: 'rss-on', url: 'https://example.com/feed.xml', enabled: true },
    { id: 'priv-on', url: 'https://a.ze.gs/x.freddie.xml', enabled: true },
    { id: '', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A', enabled: true },
    { id: 'yt-nourl', url: '', enabled: true },
  ];
  assert.deepEqual(selectFetchTargets(feeds).map((f) => f.id), ['yt-on', 'yt-str']);
  assert.deepEqual(selectFetchTargets([]), []);
  assert.deepEqual(selectFetchTargets(null), []);
  assert.deepEqual(selectFetchTargets(undefined), []);
});

test('youtubeUploadsPlaylistId: UC の先頭を UU に替える', () => {
  assert.equal(youtubeUploadsPlaylistId('UCxNfaRC6MbAnwSR1Dqqv69A'), 'UUxNfaRC6MbAnwSR1Dqqv69A');
  assert.equal(youtubeUploadsPlaylistId(''), '');
});

test('parseYouTubePlaylistItems: playlistItems 応答を記事エントリへ正規化し、削除動画を除く', () => {
  const json = JSON.stringify({
    items: [
      { snippet: { title: '動画A', description: '説明A', publishedAt: '2026-11-13T00:00:00Z', channelTitle: 'ch', resourceId: { videoId: 'vidA' } } },
      { snippet: { title: 'Deleted video', publishedAt: '2026-11-12T00:00:00Z', channelTitle: 'ch', resourceId: { videoId: 'vidB' } } },
      { snippet: { title: '動画C', publishedAt: '2026-11-11T00:00:00Z', channelTitle: 'ch', resourceId: {} } },
    ],
  });
  const entries = parseYouTubePlaylistItems(json, { id: 'yt-x' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].guid, 'vidA');
  assert.equal(entries[0].link, 'https://www.youtube.com/watch?v=vidA');
  assert.equal(entries[0].title, '動画A');
  assert.equal(entries[0].feedId, 'yt-x');
  assert.deepEqual(parseYouTubePlaylistItems('not json', { id: 'yt-x' }), []);
});

test('youtubeApiErrorDetail: エラー応答から原因だけを抜く', () => {
  const body = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'keyInvalid' }] } });
  assert.equal(youtubeApiErrorDetail(body), ' - API key not valid. Please pass a valid API key.');
  assert.equal(youtubeApiErrorDetail('not json'), '');
  assert.equal(youtubeApiErrorDetail('{}'), '');
});

test('escapeXml: XML の特殊文字をエスケープする', () => {
  assert.equal(escapeXml('a & b <c> "d" \'e\''), 'a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  assert.equal(escapeXml('plain'), 'plain');
  assert.equal(escapeXml(''), '');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
});

test('videoIdFromLink: watch URL から動画IDを抜く。それ以外は空文字', () => {
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?list=PLx&v=abc-DEF_123'), 'abc-DEF_123');
  assert.equal(videoIdFromLink('https://example.com/articles/1'), '');
  assert.equal(videoIdFromLink(''), '');
});

test('toRfc822: ISO を RFC-822 (GMT) へ変換する。不正は空文字', () => {
  assert.equal(toRfc822('2026-11-14T01:00:00.000Z'), 'Sat, 14 Nov 2026 01:00:00 GMT');
  assert.equal(toRfc822('not a date'), '');
  assert.equal(toRfc822(''), '');
});

const YT_FEED_FOR_RSS = {
  id: 'yt-sample',
  title: 'Sample & Channel',
  url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A',
};

function ytArticleRow(publishedAt, videoId, title, summary) {
  return {
    id: 'row-' + videoId, feed_id: 'yt-sample', title,
    link: 'https://www.youtube.com/watch?v=' + videoId,
    published_at: publishedAt, fetched_at: publishedAt, summary, author: 'someone',
  };
}

test('buildRssXml: チャンネル情報とアイテムを RSS 2.0 で出す', () => {
  const xml = buildRssXml(YT_FEED_FOR_RSS, [
    ytArticleRow('2026-11-13T01:00:00.000Z', 'vidOld11111', '古い動画', 'old summary'),
    ytArticleRow('2026-11-14T01:00:00.000Z', 'vidNew22222', '新しい <動画> & テスト', 'new summary'),
  ]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<rss version="2.0">'));
  // チャンネル: タイトルはエスケープされ、リンクはチャンネルページ
  assert.ok(xml.includes('<title>Sample &amp; Channel</title>'));
  assert.ok(xml.includes('<link>https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A</link>'));
  assert.ok(xml.includes('<description>Sample &amp; Channel</description>'));
  // アイテム: タイトルの & < > がエスケープされる
  assert.ok(xml.includes('<title>新しい &lt;動画&gt; &amp; テスト</title>'));
  // guid はリンクから抜いた動画ID (isPermaLink="false")
  assert.ok(xml.includes('<guid isPermaLink="false">vidNew22222</guid>'));
  assert.ok(xml.includes('<guid isPermaLink="false">vidOld11111</guid>'));
  // pubDate は RFC-822
  assert.ok(xml.includes('<pubDate>Sat, 14 Nov 2026 01:00:00 GMT</pubDate>'));
  // description は summary、author はフィードタイトル
  assert.ok(xml.includes('<description>new summary</description>'));
  assert.ok(xml.includes('<author>Sample &amp; Channel</author>'));
  // 新しい順
  assert.ok(xml.indexOf('vidNew22222') < xml.indexOf('vidOld11111'));
});

test('buildRssXml: 最大50件に絞る', () => {
  const rows = [];
  for (let i = 0; i < 55; i++) {
    rows.push(ytArticleRow('2026-11-14T00:00:00.000Z', 'vid' + String(i).padStart(8, '0'), '動画' + i, ''));
  }
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows);
  assert.equal((xml.match(/<item>/g) || []).length, 50);
});

test('buildRssXml: published_at が無ければ fetched_at で並べ、pubDate にも使う', () => {
  const rows = [
    { ...ytArticleRow('', 'vidFetch111', 'A', ''), fetched_at: '2026-11-12T01:00:00.000Z' },
    { ...ytArticleRow('', 'vidFetch222', 'B', ''), fetched_at: '2026-11-13T01:00:00.000Z' },
  ];
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows);
  assert.ok(xml.indexOf('vidFetch222') < xml.indexOf('vidFetch111'));
  assert.ok(xml.includes('<pubDate>Fri, 13 Nov 2026 01:00:00 GMT</pubDate>'));
});

test('buildFetchUrl: YouTube は RSS 出力 URL、それ以外はフィード URL そのまま', () => {
  const base = 'https://script.google.com/macros/s/AKfycTEST/exec';
  const ytUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A';
  assert.equal(buildFetchUrl({ id: 'yt-sample', url: ytUrl }, base), base + '?rss=yt-sample');
  assert.equal(buildFetchUrl({ id: 'zenn', url: 'https://zenn.dev/feed' }, base), 'https://zenn.dev/feed');
  // ベース URL が取れない環境ではフィード URL にフォールバックする
  assert.equal(buildFetchUrl({ id: 'yt-sample', url: ytUrl }, ''), ytUrl);
});

test('feedToApiShape: fetchUrl が付く (YouTube は注入したベース URL で組み立てる)', () => {
  const base = 'https://script.google.com/macros/s/AKfycTEST/exec';
  const yt = feedToApiShape(
    { id: 'yt-sample', title: 'YT', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A' },
    0, base
  );
  assert.equal(yt.fetchUrl, base + '?rss=yt-sample');
  const normal = feedToApiShape({ id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed' }, 0, base);
  assert.equal(normal.fetchUrl, 'https://zenn.dev/feed');
});

test('buildListPayload: フィードに enabled が付き、無効フィードは false になる', () => {
  // GAS グローバルの最小スタブ (シートは行列だけを持つフェイク)。
  const tables = {
    feeds: [
      ['id', 'title', 'url', 'category', 'enabled', 'is_private', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', true, false, '', '', '', '', ''],
      ['yt-off', 'YT off', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A', '', false, false, '', '', '', '', ''],
    ],
    articles: [
      ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'],
      ['a1', 'zenn', '記事1', 'https://example.com/1', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '要約1', '著者1'],
      ['a2', 'zenn', '記事2', 'https://example.com/2', '2026-11-13T00:00:00.000Z', '2026-11-13T01:00:00.000Z', '', ''],
    ],
    states: [
      ['article_id', 'is_read', 'is_starred', 'read_at', 'starred_at', 'updated_at'],
      ['a1', true, false, '2026-11-14T02:00:00.000Z', '', '2026-11-14T02:00:00.000Z'],
    ],
  };
  const ss = {
    getSheetByName(name) {
      const values = tables[name];
      if (!values) return null;
      return { getDataRange: () => ({ getValues: () => values }) };
    },
  };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (k) => (k === 'SPREADSHEET_ID' ? 'fake-id' : null) }),
  };
  globalThis.SpreadsheetApp = { openById: () => ss };
  try {
    const payload = buildListPayload({});
    assert.equal(payload.ok, true);
    const byId = {};
    payload.feeds.forEach((f) => { byId[f.id] = f; });
    // クライアントは f.enabled !== false で取得対象から外すため、
    // 無効フィードには enabled:false が明示されなければならない。
    assert.equal(byId['zenn'].enabled, true);
    assert.equal(byId['yt-off'].enabled, false);
    assert.equal(byId['zenn'].unreadCount, 1);
    // 既読マージは残る (初回取り込みが id と isRead だけを使う)。
    assert.deepEqual(payload.articles.map((a) => [a.id, a.isRead]), [['a1', true], ['a2', false]]);
    // v1 の残り (author / isStarred / total / generatedAt / starredCount) は出さない。
    assert.ok(!('author' in payload.articles[0]));
    assert.ok(!('isStarred' in payload.articles[0]));
    assert.ok(!('total' in payload));
    assert.ok(!('generatedAt' in payload));
    assert.ok(!('starredCount' in byId['zenn']));
    // limit は効き、上限は 500 にクランプされる。
    assert.equal(buildListPayload({ limit: 1 }).articles.length, 1);
    assert.equal(buildListPayload({ limit: 9999 }).articles.length, 2);
  } finally {
    delete globalThis.PropertiesService;
    delete globalThis.SpreadsheetApp;
  }
});

// ============================================================
// 合成層 (Sheets / GAS グローバルに触る層) のテスト。
// main.js は GAS グローバルを関数の中でだけ参照するため、最小フェイクを
// globalThis に差し込んでハンドラや合成関数をそのまま呼べる。
// 差し込んだグローバルは各テストで必ず復元する (sha256Hex のように
// グローバルの有無で経路が変わる関数があるため)。
// ============================================================

const FEED_HEADERS_ROW = ['id', 'title', 'url', 'category', 'enabled', 'is_private', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
const ARTICLE_HEADERS_ROW = ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'];
const STATE_HEADERS_ROW = ['article_id', 'is_read', 'is_starred', 'read_at', 'starred_at', 'updated_at'];
const SESSION_HEADERS_ROW = ['token_hash', 'issued_at', 'expires_at', 'revoked_at', 'access_count', 'last_accessed_at', 'role'];

// GAS の computeDigest は符号付きバイト配列を返す。純JS実装の hex から再現する。
function hexToSignedBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}

let fakeUuidCounter = 0;
const fakeUtilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeDigest: (_algo, value) => hexToSignedBytes(sha256HexPure(String(value))),
  getUuid: () => '00000000-0000-4000-8000-' + String(++fakeUuidCounter).padStart(12, '0'),
};

// 行列だけを持つシートのフェイク。getDataRange().getValues() はコピーを返し、
// 書き込みは getRange().setValue/setValues・appendRow・deleteRow・clearContents で行う。
class FakeSheet {
  constructor(rows = []) {
    this.rows = rows.map((r) => r.slice());
  }
  getDataRange() {
    return { getValues: () => this.rows.map((r) => r.slice()) };
  }
  appendRow(row) {
    this.rows.push(row.slice());
  }
  getRange(row, col) {
    return {
      setValue: (v) => {
        while (this.rows.length < row) this.rows.push([]);
        this.rows[row - 1][col - 1] = v;
      },
      setValues: (vals) => {
        vals.forEach((r, i) => {
          while (this.rows.length < row + i) this.rows.push([]);
          r.forEach((v, j) => { this.rows[row + i - 1][col + j - 1] = v; });
        });
      },
    };
  }
  clearContents() {
    this.rows = [];
  }
  deleteRow(n) {
    this.rows.splice(n - 1, 1);
  }
}

class FakeSpreadsheet {
  constructor(tables = {}) {
    this.sheets = {};
    Object.entries(tables).forEach(([name, rows]) => { this.sheets[name] = new FakeSheet(rows); });
  }
  getSheetByName(name) {
    return this.sheets[name] || null;
  }
  insertSheet(name) {
    const sheet = new FakeSheet([]);
    this.sheets[name] = sheet;
    return sheet;
  }
}

function fakePropertiesService(initial = {}) {
  const store = { ...initial };
  return {
    store,
    service: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
      }),
    },
  };
}

function fakeContentService() {
  return {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      return {
        content: String(text),
        mimeType: '',
        setMimeType(m) { this.mimeType = m; return this; },
        getContent() { return this.content; },
      };
    },
  };
}

// 指定した GAS グローバルを差し込み、復元関数を返す。
function installGasGlobals(globals) {
  const saved = {};
  Object.entries(globals).forEach(([name, value]) => {
    saved[name] = globalThis[name];
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  });
  return () => {
    Object.entries(saved).forEach(([name, value]) => {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    });
  };
}

// スプレッドシートと基本プロパティをまとめて差し込む。
function installSpreadsheet(ss, extraProps = {}) {
  const props = fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', ...extraProps });
  return installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: props.service,
    ContentService: fakeContentService(),
    Utilities: fakeUtilities,
  });
}

test('parseYouTubePlaylistItems: 非公開動画と snippet 欠落を除き、items 欠落は空配列', () => {
  const json = JSON.stringify({
    items: [
      { snippet: { title: 'Private video', publishedAt: '2026-11-12T00:00:00Z', channelTitle: 'ch', resourceId: { videoId: 'vidP' } } },
      {},
      { snippet: null },
      { snippet: { title: '通常動画', publishedAt: '2026-11-13T00:00:00Z', channelTitle: 'ch', resourceId: { videoId: 'vidOK' } } },
    ],
  });
  const entries = parseYouTubePlaylistItems(json, { id: 'yt-x' });
  assert.deepEqual(entries.map((e) => e.guid), ['vidOK']);
  assert.deepEqual(parseYouTubePlaylistItems(JSON.stringify({}), { id: 'yt-x' }), []);
  assert.deepEqual(parseYouTubePlaylistItems(JSON.stringify({ items: null }), { id: 'yt-x' }), []);
});

test('parseYouTubePlaylistItems: 説明の HTML を除去し500字に切り、公開日時と著者を正規化する', () => {
  const description = '<p>' + 'あ'.repeat(600) + '</p>';
  const json = JSON.stringify({
    items: [
      { snippet: { title: '長文動画', description, publishedAt: '2026-11-13T01:02:03Z', channelTitle: 'テストチャンネル', resourceId: { videoId: 'vidLong' } } },
    ],
  });
  const [entry] = parseYouTubePlaylistItems(json, { id: 'yt-x' });
  assert.equal(entry.publishedAt, '2026-11-13T01:02:03.000Z');
  assert.equal(entry.summary, 'あ'.repeat(500));
  assert.equal(entry.author, 'テストチャンネル');
});

test('appendNewEntries: 既存と同一バッチ内の重複を抑止し、列順どおりに追記する', () => {
  const sheet = new FakeSheet([ARTICLE_HEADERS_ROW]);
  const feed = { id: 'yt-x' };
  const fetchedAt = '2026-11-14T05:00:00.000Z';
  const existingIds = { [articleId('yt-x', 'vidOld')]: true };
  const entries = [
    { guid: 'vidOld', title: '既存', link: 'https://www.youtube.com/watch?v=vidOld', publishedAt: '2026-11-10T00:00:00.000Z', summary: 'old', author: 'ch' },
    { guid: 'vidNew', title: '新規', link: 'https://www.youtube.com/watch?v=vidNew', publishedAt: '2026-11-13T00:00:00.000Z', summary: 'new', author: 'ch' },
    { guid: 'vidNew', title: '重複', link: 'https://www.youtube.com/watch?v=vidNew', publishedAt: '2026-11-13T00:00:00.000Z', summary: 'dup', author: 'ch' },
    { guid: '', title: 'リンクのみ', link: 'https://example.com/item', publishedAt: '2026-11-12T00:00:00.000Z', summary: 'linkonly', author: '' },
  ];
  const added = appendNewEntries(sheet, feed, entries, existingIds, fetchedAt);
  assert.equal(added, 2);
  assert.equal(sheet.rows.length, 3);
  // 列順は articles タブの定義 [id, feed_id, title, link, publishedAt, fetchedAt, summary, author]
  assert.deepEqual(sheet.rows[1], [
    articleId('yt-x', 'vidNew'), 'yt-x', '新規', 'https://www.youtube.com/watch?v=vidNew',
    '2026-11-13T00:00:00.000Z', fetchedAt, 'new', 'ch',
  ]);
  // guid が空ならリンクから ID を作る
  assert.deepEqual(sheet.rows[2], [
    articleId('yt-x', 'https://example.com/item'), 'yt-x', 'リンクのみ', 'https://example.com/item',
    '2026-11-12T00:00:00.000Z', fetchedAt, 'linkonly', '',
  ]);
});

function rssTestSpreadsheet() {
  return new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-rakutentech', '楽天テック', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0SZCr0g1dOpKAfAZoQjIHw', '', 'TRUE', 'FALSE', '', '', '', '200', ''],
      ['nhk', 'NHK ニュース', 'https://www3.nhk.or.jp/rss/news/cat0.xml', '', 'TRUE', 'FALSE', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['row1', 'yt-rakutentech', '動画その1', 'https://www.youtube.com/watch?v=vidTech1111', '2026-11-14T01:00:00.000Z', '2026-11-14T02:00:00.000Z', '概要1', '楽天テック'],
      ['row2', 'yt-rakutentech', '動画その2', 'https://www.youtube.com/watch?v=vidTech2222', '2026-11-13T01:00:00.000Z', '2026-11-13T02:00:00.000Z', '概要2', '楽天テック'],
      ['row3', 'yt-other', '別フィードの動画', 'https://www.youtube.com/watch?v=vidOther333', '2026-11-14T03:00:00.000Z', '2026-11-14T03:30:00.000Z', '概要3', '他'],
    ],
  });
}

test('doGet: ?rss= は対象フィードの記事だけを RSS で返す', () => {
  const restore = installSpreadsheet(rssTestSpreadsheet());
  try {
    const xml = doGet({ parameter: { rss: 'yt-rakutentech' } }).getContent();
    assert.ok(xml.startsWith('<?xml'));
    assert.ok(xml.includes('<rss version="2.0">'));
    assert.equal((xml.match(/<item>/g) || []).length, 2);
    assert.ok(xml.includes('動画その1'));
    assert.ok(xml.includes('動画その2'));
    assert.ok(!xml.includes('別フィードの動画'));
  } finally { restore(); }
});

test('doGet: 非 YouTube フィードと未知の ID は feed_not_found、無指定はヘルス応答', () => {
  const restore = installSpreadsheet(rssTestSpreadsheet());
  try {
    assert.deepEqual(JSON.parse(doGet({ parameter: { rss: 'nhk' } }).getContent()), { ok: false, error: 'feed_not_found' });
    assert.deepEqual(JSON.parse(doGet({ parameter: { rss: 'no-such-feed' } }).getContent()), { ok: false, error: 'feed_not_found' });
    assert.deepEqual(JSON.parse(doGet({ parameter: {} }).getContent()), { ok: true, service: 'reader-gas' });
    assert.deepEqual(JSON.parse(doGet({}).getContent()), { ok: true, service: 'reader-gas' });
  } finally { restore(); }
});

test('issueSession / validateSession: ハッシュだけを保存し、検証で access_count が増える', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  try {
    const issued = issueSession('owner');
    const sheet = ss.sheets['owner_sessions'];
    assert.ok(sheet, 'owner_sessions が自動作成される');
    assert.equal(sheet.rows.length, 2);
    const row = sheet.rows[1];
    // 生トークンはシートのどこにも残らない (保存されるのは SHA-256 ハッシュだけ)
    assert.ok(!JSON.stringify(sheet.rows).includes(issued.sessionToken));
    assert.equal(row[0], sha256HexPure(issued.sessionToken));
    // 期限は発行から約30日
    const ttlMs = Date.parse(row[2]) - Date.parse(row[1]);
    assert.ok(Math.abs(ttlMs - 30 * 24 * 60 * 60 * 1000) < 5000, 'TTL は約30日: ' + ttlMs);
    assert.equal(row[6], 'owner');
    // 検証が通り、呼ばれるたびに access_count が加算される
    const v1 = validateSession(issued.sessionToken);
    assert.equal(v1.role, 'owner');
    assert.equal(v1.expiresAt, issued.expiresAt);
    assert.equal(sheet.rows[1][4], 1);
    validateSession(issued.sessionToken);
    assert.equal(sheet.rows[1][4], 2);
    assert.ok(sheet.rows[1][5], 'last_accessed_at も記録される');
    // 無関係なトークン・空トークンは通らない
    assert.equal(validateSession('not-a-real-token'), null);
    assert.equal(validateSession(''), null);
  } finally { restore(); }
});

test('validateSession: 期限切れは拒否し、role 空欄は owner 扱い', () => {
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const ss = new FakeSpreadsheet({
    owner_sessions: [SESSION_HEADERS_ROW,
      [sha256HexPure('expired-token'), iso(now - 40 * 24 * 3600 * 1000), iso(now - 1000), '', 0, '', 'owner'],
      [sha256HexPure('blank-role-token'), iso(now), iso(now + 24 * 3600 * 1000), '', 0, '', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  try {
    assert.equal(validateSession('expired-token'), null);
    assert.equal(validateSession('blank-role-token').role, 'owner');
  } finally { restore(); }
});

test('validateShareToken: 未設定・期限切れ・不一致は false、一致だけ true', () => {
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const hash = sha256HexPure('share-token-1');
  const cases = [
    [{}, 'share-token-1', false],
    [{ SHARE_TOKEN_HASH: hash, SHARE_EXPIRES_AT: past }, 'share-token-1', false],
    [{ SHARE_TOKEN_HASH: hash, SHARE_EXPIRES_AT: future }, 'wrong-token', false],
    [{ SHARE_TOKEN_HASH: hash, SHARE_EXPIRES_AT: future }, 'share-token-1', true],
    [{ SHARE_TOKEN_HASH: hash }, 'share-token-1', false],
    [{ SHARE_TOKEN_HASH: hash, SHARE_EXPIRES_AT: future }, '', false],
  ];
  for (const [props, token, expected] of cases) {
    const fake = fakePropertiesService(props);
    const restore = installGasGlobals({ PropertiesService: fake.service, Utilities: fakeUtilities });
    try {
      assert.equal(validateShareToken(token), expected, JSON.stringify(props) + ' token=' + token);
    } finally { restore(); }
  }
});

test('doPost: セッション無しの list は unauthorized、不正な JSON は bad_request', () => {
  const restore = installSpreadsheet(new FakeSpreadsheet({}));
  try {
    const out = doPost({ postData: { contents: JSON.stringify({ action: 'list' }) } });
    assert.deepEqual(JSON.parse(out.getContent()), { ok: false, error: 'unauthorized' });
    const bad = doPost({ postData: { contents: 'not json' } });
    assert.deepEqual(JSON.parse(bad.getContent()), { ok: false, error: 'bad_request' });
  } finally { restore(); }
});

test('buildListPayload: limit は 500 にクランプされ、不正値は既定 100 に戻る', () => {
  const articles = [ARTICLE_HEADERS_ROW];
  const base = Date.parse('2026-11-01T00:00:00.000Z');
  for (let i = 0; i < 505; i++) {
    const t = new Date(base + i * 60000).toISOString();
    articles.push(['a' + i, 'zenn', '記事' + i, 'https://example.com/' + i, t, t, '', '']);
  }
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', 'TRUE', 'FALSE', '', '', '', '', '']],
    articles,
    states: [STATE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  try {
    assert.equal(buildListPayload({}).articles.length, 100);
    assert.equal(buildListPayload({ limit: 250 }).articles.length, 250);
    assert.equal(buildListPayload({ limit: 500 }).articles.length, 500);
    // クライアントは初回取り込みで 5000 を送ることがあるが、500 で止まる
    assert.equal(buildListPayload({ limit: 5000 }).articles.length, 500);
    assert.equal(buildListPayload({ limit: 'abc' }).articles.length, 100);
    assert.equal(buildListPayload({ limit: 0 }).articles.length, 100);
    assert.equal(buildListPayload({ limit: -3 }).articles.length, 100);
    assert.equal(buildListPayload({}).feeds[0].unreadCount, 505);
  } finally { restore(); }
});

test('buildListPayload: フィードは fetchUrl を持ち、応答形は slim のまま (キー集合を固定)', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-x', 'YT', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A', '', 'TRUE', 'FALSE', '', '', '', '', ''],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', 'FALSE', 'FALSE', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['a1', 'yt-x', '動画', 'https://www.youtube.com/watch?v=vidX111111', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', ''],
    ],
    states: [STATE_HEADERS_ROW, ['a1', 'TRUE', 'FALSE', '', '', '']],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' }).service,
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example.com/exec' }) },
    Utilities: fakeUtilities,
  });
  try {
    const payload = buildListPayload({});
    const byId = {};
    payload.feeds.forEach((f) => { byId[f.id] = f; });
    // YouTube は RSS 出力 URL、通常フィードは自 URL が fetchUrl になる
    assert.equal(byId['yt-x'].fetchUrl, 'https://example.com/exec?rss=yt-x');
    assert.equal(byId['zenn'].fetchUrl, 'https://zenn.dev/feed');
    assert.equal(byId['zenn'].enabled, false);
    assert.equal(byId['yt-x'].unreadCount, 0);
    // フィードのキー集合は slim 化後 (PR #16) の形に固定する
    assert.deepEqual(Object.keys(byId['yt-x']).sort(), ['category', 'enabled', 'fetchUrl', 'id', 'isPrivate', 'title', 'unreadCount', 'url']);
    // 状態マージ: states の is_read が isRead に反映される
    assert.equal(payload.articles[0].isRead, true);
  } finally { restore(); }
});

test('handleDeleteFeed: states → articles → feeds の順にカスケード削除する', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-a', 'A チャンネル', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A', '', 'TRUE', 'FALSE', '', '', '', '', ''],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', '', 'TRUE', 'FALSE', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['a1', 'yt-a', '記事1', 'https://example.com/1', '', '', '', ''],
      ['a2', 'yt-a', '記事2', 'https://example.com/2', '', '', '', ''],
      ['b1', 'zenn', '記事B', 'https://example.com/b', '', '', '', ''],
    ],
    states: [STATE_HEADERS_ROW,
      ['a1', 'TRUE', 'FALSE', '', '', ''],
      ['a2', 'FALSE', 'FALSE', '', '', ''],
      ['b1', 'TRUE', 'FALSE', '', '', ''],
    ],
  });
  // 削除の実行順を記録する (states の全件書き戻し → articles の全件書き戻し → feeds の行削除)
  const order = [];
  const wrap = (sheet, label, method) => {
    const orig = sheet[method].bind(sheet);
    sheet[method] = (...args) => { order.push(label); return orig(...args); };
  };
  wrap(ss.sheets['states'], 'states', 'clearContents');
  wrap(ss.sheets['articles'], 'articles', 'clearContents');
  wrap(ss.sheets['feeds'], 'feeds', 'deleteRow');
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(handleDeleteFeed({ feedId: 'yt-a' }), { ok: true });
    assert.deepEqual(order, ['states', 'articles', 'feeds']);
    assert.deepEqual(ss.sheets['states'].rows.map((r) => r[0]), ['article_id', 'b1']);
    assert.deepEqual(ss.sheets['articles'].rows.map((r) => r[0]), ['id', 'b1']);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'zenn']);
  } finally { restore(); }
});

test('handleDeleteFeed: 未知の ID は not_found で、行は変わらない', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ['zenn', 'Zenn', 'https://zenn.dev/feed', '', 'TRUE', 'FALSE', '', '', '', '', '']],
    articles: [ARTICLE_HEADERS_ROW],
    states: [STATE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(handleDeleteFeed({ feedId: 'nope' }), { ok: false, error: 'not_found' });
    assert.deepEqual(handleDeleteFeed({}), { ok: false, error: 'not_found' });
    assert.equal(ss.sheets['feeds'].rows.length, 2);
  } finally { restore(); }
});

// fetchFeeds の行更新意味論。FEEDS_HEADERS の列位置: last_fetched_at=8, last_status=9, last_error=10。
function fetchTestEnv({ apiKey, responder }) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-x', 'YT チャンネル', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A', '', 'TRUE', 'FALSE', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
    // states は fetchFeeds が getSheetOrCreate で作る
  });
  const props = { SPREADSHEET_ID: 'fake-spreadsheet-id' };
  if (apiKey !== undefined) props.YOUTUBE_API_KEY = apiKey;
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService(props).service,
    UrlFetchApp: { fetch: (url) => responder(url) },
    Utilities: fakeUtilities,
  });
  return { ss, restore };
}

test('fetchFeeds: YOUTUBE_API_KEY 未設定なら行に error と理由を記録する', () => {
  const { ss, restore } = fetchTestEnv({
    responder: () => { throw new Error('fetch must not be called without an API key'); },
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    assert.equal(result.fetched, 1);
    assert.equal(result.added, 0);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[9], 'error');
    assert.equal(row[10], 'YOUTUBE_API_KEY is not set');
    assert.ok(row[8], 'last_fetched_at も記録される');
  } finally { restore(); }
});

test('fetchFeeds: HTTP 403 は API の詳細を含むエラー文を行に記録する', () => {
  const body = JSON.stringify({
    error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] },
  });
  const { ss, restore } = fetchTestEnv({
    apiKey: 'fake-api-key',
    responder: () => ({ getResponseCode: () => 403, getContentText: () => body }),
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.added, 0);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[9], 'error');
    assert.ok(row[10].startsWith('YouTube API HTTP 403'), row[10]);
    assert.ok(row[10].includes('exceeded your quota'), row[10]);
    assert.ok(row[10].length <= 500, row[10]);
  } finally { restore(); }
});

test('fetchFeeds: 長い API エラーは詳細200字で切り、行の記録も500字以内に収まる', () => {
  const body = JSON.stringify({ error: { code: 403, message: 'x'.repeat(400), errors: [{ reason: 'r' }] } });
  const { ss, restore } = fetchTestEnv({
    apiKey: 'fake-api-key',
    responder: () => ({ getResponseCode: () => 403, getContentText: () => body }),
  });
  try {
    fetchFeeds();
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[9], 'error');
    assert.equal(row[10], 'YouTube API HTTP 403 - ' + 'x'.repeat(200));
  } finally { restore(); }
});

test('fetchFeeds: 成功時は last_status 200・last_error 空になり、記事が追記される', () => {
  const body = JSON.stringify({
    items: [
      { snippet: { title: '新着動画', description: '説明', publishedAt: '2026-11-14T00:00:00Z', channelTitle: 'YT チャンネル', resourceId: { videoId: 'vidNew12345' } } },
    ],
  });
  const { ss, restore } = fetchTestEnv({
    apiKey: 'fake-api-key',
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[9], '200');
    assert.equal(row[10], '');
    const articles = ss.sheets['articles'].rows;
    assert.equal(articles.length, 2);
    assert.equal(articles[1][1], 'yt-x');
    assert.equal(articles[1][2], '新着動画');
  } finally { restore(); }
});

test('reorderRowsByIds: feedIds に無い行は元の順で末尾に残り、重複 ID は二重化しない', () => {
  const values = [
    ['id', 'title'],
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ];
  // b が feedIds に無い → 末尾に元の順で残る
  assert.deepEqual(reorderRowsByIds(values, 0, ['c', 'a']), [
    ['id', 'title'],
    ['c', 'C'],
    ['a', 'A'],
    ['b', 'B'],
  ]);
  // 重複した ID を渡しても行は1回だけ現れる
  assert.deepEqual(reorderRowsByIds(values, 0, ['b', 'b', 'a']), [
    ['id', 'title'],
    ['b', 'B'],
    ['a', 'A'],
    ['c', 'C'],
  ]);
  // 未知の ID は無視される
  assert.deepEqual(reorderRowsByIds(values, 0, ['zzz', 'a']), [
    ['id', 'title'],
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ]);
});

test('youtubeApiErrorDetail: message が空なら reason にフォールバックし、詳細は200字で切る', () => {
  const emptyMsg = JSON.stringify({ error: { code: 403, message: '', errors: [{ reason: 'quotaExceeded' }] } });
  assert.equal(youtubeApiErrorDetail(emptyMsg), ' - quotaExceeded');
  const noMsgField = JSON.stringify({ error: { code: 403, errors: [{ reason: 'keyInvalid' }] } });
  assert.equal(youtubeApiErrorDetail(noMsgField), ' - keyInvalid');
  const long = JSON.stringify({ error: { code: 400, message: 'x'.repeat(300), errors: [] } });
  assert.equal(youtubeApiErrorDetail(long), ' - ' + 'x'.repeat(200));
});

test('youtubeUploadsPlaylistId: UC で始まらない ID は空文字', () => {
  assert.equal(youtubeUploadsPlaylistId('PLxNfaRC6MbAnwSR1Dqqv69A'), '');
  assert.equal(youtubeUploadsPlaylistId('UUxNfaRC6MbAnwSR1Dqqv69A'), '');
  assert.equal(youtubeUploadsPlaylistId(null), '');
});

test('toFeedBool: 数値 1/0 も真偽として扱う', () => {
  assert.equal(toFeedBool(1, false), true);
  assert.equal(toFeedBool(0, true), false);
});

test('hashesEqual: 大文字小文字を区別しない', () => {
  const h = sha256HexPure('token');
  assert.equal(hashesEqual(h.toUpperCase(), h), true);
  assert.equal(hashesEqual(h, h.toUpperCase()), true);
});

test('isSessionExpired: 期限ちょうどで期限切れ扱い', () => {
  assert.equal(isSessionExpired('2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'), true);
});

test('videoIdFromLink: 6字未満の v= は ID として扱わない', () => {
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?v=abc'), '');
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?v=abcde'), '');
  assert.equal(videoIdFromLink('https://www.youtube.com/watch?v=abcdef'), 'abcdef');
});

test('buildRssXml: 日付が無いアイテムは pubDate を出さず、v= が無いリンクは guid が空になる', () => {
  const rows = [
    { id: 'r1', feed_id: 'yt-sample', title: '日付なし', link: 'https://www.youtube.com/watch?v=vidDateless', published_at: '', fetched_at: '', summary: '', author: '' },
    { id: 'r2', feed_id: 'yt-sample', title: 'リンクに v= なし', link: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', published_at: '2026-11-14T01:00:00.000Z', fetched_at: '', summary: '', author: '' },
  ];
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows);
  assert.equal((xml.match(/<pubDate>/g) || []).length, 1);
  assert.ok(xml.includes('<guid isPermaLink="false"></guid>'));
});

test('buildRssXml: 記事0件でもチャンネルだけの整った形になる', () => {
  const xml = buildRssXml(YT_FEED_FOR_RSS, []);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<channel>'));
  assert.ok(!xml.includes('<item>'));
  assert.ok(xml.indexOf('</channel>') >= 0 && xml.indexOf('</channel>') < xml.indexOf('</rss>'));
  assert.ok(xml.trimEnd().endsWith('</rss>'));
});

test('buildRssXml: summary の特殊文字をエスケープし、Date オブジェクトのセルも日付として扱う', () => {
  const rows = [
    { id: 'r1', feed_id: 'yt-sample', title: 'T', link: 'https://www.youtube.com/watch?v=vidDateCell1', published_at: new Date('2026-11-14T01:00:00.000Z'), fetched_at: '', summary: 'a <b> & "c"', author: '' },
  ];
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows);
  assert.ok(xml.includes('<description>a &lt;b&gt; &amp; &quot;c&quot;</description>'));
  assert.ok(xml.includes('<pubDate>Sat, 14 Nov 2026 01:00:00 GMT</pubDate>'));
});

test('prunePlan: ちょうど60日では消えず、61日で消える (境界は >)', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const mk = (fetched) => [{ id: 'a', published_at: '', fetched_at: fetched }];
  // 2026-09-15 → 2026-11-14 はちょうど60日
  assert.deepEqual(prunePlan(mk('2026-09-15T00:00:00.000Z'), [], now).deleteArticleIds, []);
  assert.deepEqual(prunePlan(mk('2026-09-14T00:00:00.000Z'), [], now).deleteArticleIds, ['a']);
});

test('prunePlan: 未読 (状態あり・未読) は件数上限を超えても保持される', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const day = (d) => '2026-11-' + d + 'T00:00:00.000Z';
  const articles = [
    { id: 'a4', published_at: day('14'), fetched_at: day('14') },
    { id: 'a3', published_at: day('13'), fetched_at: day('13') },
    { id: 'a2', published_at: day('12'), fetched_at: day('12') },
    { id: 'a1', published_at: day('11'), fetched_at: day('11') },
  ];
  const states = [
    { article_id: 'a1', is_read: false },
    { article_id: 'a2', is_read: true },
    { article_id: 'a3', is_read: true },
    { article_id: 'a4', is_read: true },
  ];
  const plan = prunePlan(articles, states, now, { maxArticles: 2, retentionDays: 3650 });
  // 上限2件に対し、既読の a2 だけが落ちる。未読の a1 は上限外でも残る
  assert.deepEqual(plan.deleteArticleIds, ['a2']);
  assert.deepEqual(plan.deleteStateIds, ['a2']);
});

test('prunePlan: 日付の無い記事は上限超過のときだけ消える', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'd1', published_at: '', fetched_at: '' },
    { id: 'd2', published_at: '', fetched_at: '' },
  ];
  assert.deepEqual(prunePlan(articles, [], now, { maxArticles: 5 }).deleteArticleIds, []);
  assert.deepEqual(prunePlan(articles, [], now, { maxArticles: 1 }).deleteArticleIds, ['d2']);
});

test('dist/Code.gs: export 文が残らず、スクリプトとして構文が通る', () => {
  // npm test は先に node build.js を回すため、dist/Code.gs は常に最新の生成結果。
  const code = readFileSync(new URL('../dist/Code.gs', import.meta.url), 'utf8');
  assert.ok(!/^\s*export\b/m.test(code), 'dist/Code.gs に export 文が残っている');
  new vm.Script(code); // 構文が壊れていれば SyntaxError で落ちる
});
