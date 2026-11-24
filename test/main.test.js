import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  rowsToObjects,
  articleId,
  feedIdFromUrl,
  sha256Hex,
  sha256HexPure,
  stripTags,
  summarize,
  decodeXmlEntities,
  toIsoDate,
  isTruthy,
  isAllowedIdTokenPayload,
  verifyIdToken,
  hashesEqual,
  isSessionExpired,
  prunePlan,
  filterArticles,
  buildListPayload,
  selectFetchTargets,
  youtubeChannelIdFromUrl,
  youtubeFeedUrlFromChannelId,
  youtubePlaylistIdFromUrl,
  youtubeFeedUrlFromPlaylistId,
  parseYouTubeChannelUrl,
  youtubeUploadsPlaylistId,
  parseYouTubePlaylistItems,
  parseYouTubeNextPageToken,
  parseYouTubeChannelTitle,
  parseYouTubePlaylistTitle,
  parseYouTubeDurations,
  parseChannelLookupResponse,
  youtubeApiErrorDetail,
  parseAudioUrlsMap,
  utf8ByteLength,
  scriptCache,
  rssCacheKey,
  invalidateRssCache,
  getAudioUrlsMapFromCache,
  putAudioUrlsMapCache,
  scriptBaseUrl,
  fetchAudioUrlsMap,
  ytPlayUrl,
  planYouTubeAudioTriggers,
  normalizeStarMode,
  normalizeStarCount,
  normalizeStarMinSec,
  starSettingsOf,
  effectiveStarRule,
  planStarSelection,
  normalizePastGuard,
  pastGuardOf,
  computeStarredArticleIds,
  planStarredAudioTriggers,
  fireYouTubeAudioTriggers,
  escapeXml,
  videoIdFromLink,
  toRfc822,
  buildRssXml,
  buildFetchUrl,
  parseFeedUrl,
  validateFeedInput,
  buildFeedRow,
  feedRowValues,
  feedToApiShape,
  countUnreadByFeed,
  remainingRowsAfterDelete,
  reorderRowsByIds,
  validateFeedOrder,
  groupRowsByCategory,
  regroupFeedsByCategory,
  appendNewEntries,
  parseYouTubeSubscriptionsPage,
  fetchMyYouTubeSubscriptions,
  planYouTubeSubscriptionSync,
  syncYouTubeSubscriptions,
  planPlaylistArticleDeletions,
  fetchFeeds,
  issueSession,
  validateSession,
  validateShareToken,
  shareLinkStatus,
  issueShareLink,
  getShareLinkStatus,
  revokeShareLink,
  handleSaveFeed,
  handleDeleteFeed,
  handleSetStar,
  sanitizeEvent,
  sanitizeEventBatch,
  handleLogEvents,
  aggregateFeedStats,
  buildFeedStatsPayload,
  planEventPrune,
  pruneOldEvents,
  maybePruneOldEvents,
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
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ ALLOWED_EMAIL: 'owner@example.com' }).service,
  });
  try {
    const good = { email: 'owner@example.com', email_verified: 'true', aud: 'client-1' };
    assert.equal(isAllowedIdTokenPayload(good, 'client-1'), true);
    assert.equal(isAllowedIdTokenPayload(good, null), true);
    assert.equal(isAllowedIdTokenPayload(good, 'other-client'), false);
    assert.equal(isAllowedIdTokenPayload({ ...good, email: 'someone@example.com' }, null), false);
    assert.equal(isAllowedIdTokenPayload({ ...good, email_verified: 'false' }, null), false);
    assert.equal(isAllowedIdTokenPayload(null, null), false);
  } finally { restore(); }
});

test('isAllowedIdTokenPayload: ALLOWED_EMAIL プロパティ未設定なら全て拒否 (fail-closed)', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({}).service,
  });
  try {
    const good = { email: 'owner@example.com', email_verified: 'true', aud: 'client-1' };
    assert.equal(isAllowedIdTokenPayload(good, 'client-1'), false);
  } finally { restore(); }
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

test('prunePlan: 保持期間を超えた記事は削除し、新しい記事は保持する', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'old-1', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'old-2', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '' },
    { id: 'new-1', published_at: '2026-11-13T00:00:00.000Z', fetched_at: '' },
  ];
  const plan = prunePlan(articles, now);
  assert.deepEqual(plan.deleteArticleIds.sort(), ['old-1', 'old-2']);
  // states 廃止に伴い、状態行の削除計画は返さない。
  assert.ok(!('deleteStateIds' in plan));
});

test('prunePlan: 公開日が古くても取り込みが新しい記事は保持する', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    // YouTube の過去動画のようなケース: 公開は数年前、取り込みは最近。
    { id: 'yt-old-video', published_at: '2022-06-01T00:00:00.000Z', fetched_at: '2026-11-14T00:00:00.000Z' },
    // 取り込み自体も古い記事は掃除する。
    { id: 'stale', published_at: '2026-08-01T00:00:00.000Z', fetched_at: '2026-08-01T00:00:00.000Z' },
  ];
  const plan = prunePlan(articles, now);
  assert.deepEqual(plan.deleteArticleIds, ['stale']);
});

test('prunePlan: 上限を超えた記事は新しい順を残して削除', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'a1', published_at: '2026-11-11T00:00:00.000Z', fetched_at: '' },
    { id: 'a2', published_at: '2026-11-12T00:00:00.000Z', fetched_at: '' },
    { id: 'a3', published_at: '2026-11-13T00:00:00.000Z', fetched_at: '' },
  ];
  const plan = prunePlan(articles, now, { maxArticles: 2, retentionDays: 3650 });
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

test('parseFeedUrl: https のみ許可しホストを返す', () => {
  assert.deepEqual(parseFeedUrl('https://zenn.dev/feed'), { ok: true, url: 'https://zenn.dev/feed', host: 'zenn.dev' });
  assert.equal(parseFeedUrl('https://example.com:443/mfcf.xml').host, 'example.com');
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
  });
  const r2 = validateFeedInput({ id: 'nhk', title: 'NHK', url: 'https://www3.nhk.or.jp/rss/news/cat0.xml', category: ' news ', enabled: 'FALSE', isPrivate: false });
  assert.equal(r2.feed.category, 'news');
  // enabled / isPrivate は廃止: 入力にあっても無視され、正規化結果に含まれない。
  assert.ok(!('enabled' in r2.feed));
  assert.ok(!('isPrivate' in r2.feed));
});

test('validateFeedInput: 不正な入力は ok:false と理由を返す', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  // id (slug): 指定があれば形式を検証する。空は「未指定」として許可される
  // (追加時の ID は URL のハッシュで決まる。専用テストで固定する)。
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

test('buildFeedRow: 新規はキャッシュ欄が空、更新は保持、URL変更で etag/last_modified だけ消える', () => {
  const feed = { id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech' };
  const created = buildFeedRow(feed, null);
  assert.deepEqual(created, {
    id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech',
    etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '', sort_order: '', sync_deletes: '',
    star_mode: '', star_count: '', star_min_sec: '', past_guard: '',
  });
  const existing = {
    id: 'zenn', title: 'Old', url: 'https://zenn.dev/feed', category: '',
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
  const row = buildFeedRow({ id: 'a', title: 'A', url: 'https://example.com/f', category: '' }, null);
  assert.deepEqual(feedRowValues(row, ['id', 'url', 'etag']), ['a', 'https://example.com/f', '']);
});

test('buildFeedRow: 行は10列 (enabled / is_private 列は撤去済み、sort_order を末尾に追加)', () => {
  const row = buildFeedRow({ id: 'a', title: 'A', url: 'https://example.com/f', category: '' }, null);
  const values = feedRowValues(row);
  assert.equal(values.length, 10);
});

test('feedToApiShape: シート表現をAPI形式へ変換する', () => {
  const shaped = feedToApiShape({
    id: 'x-freddie', title: 'X freddie', url: 'https://example.com/x.freddie.xml', category: 'private',
    last_status: '200', last_error: '', last_fetched_at: new Date('2026-11-14T00:15:30.088Z'),
  }, 7);
  assert.deepEqual(shaped, {
    id: 'x-freddie', title: 'X freddie', url: 'https://example.com/x.freddie.xml', fetchUrl: 'https://example.com/x.freddie.xml', category: 'private', sortDirection: 'desc', syncDeletes: false, starMode: null, starCount: null, starMinSec: null, pastGuard: null,
    lastStatus: '200', lastError: '', lastFetchedAt: '2026-11-14T00:15:30.088Z', unreadCount: 7,
  });
  assert.equal(feedToApiShape({ id: 'x' }).unreadCount, 0);
  // enabled / isPrivate は廃止: 行に値があっても API 形式には出さない。
  assert.ok(!('enabled' in feedToApiShape({ id: 'x', enabled: 'FALSE' })));
  assert.ok(!('isPrivate' in feedToApiShape({ id: 'x', is_private: 'TRUE' })));
});

test('sort_order: validateFeedInput は asc / desc を受理し、不正値を弾き、未指定はキーなし', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  assert.equal(validateFeedInput({ ...base, sortDirection: 'asc' }).feed.sortDirection, 'asc');
  assert.equal(validateFeedInput({ ...base, sortDirection: ' DESC ' }).feed.sortDirection, 'desc');
  assert.equal(validateFeedInput({ ...base, sortDirection: 'up' }).ok, false);
  assert.ok(!('sortDirection' in validateFeedInput(base).feed));
});

test('sort_order: buildFeedRow は明示を反映し、未指定では既存行の値を引き継ぐ', () => {
  const feed = { id: 'a', title: 'A', url: 'https://example.com/f', category: '' };
  assert.equal(buildFeedRow({ ...feed, sortDirection: 'asc' }, null).sort_order, 'asc');
  assert.equal(buildFeedRow({ ...feed, sortDirection: 'desc' }, null).sort_order, '');
  const existingAsc = { ...feed, etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '', sort_order: 'asc' };
  // 並び順を送らない編集では、シート側の asc を消さない。
  assert.equal(buildFeedRow(feed, existingAsc).sort_order, 'asc');
  // 明示の desc で asc を解除できる。
  assert.equal(buildFeedRow({ ...feed, sortDirection: 'desc' }, existingAsc).sort_order, '');
});

test('sort_order: feedToApiShape は asc のフィードだけ sortDirection: asc を返す', () => {
  assert.equal(feedToApiShape({ id: 'x', sort_order: 'asc' }).sortDirection, 'asc');
  assert.equal(feedToApiShape({ id: 'x', sort_order: '' }).sortDirection, 'desc');
  assert.equal(feedToApiShape({ id: 'x' }).sortDirection, 'desc');
  assert.equal(feedToApiShape({ id: 'x', sort_order: 'ASC' }).sortDirection, 'asc');
});

test('sync_deletes: validateFeedInput は真偽値と on / off を受理し、不正値を弾き、未指定はキーなし', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  assert.equal(validateFeedInput({ ...base, syncDeletes: true }).feed.syncDeletes, true);
  assert.equal(validateFeedInput({ ...base, syncDeletes: false }).feed.syncDeletes, false);
  assert.equal(validateFeedInput({ ...base, syncDeletes: ' ON ' }).feed.syncDeletes, true);
  assert.equal(validateFeedInput({ ...base, syncDeletes: 'off' }).feed.syncDeletes, false);
  assert.equal(validateFeedInput({ ...base, syncDeletes: 'yes' }).ok, false);
  assert.ok(!('syncDeletes' in validateFeedInput(base).feed));
});

test('sync_deletes: buildFeedRow は明示を反映し、未指定では既存行の値を引き継ぐ', () => {
  const feed = { id: 'a', title: 'A', url: 'https://example.com/f', category: '' };
  assert.equal(buildFeedRow({ ...feed, syncDeletes: true }, null).sync_deletes, 'on');
  assert.equal(buildFeedRow({ ...feed, syncDeletes: false }, null).sync_deletes, '');
  const existingOn = { ...feed, etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '', sort_order: '', sync_deletes: 'on' };
  // 削除同期を送らない編集では、シート側の on を消さない。
  assert.equal(buildFeedRow(feed, existingOn).sync_deletes, 'on');
  // 明示の false で on を解除できる。
  assert.equal(buildFeedRow({ ...feed, syncDeletes: false }, existingOn).sync_deletes, '');
});

test('sync_deletes: feedToApiShape は on のフィードだけ syncDeletes: true を返す', () => {
  assert.equal(feedToApiShape({ id: 'x', sync_deletes: 'on' }).syncDeletes, true);
  assert.equal(feedToApiShape({ id: 'x', sync_deletes: '' }).syncDeletes, false);
  assert.equal(feedToApiShape({ id: 'x' }).syncDeletes, false);
  assert.equal(feedToApiShape({ id: 'x', sync_deletes: 'ON' }).syncDeletes, true);
  assert.equal(feedToApiShape({ id: 'x', sync_deletes: 'junk' }).syncDeletes, false);
});

test('star設定: normalizeStarMode / Count / MinSec は範囲外を未指定に倒す', () => {
  assert.equal(normalizeStarMode(' RECENT '), 'recent');
  assert.equal(normalizeStarMode('junk'), '');
  assert.equal(normalizeStarMode(''), '');
  assert.equal(normalizeStarCount(5), 5);
  assert.equal(normalizeStarCount('3'), 3);
  assert.equal(normalizeStarCount(0), null);
  assert.equal(normalizeStarCount(101), null);
  assert.equal(normalizeStarCount('x'), null);
  assert.equal(normalizeStarCount(''), null);
  assert.equal(normalizeStarMinSec(0), 0);
  assert.equal(normalizeStarMinSec(90), 90);
  assert.equal(normalizeStarMinSec(-1), null);
  assert.equal(normalizeStarMinSec(3601), null);
  assert.equal(normalizeStarMinSec(undefined), null);
});

test('star設定: validateFeedInput は値を受理し、不正値を弾き、未指定はキーなし、空は未指定に戻す', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  const ok = validateFeedInput({ ...base, starMode: 'recent', starCount: 5, starMinSec: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.feed.starMode, 'recent');
  assert.equal(ok.feed.starCount, 5);
  assert.equal(ok.feed.starMinSec, 0);
  assert.equal(validateFeedInput({ ...base, starMode: 'many' }).ok, false);
  assert.equal(validateFeedInput({ ...base, starCount: 0 }).ok, false);
  assert.equal(validateFeedInput({ ...base, starMinSec: -5 }).ok, false);
  const bare = validateFeedInput(base).feed;
  assert.ok(!('starMode' in bare) && !('starCount' in bare) && !('starMinSec' in bare));
  // 空文字・null はクリア (未指定に戻す) として受理する。
  const cleared = validateFeedInput({ ...base, starMode: '', starCount: '', starMinSec: null });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.feed.starMode, '');
  assert.equal(cleared.feed.starCount, null);
  assert.equal(cleared.feed.starMinSec, null);
});

test('star設定: buildFeedRow は明示を反映し、未指定では既存行の値を引き継ぎ、クリアで空に戻る', () => {
  const feed = { id: 'a', title: 'A', url: 'https://example.com/f', category: '' };
  const made = buildFeedRow({ ...feed, starMode: 'all', starCount: 7, starMinSec: 30 }, null);
  assert.equal(made.star_mode, 'all');
  assert.equal(made.star_count, 7);
  assert.equal(made.star_min_sec, 30);
  const existing = { ...feed, etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '', sort_order: '', sync_deletes: '', star_mode: 'recent', star_count: 5, star_min_sec: 120 };
  const inherited = buildFeedRow(feed, existing);
  assert.equal(inherited.star_mode, 'recent');
  assert.equal(inherited.star_count, 5);
  assert.equal(inherited.star_min_sec, 120);
  const cleared = buildFeedRow({ ...feed, starMode: '', starCount: null, starMinSec: null }, existing);
  assert.equal(cleared.star_mode, '');
  assert.equal(cleared.star_count, '');
  assert.equal(cleared.star_min_sec, '');
});

test('star設定: starSettingsOf / feedToApiShape は未指定を null で返す', () => {
  assert.deepEqual(starSettingsOf({ star_mode: 'recent', star_count: 4, star_min_sec: 0 }), { starMode: 'recent', starCount: 4, starMinSec: 0 });
  assert.deepEqual(starSettingsOf({}), { starMode: null, starCount: null, starMinSec: null });
  assert.deepEqual(starSettingsOf({ star_mode: 'junk', star_count: 'x' }), { starMode: null, starCount: null, starMinSec: null });
  const shaped = feedToApiShape({ id: 'x', star_mode: 'all', star_count: 2, star_min_sec: 45 });
  assert.equal(shaped.starMode, 'all');
  assert.equal(shaped.starCount, 2);
  assert.equal(shaped.starMinSec, 45);
});

test('star設定: effectiveStarRule は未指定なら種別既定、保存値があればそれを使う', () => {
  const ch = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const own = 'https://www.youtube.com/channel/UCbiDZXbr391oT_vsRiqwPFg';
  const pl = 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00';
  assert.deepEqual(effectiveStarRule({ url: ch }), { mode: 'recent', count: 3, minSec: 90 });
  assert.deepEqual(effectiveStarRule({ url: own }), { mode: 'all', count: 3, minSec: 90 });
  assert.deepEqual(effectiveStarRule({ url: pl }), { mode: 'all', count: 3, minSec: 90 });
  assert.deepEqual(effectiveStarRule({ url: 'https://example.com/feed' }), { mode: 'none', count: 3, minSec: 90 });
  // 本数だけの指定は、モード未指定 (種別既定) のまま効く。
  assert.deepEqual(effectiveStarRule({ url: ch, star_count: 5 }), { mode: 'recent', count: 5, minSec: 90 });
  assert.deepEqual(effectiveStarRule({ url: ch, star_mode: 'none' }), { mode: 'none', count: 3, minSec: 90 });
  assert.deepEqual(effectiveStarRule({ url: pl, star_mode: 'recent', star_count: 2, star_min_sec: 0 }), { mode: 'recent', count: 2, minSec: 0 });
});

test('past_guard: normalizePastGuard は3値以外を未指定に倒し、pastGuardOf は未指定を null で返す', () => {
  assert.equal(normalizePastGuard(' READ '), 'read');
  assert.equal(normalizePastGuard('skip'), 'skip');
  assert.equal(normalizePastGuard('off'), 'off');
  assert.equal(normalizePastGuard('junk'), '');
  assert.equal(normalizePastGuard(''), '');
  assert.equal(pastGuardOf({ past_guard: 'read' }), 'read');
  assert.equal(pastGuardOf({ past_guard: '' }), null);
  assert.equal(pastGuardOf({}), null);
  assert.equal(feedToApiShape({ id: 'x', past_guard: 'off' }).pastGuard, 'off');
  assert.equal(feedToApiShape({ id: 'x' }).pastGuard, null);
});

test('past_guard: validateFeedInput は値を受理し、不正値を弾き、未指定はキーなし、空は未指定に戻す', () => {
  const base = { id: 'ok-id', title: 'Title', url: 'https://example.com/feed' };
  assert.equal(validateFeedInput({ ...base, pastGuard: 'read' }).feed.pastGuard, 'read');
  assert.equal(validateFeedInput({ ...base, pastGuard: 'keep' }).ok, false);
  assert.ok(!('pastGuard' in validateFeedInput(base).feed));
  assert.equal(validateFeedInput({ ...base, pastGuard: '' }).feed.pastGuard, '');
});

test('past_guard: buildFeedRow は明示を反映し、未指定では既存行の値を引き継ぎ、クリアで空に戻る', () => {
  const feed = { id: 'a', title: 'A', url: 'https://example.com/f', category: '' };
  assert.equal(buildFeedRow({ ...feed, pastGuard: 'off' }, null).past_guard, 'off');
  const existing = { ...feed, etag: '', last_modified: '', last_fetched_at: '', last_status: '', last_error: '', sort_order: '', sync_deletes: '', past_guard: 'read' };
  assert.equal(buildFeedRow(feed, existing).past_guard, 'read');
  assert.equal(buildFeedRow({ ...feed, pastGuard: '' }, existing).past_guard, '');
});

test('countUnreadByFeed: サーバー側に既読状態が無いため記事数をそのまま数える', () => {
  const articles = [
    { id: 'a1', feed_id: 'zenn' },
    { id: 'a2', feed_id: 'zenn' },
    { id: 'a3', feed_id: 'zenn' },
    { id: 'b1', feed_id: 'nhk' },
    { id: 'b2', feed_id: 'nhk' },
  ];
  assert.deepEqual(countUnreadByFeed(articles), { zenn: 3, nhk: 2 });
  assert.deepEqual(countUnreadByFeed([]), {});
  assert.deepEqual(countUnreadByFeed(null), {});
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
    ['id', 'title', 'url', 'category'],
    ['a', 'A', 'https://a.example/feed', 'x'],
    ['b', 'B', 'https://b.example/feed', 'y'],
    ['c', 'C', 'https://c.example/feed', 'x'],
    ['d', 'D', 'https://d.example/feed', 'y'],
  ];
  const result = reorderRowsByIds(values, 0, ['d', 'c', 'b', 'a']);
  assert.deepEqual(result, [
    ['id', 'title', 'url', 'category'],
    ['d', 'D', 'https://d.example/feed', 'y'],
    ['c', 'C', 'https://c.example/feed', 'x'],
    ['b', 'B', 'https://b.example/feed', 'y'],
    ['a', 'A', 'https://a.example/feed', 'x'],
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

test('youtubeChannelIdFromUrl: 保存形 (/channel/UC...) から channel_id を抜く', () => {
  assert.equal(
    youtubeChannelIdFromUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A'),
    'UCxNfaRC6MbAnwSR1Dqqv69A'
  );
  assert.equal(
    youtubeChannelIdFromUrl('https://youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A/videos'),
    'UCxNfaRC6MbAnwSR1Dqqv69A'
  );
  // ハンドル形式や視聴 URL はチャンネル ID を含まないので対象外。
  assert.equal(youtubeChannelIdFromUrl('https://www.youtube.com/@rakutentech'), '');
  assert.equal(youtubeChannelIdFromUrl('https://www.youtube.com/watch?v=abc123'), '');
  // 旧来の videos.xml 形は移行済みで互換を持たないため対象外。
  assert.equal(youtubeChannelIdFromUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A'), '');
  assert.equal(youtubeChannelIdFromUrl('https://example.com/feed.xml'), '');
  assert.equal(youtubeChannelIdFromUrl(''), '');
  assert.equal(youtubeChannelIdFromUrl(null), '');
});

test('youtubeFeedUrlFromChannelId: 保存形のチャンネルページ URL を組み立てる', () => {
  assert.equal(
    youtubeFeedUrlFromChannelId('UCxNfaRC6MbAnwSR1Dqqv69A'),
    'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A'
  );
  // 組み立てた URL からは youtubeChannelIdFromUrl で ID を取り戻せる。
  assert.equal(
    youtubeChannelIdFromUrl(youtubeFeedUrlFromChannelId('UCxNfaRC6MbAnwSR1Dqqv69A')),
    'UCxNfaRC6MbAnwSR1Dqqv69A'
  );
});

test('parseYouTubeChannelUrl: /channel/ 形は kind:id で ID を返す', () => {
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A'),
    { kind: 'id', channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A' }
  );
  assert.deepEqual(
    parseYouTubeChannelUrl('https://youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A'),
    { kind: 'id', channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A' }
  );
  // 末尾のパスやクエリが付いていても ID は同じ。
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A/videos'),
    { kind: 'id', channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A' }
  );
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A?hl=ja'),
    { kind: 'id', channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A' }
  );
});

test('parseYouTubeChannelUrl: /@handle 形は kind:handle で末尾を正規化して返す', () => {
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/@rakutentech'),
    { kind: 'handle', handle: 'rakutentech' }
  );
  // ドット・アンダースコア・ハイフンを含むハンドル、末尾パス・末尾スラッシュ・クエリ。
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/@some.handle_name-1/videos'),
    { kind: 'handle', handle: 'some.handle_name-1' }
  );
  assert.deepEqual(
    parseYouTubeChannelUrl('https://www.youtube.com/@rakutentech/'),
    { kind: 'handle', handle: 'rakutentech' }
  );
  assert.deepEqual(
    parseYouTubeChannelUrl('https://youtube.com/@rakutentech?hl=ja'),
    { kind: 'handle', handle: 'rakutentech' }
  );
});

test('parseYouTubeChannelUrl: 対象外の URL は null', () => {
  // videos.xml 形はチャンネルページではない。
  assert.equal(parseYouTubeChannelUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A'), null);
  // 旧来の /c/ ・ /user/ 形式は解決手段が無いため対象外。
  assert.equal(parseYouTubeChannelUrl('https://www.youtube.com/c/SomeChannel'), null);
  assert.equal(parseYouTubeChannelUrl('https://www.youtube.com/user/SomeUser'), null);
  assert.equal(parseYouTubeChannelUrl('https://www.youtube.com/watch?v=abc123'), null);
  assert.equal(parseYouTubeChannelUrl('https://example.com/@rakutentech'), null);
  assert.equal(parseYouTubeChannelUrl('http://www.youtube.com/@rakutentech'), null);
  assert.equal(parseYouTubeChannelUrl('https://www.youtube.com/@'), null);
  assert.equal(parseYouTubeChannelUrl(''), null);
  assert.equal(parseYouTubeChannelUrl(null), null);
  assert.equal(parseYouTubeChannelUrl(undefined), null);
});

test('parseChannelLookupResponse: channels.list 応答から ID とタイトルを抜く', () => {
  const body = JSON.stringify({
    items: [{ id: 'UCxNfaRC6MbAnwSR1Dqqv69A', snippet: { title: ' 正式チャンネル名 ' } }],
  });
  assert.deepEqual(parseChannelLookupResponse(body), {
    channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A',
    title: '正式チャンネル名',
  });
  // snippet が無ければタイトルは空で返す。
  assert.deepEqual(
    parseChannelLookupResponse(JSON.stringify({ items: [{ id: 'UCxNfaRC6MbAnwSR1Dqqv69A' }] })),
    { channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A', title: '' }
  );
});

test('parseChannelLookupResponse: 該当なし・壊れた応答は null', () => {
  assert.equal(parseChannelLookupResponse(JSON.stringify({ items: [] })), null);
  assert.equal(parseChannelLookupResponse(JSON.stringify({})), null);
  assert.equal(parseChannelLookupResponse(JSON.stringify({ items: [{ snippet: { title: 'x' } }] })), null);
  assert.equal(parseChannelLookupResponse('not json'), null);
  assert.equal(parseChannelLookupResponse(''), null);
  assert.equal(parseChannelLookupResponse(null), null);
});

test('selectFetchTargets: YouTube フィードだけを巡回対象にする', () => {
  const yt = (id) => ({
    id,
    url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A',
  });
  const feeds = [
    yt('yt-a'),
    yt('yt-b'),
    // プレイリストフィードも巡回対象
    { id: 'yt-pl', url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00' },
    { id: 'rss-on', url: 'https://example.com/feed.xml' },
    { id: 'priv-on', url: 'https://example.com/x.freddie.xml' },
    { id: '', url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A' },
    { id: 'yt-nourl', url: '' },
  ];
  assert.deepEqual(selectFetchTargets(feeds).map((f) => f.id), ['yt-a', 'yt-b', 'yt-pl']);
  assert.deepEqual(selectFetchTargets([]), []);
  assert.deepEqual(selectFetchTargets(null), []);
  assert.deepEqual(selectFetchTargets(undefined), []);
});

test('youtubePlaylistIdFromUrl: 保存形からプレイリスト ID を抜き、それ以外は空文字', () => {
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00'), 'PLxNfaRC6MbAnwSR1Dqqv69A00');
  assert.equal(youtubePlaylistIdFromUrl('https://youtube.com/playlist?list=UUxNfaRC6MbAnwSR1Dqqv69A'), 'UUxNfaRC6MbAnwSR1Dqqv69A');
  // 登録時の入力 (余分なクエリ付き・list= が先頭でない) からも抜ける
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?si=abc123&list=PLxNfaRC6MbAnwSR1Dqqv69A00'), 'PLxNfaRC6MbAnwSR1Dqqv69A00');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00&si=abc123'), 'PLxNfaRC6MbAnwSR1Dqqv69A00');
  // チャンネル URL・watch URL・他サイト・list= 無しは対象外
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/watch?v=abc12345678&list=PLxNfaRC6MbAnwSR1Dqqv69A00'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://example.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list='), '');
  // ID は10文字以上 (クライアント側の検証規則と一致)。短い特殊 ID
  // (WL = 後で見る、LL = 高評価) や9文字以下は弾く
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=WL'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=LL'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=PL1234567'), '');
  assert.equal(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=PL12345678'), 'PL12345678');
  assert.equal(youtubePlaylistIdFromUrl(''), '');
  assert.equal(youtubePlaylistIdFromUrl(null), '');
  // 正規形の組み立て (youtubeFeedUrlFromChannelId と対)
  assert.equal(youtubeFeedUrlFromPlaylistId('PLxNfaRC6MbAnwSR1Dqqv69A00'), 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00');
});

test('parseYouTubeNextPageToken / parseYouTubePlaylistTitle: 応答から抜き、壊れていれば空文字', () => {
  assert.equal(parseYouTubeNextPageToken(JSON.stringify({ items: [], nextPageToken: 'tok2' })), 'tok2');
  assert.equal(parseYouTubeNextPageToken(JSON.stringify({ items: [] })), '');
  assert.equal(parseYouTubeNextPageToken('not json'), '');
  assert.equal(parseYouTubeNextPageToken(''), '');
  const json = JSON.stringify({ items: [{ snippet: { title: '  お気に入り曲  ' } }] });
  assert.equal(parseYouTubePlaylistTitle(json), 'お気に入り曲');
  assert.equal(parseYouTubePlaylistTitle(JSON.stringify({ items: [] })), '');
  assert.equal(parseYouTubePlaylistTitle('not json'), '');
});

test('parseYouTubeDurations: videos.list 応答から { videoId: 秒 } を取り出す', () => {
  const json = JSON.stringify({
    items: [
      { id: 'vidA', contentDetails: { duration: 'PT3M25S' } },
      { id: 'vidB', contentDetails: { duration: 'PT45S' } },
      { id: 'vidC', contentDetails: { duration: 'PT1H2M3S' } },
      { id: 'vidD', contentDetails: { duration: 'P1DT1H0M10S' } },
      { id: 'vidE', contentDetails: {} },
      { id: 'vidF', contentDetails: { duration: 'PT0S' } },
      { contentDetails: { duration: 'PT10M' } },
    ],
  });
  // 読めない・0秒のものは含めない (= 長さ不明のまま fail-open 側に倒れる)
  assert.deepEqual(parseYouTubeDurations(json), { vidA: 205, vidB: 45, vidC: 3723, vidD: 90010 });
  assert.deepEqual(parseYouTubeDurations('not json'), {});
  assert.deepEqual(parseYouTubeDurations(''), {});
});

test('planPlaylistArticleDeletions: 取得集合に無い既存記事だけを削除候補にする', () => {
  const mk = (id, vid) => ({ id, link: 'https://www.youtube.com/watch?v=' + vid });
  const existing = [mk('a1', 'vidKeep001'), mk('a2', 'vidGone001'), { id: 'a3', link: 'https://example.com/post' }];
  const plan = planPlaylistArticleDeletions(existing, ['vidKeep001', 'vidNew0001']);
  assert.equal(plan.blocked, false);
  // a3 は YouTube 動画リンクでないため候補にしない
  assert.deepEqual(plan.deleteIds, ['a2']);
});

test('planPlaylistArticleDeletions: 取得集合が空なら削除しない (安全策)', () => {
  const existing = [{ id: 'a1', link: 'https://www.youtube.com/watch?v=vidKeep001' }];
  assert.deepEqual(planPlaylistArticleDeletions(existing, []), { deleteIds: [], blocked: false, candidates: 0 });
  assert.deepEqual(planPlaylistArticleDeletions(existing, null), { deleteIds: [], blocked: false, candidates: 0 });
});

test('planPlaylistArticleDeletions: 削除候補が上限 (20件) を超えたら削除自体を中止する', () => {
  const existing = [];
  for (let i = 1; i <= 21; i++) {
    existing.push({ id: 'a' + i, link: 'https://www.youtube.com/watch?v=vidStale' + String(i).padStart(3, '0') });
  }
  const plan = planPlaylistArticleDeletions(existing, ['vidFresh001']);
  assert.equal(plan.blocked, true);
  assert.equal(plan.candidates, 21);
  assert.deepEqual(plan.deleteIds, []);
  // ちょうど上限なら削除する
  const atCap = planPlaylistArticleDeletions(existing.slice(0, 20), ['vidFresh001']);
  assert.equal(atCap.blocked, false);
  assert.equal(atCap.deleteIds.length, 20);
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
  url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A',
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
  assert.ok(xml.includes('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">'));
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

test('buildRssXml: プレイリストフィードはチャンネルのリンクがプレイリストページになる', () => {
  const feed = {
    id: 'yt-pl',
    title: 'お気に入り曲',
    url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00',
  };
  const rows = [{
    id: 'row-pl1', feed_id: 'yt-pl', title: '選んだ曲',
    link: 'https://www.youtube.com/watch?v=vidPl111111',
    published_at: '2026-11-14T01:00:00.000Z', fetched_at: '2026-11-14T02:00:00.000Z', summary: '', author: 'someone',
  }];
  const xml = buildRssXml(feed, rows);
  assert.ok(xml.includes('<link>https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00</link>'));
  assert.ok(xml.includes('<title>お気に入り曲</title>'));
  assert.ok(xml.includes('<guid isPermaLink="false">vidPl111111</guid>'));
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
  const ytUrl = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  assert.equal(buildFetchUrl({ id: 'yt-sample', url: ytUrl }, base), base + '?rss=yt-sample');
  // プレイリストフィードも RSS 出力 URL を指す
  const plUrl = 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00';
  assert.equal(buildFetchUrl({ id: 'yt-pl', url: plUrl }, base), base + '?rss=yt-pl');
  assert.equal(buildFetchUrl({ id: 'zenn', url: 'https://zenn.dev/feed' }, base), 'https://zenn.dev/feed');
  // ベース URL が取れない環境ではフィード URL にフォールバックする
  assert.equal(buildFetchUrl({ id: 'yt-sample', url: ytUrl }, ''), ytUrl);
});

test('feedToApiShape: fetchUrl が付く (YouTube は注入したベース URL で組み立てる)', () => {
  const base = 'https://script.google.com/macros/s/AKfycTEST/exec';
  const yt = feedToApiShape(
    { id: 'yt-sample', title: 'YT', url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A' },
    0, base
  );
  assert.equal(yt.fetchUrl, base + '?rss=yt-sample');
  const normal = feedToApiShape({ id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed' }, 0, base);
  assert.equal(normal.fetchUrl, 'https://zenn.dev/feed');
});

test('buildListPayload: フィードに enabled は付かない (廃止)', () => {
  // GAS グローバルの最小スタブ (シートは行列だけを持つフェイク)。
  const tables = {
    feeds: [
      ['id', 'title', 'url', 'category', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', ''],
      ['yt-off', 'YT off', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
    ],
    articles: [
      ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'],
      ['a1', 'zenn', '記事1', 'https://example.com/1', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '要約1', '著者1'],
      ['a2', 'zenn', '記事2', 'https://example.com/2', '2026-11-13T00:00:00.000Z', '2026-11-13T01:00:00.000Z', '', ''],
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
    // enabled は廃止 (列自体も撤去済み): ペイロードには出さない。
    assert.ok(!('enabled' in byId['zenn']));
    assert.ok(!('enabled' in byId['yt-off']));
    // 未読数はサーバー側の記事数そのもの (既読は端末ローカル管理)。
    assert.equal(byId['zenn'].unreadCount, 2);
    // isRead は常に false (初回取り込みは id と isRead だけを使う形は維持)。
    assert.deepEqual(payload.articles.map((a) => [a.id, a.isRead]), [['a1', false], ['a2', false]]);
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

const FEED_HEADERS_ROW = ['id', 'title', 'url', 'category', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
const ARTICLE_HEADERS_ROW = ['id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at', 'summary', 'author'];
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
        deleteProperty: (k) => { delete store[k]; },
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

// CacheService のフェイク。store (Map) を直接のぞいて、書かれた
// キーや無効化を確認できるようにする。
function fakeCacheService(initial = {}) {
  const store = new Map(Object.entries(initial));
  const cache = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { store.set(k, String(v)); },
    remove: (k) => { store.delete(k); },
  };
  return { store, cache, service: { getScriptCache: () => cache } };
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
  const props = fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', ALLOWED_EMAIL: 'owner@example.com', ...extraProps });
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
      ['yt-rakutentech', '楽天テック', 'https://www.youtube.com/channel/UC0SZCr0g1dOpKAfAZoQjIHw', '', 'FALSE', '', '', '', '200', ''],
      ['nhk', 'NHK ニュース', 'https://www3.nhk.or.jp/rss/news/cat0.xml', '', '', '', '', '', ''],
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
    assert.ok(xml.includes('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">'));
    assert.equal((xml.match(/<item>/g) || []).length, 2);
    assert.ok(xml.includes('動画その1'));
    assert.ok(xml.includes('動画その2'));
    assert.ok(!xml.includes('別フィードの動画'));
  } finally { restore(); }
});

test('doGet: ?rss= はプレイリストフィードの記事も RSS で返す', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-pl', 'お気に入り曲', 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['rowpl1', 'yt-pl', '選んだ曲1', 'https://www.youtube.com/watch?v=vidPl111111', '2026-11-14T01:00:00.000Z', '2026-11-14T02:00:00.000Z', '概要', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  try {
    const xml = doGet({ parameter: { rss: 'yt-pl' } }).getContent();
    assert.ok(xml.startsWith('<?xml'));
    assert.ok(xml.includes('選んだ曲1'));
    assert.ok(xml.includes('<link>https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00</link>'));
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

test('shareLinkStatus: レコード無し・期限切れは inactive、有効なものだけ active', () => {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(shareLinkStatus(null, null, now), { active: false, expiresAt: null });
  assert.deepEqual(shareLinkStatus('hash', null, now), { active: false, expiresAt: null });
  assert.deepEqual(shareLinkStatus(null, future, now), { active: false, expiresAt: null });
  assert.deepEqual(shareLinkStatus('hash', past, now), { active: false, expiresAt: null });
  assert.deepEqual(shareLinkStatus('hash', future, now), { active: true, expiresAt: future });
});

test('issueShareLink: ハッシュだけを保存し、発行したトークンで検証が通る', () => {
  const fake = fakePropertiesService({});
  const restore = installGasGlobals({ PropertiesService: fake.service, Utilities: fakeUtilities });
  try {
    const issued = issueShareLink();
    assert.equal(issued.ok, true);
    // トークンは URL-safe で32文字以上
    assert.match(issued.token, /^[A-Za-z0-9_-]{32,}$/);
    // 期限は発行から約30日
    const ttlMs = Date.parse(issued.expiresAt) - Date.now();
    assert.ok(Math.abs(ttlMs - 30 * 24 * 60 * 60 * 1000) < 5000, 'TTL は約30日: ' + ttlMs);
    // 保存されるのは SHA-256 ハッシュと期限だけ (平文は保存先のどこにも無い)
    assert.equal(fake.store.SHARE_TOKEN_HASH, sha256HexPure(issued.token));
    assert.equal(fake.store.SHARE_EXPIRES_AT, issued.expiresAt);
    assert.ok(!JSON.stringify(fake.store).includes(issued.token));
    // 発行したトークンで検証が通り、状態も active になる
    assert.equal(validateShareToken(issued.token), true);
    assert.deepEqual(getShareLinkStatus(), { ok: true, active: true, expiresAt: issued.expiresAt });
  } finally { restore(); }
});

test('issueShareLink: 再発行すると旧トークンは無効になり、新トークンだけが通る', () => {
  const fake = fakePropertiesService({});
  const restore = installGasGlobals({ PropertiesService: fake.service, Utilities: fakeUtilities });
  try {
    const first = issueShareLink();
    const second = issueShareLink();
    assert.notEqual(first.token, second.token);
    assert.equal(validateShareToken(first.token), false);
    assert.equal(validateShareToken(second.token), true);
    assert.equal(getShareLinkStatus().expiresAt, second.expiresAt);
  } finally { restore(); }
});

test('getShareLinkStatus / revokeShareLink: 未発行は inactive、無効化後は検証も通らない', () => {
  const fake = fakePropertiesService({});
  const restore = installGasGlobals({ PropertiesService: fake.service, Utilities: fakeUtilities });
  try {
    assert.deepEqual(getShareLinkStatus(), { ok: true, active: false, expiresAt: null });
    const issued = issueShareLink();
    assert.equal(validateShareToken(issued.token), true);
    assert.deepEqual(revokeShareLink(), { ok: true });
    // レコード自体が消え、検証も状態確認も無効になる
    assert.equal(fake.store.SHARE_TOKEN_HASH, undefined);
    assert.equal(fake.store.SHARE_EXPIRES_AT, undefined);
    assert.equal(validateShareToken(issued.token), false);
    assert.deepEqual(getShareLinkStatus(), { ok: true, active: false, expiresAt: null });
    // 期限切れのレコードが残っていても inactive
    fake.store.SHARE_TOKEN_HASH = sha256HexPure('expired-share-token');
    fake.store.SHARE_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
    assert.deepEqual(getShareLinkStatus(), { ok: true, active: false, expiresAt: null });
    assert.equal(validateShareToken('expired-share-token'), false);
  } finally { restore(); }
});

test('doPost: 共有リンクの発行・交換・無効化はオーナーだけが行える', () => {
  const ss = new FakeSpreadsheet({});
  const fake = fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fake.service,
    ContentService: fakeContentService(),
    Utilities: fakeUtilities,
  });
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    const owner = issueSession('owner');
    const readonly = issueSession('readonly');
    // セッション無しでは発行・状態確認・無効化のいずれもできない
    assert.deepEqual(post({ action: 'issueShareLink' }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(post({ action: 'getShareLinkStatus' }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(post({ action: 'revokeShareLink' }), { ok: false, error: 'unauthorized' });
    // 読み取り専用セッションでもできない
    assert.deepEqual(post({ action: 'issueShareLink', sessionToken: readonly.sessionToken }), { ok: false, error: 'forbidden' });
    assert.deepEqual(post({ action: 'getShareLinkStatus', sessionToken: readonly.sessionToken }), { ok: false, error: 'forbidden' });
    assert.deepEqual(post({ action: 'revokeShareLink', sessionToken: readonly.sessionToken }), { ok: false, error: 'forbidden' });
    // オーナーが発行すると、そのトークンで exchange_share が通る
    assert.deepEqual(post({ action: 'getShareLinkStatus', sessionToken: owner.sessionToken }), { ok: true, active: false, expiresAt: null });
    const issued = post({ action: 'issueShareLink', sessionToken: owner.sessionToken });
    assert.equal(issued.ok, true);
    assert.match(issued.token, /^[A-Za-z0-9_-]{32,}$/);
    assert.deepEqual(post({ action: 'getShareLinkStatus', sessionToken: owner.sessionToken }), { ok: true, active: true, expiresAt: issued.expiresAt });
    const exchanged = post({ action: 'exchange_share', shareToken: issued.token });
    assert.equal(exchanged.ok, true);
    assert.equal(exchanged.role, 'readonly');
    // 再発行すると旧トークンでは交換できない
    const reissued = post({ action: 'issueShareLink', sessionToken: owner.sessionToken });
    assert.deepEqual(post({ action: 'exchange_share', shareToken: issued.token }), { ok: false, error: 'unauthorized' });
    assert.equal(post({ action: 'exchange_share', shareToken: reissued.token }).ok, true);
    // 無効化すると交換できなくなる
    assert.deepEqual(post({ action: 'revokeShareLink', sessionToken: owner.sessionToken }), { ok: true });
    assert.deepEqual(post({ action: 'exchange_share', shareToken: reissued.token }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(post({ action: 'getShareLinkStatus', sessionToken: owner.sessionToken }), { ok: true, active: false, expiresAt: null });
  } finally { restore(); }
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
    feeds: [FEED_HEADERS_ROW, ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', '']],
    articles,
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
      ['yt-x', 'YT', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['a1', 'yt-x', '動画', 'https://www.youtube.com/watch?v=vidX111111', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', ''],
    ],
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
    assert.ok(!('enabled' in byId['zenn']));
    assert.equal(byId['yt-x'].unreadCount, 1);
    // フィードのキー集合は slim 化後 (PR #16) の形から enabled を除き、
    // sortDirection と syncDeletes を加えた形に固定する
    assert.deepEqual(Object.keys(byId['yt-x']).sort(), ['category', 'fetchUrl', 'id', 'pastGuard', 'sortDirection', 'starCount', 'starMinSec', 'starMode', 'syncDeletes', 'title', 'unreadCount', 'url']);
    // 既読は端末ローカル管理のため、isRead は常に false
    assert.equal(payload.articles[0].isRead, false);
  } finally { restore(); }
});

test('buildListPayload: 旧10列シート (is_private 列が残っている過渡期) でも読み取りできる', () => {
  // 列の読み取りはヘッダー名ベースのため、未知列が残っていても壊れない。
  // 本番シートの is_private 列削除はコードのデプロイ後に行う前提。
  const legacyHeaders = ['id', 'title', 'url', 'category', 'is_private', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error'];
  const ss = new FakeSpreadsheet({
    feeds: [legacyHeaders,
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', 'TRUE', '"abc"', '', '2026-11-14T00:00:00.000Z', '200', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' }).service,
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example.com/exec' }) },
    Utilities: fakeUtilities,
  });
  try {
    const payload = buildListPayload({});
    assert.equal(payload.ok, true);
    assert.equal(payload.feeds.length, 1);
    assert.equal(payload.feeds[0].id, 'zenn');
    assert.equal(payload.feeds[0].category, 'tech');
    assert.ok(!('isPrivate' in payload.feeds[0]));
  } finally { restore(); }
});

test('buildListPayload: feeds に sortDirection を含める (シートの sort_order を反映)', () => {
  const headers = ['id', 'title', 'url', 'category', 'etag', 'last_modified', 'last_fetched_at', 'last_status', 'last_error', 'sort_order'];
  const ss = new FakeSpreadsheet({
    feeds: [headers,
      ['cal', '予定', 'https://example.com/cal', '個人', '', '', '', '', '', 'asc'],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
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
    assert.equal(byId['cal'].sortDirection, 'asc');
    assert.equal(byId['zenn'].sortDirection, 'desc');
  } finally { restore(); }
});

test('handleDeleteFeed: articles → feeds の順にカスケード削除する', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-a', 'A チャンネル', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
      ['zenn', 'Zenn', 'https://zenn.dev/feed', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['a1', 'yt-a', '記事1', 'https://example.com/1', '', '', '', ''],
      ['a2', 'yt-a', '記事2', 'https://example.com/2', '', '', '', ''],
      ['b1', 'zenn', '記事B', 'https://example.com/b', '', '', '', ''],
    ],
  });
  // 削除の実行順を記録する (articles の全件書き戻し → feeds の行削除)
  const order = [];
  const wrap = (sheet, label, method) => {
    const orig = sheet[method].bind(sheet);
    sheet[method] = (...args) => { order.push(label); return orig(...args); };
  };
  wrap(ss.sheets['articles'], 'articles', 'clearContents');
  wrap(ss.sheets['feeds'], 'feeds', 'deleteRow');
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(handleDeleteFeed({ feedId: 'yt-a' }), { ok: true });
    assert.deepEqual(order, ['articles', 'feeds']);
    assert.deepEqual(ss.sheets['articles'].rows.map((r) => r[0]), ['id', 'b1']);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'zenn']);
  } finally { restore(); }
});

test('handleDeleteFeed: 未知の ID は not_found で、行は変わらない', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ['zenn', 'Zenn', 'https://zenn.dev/feed', '', '', '', '', '', '']],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(handleDeleteFeed({ feedId: 'nope' }), { ok: false, error: 'not_found' });
    assert.deepEqual(handleDeleteFeed({}), { ok: false, error: 'not_found' });
    assert.equal(ss.sheets['feeds'].rows.length, 2);
  } finally { restore(); }
});

// fetchFeeds の行更新意味論。FEEDS_HEADERS の列位置: last_fetched_at=7, last_status=8, last_error=9。
function fetchTestEnv({ apiKey, responder }) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-x', 'YT チャンネル', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
    // states タブは廃止したため、fetchFeeds は作らない (テストで検証する)
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
    assert.equal(row[7], 'error');
    assert.equal(row[8], 'YOUTUBE_API_KEY is not set');
    assert.ok(row[6], 'last_fetched_at も記録される');
    // states タブは再作成されない (シートごと削除した本番で作り直さないため)
    assert.equal(ss.sheets['states'], undefined);
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
    assert.equal(row[7], 'error');
    assert.ok(row[8].startsWith('YouTube API HTTP 403'), row[8]);
    assert.ok(row[8].includes('exceeded your quota'), row[8]);
    assert.ok(row[8].length <= 500, row[8]);
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
    assert.equal(row[7], 'error');
    assert.equal(row[8], 'YouTube API HTTP 403 - ' + 'x'.repeat(200));
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
    assert.equal(row[7], '200');
    assert.equal(row[8], '');
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

test('groupRowsByCategory: バラバラな並びをカテゴリ出現順に安定グループ化する', () => {
  const values = [
    FEED_HEADERS_ROW,
    ['a', 'A', 'https://a.example/feed', '個人', '', '', '', '', ''],
    ['b', 'B', 'https://b.example/feed', '音楽', '', '', '', '', ''],
    ['c', 'C', 'https://c.example/feed', '個人', '', '', '', '', ''],
    ['d', 'D', 'https://d.example/feed', '川口', '', '', '', '', ''],
    ['e', 'E', 'https://e.example/feed', '音楽', '', '', '', '', ''],
  ];
  const grouped = groupRowsByCategory(values, 3);
  // カテゴリの出現順は 個人 → 音楽 → 川口。カテゴリ内は元の順序を維持する
  assert.deepEqual(grouped.map((r) => r[0]), ['id', 'a', 'c', 'b', 'e', 'd']);
  // 行の追加・削除はなく、全列の値も保持される (行そのものが同じ参照)
  assert.equal(grouped.length, values.length);
  assert.equal(grouped[1], values[1]);
  assert.equal(grouped[2], values[3]);
  assert.equal(grouped[3], values[2]);
  assert.equal(grouped[5], values[4]);
});

test('groupRowsByCategory: グループ化済みなら並びは変わらない', () => {
  const values = [
    FEED_HEADERS_ROW,
    ['a', 'A', 'https://a.example/feed', '個人', '', '', '', '', ''],
    ['c', 'C', 'https://c.example/feed', '個人', '', '', '', '', ''],
    ['b', 'B', 'https://b.example/feed', '音楽', '', '', '', '', ''],
  ];
  const grouped = groupRowsByCategory(values, 3);
  assert.deepEqual(grouped.map((r) => r[0]), ['id', 'a', 'c', 'b']);
  for (let i = 0; i < values.length; i++) assert.equal(grouped[i], values[i]);
});

test('groupRowsByCategory: 新しいカテゴリのフィードは末尾側のブロックに残る', () => {
  const values = [
    FEED_HEADERS_ROW,
    ['a', 'A', 'https://a.example/feed', '音楽', '', '', '', '', ''],
    ['b', 'B', 'https://b.example/feed', '個人', '', '', '', '', ''],
    ['c', 'C', 'https://c.example/feed', '音楽', '', '', '', '', ''],
    // 新規追加されたフィード (新しいカテゴリ) は末尾に付いている
    ['z', 'Z', 'https://z.example/feed', 'ゲーム', '', '', '', '', ''],
  ];
  const grouped = groupRowsByCategory(values, 3);
  // 音楽 (a, c) → 個人 (b) → ゲーム (z) で、新カテゴリは末尾側に残る
  assert.deepEqual(grouped.map((r) => r[0]), ['id', 'a', 'c', 'b', 'z']);
});

test('groupRowsByCategory: カテゴリ列が無い・行が無い入力はそのまま返す', () => {
  const noCat = [['id', 'title'], ['a', 'A']];
  assert.equal(groupRowsByCategory(noCat, -1), noCat);
  const headerOnly = [FEED_HEADERS_ROW];
  assert.equal(groupRowsByCategory(headerOnly, 3), headerOnly);
  assert.equal(groupRowsByCategory(null, 3), null);
});

test('regroupFeedsByCategory: 散らかった feeds を書き戻し、2回目は書き込まない', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['a', 'A', 'https://a.example/feed', '個人', 'etag-a', '', '2026-11-17T00:00:00.000Z', '200', ''],
      ['b', 'B', 'https://b.example/feed', '音楽', '', '', '', '', ''],
      ['c', 'C', 'https://c.example/feed', '個人', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
  });
  let clears = 0;
  const sheet = ss.sheets['feeds'];
  const origClear = sheet.clearContents.bind(sheet);
  sheet.clearContents = () => { clears++; return origClear(); };
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(regroupFeedsByCategory(), { ok: true, changed: true });
    assert.equal(clears, 1);
    // 全列の値が保持されたまま、個人 (a, c) → 音楽 (b) の順になる
    assert.deepEqual(sheet.rows, [
      FEED_HEADERS_ROW,
      ['a', 'A', 'https://a.example/feed', '個人', 'etag-a', '', '2026-11-17T00:00:00.000Z', '200', ''],
      ['c', 'C', 'https://c.example/feed', '個人', '', '', '', '', ''],
      ['b', 'B', 'https://b.example/feed', '音楽', '', '', '', '', ''],
    ]);
    // すでにまとまっているので2回目は書き込まない
    assert.deepEqual(regroupFeedsByCategory(), { ok: true, changed: false });
    assert.equal(clears, 1);
  } finally { restore(); }
});

test('regroupFeedsByCategory: feeds タブが無い・ヘッダーだけなら何もしない', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(regroupFeedsByCategory(), { ok: true, changed: false });
    assert.equal(ss.sheets['feeds'], undefined);
  } finally { restore(); }
  const ss2 = new FakeSpreadsheet({ feeds: [FEED_HEADERS_ROW] });
  const restore2 = installSpreadsheet(ss2);
  try {
    assert.deepEqual(regroupFeedsByCategory(), { ok: true, changed: false });
    assert.equal(ss2.sheets['feeds'].rows.length, 1);
  } finally { restore2(); }
});

test('fetchFeeds: 巡回の保守処理で feeds がカテゴリごとにまとまる', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['a', 'A', 'https://a.example/feed', '個人', '', '', '', '', ''],
      ['b', 'B', 'https://b.example/feed', '音楽', '', '', '', '', ''],
      ['c', 'C', 'https://c.example/feed', '個人', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    // YouTube フィードは無いので取得対象は0件。それでも保守処理で
    // feeds の並びが 個人 (a, c) → 音楽 (b) にまとまる
    assert.equal(result.fetched, 0);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'a', 'c', 'b']);
  } finally { restore(); }
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
  assert.deepEqual(prunePlan(mk('2026-09-15T00:00:00.000Z'), now).deleteArticleIds, []);
  assert.deepEqual(prunePlan(mk('2026-09-14T00:00:00.000Z'), now).deleteArticleIds, ['a']);
});

test('prunePlan: 件数上限は既読状態に依らず、新しい順を残して古い順に適用される', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const day = (d) => '2026-11-' + d + 'T00:00:00.000Z';
  const articles = [
    { id: 'a4', published_at: day('14'), fetched_at: day('14') },
    { id: 'a3', published_at: day('13'), fetched_at: day('13') },
    { id: 'a2', published_at: day('12'), fetched_at: day('12') },
    { id: 'a1', published_at: day('11'), fetched_at: day('11') },
  ];
  const plan = prunePlan(articles, now, { maxArticles: 2, retentionDays: 3650 });
  // 上限2件に対し、古い a1・a2 が落ちる (v1 の states による未読保護は無い)。
  assert.deepEqual(plan.deleteArticleIds.sort(), ['a1', 'a2']);
});

test('prunePlan: 日付の無い記事は上限超過のときだけ消える', () => {
  const now = '2026-11-14T00:00:00.000Z';
  const articles = [
    { id: 'd1', published_at: '', fetched_at: '' },
    { id: 'd2', published_at: '', fetched_at: '' },
  ];
  assert.deepEqual(prunePlan(articles, now, { maxArticles: 5 }).deleteArticleIds, []);
  assert.deepEqual(prunePlan(articles, now, { maxArticles: 1 }).deleteArticleIds, ['d2']);
});

test('dist/Code.gs: export 文が残らず、スクリプトとして構文が通る', () => {
  // npm test は先に node build.js を回すため、dist/Code.gs は常に最新の生成結果。
  const code = readFileSync(new URL('../dist/Code.gs', import.meta.url), 'utf8');
  assert.ok(!/^\s*export\b/m.test(code), 'dist/Code.gs に export 文が残っている');
  new vm.Script(code); // 構文が壊れていれば SyntaxError で落ちる
});

// ============================================================
// v3 フェーズ1: フィード ID のハッシュ化とタイトル自動化。
// フロント (reader) も同じ規則で ID を算出するため、ベクトルは正規の値で固定する。
// ============================================================

test('feedIdFromUrl: URL の SHA-256 先頭16文字 (正規ベクトル)', () => {
  assert.equal(feedIdFromUrl('https://feeds.rebuild.fm/rebuildfm'), 'b81e59da11f890d2');
  assert.equal(feedIdFromUrl('https://anchor.fm/s/8c2088c/podcast/rss'), '87e6ebcd1afd6416');
  const id = feedIdFromUrl('https://example.com/feed');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, feedIdFromUrl('https://example.com/feed'));
  assert.notEqual(id, feedIdFromUrl('https://example.com/other'));
  assert.equal(feedIdFromUrl(''), feedIdFromUrl(''));
});

test('validateFeedInput: id は任意で、空なら未指定として通る', () => {
  const noId = validateFeedInput({ title: 'Title', url: 'https://example.com/feed' });
  assert.equal(noId.ok, true);
  assert.equal(noId.feed.id, '');
  const emptyId = validateFeedInput({ id: '   ', title: 'Title', url: 'https://example.com/feed' });
  assert.equal(emptyId.ok, true);
  assert.equal(emptyId.feed.id, '');
  // 指定があれば従来どおり slug 形式が検証される
  assert.equal(validateFeedInput({ id: 'ok-id', title: 'T', url: 'https://example.com/feed' }).feed.id, 'ok-id');
});

test('validateFeedInput: YouTube 疑似フィードだけタイトル空を許可する', () => {
  const ytUrl = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const yt = validateFeedInput({ title: '', url: ytUrl });
  assert.equal(yt.ok, true);
  assert.equal(yt.feed.title, '');
  // プレイリストフィードもタイトル空を許可する (playlists.list で補完する)
  const pl = validateFeedInput({ title: '', url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00' });
  assert.equal(pl.ok, true);
  assert.equal(pl.feed.title, '');
  // www 無し・タイトル未指定でも同じ
  const ytBare = validateFeedInput({ url: 'https://youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A' });
  assert.equal(ytBare.ok, true);
  // タイトルがあれば通常どおり保持される
  assert.equal(validateFeedInput({ title: 'My Ch', url: ytUrl }).feed.title, 'My Ch');
  // 旧来の videos.xml 形は通常の URL として扱うためタイトル必須。
  // チャンネル ID を含まない YouTube URL と通常フィードも従来どおりタイトル必須
  assert.equal(validateFeedInput({ title: '', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A' }).ok, false);
  assert.equal(validateFeedInput({ title: '', url: 'https://www.youtube.com/watch?v=abc123' }).ok, false);
  assert.equal(validateFeedInput({ title: '', url: 'https://example.com/feed' }).ok, false);
});

test('validateFeedInput: 自動生成プレイリスト (LR/RD) は弾き、通常のプレイリスト (PL) は通る', () => {
  const lrUrl = 'https://www.youtube.com/playlist?list=LRYRPO8Pv28j5-Rl0Vg4YL4w4Ck43RL4ZkJTF';
  const rdUrl = 'https://www.youtube.com/playlist?list=RDxNfaRC6MbAnwSR1Dqqv69A00';
  // 抽出自体は従来どおり (巡回側の判定に影響させない)
  assert.equal(youtubePlaylistIdFromUrl(lrUrl), 'LRYRPO8Pv28j5-Rl0Vg4YL4w4Ck43RL4ZkJTF');
  assert.equal(youtubePlaylistIdFromUrl(rdUrl), 'RDxNfaRC6MbAnwSR1Dqqv69A00');
  // タイトル空 (プレイリストなら本来通る形) でも弾き、理由が分かるメッセージを返す
  const lr = validateFeedInput({ title: '', url: lrUrl });
  assert.equal(lr.ok, false);
  assert.match(lr.message, /自動生成プレイリスト/);
  assert.equal(validateFeedInput({ title: '', url: rdUrl }).ok, false);
  // タイトルがあっても弾く
  assert.equal(validateFeedInput({ title: 'ラジオ', url: lrUrl }).ok, false);
  // 通常のプレイリストは従来どおり通る
  assert.equal(validateFeedInput({ title: '', url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00' }).ok, true);
});

test('parseYouTubeChannelTitle: channels.list 応答からチャンネル名を取り出す', () => {
  const json = JSON.stringify({ items: [{ snippet: { title: '  楽天テック  ' } }] });
  assert.equal(parseYouTubeChannelTitle(json), '楽天テック');
  assert.equal(parseYouTubeChannelTitle(JSON.stringify({ items: [] })), '');
  assert.equal(parseYouTubeChannelTitle(JSON.stringify({})), '');
  assert.equal(parseYouTubeChannelTitle('not json'), '');
  assert.equal(parseYouTubeChannelTitle(''), '');
});

// handleSaveFeed の合成テスト。feeds / articles を持つフェイクを使う。
function saveFeedEnv(feedRows) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ...feedRows],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  return { ss, restore };
}

test('handleSaveFeed: 追加時はクライアント指定の id を無視し、URL のハッシュを ID にする', () => {
  const { ss, restore } = saveFeedEnv([]);
  try {
    const res = handleSaveFeed({ feed: { id: 'rebuild', title: 'Rebuild', url: 'https://feeds.rebuild.fm/rebuildfm', category: 'tech' } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, 'b81e59da11f890d2');
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], 'b81e59da11f890d2');
    assert.equal(rows[1][1], 'Rebuild');
    assert.equal(rows[1][2], 'https://feeds.rebuild.fm/rebuildfm');
    // id を送らなくても同じ ID で追加される
    const res2 = handleSaveFeed({ feed: { title: 'COTEN', url: 'https://anchor.fm/s/8c2088c/podcast/rss' } });
    assert.equal(res2.ok, true);
    assert.equal(res2.feed.id, '87e6ebcd1afd6416');
    assert.equal(ss.sheets['feeds'].rows.length, 3);
  } finally { restore(); }
});

test('handleSaveFeed: 同じ URL の再追加は行を増やさず、その行の更新になる (冪等)', () => {
  const { ss, restore } = saveFeedEnv([]);
  try {
    handleSaveFeed({ feed: { title: 'Rebuild', url: 'https://feeds.rebuild.fm/rebuildfm' } });
    const res = handleSaveFeed({ feed: { id: 'another-slug', title: 'Rebuild FM', url: 'https://feeds.rebuild.fm/rebuildfm', category: 'podcast' } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, 'b81e59da11f890d2');
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][1], 'Rebuild FM');
    assert.equal(rows[1][3], 'podcast');
  } finally { restore(); }
});

test('handleSaveFeed: slug ID の既存行は URL 一致で更新され、ID とタイトルを維持する', () => {
  const ytUrl = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const { ss, restore } = saveFeedEnv([
    ['yt-legacy', '補完済みタイトル', ytUrl, '', 'FALSE', '', '', '', '200', ''],
  ]);
  try {
    // タイトル空で再追加しても、補完済みのタイトルを消さない
    const res = handleSaveFeed({ feed: { title: '', url: ytUrl, category: 'video' } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, 'yt-legacy');
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], 'yt-legacy');
    assert.equal(rows[1][1], '補完済みタイトル');
    assert.equal(rows[1][3], 'video');
  } finally { restore(); }
});

test('handleSaveFeed: id 指定の更新は行を書き換え、15列で保存される (属性列を遅延追加)', () => {
  const { ss, restore } = saveFeedEnv([
    ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', ''],
  ]);
  try {
    const res = handleSaveFeed({ feed: { id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'blog', enabled: false } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, 'zenn');
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][3], 'blog');
    // enabled / is_private 列は撤去済み: E列 (index 4) は etag になる。
    // 入力の enabled は無視される。sort_order / sync_deletes / star_* /
    // past_guard 列は保存時に末尾へ遅延追加され、行は15列になる
    // (未指定なので値は空)。
    assert.equal(rows[0][9], 'sort_order');
    assert.equal(rows[0][10], 'sync_deletes');
    assert.equal(rows[0][11], 'star_mode');
    assert.equal(rows[0][12], 'star_count');
    assert.equal(rows[0][13], 'star_min_sec');
    assert.equal(rows[0][14], 'past_guard');
    assert.equal(rows[1].length, 15);
    assert.equal(rows[1][4], '');
    assert.equal(rows[1][9], '');
    assert.equal(rows[1][10], '');
    assert.equal(rows[1][11], '');
    assert.equal(rows[1][12], '');
    assert.equal(rows[1][13], '');
    assert.equal(rows[1][14], '');
  } finally { restore(); }
});

test('handleSaveFeed: YouTube はタイトル空で追加でき、通常フィードは弾く', () => {
  const canonical = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const { ss, restore } = saveFeedEnv([]);
  try {
    const yt = handleSaveFeed({ feed: { url: canonical } });
    assert.equal(yt.ok, true);
    assert.equal(yt.feed.title, '');
    // 保存形 (/channel/) のまま ID を決める。
    assert.equal(yt.feed.id, feedIdFromUrl(canonical));
    assert.equal(yt.feed.url, canonical);
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][1], '');
    assert.equal(rows[1][2], canonical);
    const rss = handleSaveFeed({ feed: { url: 'https://example.com/feed' } });
    assert.equal(rss.ok, false);
    assert.equal(ss.sheets['feeds'].rows.length, 2);
  } finally { restore(); }
});

test('handleSaveFeed: プレイリストはタイトル空で追加でき、保存形に寄せて ID を決める', () => {
  const canonical = 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00';
  const { ss, restore } = saveFeedEnv([]);
  try {
    // 余分なクエリ付きで登録しても保存形 (/playlist?list=...) に寄る
    const res = handleSaveFeed({ feed: { url: canonical + '&si=sharetoken' } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.title, '');
    assert.equal(res.feed.url, canonical);
    assert.equal(res.feed.id, feedIdFromUrl(canonical));
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][2], canonical);
    // 巡回対象 (YouTube) になる
    assert.deepEqual(selectFetchTargets([{ id: res.feed.id, url: canonical }]).map((f) => f.id), [res.feed.id]);
    // 別形 (クエリ違い) で再登録しても同じ行の更新になる (冪等)
    const again = handleSaveFeed({ feed: { url: 'https://www.youtube.com/playlist?si=x&list=PLxNfaRC6MbAnwSR1Dqqv69A00', title: 'お気に入り' } });
    assert.equal(again.ok, true);
    assert.equal(again.feed.id, res.feed.id);
    assert.equal(ss.sheets['feeds'].rows.length, 2);
    assert.equal(ss.sheets['feeds'].rows[1][1], 'お気に入り');
  } finally { restore(); }
});

test('handleSaveFeed: 自動生成プレイリスト (LR) は invalid で弾き、何も書かない', () => {
  const { ss, restore } = saveFeedEnv([]);
  try {
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/playlist?list=LRYRPO8Pv28j5-Rl0Vg4YL4w4Ck43RL4ZkJTF' } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid');
    assert.match(res.message, /自動生成プレイリスト/);
    // ヘッダー行だけで、フィードは追加されていない
    assert.equal(ss.sheets['feeds'].rows.length, 1);
  } finally { restore(); }
});

test('handleSaveFeed: videos.xml 形は通常の URL として保存され、YouTube 扱いにならない', () => {
  const legacyUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxNfaRC6MbAnwSR1Dqqv69A';
  const { ss, restore } = saveFeedEnv([]);
  try {
    // 互換を削除したため、正規形へは寄せず、入力 URL のまま保存する。
    const res = handleSaveFeed({ feed: { title: '普通のフィード', url: legacyUrl } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, feedIdFromUrl(legacyUrl));
    assert.equal(res.feed.url, legacyUrl);
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][2], legacyUrl);
    // 巡回対象 (YouTube) にもならない。
    assert.deepEqual(selectFetchTargets([{ id: res.feed.id, url: legacyUrl }]), []);
  } finally { restore(); }
});

test('handleSaveFeed: ハッシュ衝突 (同じ ID・別 URL の行がある) は conflict で弾く', () => {
  const targetUrl = 'https://example.com/feed-b';
  const collidingId = feedIdFromUrl(targetUrl);
  const { ss, restore } = saveFeedEnv([
    [collidingId, 'Feed A', 'https://example.com/feed-a', '', '', '', '', '', ''],
  ]);
  try {
    const res = handleSaveFeed({ feed: { title: 'Feed B', url: targetUrl } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'conflict');
    // 行は増えず、既存行も書き換わらない
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][2], 'https://example.com/feed-a');
  } finally { restore(); }
});

test('handleSaveFeed: /channel/ 形の登録はそのまま保存形になり、resolver は呼ばない', () => {
  const canonical = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const { ss, restore } = saveFeedEnv([]);
  try {
    let resolverCalls = 0;
    const resolver = () => { resolverCalls++; return null; };
    const res = handleSaveFeed({ feed: { url: canonical } }, resolver);
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, feedIdFromUrl(canonical));
    assert.equal(res.feed.url, canonical);
    assert.equal(resolverCalls, 0);
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][2], canonical);
    // 末尾パス付きで登録しても裸の保存形に寄せる
    const res2 = handleSaveFeed({ feed: { url: canonical + '/videos', title: '付け替え' } }, resolver);
    assert.equal(res2.ok, true);
    assert.equal(res2.feed.url, canonical);
    assert.equal(ss.sheets['feeds'].rows.length, 2);
    assert.equal(resolverCalls, 0);
  } finally { restore(); }
});

test('handleSaveFeed: /@handle 形は resolver で解決し、保存形・タイトル・ID を寄せる', () => {
  const canonical = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const { ss, restore } = saveFeedEnv([]);
  try {
    const seenHandles = [];
    const resolver = (handle) => {
      seenHandles.push(handle);
      return { channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A', title: '解決したチャンネル名' };
    };
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@rakutentech/videos', category: 'video' } }, resolver);
    assert.equal(res.ok, true);
    // resolver には @ を含まない裸のハンドルが渡る
    assert.deepEqual(seenHandles, ['rakutentech']);
    assert.equal(res.feed.id, feedIdFromUrl(canonical));
    assert.equal(res.feed.url, canonical);
    // 入力タイトルが空なら、解決したタイトルで補完する
    assert.equal(res.feed.title, '解決したチャンネル名');
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][1], '解決したチャンネル名');
    assert.equal(rows[1][2], canonical);
    assert.equal(rows[1][3], 'video');
  } finally { restore(); }
});

test('handleSaveFeed: /@handle 形でも入力タイトルがあればそちらを優先する', () => {
  const { ss, restore } = saveFeedEnv([]);
  try {
    const resolver = () => ({ channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A', title: '解決したチャンネル名' });
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@rakutentech', title: '自分の付けた名前' } }, resolver);
    assert.equal(res.ok, true);
    assert.equal(res.feed.title, '自分の付けた名前');
    assert.equal(ss.sheets['feeds'].rows[1][1], '自分の付けた名前');
  } finally { restore(); }
});

test('handleSaveFeed: /@handle の解決に失敗したら何も書かずに弾く', () => {
  const { ss, restore } = saveFeedEnv([]);
  try {
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@no-such-handle' } }, () => null);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid');
    assert.equal(res.message, 'YouTube チャンネルが見つかりませんでした');
    // channelId が空の解決結果も失敗として扱う
    const res2 = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@no-such-handle' } }, () => ({ channelId: '', title: 'x' }));
    assert.equal(res2.ok, false);
    assert.equal(ss.sheets['feeds'].rows.length, 1);
  } finally { restore(); }
});

test('handleSaveFeed: 別形で再登録してもチャンネルIDが一致すれば既存行を更新する (クロスフォーム重複防止)', () => {
  const canonical = 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A';
  const canonicalId = feedIdFromUrl(canonical);
  const { ss, restore } = saveFeedEnv([
    [canonicalId, '既存タイトル', canonical, '', 'FALSE', '', '', '', '200', ''],
  ]);
  try {
    // /channel/ 形 (末尾パス付き) で再登録: 既存行が更新され、行は増えない。
    const res = handleSaveFeed({ feed: { url: canonical + '/videos', category: 'video' } });
    assert.equal(res.ok, true);
    assert.equal(res.feed.id, canonicalId);
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], canonicalId);
    assert.equal(rows[1][1], '既存タイトル');
    assert.equal(rows[1][2], canonical);
    assert.equal(rows[1][3], 'video');
    // /@handle 形で再登録しても同じ行に当たる。タイトルは解決した
    // チャンネル名で補完されてから更新判定に入るため、現在の名前に寄る。
    const res2 = handleSaveFeed(
      { feed: { url: 'https://www.youtube.com/@rakutentech' } },
      () => ({ channelId: 'UCxNfaRC6MbAnwSR1Dqqv69A', title: '解決したチャンネル名' })
    );
    assert.equal(res2.ok, true);
    assert.equal(res2.feed.id, canonicalId);
    assert.equal(ss.sheets['feeds'].rows.length, 2);
    assert.equal(ss.sheets['feeds'].rows[1][1], '解決したチャンネル名');
  } finally { restore(); }
});

test('handleSaveFeed: 既定 resolver は channels.list?forHandle= を引き、保存形で登録する', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const fetchedUrls = [];
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key' }).service,
    UrlFetchApp: {
      fetch: (url) => {
        fetchedUrls.push(url);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            items: [{ id: 'UCxNfaRC6MbAnwSR1Dqqv69A', snippet: { title: 'API のチャンネル名' } }],
          }),
        };
      },
    },
    Utilities: fakeUtilities,
  });
  try {
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@rakutentech' } });
    assert.equal(res.ok, true);
    assert.equal(fetchedUrls.length, 1);
    assert.match(fetchedUrls[0], /\/youtube\/v3\/channels\?part=snippet/);
    assert.ok(fetchedUrls[0].includes('forHandle=%40rakutentech'));
    assert.equal(res.feed.url, 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A');
    assert.equal(res.feed.title, 'API のチャンネル名');
    assert.equal(ss.sheets['feeds'].rows.length, 2);
  } finally { restore(); }
});

test('handleSaveFeed: 既定 resolver は APIキーが無い・該当が無い場合に登録を弾く', () => {
  // APIキー未設定 (saveFeedEnv のプロパティには YOUTUBE_API_KEY が無い)
  const noKey = saveFeedEnv([]);
  try {
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@rakutentech' } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid');
    assert.equal(res.message, 'YouTube チャンネルが見つかりませんでした');
    assert.equal(noKey.ss.sheets['feeds'].rows.length, 1);
  } finally { noKey.restore(); }
  // キーはあるが channels.list が空を返す
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key' }).service,
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ items: [] }) }),
    },
    Utilities: fakeUtilities,
  });
  try {
    const res = handleSaveFeed({ feed: { url: 'https://www.youtube.com/@no-such-handle' } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid');
    assert.equal(ss.sheets['feeds'].rows.length, 1);
  } finally { restore(); }
});

// fetchFeeds のタイトル補完テスト。URL で playlistItems / channels を振り分ける。
function fetchTitleEnv({ feedTitle, responder }) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-x', feedTitle, 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key' }).service,
    UrlFetchApp: { fetch: (url) => responder(url) },
    Utilities: fakeUtilities,
  });
  return { ss, restore };
}

const PLAYLIST_BODY = JSON.stringify({
  items: [
    { snippet: { title: '新着動画', description: '説明', publishedAt: '2026-11-14T00:00:00Z', channelTitle: 'YT チャンネル', resourceId: { videoId: 'vidNew12345' } } },
  ],
});
const CHANNELS_BODY = JSON.stringify({ items: [{ snippet: { title: '正式チャンネル名' } }] });

test('fetchFeeds: タイトル未設定なら channels.list のチャンネル名で補完する', () => {
  const { ss, restore } = fetchTitleEnv({
    feedTitle: '',
    responder: (url) => (url.includes('/channels?')
      ? { getResponseCode: () => 200, getContentText: () => CHANNELS_BODY }
      : { getResponseCode: () => 200, getContentText: () => PLAYLIST_BODY }),
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.added, 1);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[1], '正式チャンネル名');
    assert.equal(row[7], '200');
  } finally { restore(); }
});

test('fetchFeeds: タイトル補完が失敗しても巡回は続け、タイトルは空のまま', () => {
  const { ss, restore } = fetchTitleEnv({
    feedTitle: '',
    responder: (url) => {
      if (url.includes('/channels?')) throw new Error('network down');
      return { getResponseCode: () => 200, getContentText: () => PLAYLIST_BODY };
    },
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[1], '');
    assert.equal(row[7], '200');
    assert.equal(row[8], '');
  } finally { restore(); }
});

test('fetchFeeds: タイトルが入っていれば channels.list を呼ばず、上書きもしない', () => {
  const fetchedUrls = [];
  const { ss, restore } = fetchTitleEnv({
    feedTitle: '既存タイトル',
    responder: (url) => {
      fetchedUrls.push(url);
      return { getResponseCode: () => 200, getContentText: () => PLAYLIST_BODY };
    },
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.added, 1);
    assert.ok(fetchedUrls.length > 0);
    assert.ok(fetchedUrls.every((u) => !u.includes('/channels?')), fetchedUrls.join(','));
    assert.equal(ss.sheets['feeds'].rows[1][1], '既存タイトル');
  } finally { restore(); }
});

// ============================================================
// 音声ストリーム URL の配布 (ogp 方式): ze が公開する
// audio-urls.json の新鮮なエントリだけを ?rss= の enclosure にし、
// 毎時巡回では各フィードの最新3本ぶん抽出トリガーを発火する。
// ============================================================

test('parseAudioUrlsMap: 形の合うエントリだけを残し、不正な入力は空マップ', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const map = parseAudioUrlsMap(JSON.stringify({
    vidGood1111: { url: 'https://stream.example.com/a', ts: nowSec },
    vidDur11111: { url: 'https://stream.example.com/e', ts: nowSec, dur: 104.234 },
    vidBadDur11: { url: 'https://stream.example.com/f', ts: nowSec, dur: 'abc' },
    vidZeroDur1: { url: 'https://stream.example.com/g', ts: nowSec, dur: 0 },
    vidNoUrl111: { ts: nowSec },
    vidNoTs1111: { url: 'https://stream.example.com/b' },
    vidBadTs111: { url: 'https://stream.example.com/c', ts: 'abc' },
    vidScalar11: 'https://stream.example.com/d',
  }));
  // dur は正の数値のときだけ保持し、読めない・0 の dur は落とす
  // (エントリ自体は残り、enclosure は従来どおり付く)
  assert.deepEqual(map, {
    vidGood1111: { url: 'https://stream.example.com/a', ts: nowSec },
    vidDur11111: { url: 'https://stream.example.com/e', ts: nowSec, dur: 104.234 },
    vidBadDur11: { url: 'https://stream.example.com/f', ts: nowSec },
    vidZeroDur1: { url: 'https://stream.example.com/g', ts: nowSec },
  });
  assert.deepEqual(parseAudioUrlsMap('not json'), {});
  assert.deepEqual(parseAudioUrlsMap(''), {});
  assert.deepEqual(parseAudioUrlsMap('[1,2]'), {});
  assert.deepEqual(parseAudioUrlsMap('null'), {});
});

test('buildRssXml: 新鮮なエントリがあるアイテムにだけ enclosure を付ける', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [
    ytArticleRow('2026-11-14T01:00:00.000Z', 'vidFresh111', '新鮮な動画', ''),
    ytArticleRow('2026-11-13T01:00:00.000Z', 'vidStale111', '古い動画', ''),
    ytArticleRow('2026-11-12T01:00:00.000Z', 'vidMissing1', '無い動画', ''),
  ];
  const audioUrls = {
    vidFresh111: { url: 'https://stream.example.com/play?vid=1&sig=abc', ts: nowSec - 60 },
    vidStale111: { url: 'https://stream.example.com/stale', ts: nowSec - 6 * 3600 },
  };
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows, audioUrls);
  // URL は XML エスケープしてそのまま入る (& → &amp;)
  assert.ok(xml.includes('<enclosure url="https://stream.example.com/play?vid=1&amp;sig=abc" type="audio/x-m4a" length="0"/>'));
  assert.equal((xml.match(/<enclosure /g) || []).length, 1);
  // dur の無いエントリには itunes:duration を付けない
  assert.ok(!xml.includes('<itunes:duration>'));
  // マップを渡さなければ enclosure は付かない (従来どおり)
  const plain = buildRssXml(YT_FEED_FOR_RSS, rows);
  assert.ok(!plain.includes('<enclosure'));
});

test('buildRssXml: enclosure に dur があれば実尺を itunes:duration (整数秒) で付ける', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [
    ytArticleRow('2026-11-14T01:00:00.000Z', 'vidDurA1111', '実尺つき動画', ''),
    ytArticleRow('2026-11-13T01:00:00.000Z', 'vidDurB1111', '切り上げ対象の動画', ''),
    ytArticleRow('2026-11-12T01:00:00.000Z', 'vidNoDur111', '実尺なし動画', ''),
    ytArticleRow('2026-11-11T01:00:00.000Z', 'vidMissing1', 'エントリ無し動画', ''),
  ];
  const audioUrls = {
    vidDurA1111: { url: 'https://stream.example.com/a', ts: nowSec - 60, dur: 104.234 },
    vidDurB1111: { url: 'https://stream.example.com/b', ts: nowSec - 60, dur: 104.6 },
    vidNoDur111: { url: 'https://stream.example.com/c', ts: nowSec - 60 },
  };
  const xml = buildRssXml(YT_FEED_FOR_RSS, rows, audioUrls);
  assert.equal((xml.match(/<enclosure /g) || []).length, 3);
  // dur は四捨五入した整数秒で出す (104.234 → 104、104.6 → 105)
  assert.ok(xml.includes('<itunes:duration>104</itunes:duration>'));
  assert.ok(xml.includes('<itunes:duration>105</itunes:duration>'));
  assert.equal((xml.match(/<itunes:duration>/g) || []).length, 2);
  // itunes:duration は対応するアイテムの enclosure の直後にだけ出る
  const itemOf = (title) => {
    const start = xml.indexOf('<title>' + title + '</title>');
    assert.ok(start >= 0, title);
    return xml.slice(xml.lastIndexOf('<item>', start), xml.indexOf('</item>', start));
  };
  assert.ok(itemOf('実尺つき動画').includes('<enclosure '));
  assert.ok(itemOf('実尺つき動画').includes('<itunes:duration>104</itunes:duration>'));
  assert.ok(itemOf('切り上げ対象の動画').includes('<itunes:duration>105</itunes:duration>'));
  // enclosure があっても dur が無ければ付けない、enclosure 自体が
  // 無いアイテムにも付けない (それ以外は従来どおり)
  assert.ok(itemOf('実尺なし動画').includes('<enclosure '));
  assert.ok(!itemOf('実尺なし動画').includes('<itunes:duration>'));
  assert.ok(!itemOf('エントリ無し動画').includes('<enclosure'));
  assert.ok(!itemOf('エントリ無し動画').includes('<itunes:duration>'));
});

test('ytPlayUrl: 合言葉と動画IDから中継 URL を組み立て、欠ければ空', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ Y_ZE_GS_BASE_URL: 'https://y.ze.gs' }).service,
  });
  try {
    assert.equal(
      ytPlayUrl('secret-token', 'vidFresh111'),
      'https://y.ze.gs/secret-token/vidFresh111',
    );
    assert.equal(ytPlayUrl('', 'vidFresh111'), '');
    assert.equal(ytPlayUrl(null, 'vidFresh111'), '');
    assert.equal(ytPlayUrl(undefined, 'vidFresh111'), '');
    assert.equal(ytPlayUrl('secret-token', ''), '');
    assert.equal(ytPlayUrl('secret-token', null), '');
  } finally { restore(); }
});

test('scriptBaseUrl: プロパティを末尾スラッシュなしで返し、未設定・異常時は空', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({
      A_ZE_GS_BASE_URL: 'https://a.ze.gs/', Y_ZE_GS_BASE_URL: 'https://y.ze.gs',
    }).service,
  });
  try {
    assert.equal(scriptBaseUrl('A_ZE_GS_BASE_URL'), 'https://a.ze.gs');
    assert.equal(scriptBaseUrl('Y_ZE_GS_BASE_URL'), 'https://y.ze.gs');
    assert.equal(scriptBaseUrl('NO_SUCH_PROP'), '');
  } finally { restore(); }
  // PropertiesService 自体が無い環境でも例外にせず空を返す
  const restoreNone = installGasGlobals({ PropertiesService: undefined });
  try {
    assert.equal(scriptBaseUrl('A_ZE_GS_BASE_URL'), '');
    // 中継 URL も組み立てない (= 直接 URL にフォールバックする)
    assert.equal(ytPlayUrl('secret-token', 'vidFresh111'), '');
  } finally { restoreNone(); }
});

test('buildRssXml: 合言葉があれば enclosure は中継 URL になり、直接 URL は出ない', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [
    ytArticleRow('2026-11-14T01:00:00.000Z', 'vidFresh111', '新鮮な動画', ''),
    ytArticleRow('2026-11-13T01:00:00.000Z', 'vidStale111', '古い動画', ''),
    ytArticleRow('2026-11-12T01:00:00.000Z', 'vidMissing1', '無い動画', ''),
  ];
  const audioUrls = {
    vidFresh111: { url: 'https://stream.example.com/play?vid=1&sig=abc', ts: nowSec - 60, dur: 104.234 },
    vidStale111: { url: 'https://stream.example.com/stale', ts: nowSec - 6 * 3600 },
  };
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ Y_ZE_GS_BASE_URL: 'https://y.ze.gs' }).service,
  });
  let xml;
  try {
    xml = buildRssXml(YT_FEED_FOR_RSS, rows, audioUrls, 'secret-token');
  } finally { restore(); }
  assert.ok(xml.includes('<enclosure url="https://y.ze.gs/secret-token/vidFresh111" type="audio/x-m4a" length="0"/>'));
  // 直接のストリーム URL はどこにも出ない
  assert.ok(!xml.includes('stream.example.com'));
  // itunes:duration は従来どおり付く
  assert.ok(xml.includes('<itunes:duration>104</itunes:duration>'));
  // 鮮度切れ・欠落のアイテムには、合言葉があっても enclosure 自体が付かない
  assert.equal((xml.match(/<enclosure /g) || []).length, 1);
  assert.ok(!xml.includes('yt-play/secret-token/vidStale111'));
  assert.ok(!xml.includes('yt-play/secret-token/vidMissing1'));
});

test('buildRssXml: 合言葉が未設定・空なら従来どおり直接 URL の enclosure', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = [
    ytArticleRow('2026-11-14T01:00:00.000Z', 'vidFresh111', '新鮮な動画', ''),
  ];
  const audioUrls = {
    vidFresh111: { url: 'https://stream.example.com/direct', ts: nowSec - 60 },
  };
  [undefined, null, ''].forEach((token) => {
    const xml = buildRssXml(YT_FEED_FOR_RSS, rows, audioUrls, token);
    assert.ok(xml.includes('<enclosure url="https://stream.example.com/direct" type="audio/x-m4a" length="0"/>'));
    assert.ok(!xml.includes('yt-play'));
  });
});

test('fetchAudioUrlsMap: HTTPエラーや例外は空マップ (RSS は enclosure 無しで続く)', () => {
  const restore500 = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 500, getContentText: () => '' }) },
  });
  try {
    assert.deepEqual(fetchAudioUrlsMap(), {});
  } finally { restore500(); }
  const restoreThrow = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    UrlFetchApp: { fetch: () => { throw new Error('network down'); } },
  });
  try {
    assert.deepEqual(fetchAudioUrlsMap(), {});
  } finally { restoreThrow(); }
  // ベース URL が未設定なら取得自体を省いて空マップ (fetch は呼ばれない)
  const restoreNoBase = installGasGlobals({
    PropertiesService: fakePropertiesService({}).service,
    UrlFetchApp: { fetch: () => { throw new Error('must not be called'); } },
  });
  try {
    assert.deepEqual(fetchAudioUrlsMap(), {});
  } finally { restoreNoBase(); }
});

test('utf8ByteLength: ASCII は1バイト、日本語は3バイト、絵文字は4バイトで数える', () => {
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('日本語'), 9);
  assert.equal(utf8ByteLength('aあ😀'), 1 + 3 + 4);
  assert.equal(utf8ByteLength(null), 0);
});

test('scriptCache: CacheService が無い環境では null、ある環境ではキャッシュを返す', () => {
  const restoreNone = installGasGlobals({ CacheService: undefined });
  try {
    assert.equal(scriptCache(), null);
  } finally { restoreNone(); }
  const fake = fakeCacheService();
  const restore = installGasGlobals({ CacheService: fake.service });
  try {
    assert.equal(scriptCache(), fake.cache);
  } finally { restore(); }
});

test('rssCacheKey / invalidateRssCache: キーの形と、対象フィード分だけの削除', () => {
  assert.equal(rssCacheKey('feed-x'), 'rss:v1:feed-x');
  const fake = fakeCacheService({ 'rss:v1:feed-x': '<rss/>', 'rss:v1:feed-y': '<rss/>' });
  const restore = installGasGlobals({ CacheService: fake.service });
  try {
    invalidateRssCache('feed-x');
    assert.equal(fake.store.has('rss:v1:feed-x'), false);
    assert.equal(fake.store.has('rss:v1:feed-y'), true);
    invalidateRssCache(''); // 空 ID は何もしない
  } finally { restore(); }
  // CacheService が無い環境でも例外にしない
  const restoreNone = installGasGlobals({ CacheService: undefined });
  try {
    invalidateRssCache('feed-x');
  } finally { restoreNone(); }
});

test('audio-urls キャッシュ: 100KB超の本文をチャンク分割して読み戻せる', () => {
  const fake = fakeCacheService();
  const bigMap = { vidPad11111: { url: 'https://example.com/' + 'p'.repeat(65000), ts: 1700000000, dur: 42 } };
  const bigText = JSON.stringify(bigMap);
  assert.ok(bigText.length > 60000);
  putAudioUrlsMapCache(fake.cache, bigText);
  assert.equal(fake.store.get('audiomap:v1:count'), '3');
  const joined = [0, 1, 2].map((i) => fake.store.get('audiomap:v1:' + i)).join('');
  assert.equal(joined, bigText);
  assert.deepEqual(getAudioUrlsMapFromCache(fake.cache), {
    vidPad11111: { url: bigMap.vidPad11111.url, ts: 1700000000, dur: 42 },
  });
});

test('audio-urls キャッシュ: 欠け・壊れ・想定外の形はミス (null) として扱う', () => {
  assert.equal(getAudioUrlsMapFromCache(fakeCacheService().cache), null);
  assert.equal(getAudioUrlsMapFromCache(fakeCacheService({ 'audiomap:v1:count': 'abc' }).cache), null);
  // count はあるがチャンクが欠けている
  assert.equal(getAudioUrlsMapFromCache(fakeCacheService({ 'audiomap:v1:count': '2', 'audiomap:v1:0': '{}' }).cache), null);
  // JSON として壊れている
  assert.equal(getAudioUrlsMapFromCache(fakeCacheService({ 'audiomap:v1:count': '1', 'audiomap:v1:0': 'not json' }).cache), null);
  // オブジェクトでない JSON
  assert.equal(getAudioUrlsMapFromCache(fakeCacheService({ 'audiomap:v1:count': '1', 'audiomap:v1:0': '[1,2]' }).cache), null);
  // 上限を超えるチャンク数は書かない
  const fake = fakeCacheService();
  putAudioUrlsMapCache(fake.cache, 'x'.repeat(600001));
  assert.equal(fake.store.size, 0);
});

// このテストは、モジュール内の実行内キャッシュ (audioUrlsMapCache) が
// まだ温まっていない位置に置く必要がある (温まっているとそちらが
// 先に返り、スクリプトキャッシュの読み取りを検証できない)。
// ついでに、後続の doGet テストが使う vidAudio111 のエントリも
// 含めておく (実行内キャッシュがこのマップで温まるため、後続の
// doGet テストは従来どおり enclosure を受け取れる)。
test('fetchAudioUrlsMap: スクリプトキャッシュにヒットすれば取得を省く', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const seeded = {
    vidSeeded111: { url: 'https://stream.example.com/vidSeeded111', ts: nowSec - 30 },
    vidAudio111: { url: 'https://stream.example.com/vidAudio111', ts: nowSec - 60, dur: 2297.4 },
  };
  const fake = fakeCacheService();
  putAudioUrlsMapCache(fake.cache, JSON.stringify(seeded));
  let fetchCalls = 0;
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    CacheService: fake.service,
    UrlFetchApp: { fetch: () => { fetchCalls++; throw new Error('must not be called'); } },
  });
  try {
    const map = fetchAudioUrlsMap();
    assert.equal(fetchCalls, 0);
    assert.equal(map.vidSeeded111.url, 'https://stream.example.com/vidSeeded111');
    assert.equal(map.vidAudio111.dur, 2297.4);
  } finally { restore(); }
});

function audioRssSpreadsheet(videoId) {
  return new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-audio-feed', '音声テスト', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', 'FALSE', '', '', '', '200', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['rowA', 'yt-audio-feed', '音声つき動画', 'https://www.youtube.com/watch?v=' + videoId, '2026-11-14T01:00:00.000Z', '2026-11-14T02:00:00.000Z', '概要', '音声テスト'],
    ],
  });
}

test('doGet: ?rss= は audio-urls.json の新鮮なエントリを enclosure として配信する', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const mapJson = JSON.stringify({ vidAudio111: { url: 'https://stream.example.com/vidAudio111', ts: nowSec - 60, dur: 2297.4 } });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => audioRssSpreadsheet('vidAudio111') },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    ContentService: fakeContentService(),
    UrlFetchApp: {
      fetch: (url) => {
        assert.equal(String(url), 'https://a.ze.gs/audio-urls.json');
        return { getResponseCode: () => 200, getContentText: () => mapJson };
      },
    },
    Utilities: fakeUtilities,
  });
  try {
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('<enclosure url="https://stream.example.com/vidAudio111" type="audio/x-m4a" length="0"/>'));
    // dur (2297.4) は整数秒に丸めて itunes:duration としても配信する
    assert.ok(xml.includes('<itunes:duration>2297</itunes:duration>'));
  } finally { restore(); }
});

test('doGet: audio-urls.json の取得に失敗しても RSS は enclosure 無しで配信される', () => {
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => audioRssSpreadsheet('vidAudioFail') },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    ContentService: fakeContentService(),
    UrlFetchApp: { fetch: () => { throw new Error('ze unreachable'); } },
    Utilities: fakeUtilities,
  });
  try {
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('音声つき動画'));
    assert.ok(!xml.includes('<enclosure'));
  } finally { restore(); }
});

test('doGet: ?rss= は YT_PLAY_TOKEN があれば中継 URL の enclosure を配信する', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const mapJson = JSON.stringify({ vidAudio111: { url: 'https://stream.example.com/vidAudio111', ts: nowSec - 60, dur: 2297.4 } });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => audioRssSpreadsheet('vidAudio111') },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', YT_PLAY_TOKEN: 'secret-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs', Y_ZE_GS_BASE_URL: 'https://y.ze.gs' }).service,
    ContentService: fakeContentService(),
    UrlFetchApp: {
      fetch: (url) => {
        assert.equal(String(url), 'https://a.ze.gs/audio-urls.json');
        return { getResponseCode: () => 200, getContentText: () => mapJson };
      },
    },
    Utilities: fakeUtilities,
  });
  try {
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('<enclosure url="https://y.ze.gs/secret-token/vidAudio111" type="audio/x-m4a" length="0"/>'));
    // 直接のストリーム URL は出ない。itunes:duration は従来どおり付く
    assert.ok(!xml.includes('stream.example.com'));
    assert.ok(xml.includes('<itunes:duration>2297</itunes:duration>'));
  } finally { restore(); }
});

// --- ?rss= の RSS 本文キャッシュ ---

// doGet (?rss=) 用の環境。openById の呼び出し回数を数えられる。
function rssCacheEnv(cacheFake) {
  let opens = 0;
  let ss = audioRssSpreadsheet('vidCache111');
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => { opens++; return ss; } },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    ContentService: fakeContentService(),
    CacheService: cacheFake.service,
    UrlFetchApp: { fetch: () => { throw new Error('no network in this test'); } },
    Utilities: fakeUtilities,
  });
  return { restore, opens: () => opens, setSpreadsheet: (next) => { ss = next; } };
}

test('doGet: ?rss= の2回目は RSS キャッシュから返し、シートを読まない', () => {
  const fake = fakeCacheService();
  const env = rssCacheEnv(fake);
  try {
    const first = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(first.includes('音声つき動画'));
    assert.equal(env.opens(), 1);
    assert.equal(fake.store.get('rss:v1:yt-audio-feed'), first);
    const second = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.equal(second, first);
    assert.equal(env.opens(), 1); // 2回目はシートを開いていない
  } finally { env.restore(); }
});

test('doGet: feed_not_found はキャッシュせず、フィードができれば次回は RSS を返す', () => {
  const fake = fakeCacheService();
  const env = rssCacheEnv(fake);
  const empty = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW],
    articles: [ARTICLE_HEADERS_ROW],
  });
  env.setSpreadsheet(empty);
  try {
    const err = JSON.parse(doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent());
    assert.deepEqual(err, { ok: false, error: 'feed_not_found' });
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), false);
    env.setSpreadsheet(audioRssSpreadsheet('vidCache111'));
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('音声つき動画'));
  } finally { env.restore(); }
});

test('doGet: CacheService が例外を投げても通常生成にフォールバックする', () => {
  const throwing = {
    getScriptCache: () => ({
      get: () => { throw new Error('cache get down'); },
      put: () => { throw new Error('cache put down'); },
      remove: () => { throw new Error('cache remove down'); },
    }),
  };
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => audioRssSpreadsheet('vidCache111') },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    ContentService: fakeContentService(),
    CacheService: throwing,
    UrlFetchApp: { fetch: () => { throw new Error('no network in this test'); } },
    Utilities: fakeUtilities,
  });
  try {
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('音声つき動画'));
  } finally { restore(); }
});

test('doGet: 100KBを超える RSS 本文はキャッシュに入れない (応答自体は返す)', () => {
  const fake = fakeCacheService();
  const big = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-audio-feed', '音声テスト', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', 'FALSE', '', '', '', '200', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['rowBig', 'yt-audio-feed', '大きい動画', 'https://www.youtube.com/watch?v=vidCache111', '2026-11-14T01:00:00.000Z', '2026-11-14T02:00:00.000Z', 'x'.repeat(120000), '音声テスト'],
    ],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => big },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
    ContentService: fakeContentService(),
    CacheService: fake.service,
    UrlFetchApp: { fetch: () => { throw new Error('no network in this test'); } },
    Utilities: fakeUtilities,
  });
  try {
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('大きい動画'));
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), false);
  } finally { restore(); }
});

test('handleSetStar: スターを付け外しすると、そのフィードの RSS キャッシュが落ちる', () => {
  const fake = fakeCacheService();
  const env = rssCacheEnv(fake);
  try {
    doGet({ parameter: { rss: 'yt-audio-feed' } });
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), true);
    const res = handleSetStar({ id: 'rowA', on: false });
    assert.equal(res.ok, true);
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), false);
    // 落ちたので次の ?rss= はシートを読み直して再生成する
    const before = env.opens();
    const xml = doGet({ parameter: { rss: 'yt-audio-feed' } }).getContent();
    assert.ok(xml.includes('音声つき動画'));
    assert.equal(env.opens(), before + 1);
  } finally { env.restore(); }
});

test('handleDeleteFeed / handleSaveFeed: フィードの削除・保存でも RSS キャッシュが落ちる', () => {
  const fake = fakeCacheService();
  const env = rssCacheEnv(fake);
  try {
    doGet({ parameter: { rss: 'yt-audio-feed' } });
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), true);
    const saved = handleSaveFeed({ feed: { id: 'yt-audio-feed', title: '音声テスト', url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', category: '音楽' } });
    assert.equal(saved.ok, true);
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), false);
    doGet({ parameter: { rss: 'yt-audio-feed' } });
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), true);
    const deleted = handleDeleteFeed({ feedId: 'yt-audio-feed' });
    assert.deepEqual(deleted, { ok: true });
    assert.equal(fake.store.has('rss:v1:yt-audio-feed'), false);
  } finally { env.restore(); }
});

// --- 抽出トリガー (yt-audio) ---

function playlistBodyWith(items) {
  return JSON.stringify({
    items: items.map(([videoId, publishedAt]) => ({
      snippet: {
        title: '動画 ' + videoId, description: '', publishedAt,
        channelTitle: 'YT チャンネル', resourceId: { videoId },
      },
    })),
  });
}

const YT_FEED_ROW_X = ['yt-x', 'YT チャンネル', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''];

// feedsRows と articles の初期行を差し替えられる fetchFeeds 用環境。
function fetchAudioEnv({ props = {}, feedsRows, articlesRows = [], responder }) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ...feedsRows],
    articles: [ARTICLE_HEADERS_ROW, ...articlesRows],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({
      SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key',
      A_ZE_GS_BASE_URL: 'https://a.ze.gs', Y_ZE_GS_BASE_URL: 'https://y.ze.gs', ...props,
    }).service,
    UrlFetchApp: { fetch: (url, params) => responder(url, params) },
    Utilities: fakeUtilities,
  });
  return { ss, restore };
}

test('planYouTubeAudioTriggers: フィードごとに新しい順の最大3本を選び、重複を除く', () => {
  const mk = (prefix, days) => days.map((d) => ({
    videoId: prefix + String(d).padStart(2, '0'),
    publishedAt: '2026-11-' + String(d).padStart(2, '0') + 'T00:00:00.000Z',
  }));
  // フィードA: 12本 (古い順に渡しても新しい3本だけが選ばれる)
  const feedA = mk('vidA', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // フィードB: A と重なる1本 + 独自2本 + 空ID
  const feedB = [
    { videoId: 'vidA12', publishedAt: '2026-11-12T00:00:00.000Z' },
    { videoId: 'vidB02', publishedAt: '2026-11-02T00:00:00.000Z' },
    { videoId: 'vidB01', publishedAt: '2026-11-01T00:00:00.000Z' },
    { videoId: '', publishedAt: '2026-11-03T00:00:00.000Z' },
  ];
  const plan = planYouTubeAudioTriggers([feedA, feedB], Date.parse('2026-11-15T00:00:00.000Z'));
  assert.equal(plan.length, 5); // A の3本 + B の独自2本 (重複と空IDは除く)
  assert.equal(plan[0], 'vidA12');
  assert.equal(plan[2], 'vidA10');
  assert.deepEqual(plan.slice(3), ['vidB02', 'vidB01']);
  assert.deepEqual(planYouTubeAudioTriggers([]), []);
  assert.deepEqual(planYouTubeAudioTriggers(null), []);
  assert.deepEqual(planYouTubeAudioTriggers([null, []]), []);
});

test('planYouTubeAudioTriggers: 期間制限は無く、古い動画も新しい順3本の対象になる', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');
  const videos = [[
    { videoId: 'vidFresh001', publishedAt: '2026-11-15T00:00:00.000Z' },
    { videoId: 'vidEdge0001', publishedAt: '2026-10-16T12:00:00.000Z' },
    { videoId: 'vidStale001', publishedAt: '2026-10-16T11:59:59.999Z' },
    { videoId: 'vidOld00001', publishedAt: '2026-09-01T00:00:00.000Z' },
  ]];
  // 旧来の30日制限は廃止した。年齢に関係なく新しい順の3本だけ。
  assert.deepEqual(planYouTubeAudioTriggers(videos, now), ['vidFresh001', 'vidEdge0001', 'vidStale001']);
});

test('planYouTubeAudioTriggers: 90秒未満と分かっている動画は数えず、次の動画が繰り上がる', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const videos = [[
    { videoId: 'vidShort001', publishedAt: '2026-11-15T00:00:00.000Z', durationSec: 45 },
    { videoId: 'vidShort002', publishedAt: '2026-11-14T00:00:00.000Z', durationSec: 89 },
    // ちょうど90秒は対象 (未満だけを除く)
    { videoId: 'vidExact090', publishedAt: '2026-11-13T00:00:00.000Z', durationSec: 90 },
    { videoId: 'vidLong0001', publishedAt: '2026-11-12T00:00:00.000Z', durationSec: 240 },
    // 長さ不明は fail-open で通常どおり数える
    { videoId: 'vidUnknown1', publishedAt: '2026-11-11T00:00:00.000Z' },
    { videoId: 'vidLong0002', publishedAt: '2026-11-10T00:00:00.000Z', durationSec: 300 },
  ]];
  assert.deepEqual(planYouTubeAudioTriggers(videos, now), ['vidExact090', 'vidLong0001', 'vidUnknown1']);
});

test('planYouTubeAudioTriggers: 全件クラス (常時対応・プレイリスト) には90秒未満の除外を適用しない', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const own = [
    { videoId: 'vidOwnShort', publishedAt: '2026-11-14T00:00:00.000Z', durationSec: 30, channelId: 'UCbiDZXbr391oT_vsRiqwPFg' },
  ];
  const playlist = [
    { videoId: 'vidPlShort1', publishedAt: '2026-11-14T00:00:00.000Z', durationSec: 30, playlist: true },
  ];
  // 手で選んだものは長さで落とさない。
  assert.deepEqual(planYouTubeAudioTriggers([own], now), ['vidOwnShort']);
  assert.deepEqual(planYouTubeAudioTriggers([playlist], now), ['vidPlShort1']);
});

test('planYouTubeAudioTriggers: 新しい順3本だけを選ぶ (古い動画は順位で落ちる)', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  // 12本中9本が30日以内、3本が30日超 → 30日以内の新しい順3本だけ
  const feed = [];
  for (let d = 7; d <= 15; d++) {
    feed.push({ videoId: 'vidIn' + String(d).padStart(2, '0'), publishedAt: '2026-11-' + String(d).padStart(2, '0') + 'T00:00:00.000Z' });
  }
  ['2026-10-10', '2026-10-05', '2026-09-20'].forEach((date, i) => {
    feed.push({ videoId: 'vidOut0' + i, publishedAt: date + 'T00:00:00.000Z' });
  });
  const plan = planYouTubeAudioTriggers([feed], now);
  assert.deepEqual(plan, ['vidIn15', 'vidIn14', 'vidIn13']);
});

test('planYouTubeAudioTriggers: 更新の止まったチャンネルでも最新3本は選ぶ (期間制限なし)', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const staleFeed = [1, 2, 3].map((i) => ({
    videoId: 'vidStale00' + i,
    publishedAt: '2026-08-0' + i + 'T00:00:00.000Z',
  }));
  assert.deepEqual(planYouTubeAudioTriggers([staleFeed], now), ['vidStale003', 'vidStale002', 'vidStale001']);
});

test('planYouTubeAudioTriggers: 公開日時が読めない動画は対象外', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const videos = [[
    { videoId: 'vidNoDate01', publishedAt: '' },
    { videoId: 'vidBadDate1', publishedAt: 'not-a-date' },
    { videoId: 'vidMissing1' },
    { videoId: 'vidOk000001', publishedAt: '2026-11-14T00:00:00.000Z' },
  ]];
  assert.deepEqual(planYouTubeAudioTriggers(videos, now), ['vidOk000001']);
});

test('planYouTubeAudioTriggers: 常時対応チャンネルは30日超・3本超・日時不明でも全件選ぶ', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const special = [];
  for (let i = 1; i <= 15; i++) {
    special.push({
      videoId: 'vidS' + String(i).padStart(5, '0'),
      // 後半は30日より古い日付にする
      publishedAt: i <= 7 ? '2026-11-10T00:00:00.000Z' : '2025-01-10T00:00:00.000Z',
      channelId: 'UCbiDZXbr391oT_vsRiqwPFg',
    });
  }
  // 公開日時が読めない動画も常時対応では対象 (通常フィードとは逆)
  special.push({ videoId: 'vidSNoDate1', publishedAt: '', channelId: 'UCbiDZXbr391oT_vsRiqwPFg' });
  // 動画IDが無いものだけは除く
  special.push({ videoId: '', publishedAt: '2026-11-10T00:00:00.000Z', channelId: 'UCbiDZXbr391oT_vsRiqwPFg' });
  const plan = planYouTubeAudioTriggers([special], now);
  assert.equal(plan.length, 16); // 15本 + 日時不明1本
  assert.equal(plan[0], 'vidS00001');
  assert.ok(plan.includes('vidS00015'));
  assert.ok(plan.includes('vidSNoDate1'));
});

test('planYouTubeAudioTriggers: 常時対応と通常フィードが混ざっても通常分は新しい順3本のまま', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const special = [
    { videoId: 'vidSOld0001', publishedAt: '2024-05-01T00:00:00.000Z', channelId: 'UCbiDZXbr391oT_vsRiqwPFg' },
  ];
  const normal = [
    { videoId: 'vidNOld0001', publishedAt: '2024-05-01T00:00:00.000Z', channelId: 'UCsomeOtherCh' },
    { videoId: 'vidNNew0001', publishedAt: '2026-11-14T00:00:00.000Z', channelId: 'UCsomeOtherCh' },
  ];
  // 通常分は2本しかないので、古い方も含めて両方選ばれる (期間制限なし)。
  assert.deepEqual(planYouTubeAudioTriggers([special, normal], now), ['vidSOld0001', 'vidNNew0001', 'vidNOld0001']);
});

test('planYouTubeAudioTriggers: ジャンルが音楽でも特別扱いはなく、期間なし・新しい順3本だけ選ぶ', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  // 旧来の音楽ジャンル特別ルール (期間なし・20本) は廃止した。
  // category は判定に使わないため、音楽ジャンルの材料でも通常ルール。
  const dates = [
    '2023-01-01', '2024-01-01', '2025-01-01', '2026-01-01', '2026-09-01',
    '2026-10-01', '2026-10-20', '2026-11-10', '2026-11-12', '2026-11-13', '2026-11-14',
  ];
  const music = dates.map((d, i) => ({
    videoId: 'vidM' + String(i + 1).padStart(2, '0'),
    publishedAt: d + 'T00:00:00.000Z',
    category: '音楽',
  }));
  const plan = planYouTubeAudioTriggers([music], now);
  // 旧来の音楽特別ルール (期間なし・20本) ではなく、通常と同じ
  // 「期間なし・新しい順3本」。
  assert.deepEqual(plan, ['vidM11', 'vidM10', 'vidM09']);
});

test('planYouTubeAudioTriggers: プレイリストフィードは30日超・3本超・日時不明でも全件選ぶ (全件クラス)', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const playlist = [];
  for (let i = 1; i <= 15; i++) {
    playlist.push({
      videoId: 'vidP' + String(i).padStart(5, '0'),
      // 後半は30日より古い日付にする
      publishedAt: i <= 7 ? '2026-11-10T00:00:00.000Z' : '2023-01-10T00:00:00.000Z',
      playlist: true,
    });
  }
  // 公開日時が読めない動画も全件クラスでは対象 (通常フィードとは逆)
  playlist.push({ videoId: 'vidPNoDate1', publishedAt: '', playlist: true });
  // 動画IDが無いものだけは除く
  playlist.push({ videoId: '', publishedAt: '2026-11-10T00:00:00.000Z', playlist: true });
  const plan = planYouTubeAudioTriggers([playlist], now);
  assert.equal(plan.length, 16); // 15本 + 日時不明1本
  assert.equal(plan[0], 'vidP00001');
  assert.ok(plan.includes('vidP00015'));
  assert.ok(plan.includes('vidPNoDate1'));
});

test('planYouTubeAudioTriggers: プレイリストと通常が混ざっても通常分は新しい順3本のまま', () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const playlist = [1, 2, 3, 4, 5].map((i) => ({
    videoId: 'vidPOld000' + i,
    publishedAt: '2025-06-0' + i + 'T00:00:00.000Z',
    playlist: true,
  }));
  const normal = [
    { videoId: 'vidNOld0001', publishedAt: '2025-06-01T00:00:00.000Z' },
    { videoId: 'vidNNew0001', publishedAt: '2026-11-14T00:00:00.000Z' },
  ];
  const plan = planYouTubeAudioTriggers([playlist, normal], now);
  // 通常分は2本しかないので古い方も選ばれる (期間制限なし)。
  assert.deepEqual(plan, ['vidPOld0001', 'vidPOld0002', 'vidPOld0003', 'vidPOld0004', 'vidPOld0005', 'vidNNew0001', 'vidNOld0001']);
});

test('fetchFeeds: 抽出トリガーは各フィードの最新3本に発火する', () => {
  const items = [];
  for (let i = 1; i <= 12; i++) {
    items.push(['vidT' + String(i).padStart(5, '0'), '2026-11-' + String(i).padStart(2, '0') + 'T00:00:00Z']);
  }
  const body = playlistBodyWith(items);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId, token) => { calls.push([videoId, token]); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 12);
    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], 'vidT00012');
    assert.ok(!calls.some(([id]) => id === 'vidT00009' || id === 'vidT00001'));
    assert.ok(calls.every(([, token]) => token === 'fake-ze-token'));
  } finally { restore(); }
});

test('fetchFeeds: 抽出トリガーは新着でなくても発火する (既存動画も対象)', () => {
  const existingRows = [1, 2, 3].map((i) => {
    const vid = 'vidOld0000' + i;
    return [articleId('yt-x', vid), 'yt-x', '既存動画' + i, 'https://www.youtube.com/watch?v=' + vid,
      '2026-11-1' + i + 'T00:00:00.000Z', '2026-11-1' + i + 'T01:00:00.000Z', '', 'YT チャンネル'];
  });
  const body = playlistBodyWith([
    ['vidOld00001', '2026-11-11T00:00:00Z'],
    ['vidOld00002', '2026-11-12T00:00:00Z'],
    ['vidOld00003', '2026-11-13T00:00:00Z'],
  ]);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    articlesRows: existingRows,
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 0);
    assert.deepEqual(calls, ['vidOld00003', 'vidOld00002', 'vidOld00001']);
  } finally { restore(); }
});

test('fetchFeeds: 公開から時間が経った動画でも最新3本は抽出トリガーが発火する (期間制限なし)', () => {
  const body = playlistBodyWith([
    ['vidStale001', '2026-08-01T00:00:00Z'],
    ['vidStale002', '2026-08-02T00:00:00Z'],
  ]);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 2); // 記事の取り込み自体は行われる
    // 旧来の30日制限は廃止した。古くても新しい順に発火する。
    assert.deepEqual(calls, ['vidStale002', 'vidStale001']);
  } finally { restore(); }
});

test('fetchFeeds: 抽出トリガーはフィードをまたいだ重複を除いて発火する', () => {
  const rowA = ['yt-a', 'チャンネルA', 'https://www.youtube.com/channel/UCaaaaaaaaaaA', '', '', '', '', '', ''];
  const rowB = ['yt-b', 'チャンネルB', 'https://www.youtube.com/channel/UCbbbbbbbbbbB', '', '', '', '', '', ''];
  const bodyA = playlistBodyWith([
    ['vidShared01', '2026-11-10T00:00:00Z'],
    ['vidOnlyA001', '2026-11-09T00:00:00Z'],
  ]);
  const bodyB = playlistBodyWith([
    ['vidShared01', '2026-11-10T00:00:00Z'],
    ['vidOnlyB001', '2026-11-08T00:00:00Z'],
  ]);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [rowA, rowB],
    responder: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).includes('playlistId=UUaaaaaaaaaaA') ? bodyA : bodyB),
    }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['vidShared01', 'vidOnlyA001', 'vidOnlyB001']);
  } finally { restore(); }
});

test('fetchFeeds: 常時対応チャンネルは30日超でも取得できた全件に発火する', () => {
  const rowSpecial = ['yt-special', '藤原史和 川口を歩くQAエンジニア', 'https://www.youtube.com/channel/UCbiDZXbr391oT_vsRiqwPFg', '', '', '', '', '', ''];
  const items = [];
  for (let i = 1; i <= 12; i++) {
    // 全て公開から30日を大きく超えた日付にする
    items.push(['vidK' + String(i).padStart(5, '0'), '2025-0' + ((i % 9) + 1) + '-15T00:00:00Z']);
  }
  const body = playlistBodyWith(items);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [rowSpecial],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 12);
    assert.equal(calls.length, 12); // 3本上限も30日制限も付けない
  } finally { restore(); }
});

test('fetchFeeds: 音楽ジャンルのフィードでも特別扱いはなく、通常と同じ新しい順3本だけ発火する', () => {
  // 旧来の音楽ジャンル特別ルール (期間なし・20本) は廃止した。
  // ジャンルが「音楽」でも通常チャンネルと同じく新しい順3本だけ。
  const rowMusic = ['yt-music', '音楽チャンネル', 'https://www.youtube.com/channel/UCmusicchanneL1', '音楽', '', '', '', '', ''];
  const items = [];
  for (let i = 1; i <= 15; i++) {
    // 全て公開から30日を大きく超えた日付にする (期間制限が無いことの確認)
    const y = 2024 + Math.floor((i - 1) / 12);
    const m = String(((i - 1) % 12) + 1).padStart(2, '0');
    items.push(['vidMu' + String(i).padStart(5, '0'), y + '-' + m + '-15T00:00:00Z']);
  }
  const body = playlistBodyWith(items);
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [rowMusic],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 15); // 記事の取り込み自体は行われる
    // 最新は 2025-03-15 (i=15)、続いて 2025-02-15、2025-01-15。
    assert.deepEqual(calls, ['vidMu00015', 'vidMu00014', 'vidMu00013']);
  } finally { restore(); }
});

// --- プレイリストフィードの取り込み (fetchFeeds 統合) ---

const PL_FEED_ID = 'PLtestlist00000001';
const PL_FEED_ROW = ['yt-pl', 'お気に入り', 'https://www.youtube.com/playlist?list=' + PL_FEED_ID, '', '', '', '', '', ''];

function playlistPageBody(items, nextPageToken) {
  const body = {
    items: items.map(([videoId, publishedAt]) => ({
      snippet: { title: '動画 ' + videoId, description: '', publishedAt, channelTitle: 'ch', resourceId: { videoId } },
    })),
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return JSON.stringify(body);
}

function plArticleRow(vid, published) {
  return [articleId('yt-pl', vid), 'yt-pl', '動画 ' + vid, 'https://www.youtube.com/watch?v=' + vid,
    published, '2026-11-14T01:00:00.000Z', '', 'ch'];
}

test('fetchFeeds: プレイリストは最大2ページ (100件) まで取り込み、published_at は追加日時になる', () => {
  const requested = [];
  const page1 = playlistPageBody([
    ['vidPl00001', '2026-11-10T00:00:00Z'],
    ['vidPl00002', '2026-11-09T00:00:00Z'],
  ], 'tok2');
  const page2 = playlistPageBody([
    ['vidPl00003', '2026-11-08T00:00:00Z'],
  ], 'tok3'); // まだ次があるが、2ページで打ち切る
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    responder: (url) => {
      requested.push(String(url));
      return {
        getResponseCode: () => 200,
        getContentText: () => (String(url).includes('pageToken=tok2') ? page2 : page1),
      };
    },
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 3);
    const itemRequests = requested.filter((u) => u.includes('playlistId=' + PL_FEED_ID));
    assert.equal(itemRequests.length, 2); // 3ページ目は引かない
    assert.ok(itemRequests[0].includes('part=snippet,contentDetails'));
    assert.ok(itemRequests[0].includes('maxResults=50'));
    assert.ok(itemRequests[1].includes('pageToken=tok2'));
    const rows = ss.sheets['articles'].rows;
    assert.equal(rows.length, 4); // ヘッダー + 3件
    // published_at は snippet.publishedAt (= プレイリストへの追加日時)
    assert.equal(rows[1][4], '2026-11-10T00:00:00.000Z');
    assert.equal(rows[3][4], '2026-11-08T00:00:00.000Z');
  } finally { restore(); }
});

test('fetchFeeds: プレイリストのタイトルが空なら playlists.list で補完する', () => {
  const rowNoTitle = ['yt-pl', '', 'https://www.youtube.com/playlist?list=' + PL_FEED_ID, '', '', '', '', '', ''];
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [rowNoTitle],
    responder: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).includes('v3/playlists?')
        ? JSON.stringify({ items: [{ snippet: { title: 'お気に入り曲' } }] })
        : playlistPageBody([['vidPl00001', '2026-11-10T00:00:00Z']])),
    }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(ss.sheets['feeds'].rows[1][1], 'お気に入り曲');
  } finally { restore(); }
});

test('fetchFeeds: プレイリストから外れた記事は削除同期で消え、残る記事と新規記事は残る', () => {
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    articlesRows: [plArticleRow('vidKeepPl01', '2026-11-01T00:00:00.000Z'), plArticleRow('vidGonePl01', '2026-10-01T00:00:00.000Z')],
    responder: () => ({
      getResponseCode: () => 200,
      getContentText: () => playlistPageBody([
        ['vidKeepPl01', '2026-11-01T00:00:00Z'],
        ['vidNewPl001', '2026-11-12T00:00:00Z'],
      ]),
    }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const links = ss.sheets['articles'].rows.slice(1).map((r) => r[3]);
    assert.deepEqual(links.sort(), [
      'https://www.youtube.com/watch?v=vidKeepPl01',
      'https://www.youtube.com/watch?v=vidNewPl001',
    ]);
  } finally { restore(); }
});

test('fetchFeeds: プレイリストの取得が失敗したら削除同期はせず、既存記事は残る', () => {
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    articlesRows: [plArticleRow('vidKeepPl01', '2026-11-01T00:00:00.000Z')],
    responder: () => ({ getResponseCode: () => 500, getContentText: () => '{}' }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(ss.sheets['feeds'].rows[1][7], 'error');
    assert.equal(ss.sheets['articles'].rows.length, 2); // ヘッダー + 既存1件
  } finally { restore(); }
});

test('fetchFeeds: プレイリストの取得が0件なら削除同期はせず、既存記事は残る', () => {
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    articlesRows: [plArticleRow('vidKeepPl01', '2026-11-01T00:00:00.000Z')],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ items: [] }) }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(ss.sheets['feeds'].rows[1][7], '200');
    assert.equal(ss.sheets['articles'].rows.length, 2);
  } finally { restore(); }
});

test('fetchFeeds: プレイリストの削除候補が上限を超えたら削除だけ中止する', () => {
  const staleRows = [];
  for (let i = 1; i <= 21; i++) {
    staleRows.push(plArticleRow('vidStalePl' + String(i).padStart(2, '0'), '2026-10-01T00:00:00.000Z'));
  }
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    articlesRows: staleRows,
    responder: () => ({
      getResponseCode: () => 200,
      getContentText: () => playlistPageBody([['vidFreshPl1', '2026-11-12T00:00:00Z']]),
    }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 1); // 追加は行われる
    assert.equal(ss.sheets['articles'].rows.length, 1 + 21 + 1); // 削除はされない
  } finally { restore(); }
});

test('fetchFeeds: プレイリストの記事は古くても全件に抽出トリガーが発火する (全件クラス)', () => {
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [PL_FEED_ROW],
    responder: () => ({
      getResponseCode: () => 200,
      getContentText: () => playlistPageBody([
        ['vidPlOld001', '2023-05-01T00:00:00Z'],
        ['vidPlOld002', '2023-04-01T00:00:00Z'],
        ['vidPlOld003', '2023-03-01T00:00:00Z'],
        ['vidPlOld004', '2023-02-01T00:00:00Z'],
      ]),
    }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['vidPlOld001', 'vidPlOld002', 'vidPlOld003', 'vidPlOld004']);
  } finally { restore(); }
});

test('fetchFeeds: プレイリスト取り込みでも新規記事に長さが保存される', () => {
  const requested = [];
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    responder: (url) => {
      requested.push(String(url));
      return {
        getResponseCode: () => 200,
        getContentText: () => (String(url).includes('v3/videos?')
          ? durationsBody({ vidPlNew001: 'PT4M38S', vidPlNew002: 'PT30S' })
          : playlistPageBody([
            ['vidPlNew001', '2026-11-12T00:00:00Z'],
            ['vidPlNew002', '2026-11-11T00:00:00Z'],
          ])),
      };
    },
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 2);
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.ok(durIdx >= 0);
    const byLink = {};
    rows.slice(1).forEach((r) => { byLink[r[3]] = r[durIdx]; });
    assert.equal(byLink['https://www.youtube.com/watch?v=vidPlNew001'], 278);
    assert.equal(byLink['https://www.youtube.com/watch?v=vidPlNew002'], 30);
    // 長さは videos.list へページ単位でまとめて1回だけ引かれる
    const videoRequests = requested.filter((u) => u.includes('v3/videos?'));
    assert.equal(videoRequests.length, 1);
    assert.ok(videoRequests[0].includes('vidPlNew001'));
    assert.ok(videoRequests[0].includes('vidPlNew002'));
  } finally { restore(); }
});

test('fetchFeeds: プレイリストの既存記事は長さが空の行だけ埋め戻され、入っている行は引き直さない', () => {
  const requested = [];
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, PL_FEED_ROW],
    articles: [
      [...ARTICLE_HEADERS_ROW, 'star_override', 'duration_sec'],
      [...plArticleRow('vidPlFill01', '2026-11-01T00:00:00.000Z'), '', ''],
      [...plArticleRow('vidPlKnow01', '2026-11-02T00:00:00.000Z'), '', 321],
    ],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({
      SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key',
      A_ZE_GS_BASE_URL: 'https://a.ze.gs', Y_ZE_GS_BASE_URL: 'https://y.ze.gs',
    }).service,
    UrlFetchApp: {
      fetch: (url) => {
        requested.push(String(url));
        return {
          getResponseCode: () => 200,
          getContentText: () => (String(url).includes('v3/videos?')
            ? durationsBody({ vidPlFill01: 'PT4M00S', vidPlKnow01: 'PT10M39S' })
            : playlistPageBody([
              ['vidPlFill01', '2026-11-01T00:00:00Z'],
              ['vidPlKnow01', '2026-11-02T00:00:00Z'],
            ])),
        };
      },
    },
    Utilities: fakeUtilities,
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 0); // どちらも既存なので再追加はされない
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.equal(rows[1][durIdx], 240); // 空だった行は埋め戻される
    assert.equal(rows[2][durIdx], 321); // 入っていた行は上書きされない
    // 引き直しの対象は長さが空だった行だけに絞られる
    const videoRequests = requested.filter((u) => u.includes('v3/videos?'));
    assert.equal(videoRequests.length, 1);
    assert.ok(videoRequests[0].includes('vidPlFill01'));
    assert.ok(!videoRequests[0].includes('vidPlKnow01'));
  } finally { restore(); }
});

test('fetchFeeds: プレイリストで長さの取得に失敗しても取り込みは完了する (fail-open)', () => {
  const { ss, restore } = fetchAudioEnv({
    feedsRows: [PL_FEED_ROW],
    responder: (url) => (String(url).includes('v3/videos?')
      ? { getResponseCode: () => 500, getContentText: () => '{}' }
      : {
        getResponseCode: () => 200,
        getContentText: () => playlistPageBody([
          ['vidPlFail01', '2026-11-12T00:00:00Z'],
          ['vidPlFail02', '2026-11-11T00:00:00Z'],
        ]),
      }),
  });
  try {
    const result = fetchFeeds(() => {});
    assert.equal(result.ok, true);
    assert.equal(result.added, 2);
    assert.equal(ss.sheets['feeds'].rows[1][7], '200'); // 巡回自体は成功扱い
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.ok(durIdx >= 0);
    assert.ok(rows.slice(1).every((r) => r[durIdx] === '' || r[durIdx] === undefined));
  } finally { restore(); }
});

// --- 動画の長さ (duration) の取り込みとスター判定への反映 ---

function durationsBody(map) {
  return JSON.stringify({
    items: Object.entries(map).map(([id, duration]) => ({ id, contentDetails: { duration } })),
  });
}

test('fetchFeeds: チャンネル取り込みで長さを保存し、90秒未満は発火対象から数えない', () => {
  const body = playlistBodyWith([
    ['vidDuraNew1', '2026-11-14T00:00:00Z'],
    ['vidDuraShrt', '2026-11-13T00:00:00Z'],
    ['vidDuraOld1', '2026-11-12T00:00:00Z'],
    ['vidDuraOld2', '2026-11-11T00:00:00Z'],
  ]);
  const { ss, restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).includes('v3/videos?')
        ? durationsBody({ vidDuraNew1: 'PT3M10S', vidDuraShrt: 'PT30S', vidDuraOld1: 'PT4M00S', vidDuraOld2: 'PT5M00S' })
        : body),
    }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 4);
    // duration_sec 列が遅延追加され、長さが秒で保存される
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.ok(durIdx >= 0);
    const byLink = {};
    rows.slice(1).forEach((r) => { byLink[r[3]] = r[durIdx]; });
    assert.equal(byLink['https://www.youtube.com/watch?v=vidDuraShrt'], 30);
    assert.equal(byLink['https://www.youtube.com/watch?v=vidDuraNew1'], 190);
    // 短尺 (30秒) は数えず、次の動画が繰り上がって3本発火する
    assert.deepEqual(calls, ['vidDuraNew1', 'vidDuraOld1', 'vidDuraOld2']);
  } finally { restore(); }
});

test('fetchFeeds: 既存記事の長さは再追加されなくても埋め戻される', () => {
  const existing = [articleId('yt-x', 'vidBackfil1'), 'yt-x', '既存動画', 'https://www.youtube.com/watch?v=vidBackfil1',
    '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', 'YT チャンネル'];
  const body = playlistBodyWith([['vidBackfil1', '2026-11-14T00:00:00Z']]);
  const { ss, restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    articlesRows: [existing],
    responder: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).includes('v3/videos?')
        ? durationsBody({ vidBackfil1: 'PT4M00S' })
        : body),
    }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 0); // 既存なので再追加はされない
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.ok(durIdx >= 0);
    assert.equal(rows[1][durIdx], 240);
    assert.deepEqual(calls, ['vidBackfil1']);
  } finally { restore(); }
});

test('fetchFeeds: 長さの取得に失敗しても取り込みは進み、発火は通常の新しい順3本に倒れる (fail-open)', () => {
  const body = playlistBodyWith([
    ['vidFailNew1', '2026-11-14T00:00:00Z'],
    ['vidFailShrt', '2026-11-13T00:00:00Z'],
    ['vidFailOld1', '2026-11-12T00:00:00Z'],
  ]);
  const { ss, restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: (url) => (String(url).includes('v3/videos?')
      ? { getResponseCode: () => 500, getContentText: () => '{}' }
      : { getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 3);
    // 長さ不明のため短尺らしい動画も含めて新しい順3本が発火する
    assert.deepEqual(calls, ['vidFailNew1', 'vidFailShrt', 'vidFailOld1']);
    const rows = ss.sheets['articles'].rows;
    const durIdx = rows[0].indexOf('duration_sec');
    assert.ok(durIdx >= 0);
    assert.ok(rows.slice(1).every((r) => r[durIdx] === '' || r[durIdx] === undefined));
  } finally { restore(); }
});

test('fetchFeeds: A_ZE_GS_TOKEN 未設定なら抽出トリガーは発火しない (エラーにもしない)', () => {
  const body = playlistBodyWith([['vidNew12345', '2026-11-14T00:00:00Z']]);
  const { restore } = fetchAudioEnv({
    // A_ZE_GS_TOKEN は渡さない
    feedsRows: [YT_FEED_ROW_X],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test('fetchFeeds: 抽出トリガーが例外を投げても巡回は成功する', () => {
  const body = playlistBodyWith([['vidNew12345', '2026-11-14T00:00:00Z']]);
  const { ss, restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: () => ({ getResponseCode: () => 200, getContentText: () => body }),
  });
  try {
    const result = fetchFeeds(() => { throw new Error('ze unreachable'); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const row = ss.sheets['feeds'].rows[1];
    assert.equal(row[7], '200');
    assert.equal(row[8], '');
  } finally { restore(); }
});

test('fetchFeeds: 既定の抽出トリガーは自宅サーバーの公開ホストの yt-audio/<videoId> をトークンヘッダー付きで叩く', () => {
  const body = playlistBodyWith([['vidNew12345', '2026-11-14T00:00:00Z']]);
  const requests = [];
  const { restore } = fetchAudioEnv({
    props: { A_ZE_GS_TOKEN: 'fake-ze-token' },
    feedsRows: [YT_FEED_ROW_X],
    responder: (url, params) => {
      requests.push([String(url), params]);
      if (String(url).startsWith('https://a.ze.gs/')) {
        return { getResponseCode: () => 200, getContentText: () => '' };
      }
      return { getResponseCode: () => 200, getContentText: () => body };
    },
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    const triggerReq = requests.find(([url]) => url.startsWith('https://a.ze.gs/'));
    assert.ok(triggerReq, '自宅サーバーの公開ホストへのリクエストがある');
    assert.equal(triggerReq[0], 'https://a.ze.gs/yt-audio/vidNew12345');
    assert.equal(triggerReq[1].headers['X-Api-Token'], 'fake-ze-token');
    assert.equal(triggerReq[1].muteHttpExceptions, true);
  } finally { restore(); }
});

test('fireYouTubeAudioTriggers: 1回の巡回で最大200件まで (全体キャップ)', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
  });
  const feedVideos = [];
  for (let f = 0; f < 80; f++) {
    const videos = [];
    for (let i = 0; i < 10; i++) {
      videos.push({ videoId: 'vid' + f + '_' + i, publishedAt: '2026-11-14T00:00:00.000Z' });
    }
    feedVideos.push(videos);
  }
  let count = 0;
  try {
    // 計画は 80フィード×3本 = 240件 → キャップで200件に絞られる
    const fired = fireYouTubeAudioTriggers(feedVideos, () => { count++; }, Date.parse('2026-11-15T00:00:00.000Z'));
    assert.equal(fired, 200);
    assert.equal(count, 200);
  } finally { restore(); }
});

test('fireYouTubeAudioTriggers: 常時対応分 (最大20本) を含んでも全体キャップ200件で収まる', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
  });
  const now = Date.parse('2026-11-15T00:00:00.000Z');
  const special = [];
  for (let i = 0; i < 20; i++) {
    // 常時対応分は古い動画でも全件が計画に入る
    special.push({ videoId: 'vidSp' + i, publishedAt: '2020-01-01T00:00:00.000Z', channelId: 'UCbiDZXbr391oT_vsRiqwPFg' });
  }
  const feedVideos = [special];
  for (let f = 0; f < 61; f++) {
    const videos = [];
    for (let i = 0; i < 10; i++) {
      videos.push({ videoId: 'vidN' + f + '_' + i, publishedAt: '2026-11-14T00:00:00.000Z' });
    }
    feedVideos.push(videos);
  }
  let count = 0;
  try {
    // 計画は 20 + 61フィード×3本 = 203件 → キャップで200件に絞られる
    const fired = fireYouTubeAudioTriggers(feedVideos, () => { count++; }, now);
    assert.equal(fired, 200);
    assert.equal(count, 200);
  } finally { restore(); }
});

test('fireYouTubeAudioTriggers: プレイリスト (全件クラス) が増えても全体キャップ200件でフィード順に打ち切る', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
  });
  const feedVideos = [];
  for (let f = 0; f < 14; f++) {
    const videos = [];
    for (let i = 0; i < 15; i++) {
      // プレイリストは30日超でも全件が計画に入るため、14フィード×15本 = 210件の計画になる
      videos.push({ videoId: 'vidPl' + f + '_' + i, publishedAt: '2025-06-01T00:00:00.000Z', playlist: true });
    }
    feedVideos.push(videos);
  }
  let count = 0;
  try {
    const fired = fireYouTubeAudioTriggers(feedVideos, () => { count++; }, Date.parse('2026-11-15T00:00:00.000Z'));
    assert.equal(fired, 200);
    assert.equal(count, 200);
  } finally { restore(); }
});

test('fireYouTubeAudioTriggers: ベース URL が未設定ならトークンがあっても差し込み口は呼ばれない', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token' }).service,
  });
  let called = 0;
  try {
    const fired = fireYouTubeAudioTriggers(
      [[{ videoId: 'vidNew12345', publishedAt: '2026-11-14T00:00:00.000Z' }]],
      () => { called++; }
    );
    assert.equal(fired, 0);
    assert.equal(called, 0);
  } finally { restore(); }
});

test('fireYouTubeAudioTriggers: トークンが無ければ差し込み口も呼ばれない', () => {
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({}).service,
  });
  let called = 0;
  try {
    const fired = fireYouTubeAudioTriggers(
      [[{ videoId: 'vidNew12345', publishedAt: '2026-11-14T00:00:00.000Z' }]],
      () => { called++; }
    );
    assert.equal(fired, 0);
    assert.equal(called, 0);
  } finally { restore(); }
});

// ============================================================
// YouTube チャンネル登録 (購読) とフィードの同期。
// 購読の取得は YouTube 連携サービス (Advanced Service) を
// globalThis.YouTube のフェイクで差し替えて検証する。
// ============================================================

const CH_KEEP = 'UCkeepChannel000000001';
const CH_GONE = 'UCgoneChannel000000001';
const CH_NEW = 'UCnewChannel0000000001';
const CH_PINNED = 'UCbiDZXbr391oT_vsRiqwPFg'; // 本人のチャンネル (ピン留め)

function subscriptionItem(channelId, title) {
  return { snippet: { title, resourceId: { channelId } } };
}

// YouTube 連携サービスのフェイク。pages の要素が応答オブジェクト
// (または throw する Error) で、呼び出し順に返る。
function fakeYouTubeSubscriptions(pages) {
  const calls = [];
  let idx = 0;
  return {
    calls,
    service: {
      Subscriptions: {
        list: (part, params) => {
          calls.push([part, { ...params }]);
          const page = pages[Math.min(idx, pages.length - 1)];
          idx++;
          if (page instanceof Error) throw page;
          return page;
        },
      },
    },
  };
}

function ytFeedRow(id, channelId, title = 'YT', category = '') {
  return [id, title, 'https://www.youtube.com/channel/' + channelId, category, '', '', '', '', ''];
}

test('parseYouTubeSubscriptionsPage: snippet から channelId とタイトルを抜き、次ページトークンを返す', () => {
  const parsed = parseYouTubeSubscriptionsPage({
    items: [
      subscriptionItem(CH_KEEP, ' チャンネルA '),
      { snippet: { title: 'IDなし', resourceId: {} } },
      { snippet: null },
      {},
      subscriptionItem(CH_NEW, 'チャンネルB'),
    ],
    nextPageToken: 'tok2',
  });
  assert.deepEqual(parsed.channels, [
    { channelId: CH_KEEP, title: 'チャンネルA' },
    { channelId: CH_NEW, title: 'チャンネルB' },
  ]);
  assert.equal(parsed.nextPageToken, 'tok2');
  // 応答が壊れていても空として扱う (呼び出し側の中止判定に委ねる)
  assert.deepEqual(parseYouTubeSubscriptionsPage(null), { channels: [], nextPageToken: '' });
  assert.deepEqual(parseYouTubeSubscriptionsPage({}), { channels: [], nextPageToken: '' });
});

test('planYouTubeSubscriptionSync: 購読にあって feeds に無いチャンネルは正規形 URL とハッシュ ID で追加候補になる', () => {
  const feeds = [
    { id: 'yt-keep', title: 'A', url: 'https://www.youtube.com/channel/' + CH_KEEP, category: '' },
    { id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech' },
  ];
  const plan = planYouTubeSubscriptionSync(feeds, [
    { channelId: CH_KEEP, title: 'A' },
    { channelId: CH_NEW, title: '新しいチャンネル' },
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.toAdd[0].channelId, CH_NEW);
  assert.equal(plan.toAdd[0].title, '新しいチャンネル');
  assert.equal(plan.toAdd[0].url, 'https://www.youtube.com/channel/' + CH_NEW);
  assert.equal(plan.toAdd[0].id, feedIdFromUrl('https://www.youtube.com/channel/' + CH_NEW));
  assert.deepEqual(plan.toDelete, []);
  assert.equal(plan.deleteBlocked, false);
});

test('planYouTubeSubscriptionSync: 購読に無い YouTube フィードは削除候補になり、通常フィードには触らない', () => {
  const feeds = [
    { id: 'yt-keep', title: 'A', url: 'https://www.youtube.com/channel/' + CH_KEEP, category: '' },
    { id: 'yt-gone', title: 'G', url: 'https://www.youtube.com/channel/' + CH_GONE, category: '' },
    { id: 'zenn', title: 'Zenn', url: 'https://zenn.dev/feed', category: 'tech' },
  ];
  const plan = planYouTubeSubscriptionSync(feeds, [{ channelId: CH_KEEP, title: 'A' }]);
  assert.equal(plan.ok, true);
  // 削除判定は URL のチャンネルIDで行い、行の ID (slug でも) をそのまま返す
  assert.deepEqual(plan.toDelete, [
    { id: 'yt-gone', channelId: CH_GONE, url: 'https://www.youtube.com/channel/' + CH_GONE },
  ]);
  assert.deepEqual(plan.toAdd, []);
});

test('planYouTubeSubscriptionSync: 本人のチャンネル (ピン留め) は購読に無くても削除せず、購読にあっても追加しない', () => {
  const feeds = [
    { id: 'own', title: '本人', url: 'https://www.youtube.com/channel/' + CH_PINNED, category: '音楽' },
    { id: 'yt-keep', title: 'A', url: 'https://www.youtube.com/channel/' + CH_KEEP, category: '' },
  ];
  const plan = planYouTubeSubscriptionSync(feeds, [{ channelId: CH_KEEP, title: 'A' }]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.toDelete, []);
  assert.deepEqual(plan.toAdd, []);
  // feeds に無い状態で購読側に現れても (実際には起こらないが) 追加対象にしない
  const plan2 = planYouTubeSubscriptionSync([], [
    { channelId: CH_PINNED, title: '本人' },
    { channelId: CH_KEEP, title: 'A' },
  ]);
  assert.deepEqual(plan2.toAdd.map((a) => a.channelId), [CH_KEEP]);
});

test('planYouTubeSubscriptionSync: プレイリストフィードには触らない (購読に無くても削除しない)', () => {
  const feeds = [
    { id: 'yt-keep', title: 'A', url: 'https://www.youtube.com/channel/' + CH_KEEP, category: '' },
    { id: 'yt-pl', title: 'PL', url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00', category: '' },
  ];
  const plan = planYouTubeSubscriptionSync(feeds, [{ channelId: CH_KEEP, title: 'A' }]);
  assert.equal(plan.ok, true);
  // 同期対象はチャンネル正規形のフィードだけ。プレイリスト行は
  // チャンネルIDが抜けないため、削除候補にも追加候補にも入らない。
  assert.deepEqual(plan.toDelete, []);
  assert.deepEqual(plan.toAdd, []);
});

test('planYouTubeSubscriptionSync: 購読が空・不正なら中止 (ok:false) で何も計画しない', () => {
  const feeds = [
    { id: 'yt-gone', title: 'G', url: 'https://www.youtube.com/channel/' + CH_GONE, category: '' },
  ];
  assert.deepEqual(planYouTubeSubscriptionSync(feeds, []), { ok: false, reason: 'empty', toAdd: [], toDelete: [], deleteBlocked: false });
  assert.equal(planYouTubeSubscriptionSync(feeds, null).ok, false);
  assert.equal(planYouTubeSubscriptionSync(feeds, undefined).reason, 'invalid');
  // channelId が読めないエントリだけなら実質0件として中止する
  assert.equal(planYouTubeSubscriptionSync(feeds, [{ title: 'x' }]).reason, 'empty');
});

test('planYouTubeSubscriptionSync: 削除候補が上限 (5件) を超えたら deleteBlocked で、追加は計画される', () => {
  const feeds = [{ id: 'yt-keep', title: 'A', url: 'https://www.youtube.com/channel/' + CH_KEEP, category: '' }];
  for (let i = 0; i < 6; i++) {
    feeds.push({ id: 'yt-gone-' + i, title: 'G' + i, url: 'https://www.youtube.com/channel/UCgone0000000000000' + i, category: '' });
  }
  const plan = planYouTubeSubscriptionSync(feeds, [
    { channelId: CH_KEEP, title: 'A' },
    { channelId: CH_NEW, title: 'N' },
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.toDelete.length, 6);
  assert.equal(plan.deleteBlocked, true);
  assert.equal(plan.toAdd.length, 1);
  // ちょうど上限なら削除できる
  const plan5 = planYouTubeSubscriptionSync(feeds.slice(0, 6), [{ channelId: CH_KEEP, title: 'A' }]);
  assert.equal(plan5.toDelete.length, 5);
  assert.equal(plan5.deleteBlocked, false);
});

test('planYouTubeSubscriptionSync: 購読の重複は一意化され、追加は1件だけになる', () => {
  const plan = planYouTubeSubscriptionSync([], [
    { channelId: CH_NEW, title: 'N' },
    { channelId: CH_NEW, title: 'N (重複)' },
  ]);
  assert.equal(plan.ok, true);
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.toAdd[0].title, 'N');
});

test('fetchMyYouTubeSubscriptions: ページングをたどって全件を集約し、引数は mine=true で渡る', () => {
  const yt = fakeYouTubeSubscriptions([
    { items: [subscriptionItem(CH_KEEP, 'A')], nextPageToken: 'tok2' },
    { items: [subscriptionItem(CH_NEW, 'B')] },
  ]);
  const restore = installGasGlobals({ YouTube: yt.service });
  try {
    const channels = fetchMyYouTubeSubscriptions();
    assert.deepEqual(channels, [
      { channelId: CH_KEEP, title: 'A' },
      { channelId: CH_NEW, title: 'B' },
    ]);
    assert.equal(yt.calls.length, 2);
    assert.equal(yt.calls[0][0], 'snippet');
    assert.deepEqual(yt.calls[0][1], { mine: true, maxResults: 50 });
    assert.deepEqual(yt.calls[1][1], { mine: true, maxResults: 50, pageToken: 'tok2' });
  } finally { restore(); }
});

test('fetchMyYouTubeSubscriptions: 連携サービスが無い環境では例外になる', () => {
  const restore = installGasGlobals({ YouTube: undefined });
  try {
    assert.throws(() => fetchMyYouTubeSubscriptions(), /advanced service is not enabled/);
  } finally { restore(); }
});

// syncYouTubeSubscriptions の統合テスト用環境。
function syncTestEnv({ feedsRows = [], articlesRows = [], pages }) {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, ...feedsRows],
    articles: [ARTICLE_HEADERS_ROW, ...articlesRows],
  });
  const yt = fakeYouTubeSubscriptions(pages);
  const logs = [];
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' }).service,
    Utilities: fakeUtilities,
    YouTube: yt.service,
    Logger: { log: (msg) => logs.push(String(msg)) },
  });
  return { ss, restore, logs, yt };
}

test('syncYouTubeSubscriptions: 新規チャンネルは仮ジャンル YouTube で正規形の行が追加される', () => {
  const { ss, restore, logs } = syncTestEnv({
    feedsRows: [
      ytFeedRow('yt-keep', CH_KEEP, 'A'),
      ['zenn', 'Zenn', 'https://zenn.dev/feed', 'tech', '', '', '', '', ''],
    ],
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A'), subscriptionItem(CH_NEW, '新しいチャンネル')] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.deepEqual(result, { ok: true, added: 1, deleted: 0, deleteBlocked: false, subscriptionCount: 2 });
    const rows = ss.sheets['feeds'].rows;
    assert.equal(rows.length, 4);
    const added = rows[3];
    assert.equal(added[0], feedIdFromUrl('https://www.youtube.com/channel/' + CH_NEW));
    assert.equal(added[1], '新しいチャンネル');
    assert.equal(added[2], 'https://www.youtube.com/channel/' + CH_NEW);
    assert.equal(added[3], 'YouTube');
    assert.equal(added.length, 9);
    assert.ok(logs.some((m) => m.includes('added=1') && m.includes('deleted=0')), logs.join('\n'));
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: 購読解除されたチャンネルは記事ごと削除され、他の記事は残る', () => {
  const { ss, restore } = syncTestEnv({
    feedsRows: [ytFeedRow('yt-keep', CH_KEEP, 'A'), ytFeedRow('yt-gone', CH_GONE, 'G')],
    articlesRows: [
      ['art-g1', 'yt-gone', '動画1', 'https://www.youtube.com/watch?v=v1', '', '', '', ''],
      ['art-g2', 'yt-gone', '動画2', 'https://www.youtube.com/watch?v=v2', '', '', '', ''],
      ['art-k1', 'yt-keep', '動画3', 'https://www.youtube.com/watch?v=v3', '', '', '', ''],
    ],
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A')] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 1);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'yt-keep']);
    assert.deepEqual(ss.sheets['articles'].rows.map((r) => r[0]), ['id', 'art-k1']);
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: 本人のチャンネル (ピン留め) は購読に無くても残る', () => {
  const { ss, restore } = syncTestEnv({
    feedsRows: [ytFeedRow('own', CH_PINNED, '本人', '音楽'), ytFeedRow('yt-keep', CH_KEEP, 'A')],
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A')] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 0);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'own', 'yt-keep']);
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: プレイリストフィードは購読に無くても残る', () => {
  const { ss, restore } = syncTestEnv({
    feedsRows: [
      ytFeedRow('yt-keep', CH_KEEP, 'A'),
      ['yt-pl', 'お気に入り', 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00', '', '', '', '', '', ''],
    ],
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A')] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 0);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'yt-keep', 'yt-pl']);
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: 購読の取得に失敗したら中止し、フィードは一切変わらない', () => {
  const { ss, restore, logs } = syncTestEnv({
    feedsRows: [ytFeedRow('yt-gone', CH_GONE, 'G')],
    pages: [new Error('API unavailable')],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch_failed');
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'yt-gone']);
    assert.ok(logs.some((m) => m.includes('aborted (fetch_failed)')), logs.join('\n'));
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: 購読が0件なら中止し、YouTube フィードを消さない', () => {
  const { ss, restore, logs } = syncTestEnv({
    feedsRows: [ytFeedRow('yt-gone', CH_GONE, 'G')],
    pages: [{ items: [] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'yt-gone']);
    assert.ok(logs.some((m) => m.includes('aborted (empty)')), logs.join('\n'));
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: 削除候補が上限を超えたら削除だけ中止し、追加は行われる', () => {
  const feedsRows = [ytFeedRow('yt-keep', CH_KEEP, 'A')];
  for (let i = 0; i < 6; i++) {
    feedsRows.push(ytFeedRow('yt-gone-' + i, 'UCgone0000000000000' + i, 'G' + i));
  }
  const { ss, restore, logs } = syncTestEnv({
    feedsRows,
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A'), subscriptionItem(CH_NEW, 'N')] }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    assert.equal(result.deleted, 0);
    assert.equal(result.deleteBlocked, true);
    // 6件とも残り、新規行が末尾に足される
    assert.equal(ss.sheets['feeds'].rows.length, 1 + 7 + 1);
    assert.ok(logs.some((m) => m.includes('deletes skipped')), logs.join('\n'));
  } finally { restore(); }
});

test('fetchFeeds: 記事取得より前に購読同期が走り、追加されたチャンネルも同じ巡回で取り込まれる', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ytFeedRow('yt-keep', CH_KEEP, 'A'),
      ytFeedRow('yt-gone', CH_GONE, 'G'),
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['art-g1', 'yt-gone', '動画G', 'https://www.youtube.com/watch?v=vG', '', '', '', ''],
    ],
  });
  const yt = fakeYouTubeSubscriptions([
    { items: [subscriptionItem(CH_KEEP, 'A'), subscriptionItem(CH_NEW, '新しいチャンネル')] },
  ]);
  const playlistBody = JSON.stringify({
    items: [
      { snippet: { title: '新着動画', description: '説明', publishedAt: '2026-11-14T00:00:00Z', channelTitle: 'ch', resourceId: { videoId: 'vidNew12345' } } },
    ],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key' }).service,
    Utilities: fakeUtilities,
    YouTube: yt.service,
    Logger: { log: () => {} },
    UrlFetchApp: {
      fetch: (url) => {
        if (String(url).includes('playlistItems')) {
          return { getResponseCode: () => 200, getContentText: () => playlistBody };
        }
        throw new Error('unexpected fetch: ' + url);
      },
    },
  });
  try {
    const result = fetchFeeds();
    assert.equal(result.ok, true);
    // 同期で yt-gone が消え、yt-new が増えた後の2件が巡回対象になる
    assert.equal(result.fetched, 2);
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), [
      'id', 'yt-keep', feedIdFromUrl('https://www.youtube.com/channel/' + CH_NEW),
    ]);
    // 削除されたフィードの記事はカスケードで消え、残った2フィードの記事が入る
    const articleFeedIds = ss.sheets['articles'].rows.slice(1).map((r) => r[1]).sort();
    assert.deepEqual(articleFeedIds, ['yt-keep', feedIdFromUrl('https://www.youtube.com/channel/' + CH_NEW)].sort());
  } finally { restore(); }
});

// --- テスト総点検 (2026-11-16) の最小追加セット ---
// 監査レポート test-audit-reader-gas.md の不足リスト (高1・高2・中3・中4・中5) への対応。

test('doPost: 書き込み系アクションは readonly セッションで forbidden になり、シートも変わらない', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['feed-a', 'フィードA', 'https://example.com/a.xml', 'tech', '', '', '', '', ''],
      ['feed-b', 'フィードB', 'https://example.com/b.xml', 'tech', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    const readonly = issueSession('readonly');
    const before = JSON.stringify(ss.sheets['feeds'].rows);
    assert.deepEqual(post({ action: 'listFeeds', sessionToken: readonly.sessionToken }), { ok: false, error: 'forbidden' });
    assert.deepEqual(post({ action: 'saveFeed', sessionToken: readonly.sessionToken, feed: { url: 'https://example.com/c.xml', title: 'C' } }), { ok: false, error: 'forbidden' });
    assert.deepEqual(post({ action: 'deleteFeed', sessionToken: readonly.sessionToken, feedId: 'feed-a' }), { ok: false, error: 'forbidden' });
    assert.deepEqual(post({ action: 'reorderFeeds', sessionToken: readonly.sessionToken, feedIds: ['feed-b', 'feed-a'] }), { ok: false, error: 'forbidden' });
    // 拒否された書き込みはシートに一切反映されない
    assert.equal(JSON.stringify(ss.sheets['feeds'].rows), before);
    // 対照: オーナーは同じアクションを通せる
    const owner = issueSession('owner');
    assert.equal(post({ action: 'listFeeds', sessionToken: owner.sessionToken }).ok, true);
  } finally { restore(); }
});

test('doPost reorderFeeds: 指定順がシートに書き戻され、不正な順序は invalid で無変更', () => {
  const rowA = ['feed-a', 'フィードA', 'https://example.com/a.xml', 'tech', '', '', '2026-11-15T00:00:00.000Z', '200', ''];
  const rowB = ['feed-b', 'フィードB', 'https://example.com/b.xml', 'news', '', '', '', '', ''];
  const rowC = ['feed-c', 'フィードC', 'https://example.com/c.xml', '', '', '', '', '', ''];
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, rowA, rowB, rowC],
    articles: [ARTICLE_HEADERS_ROW],
  });
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    const owner = issueSession('owner');
    assert.deepEqual(post({ action: 'reorderFeeds', sessionToken: owner.sessionToken, feedIds: ['feed-c', 'feed-a', 'feed-b'] }), { ok: true });
    // ヘッダーは先頭のまま、データ行だけが指定順に入れ替わる
    assert.deepEqual(ss.sheets['feeds'].rows, [FEED_HEADERS_ROW, rowC, rowA, rowB]);
    // 未知の ID を含む順序は invalid で、シートは変わらない
    const bad = post({ action: 'reorderFeeds', sessionToken: owner.sessionToken, feedIds: ['feed-c', 'feed-a', 'nope'] });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid');
    assert.deepEqual(ss.sheets['feeds'].rows, [FEED_HEADERS_ROW, rowC, rowA, rowB]);
  } finally { restore(); }
});

test('doPost listFeeds: 応答のキー集合が固定され、行順と記事数がそのまま返る', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['feed-b', 'フィードB', 'https://example.com/b.xml', 'news', '', '', '2026-11-15T01:00:00.000Z', '200', ''],
      ['feed-a', 'フィードA', 'https://example.com/a.xml', 'tech', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW,
      ['art1', 'feed-a', '記事1', 'https://example.com/1', '', '', '', ''],
      ['art2', 'feed-a', '記事2', 'https://example.com/2', '', '', '', ''],
      ['art3', 'feed-b', '記事3', 'https://example.com/3', '', '', '', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    const owner = issueSession('owner');
    const res = post({ action: 'listFeeds', sessionToken: owner.sessionToken });
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res).sort(), ['feeds', 'ok']);
    // シートの行順が表示順としてそのまま返る
    assert.deepEqual(res.feeds.map((f) => f.id), ['feed-b', 'feed-a']);
    assert.deepEqual(Object.keys(res.feeds[0]).sort(), [
      'category', 'fetchUrl', 'id', 'lastError', 'lastFetchedAt', 'lastStatus', 'pastGuard', 'sortDirection', 'starCount', 'starMinSec', 'starMode', 'syncDeletes', 'title', 'unreadCount', 'url',
    ]);
    // 未読数 = そのフィードの記事数 (サーバー側に既読は無い)
    assert.equal(res.feeds[0].unreadCount, 1);
    assert.equal(res.feeds[1].unreadCount, 2);
    assert.equal(res.feeds[0].title, 'フィードB');
    assert.equal(res.feeds[0].category, 'news');
    // ScriptApp が無い環境ではサービス URL が空で、fetchUrl はフィード URL そのまま
    assert.equal(res.feeds[0].fetchUrl, 'https://example.com/b.xml');
    assert.equal(res.feeds[0].lastFetchedAt, '2026-11-15T01:00:00.000Z');
    assert.equal(res.feeds[0].lastStatus, '200');
  } finally { restore(); }
});

// tokeninfo への UrlFetch を差し込んだ環境 (verifyIdToken と exchange_session 用)。
function tokenInfoEnv({ responder, ss = new FakeSpreadsheet({}), extraProps = {} }) {
  const props = fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id', ALLOWED_EMAIL: 'owner@example.com', ...extraProps });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: props.service,
    ContentService: fakeContentService(),
    Utilities: fakeUtilities,
    UrlFetchApp: { fetch: (url) => responder(url) },
  });
  return { restore, ss };
}
const jsonHttpResponse = (code, body) => ({
  getResponseCode: () => code,
  getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('verifyIdToken: tokeninfo の許可ペイロードをそのまま返し、URL に id_token が乗る', () => {
  const payload = { email: 'owner@example.com', email_verified: 'true', aud: 'client-123', sub: 'subject-1' };
  let seenUrl = '';
  const { restore } = tokenInfoEnv({
    responder: (url) => { seenUrl = String(url); return jsonHttpResponse(200, payload); },
    extraProps: { GOOGLE_CLIENT_ID: 'client-123' },
  });
  try {
    assert.deepEqual(verifyIdToken('tok en/+='), payload);
    assert.equal(seenUrl, 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent('tok en/+='));
  } finally { restore(); }
});

test('verifyIdToken: 非200・不正JSON・未検証メール・別メール・aud不一致はすべて null', () => {
  const okPayload = { email: 'owner@example.com', email_verified: 'true', aud: 'client-123' };
  const responders = [
    () => jsonHttpResponse(400, { error: 'invalid_token' }),
    () => jsonHttpResponse(200, 'not json'),
    () => jsonHttpResponse(200, { ...okPayload, email_verified: 'false' }),
    () => jsonHttpResponse(200, { ...okPayload, email: 'someone@example.com' }),
    () => jsonHttpResponse(200, { ...okPayload, aud: 'other-client' }),
  ];
  for (const responder of responders) {
    const { restore } = tokenInfoEnv({ responder, extraProps: { GOOGLE_CLIENT_ID: 'client-123' } });
    try {
      assert.equal(verifyIdToken('some-token'), null);
    } finally { restore(); }
  }
  // 空トークンは tokeninfo を叩かずに null
  let called = false;
  const env = tokenInfoEnv({ responder: () => { called = true; return jsonHttpResponse(200, okPayload); } });
  try {
    assert.equal(verifyIdToken(''), null);
    assert.equal(called, false);
  } finally { env.restore(); }
});

test('verifyIdToken / exchange_session: tokeninfo の例外は伝播し、doPost では ok:false でセッションは作られない', () => {
  // 現行の verifyIdToken は UrlFetchApp.fetch の例外を握らない (非200や
  // 検証 NG は null で返す)。例外は doPost の外側 catch で ok:false に
  // なり、セッションは発行されない。この現行挙動を固定する。
  const { restore, ss } = tokenInfoEnv({
    responder: () => { throw new Error('network down'); },
  });
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    assert.throws(() => verifyIdToken('some-token'), /network down/);
    const res = post({ action: 'exchange_session', idToken: 'some-token' });
    assert.equal(res.ok, false);
    const sheet = ss.sheets['owner_sessions'];
    assert.ok(!sheet || sheet.rows.length <= 1, 'セッション行が作られていない');
  } finally { restore(); }
});

test('doPost exchange_session: ID トークンが通れば owner セッションが発行され、オーナー限定アクションまで使える', () => {
  const payload = { email: 'owner@example.com', email_verified: 'true', aud: 'client-123' };
  const { restore, ss } = tokenInfoEnv({
    responder: () => jsonHttpResponse(200, payload),
    extraProps: { GOOGLE_CLIENT_ID: 'client-123' },
  });
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    const issued = post({ action: 'exchange_session', idToken: 'valid-token' });
    assert.equal(issued.ok, true);
    assert.equal(issued.role, 'owner');
    assert.ok(issued.sessionToken);
    // 発行されたセッションで listFeeds が通る
    assert.deepEqual(post({ action: 'listFeeds', sessionToken: issued.sessionToken }), { ok: true, feeds: [] });
    // シートに残るのはハッシュだけで、生トークンは残らない
    assert.ok(!JSON.stringify(ss.sheets['owner_sessions'].rows).includes(issued.sessionToken));
  } finally { restore(); }
});

test('doPost exchange_session: ID トークンが拒否されれば unauthorized で、セッション行は作られない', () => {
  const { restore, ss } = tokenInfoEnv({
    responder: () => jsonHttpResponse(200, { email: 'owner@example.com', email_verified: 'false' }),
  });
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    assert.deepEqual(post({ action: 'exchange_session', idToken: 'bad-token' }), { ok: false, error: 'unauthorized' });
    const sheet = ss.sheets['owner_sessions'];
    assert.ok(!sheet || sheet.rows.length <= 1, 'セッション行が作られていない');
  } finally { restore(); }
});

test('appsscript.json: webapp.access とスコープ・有効化サービスが固定されている', () => {
  const manifest = JSON.parse(readFileSync(new URL('../appsscript.json', import.meta.url), 'utf8'));
  // 匿名アクセスが CI 再デプロイで巻き戻らないこと (access は ANYONE_ANONYMOUS が正)
  assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.deepEqual([...manifest.oauthScopes].sort(), [
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].sort());
  assert.deepEqual(manifest.dependencies.enabledAdvancedServices, [
    { serviceId: 'youtube', userSymbol: 'YouTube', version: 'v3' },
  ]);
});

test('fetchMyYouTubeSubscriptions: 次ページが返り続けると上限ページ数で例外になる', () => {
  const yt = fakeYouTubeSubscriptions([{ items: [subscriptionItem(CH_KEEP, 'A')], nextPageToken: 'more' }]);
  const restore = installGasGlobals({ YouTube: yt.service });
  try {
    assert.throws(() => fetchMyYouTubeSubscriptions(), /paging exceeded 20 pages/);
    assert.equal(yt.calls.length, 20);
  } finally { restore(); }
});

test('syncYouTubeSubscriptions: ページング上限超過では中止し、削除も追加も走らない', () => {
  const { ss, restore, logs } = syncTestEnv({
    feedsRows: [ytFeedRow('yt-gone', CH_GONE, 'G')],
    pages: [{ items: [subscriptionItem(CH_KEEP, 'A')], nextPageToken: 'more' }],
  });
  try {
    const result = syncYouTubeSubscriptions();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch_failed');
    // 一覧が不完全な可能性があるため、購読に無いフィードも消さない
    assert.deepEqual(ss.sheets['feeds'].rows.map((r) => r[0]), ['id', 'yt-gone']);
    assert.ok(logs.some((m) => m.includes('aborted (fetch_failed)') && m.includes('paging exceeded')), logs.join('\n'));
  } finally { restore(); }
});

// ============================================================
// スター制 (YouTube 再生対象の手動オーバーライド＋デフォルト判定)
// ============================================================

const ARTICLE_HEADERS_ROW_STAR = [...ARTICLE_HEADERS_ROW, 'star_override'];
const STAR_NOW = Date.parse('2026-11-15T00:00:00.000Z');
const STAR_FEED_NORMAL = { id: 'yt-n', title: '通常', url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', category: '' };
const STAR_FEED_MUSIC = { id: 'yt-m', title: '音楽', url: 'https://www.youtube.com/channel/UCmusicchanneL1', category: '音楽' };
const STAR_FEED_OWN = { id: 'yt-own', title: '本人', url: 'https://www.youtube.com/channel/UCbiDZXbr391oT_vsRiqwPFg', category: '' };
const STAR_FEED_PLAYLIST = { id: 'yt-pl', title: 'お気に入り', url: 'https://www.youtube.com/playlist?list=PLxNfaRC6MbAnwSR1Dqqv69A00', category: '' };

function starArticle(id, feedId, videoId, publishedAt, override) {
  const a = {
    id, feed_id: feedId, title: '動画 ' + videoId,
    link: 'https://www.youtube.com/watch?v=' + videoId,
    published_at: publishedAt, fetched_at: publishedAt, summary: '', author: '',
  };
  if (override !== undefined) a.star_override = override;
  return a;
}

test('computeStarredArticleIds: デフォルトは通常フィードで期間なし・新しい順3本だけ', () => {
  const articles = [
    starArticle('a1', 'yt-n', 'vidS00001', '2026-11-14T00:00:00.000Z'),
    starArticle('a2', 'yt-n', 'vidS00002', '2026-11-13T00:00:00.000Z'),
    starArticle('a3', 'yt-n', 'vidS00003', '2026-11-12T00:00:00.000Z'),
    starArticle('a4', 'yt-n', 'vidS00004', '2026-11-11T00:00:00.000Z'),
    starArticle('a5', 'yt-n', 'vidS00005', '2026-11-10T00:00:00.000Z'),
    starArticle('a6', 'yt-n', 'vidS00006', '2026-09-01T00:00:00.000Z'),
  ];
  const starred = computeStarredArticleIds([STAR_FEED_NORMAL], articles, STAR_NOW);
  assert.deepEqual(Object.keys(starred).sort(), ['a1', 'a2', 'a3']);
});

test('computeStarredArticleIds: 音楽ジャンルのチャンネルも通常ルール (期間なし・新しい順3本)、常時対応チャンネルは全件', () => {
  // 旧来の音楽ジャンル特別ルール (期間なし・20本) は廃止した。
  const music = [];
  for (let i = 1; i <= 25; i++) {
    // 2024年の日付を新しい順に25本 (すべて30日より古い)
    const d = new Date(Date.parse('2024-12-31T00:00:00.000Z') - (i - 1) * 24 * 60 * 60 * 1000).toISOString();
    music.push(starArticle('m' + i, 'yt-m', 'vidM' + String(i).padStart(5, '0'), d));
  }
  const own = [
    starArticle('o1', 'yt-own', 'vidO00001', '2023-01-01T00:00:00.000Z'),
    starArticle('o2', 'yt-own', 'vidO00002', '2023-06-01T00:00:00.000Z'),
  ];
  const starred = computeStarredArticleIds([STAR_FEED_MUSIC, STAR_FEED_OWN], [...music, ...own], STAR_NOW);
  // 音楽ジャンルでも通常ルール: 期間制限は無いので古くても新しい順3本
  // (m1 が最新) だけが付き、4本目以降は付かない (旧特別ルールの20本ではない)。
  assert.deepEqual(Object.keys(starred).filter((id) => id.startsWith('m')).sort(), ['m1', 'm2', 'm3']);
  // 常時対応チャンネルは古くても全件
  assert.ok(starred['o1'] && starred['o2']);
});

test('computeStarredArticleIds: duration_sec が90秒未満の記事はデフォルトで付かず、次の記事が繰り上がる', () => {
  const mk = (id, vid, date, sec) => {
    const a = starArticle(id, 'yt-n', vid, date);
    if (sec !== undefined) a.duration_sec = sec;
    return a;
  };
  const articles = [
    mk('s1', 'vidD00001', '2026-11-14T00:00:00.000Z', 45),
    mk('s2', 'vidD00002', '2026-11-13T00:00:00.000Z', 200),
    mk('s3', 'vidD00003', '2026-11-12T00:00:00.000Z', ''),
    mk('s4', 'vidD00004', '2026-11-11T00:00:00.000Z', 300),
    mk('s5', 'vidD00005', '2026-11-10T00:00:00.000Z', 400),
  ];
  const starred = computeStarredArticleIds([STAR_FEED_NORMAL], articles, STAR_NOW);
  // s1 (45秒) は数えず、s2・s3 (長さ不明=fail-open)・s4 の3本。
  assert.deepEqual(Object.keys(starred).sort(), ['s2', 's3', 's4']);
});

test('computeStarredArticleIds: プレイリストフィードの記事は全件がデフォルトで付く (手動 off は外れる)', () => {
  const articles = [];
  for (let i = 1; i <= 25; i++) {
    // すべて30日より古い日付でも、プレイリストは全件クラス
    const d = new Date(Date.parse('2024-12-31T00:00:00.000Z') - (i - 1) * 24 * 60 * 60 * 1000).toISOString();
    articles.push(starArticle('p' + i, 'yt-pl', 'vidP' + String(i).padStart(5, '0'), d));
  }
  // 手動で外した1本だけは全件クラスでも外れる
  articles.push(starArticle('pOff', 'yt-pl', 'vidPOff0001', '2024-01-01T00:00:00.000Z', 'off'));
  const starred = computeStarredArticleIds([STAR_FEED_PLAYLIST], articles, STAR_NOW);
  assert.equal(Object.keys(starred).length, 25);
  assert.ok(starred['p25']);
  assert.ok(!starred['pOff']);
});

test('computeStarredArticleIds: star_mode=all のチャンネルは全件、none は自動が付かない (手動 on は効く)', () => {
  const mkArticles = () => [
    starArticle('a1', 'yt-n', 'vidS00001', '2026-11-14T00:00:00.000Z'),
    starArticle('a2', 'yt-n', 'vidS00002', '2026-11-13T00:00:00.000Z'),
    starArticle('a3', 'yt-n', 'vidS00003', '2026-11-12T00:00:00.000Z'),
    starArticle('a4', 'yt-n', 'vidS00004', '2026-11-11T00:00:00.000Z'),
  ];
  const allFeed = { ...STAR_FEED_NORMAL, star_mode: 'all' };
  assert.deepEqual(Object.keys(computeStarredArticleIds([allFeed], mkArticles(), STAR_NOW)).sort(), ['a1', 'a2', 'a3', 'a4']);
  const noneFeed = { ...STAR_FEED_NORMAL, star_mode: 'none' };
  assert.deepEqual(Object.keys(computeStarredArticleIds([noneFeed], mkArticles(), STAR_NOW)), []);
  const withManual = mkArticles();
  withManual[3].star_override = 'on';
  assert.deepEqual(Object.keys(computeStarredArticleIds([noneFeed], withManual, STAR_NOW)), ['a4']);
});

test('computeStarredArticleIds: star_count と star_min_sec の指定が選定に効く', () => {
  const feed = { ...STAR_FEED_NORMAL, star_count: 2, star_min_sec: 0 };
  const mk = (id, vid, date, sec) => {
    const a = starArticle(id, 'yt-n', vid, date);
    if (sec !== undefined) a.duration_sec = sec;
    return a;
  };
  const articles = [
    mk('s1', 'vidD00001', '2026-11-14T00:00:00.000Z', 45),
    mk('s2', 'vidD00002', '2026-11-13T00:00:00.000Z', 200),
    mk('s3', 'vidD00003', '2026-11-12T00:00:00.000Z', 300),
  ];
  // minSec=0 では45秒も数え、本数2で s1・s2。
  assert.deepEqual(Object.keys(computeStarredArticleIds([feed], articles, STAR_NOW)).sort(), ['s1', 's2']);
});

test('planStarSelection: none は空、recent は本数と下限で選び、all は入力順の全件', () => {
  const vids = [
    { videoId: 'v1', publishedAt: '2026-11-14T00:00:00.000Z', durationSec: 30 },
    { videoId: 'v2', publishedAt: '2026-11-13T00:00:00.000Z', durationSec: 500 },
    { videoId: 'v3', publishedAt: '2026-11-12T00:00:00.000Z', durationSec: 500 },
  ];
  assert.deepEqual(planStarSelection(vids, { mode: 'none' }), []);
  assert.deepEqual(planStarSelection(vids, { mode: 'all' }), ['v1', 'v2', 'v3']);
  assert.deepEqual(planStarSelection(vids, { mode: 'recent', count: 2, minSec: 90 }), ['v2', 'v3']);
  assert.deepEqual(planStarSelection(vids, { mode: 'recent', count: 1, minSec: 0 }), ['v1']);
});

test('computeStarredArticleIds: 手動オーバーライドが優先され、外した枠への繰り上げは起きない', () => {
  const articles = [
    starArticle('v1', 'yt-n', 'vidNv00001', '2026-11-14T00:00:00.000Z', 'off'),
    starArticle('v2', 'yt-n', 'vidNv00002', '2026-11-13T00:00:00.000Z'),
    starArticle('v3', 'yt-n', 'vidNv00003', '2026-11-12T00:00:00.000Z'),
    starArticle('v4', 'yt-n', 'vidNv00004', '2026-11-11T00:00:00.000Z'),
    starArticle('v5', 'yt-n', 'vidNv00005', '2026-11-10T00:00:00.000Z', 'on'),
    starArticle('vOld', 'yt-n', 'vidNv00006', '2026-08-01T00:00:00.000Z', 'on'),
  ];
  const starred = computeStarredArticleIds([STAR_FEED_NORMAL], articles, STAR_NOW);
  // デフォルトは v1..v3 だが v1 は手動で外したため入らない。
  // v4 は v1 の枠に繰り上がらない (ランキングは記事集合全体で評価)。
  // v5 と vOld はデフォルト外でも手動で付けたため入る。
  assert.deepEqual(Object.keys(starred).sort(), ['v2', 'v3', 'v5', 'vOld']);
});

test('computeStarredArticleIds: 非YouTubeの記事は対象外、未知のオーバーライド値は自動判定扱い', () => {
  const webFeed = { id: 'web', title: 'Web', url: 'https://example.com/feed', category: '' };
  const articles = [
    // 非 YouTube フィードの記事は、手動 on でも実効スターにならない
    { id: 'w1', feed_id: 'web', title: '記事', link: 'https://example.com/1', published_at: '2026-11-14T00:00:00.000Z', fetched_at: '', summary: '', author: '', star_override: 'on' },
    // フィードが存在しない記事も対象外
    starArticle('x1', 'no-such-feed', 'vidX00001', '2026-11-14T00:00:00.000Z', 'on'),
    // 'yes' のような想定外の値は '' (自動判定) として扱い、デフォルトで付く
    starArticle('y1', 'yt-n', 'vidY00001', '2026-11-14T00:00:00.000Z', 'yes'),
  ];
  const starred = computeStarredArticleIds([webFeed, STAR_FEED_NORMAL], articles, STAR_NOW);
  assert.deepEqual(Object.keys(starred), ['y1']);
});

test('planStarredAudioTriggers: 手動 on を先頭に寄せ、続いてデフォルト (off除く) をフィード順に並べる', () => {
  const articles = [
    starArticle('m1', 'yt-pl', 'vidMu00001', '2024-05-01T00:00:00.000Z'),
    starArticle('v1', 'yt-n', 'vidNv00001', '2026-11-14T00:00:00.000Z', 'off'),
    starArticle('v2', 'yt-n', 'vidNv00002', '2026-11-13T00:00:00.000Z'),
    starArticle('v3', 'yt-n', 'vidNv00003', '2026-11-12T00:00:00.000Z'),
    starArticle('v4', 'yt-n', 'vidNv00004', '2026-11-11T00:00:00.000Z'),
    starArticle('v5', 'yt-n', 'vidNv00005', '2026-11-10T00:00:00.000Z', 'on'),
    starArticle('vOld', 'yt-n', 'vidNv00006', '2026-08-01T00:00:00.000Z', 'on'),
  ];
  const planned = planStarredAudioTriggers([STAR_FEED_PLAYLIST, STAR_FEED_NORMAL], articles, STAR_NOW);
  // 手動 on (新しい順: v5 → vOld) が全体の先頭。その後にデフォルト分を
  // フィード順に並べる (プレイリストのデフォルト (全件クラス) → 通常の
  // デフォルト。v1 は off で除く)。v4 はどちらにも入らない。
  assert.deepEqual(planned, ['vidNv00005', 'vidNv00006', 'vidMu00001', 'vidNv00002', 'vidNv00003']);
});

test('planStarredAudioTriggers + fire: 143本規模の計画は上限200に収まり全件が発火対象になる', () => {
  // 構成: プレイリスト4フィード×20本 (全件クラス) + 通常21フィード×3本 = 143本。
  // 旧上限100では後順位フィードが締め出されていた。
  const feeds = [];
  const articles = [];
  for (let f = 0; f < 4; f++) {
    const feedId = 'yt-cap-p' + f;
    feeds.push({ id: feedId, title: 'プレイリスト' + f, url: 'https://www.youtube.com/playlist?list=PLcaplist' + f + 'abcdefghij00', category: '' });
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.parse('2024-12-31T00:00:00.000Z') - i * 24 * 60 * 60 * 1000).toISOString();
      articles.push(starArticle(feedId + '-a' + i, feedId, 'vidCM' + f + '_' + String(i).padStart(2, '0'), d));
    }
  }
  for (let f = 0; f < 21; f++) {
    const feedId = 'yt-cap-n' + f;
    feeds.push({ id: feedId, title: '通常' + f, url: 'https://www.youtube.com/channel/UCcapnormal' + f + 'abcdefghij', category: '' });
    for (let i = 0; i < 3; i++) {
      const d = new Date(STAR_NOW - (i + 1) * 24 * 60 * 60 * 1000).toISOString();
      articles.push(starArticle(feedId + '-a' + i, feedId, 'vidCN' + f + '_' + i, d));
    }
  }
  const planned = planStarredAudioTriggers(feeds, articles, STAR_NOW);
  assert.equal(planned.length, 143);
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
  });
  let count = 0;
  try {
    const fired = fireYouTubeAudioTriggers(null, () => { count++; }, STAR_NOW, planned);
    assert.equal(fired, 143);
    assert.equal(count, 143);
  } finally { restore(); }
});

test('planStarredAudioTriggers + fire: 上限超過時は手動スターが残り、デフォルト分が末尾から切れる', () => {
  // プレイリスト11フィード×20本 (全件クラス) = デフォルト220本に、
  // 最後尾フィードの手動 on 1本を加えた221本の計画。上限200で
  // 切られても、手動分は先頭に寄せてあるため必ず残る。
  const feeds = [];
  const articles = [];
  for (let f = 0; f < 11; f++) {
    const feedId = 'yt-pri-p' + f;
    feeds.push({ id: feedId, title: 'プレイリスト' + f, url: 'https://www.youtube.com/playlist?list=PLprilist' + f + 'abcdefghij00', category: '' });
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.parse('2024-12-31T00:00:00.000Z') - i * 24 * 60 * 60 * 1000).toISOString();
      articles.push(starArticle(feedId + '-a' + i, feedId, 'vidPM' + f + '_' + String(i).padStart(2, '0'), d));
    }
  }
  const lastFeed = { id: 'yt-pri-last', title: '最後尾', url: 'https://www.youtube.com/channel/UCprilastchannel00', category: '' };
  feeds.push(lastFeed);
  articles.push(starArticle('last-manual', 'yt-pri-last', 'vidPriManual1', '2023-01-01T00:00:00.000Z', 'on'));
  const planned = planStarredAudioTriggers(feeds, articles, STAR_NOW);
  assert.equal(planned.length, 221);
  assert.equal(planned[0], 'vidPriManual1');
  const restore = installGasGlobals({
    PropertiesService: fakePropertiesService({ A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs' }).service,
  });
  const firedIds = [];
  try {
    const fired = fireYouTubeAudioTriggers(null, (videoId) => { firedIds.push(videoId); }, STAR_NOW, planned);
    assert.equal(fired, 200);
    assert.equal(firedIds.length, 200);
    // 手動スターは発火対象に残り、切れたのは末尾のデフォルト分だけ
    assert.ok(firedIds.includes('vidPriManual1'));
    assert.deepEqual(firedIds, planned.slice(0, 200));
    assert.ok(!firedIds.includes(planned[220]));
  } finally { restore(); }
});

test('handleSetStar: on で star_override 列を遅延追加して保存し、その場で抽出を依頼する', () => {
  const ss = new FakeSpreadsheet({
    articles: [ARTICLE_HEADERS_ROW,
      ['art-1', 'yt-x', '動画1', 'https://www.youtube.com/watch?v=vidStar0001', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', ''],
    ],
  });
  const restore = installSpreadsheet(ss, { A_ZE_GS_TOKEN: 'fake-ze-token' });
  const calls = [];
  try {
    const result = handleSetStar({ id: 'art-1', on: true }, (videoId, token) => { calls.push([videoId, token]); });
    assert.deepEqual(result, { ok: true, id: 'art-1', star_state: 'on', starred: true });
    // 列が無かったのでヘッダーへ追加され、その行のセルに on が入る
    assert.equal(ss.sheets['articles'].rows[0][8], 'star_override');
    assert.equal(ss.sheets['articles'].rows[1][8], 'on');
    // 既存の列は壊れていない
    assert.equal(ss.sheets['articles'].rows[1][2], '動画1');
    // 即時投入は1回だけ、動画IDとトークンが渡る
    assert.deepEqual(calls, [['vidStar0001', 'fake-ze-token']]);
  } finally { restore(); }
});

test('handleSetStar: off は依頼せず、既存の列は再利用し、未知IDは not_found で無変更', () => {
  const ss = new FakeSpreadsheet({
    articles: [ARTICLE_HEADERS_ROW_STAR,
      ['art-1', 'yt-x', '動画1', 'https://www.youtube.com/watch?v=vidStar0001', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', '', 'on'],
    ],
  });
  const restore = installSpreadsheet(ss, { A_ZE_GS_TOKEN: 'fake-ze-token' });
  const calls = [];
  try {
    const result = handleSetStar({ id: 'art-1', on: false }, (videoId) => { calls.push(videoId); });
    assert.deepEqual(result, { ok: true, id: 'art-1', star_state: 'off', starred: false });
    assert.equal(ss.sheets['articles'].rows[1][8], 'off');
    // ヘッダーは増えない (既存列の再利用)
    assert.equal(ss.sheets['articles'].rows[0].length, 9);
    assert.deepEqual(calls, []);
    // 未知の ID は not_found で、シートは変わらない
    const before = JSON.stringify(ss.sheets['articles'].rows);
    assert.deepEqual(handleSetStar({ id: 'nope', on: true }), { ok: false, error: 'not_found' });
    assert.equal(JSON.stringify(ss.sheets['articles'].rows), before);
    // ID が無ければ invalid
    assert.equal(handleSetStar({ on: true }).error, 'invalid');
  } finally { restore(); }
});

test('handleSetStar: A_ZE_GS_TOKEN 未設定でも保存は成功し、依頼だけ省く', () => {
  const ss = new FakeSpreadsheet({
    articles: [ARTICLE_HEADERS_ROW_STAR,
      ['art-1', 'yt-x', '動画1', 'https://www.youtube.com/watch?v=vidStar0001', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', '', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  const calls = [];
  try {
    const result = handleSetStar({ id: 'art-1', on: true }, (videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(ss.sheets['articles'].rows[1][8], 'on');
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test('doPost set_star: オーナーは実行でき、readonly は forbidden、無セッションは unauthorized', () => {
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW],
    articles: [ARTICLE_HEADERS_ROW,
      ['art-1', 'yt-x', '動画1', 'https://www.youtube.com/watch?v=vidStar0001', '2026-11-14T00:00:00.000Z', '2026-11-14T01:00:00.000Z', '', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    assert.deepEqual(post({ action: 'set_star', id: 'art-1', on: true }), { ok: false, error: 'unauthorized' });
    const readonly = issueSession('readonly');
    assert.deepEqual(post({ action: 'set_star', sessionToken: readonly.sessionToken, id: 'art-1', on: true }), { ok: false, error: 'forbidden' });
    // 拒否された書き込みは反映されない (列も作られない)
    assert.equal(ss.sheets['articles'].rows[0].length, 8);
    const owner = issueSession('owner');
    assert.deepEqual(
      post({ action: 'set_star', sessionToken: owner.sessionToken, id: 'art-1', on: true }),
      { ok: true, id: 'art-1', star_state: 'on', starred: true }
    );
    assert.equal(ss.sheets['articles'].rows[1][8], 'on');
  } finally { restore(); }
});

test('buildRssXml: スター制マップを渡すと、スターの付いたアイテムにだけ enclosure が付く', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const feed = { title: 'ch', url: 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A' };
  const rows = [
    { id: 'r1', feed_id: 'f', title: 'スター付き', link: 'https://www.youtube.com/watch?v=vidStar0001', published_at: '2026-11-14T00:00:00.000Z', fetched_at: '', summary: '', author: '' },
    { id: 'r2', feed_id: 'f', title: 'スター無し', link: 'https://www.youtube.com/watch?v=vidPlain001', published_at: '2026-11-13T00:00:00.000Z', fetched_at: '', summary: '', author: '' },
  ];
  const audioUrls = {
    vidStar0001: { url: 'https://stream.example.com/star', ts: nowSec - 60 },
    vidPlain001: { url: 'https://stream.example.com/plain', ts: nowSec - 60 },
  };
  const gated = buildRssXml(feed, rows, audioUrls, '', { vidStar0001: true });
  assert.ok(gated.includes('<enclosure url="https://stream.example.com/star"'));
  assert.ok(!gated.includes('stream.example.com/plain'));
  // アイテム自体は両方とも出る (絞るのは enclosure だけ)
  assert.equal((gated.match(/<item>/g) || []).length, 2);
  // 空マップでは全アイテム enclosure 無し
  const none = buildRssXml(feed, rows, audioUrls, '', {});
  assert.ok(!none.includes('<enclosure'));
  // 省略時は従来どおり両方に付く
  const legacy = buildRssXml(feed, rows, audioUrls, '');
  assert.ok(legacy.includes('stream.example.com/plain'));
});

test('doGet: ?rss= は override off の動画に enclosure を付けず、on の古い動画には付ける', () => {
  // audio-urls.json のキャッシュ (モジュール内) が先行テストで温まって
  // いる場合はそちらが使われるため、マップは既存フィクスチャと同じ
  // vidAudio111 のエントリで組み立て、どちらの経路でも成り立つ形にする。
  const nowSec = Math.floor(Date.now() / 1000);
  const mapJson = JSON.stringify({ vidAudio111: { url: 'https://stream.example.com/vidAudio111', ts: nowSec - 60, dur: 2297.4 } });
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-off-feed', 'OFFフィード', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
      ['yt-on-feed', 'ONフィード', 'https://www.youtube.com/channel/UCmusicchanneL1', '', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW_STAR,
      ['rowOff', 'yt-off-feed', '外した動画', 'https://www.youtube.com/watch?v=vidAudio111', '2026-11-14T01:00:00.000Z', '2026-11-14T02:00:00.000Z', '', '', 'off'],
      ['rowOn', 'yt-on-feed', '付けた動画', 'https://www.youtube.com/watch?v=vidAudio111', '2025-01-01T00:00:00.000Z', '2026-11-14T02:00:00.000Z', '', '', 'on'],
    ],
  });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' }).service,
    ContentService: fakeContentService(),
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => mapJson }) },
    Utilities: fakeUtilities,
  });
  try {
    // 新しい動画でも、手動で外していれば enclosure は付かない
    const xmlOff = doGet({ parameter: { rss: 'yt-off-feed' } }).getContent();
    assert.ok(xmlOff.includes('外した動画'));
    assert.ok(!xmlOff.includes('<enclosure'));
    // 古い動画でも、手動で付けていれば enclosure が付く
    const xmlOn = doGet({ parameter: { rss: 'yt-on-feed' } }).getContent();
    assert.ok(xmlOn.includes('<enclosure url="https://stream.example.com/vidAudio111"'));
  } finally { restore(); }
});

test('buildListPayload: 記事に star_state (オーバーライド) と starred (実効スター) が付く', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW,
      ['yt-x', 'YT', 'https://www.youtube.com/channel/UCxNfaRC6MbAnwSR1Dqqv69A', '', '', '', '', '', ''],
      ['web', 'Web', 'https://example.com/feed', 'tech', '', '', '', '', ''],
    ],
    articles: [ARTICLE_HEADERS_ROW_STAR,
      ['a1', 'yt-x', '最新', 'https://www.youtube.com/watch?v=vidL00001', iso(now - dayMs), iso(now - dayMs), '', '', ''],
      ['a2', 'yt-x', '外した', 'https://www.youtube.com/watch?v=vidL00002', iso(now - 2 * dayMs), iso(now - 2 * dayMs), '', '', 'off'],
      ['a3', 'yt-x', '付けた古い動画', 'https://www.youtube.com/watch?v=vidL00003', iso(now - 400 * dayMs), iso(now - dayMs), '', '', 'on'],
      ['a4', 'web', '通常記事', 'https://example.com/1', iso(now - dayMs), iso(now - dayMs), '', '', ''],
    ],
  });
  const restore = installSpreadsheet(ss);
  try {
    const payload = buildListPayload({});
    const byId = {};
    payload.articles.forEach((a) => { byId[a.id] = a; });
    assert.deepEqual([byId['a1'].star_state, byId['a1'].starred], ['', true]);
    assert.deepEqual([byId['a2'].star_state, byId['a2'].starred], ['off', false]);
    assert.deepEqual([byId['a3'].star_state, byId['a3'].starred], ['on', true]);
    // 非 YouTube の記事はスター対象外
    assert.deepEqual([byId['a4'].star_state, byId['a4'].starred], ['', false]);
  } finally { restore(); }
});

test('fetchFeeds: スター制で、off の最新動画は発火せず、on の古い動画は発火する', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const ss = new FakeSpreadsheet({
    feeds: [FEED_HEADERS_ROW, YT_FEED_ROW_X],
    articles: [ARTICLE_HEADERS_ROW_STAR,
      [articleId('yt-x', 'vidOff00001'), 'yt-x', '外した動画', 'https://www.youtube.com/watch?v=vidOff00001', iso(now - dayMs), iso(now - dayMs), '', '', 'off'],
      [articleId('yt-x', 'vidOn000001'), 'yt-x', '付けた古い動画', 'https://www.youtube.com/watch?v=vidOn000001', '2025-06-01T00:00:00.000Z', iso(now - dayMs), '', '', 'on'],
    ],
  });
  const body = playlistBodyWith([
    ['vidOff00001', iso(now - dayMs)],
    ['vidOn000001', '2025-06-01T00:00:00Z'],
  ]);
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: fakePropertiesService({
      SPREADSHEET_ID: 'fake-spreadsheet-id', YOUTUBE_API_KEY: 'fake-api-key', A_ZE_GS_TOKEN: 'fake-ze-token', A_ZE_GS_BASE_URL: 'https://a.ze.gs',
    }).service,
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => body }) },
    Utilities: fakeUtilities,
  });
  const calls = [];
  try {
    const result = fetchFeeds((videoId) => { calls.push(videoId); });
    assert.equal(result.ok, true);
    assert.equal(result.added, 0); // どちらも既存記事
    // 最新でも off なら発火しない。30日超でも on なら発火する
    assert.deepEqual(calls, ['vidOn000001']);
  } finally { restore(); }
});

// ============================================================
// 視聴ログ (events)
// ============================================================

const EVENTS_HEADERS_ROW = ['ts', 'type', 'feed_id', 'feed_title', 'article_id', 'article_title', 'seconds'];

test('sanitizeEvent: 5種のイベントを行にし、不正な行は捨てる', () => {
  const now = '2026-11-17T00:00:00.000Z';
  assert.deepEqual(
    sanitizeEvent({ type: 'feed_view', feed_id: 'feed-a', feed_title: 'フィードA', ts: '2026-11-16T10:00:00Z' }, now),
    ['2026-11-16T10:00:00.000Z', 'feed_view', 'feed-a', 'フィードA', '', '', '']
  );
  // camelCase のキーも受ける。play 以外の seconds は保存しない
  assert.deepEqual(
    sanitizeEvent({ type: 'article_open', feedId: 'feed-a', articleId: 'art-1', articleTitle: '記事1', seconds: 10 }, now),
    [now, 'article_open', 'feed-a', '', 'art-1', '記事1', '']
  );
  // play は seconds を整数化して持つ
  assert.deepEqual(
    sanitizeEvent({ type: 'play', feed_id: 'feed-a', article_id: 'art-1', seconds: 65.9 }, now),
    [now, 'play', 'feed-a', '', 'art-1', '', 65]
  );
  // scroll は seconds を持たない (渡されても保存しない)
  assert.deepEqual(
    sanitizeEvent({ type: 'scroll', feed_id: 'feed-a', feed_title: 'フィードA', seconds: 10, ts: '2026-11-16T10:00:00Z' }, now),
    ['2026-11-16T10:00:00.000Z', 'scroll', 'feed-a', 'フィードA', '', '', '']
  );
  // expand は記事系イベントとして article_id / article_title を保持し、
  // seconds は持たない (渡されても保存しない)
  assert.deepEqual(
    sanitizeEvent({ type: 'expand', feed_id: 'feed-a', article_id: 'art-1', article_title: '記事1', seconds: 10, ts: '2026-11-16T10:00:00Z' }, now),
    ['2026-11-16T10:00:00.000Z', 'expand', 'feed-a', '', 'art-1', '記事1', '']
  );
  // ts が解釈できなければ受付時刻にフォールバック
  assert.equal(sanitizeEvent({ type: 'feed_view', feed_id: 'f', ts: 'not-a-date' }, now)[0], now);
  // 捨てる行: 未知の type / feed_id 欠落 / play の seconds 不正 / 非オブジェクト
  assert.equal(sanitizeEvent({ type: 'click', feed_id: 'f' }, now), null);
  assert.equal(sanitizeEvent({ type: 'feed_view' }, now), null);
  assert.equal(sanitizeEvent({ type: 'play', feed_id: 'f', seconds: -1 }, now), null);
  assert.equal(sanitizeEvent({ type: 'play', feed_id: 'f', seconds: 'abc' }, now), null);
  assert.equal(sanitizeEvent({ type: 'play', feed_id: 'f' }, now), null);
  assert.equal(sanitizeEvent(null, now), null);
  assert.equal(sanitizeEvent('feed_view', now), null);
});

test('sanitizeEvent: 再生診断の種別も行にし、stall は seconds を持つ', () => {
  const now = '2026-11-17T00:00:00.000Z';
  // 診断イベントは記事の文脈を保持し、stall 以外は seconds を
  // 持たない (渡されても保存しない)
  assert.deepEqual(
    sanitizeEvent({ type: 'preload_error', feed_id: 'feed-a', article_id: 'art-1', article_title: '記事1', seconds: 10 }, now),
    [now, 'preload_error', 'feed-a', '', 'art-1', '記事1', '']
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'advance_swap', feed_id: 'feed-a', article_id: 'art-2' }, now),
    [now, 'advance_swap', 'feed-a', '', 'art-2', '', '']
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'advance_load', feed_id: 'feed-a', article_id: 'art-2' }, now),
    [now, 'advance_load', 'feed-a', '', 'art-2', '', '']
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'recover', feed_id: 'feed-a', article_id: 'art-1' }, now),
    [now, 'recover', 'feed-a', '', 'art-1', '', '']
  );
  // stall は play と同じく seconds (止まった位置) を整数化して持ち、
  // 不正なら行を捨てる
  assert.deepEqual(
    sanitizeEvent({ type: 'stall', feed_id: 'feed-a', article_id: 'art-1', seconds: 19.8 }, now),
    [now, 'stall', 'feed-a', '', 'art-1', '', 19]
  );
  assert.equal(sanitizeEvent({ type: 'stall', feed_id: 'feed-a', seconds: -1 }, now), null);
  assert.equal(sanitizeEvent({ type: 'stall', feed_id: 'feed-a', seconds: 'abc' }, now), null);
  assert.equal(sanitizeEvent({ type: 'stall', feed_id: 'feed-a' }, now), null);
});

test('sanitizeEvent: deck_overlap は seconds (待機側の止めた位置) を任意で持つ', () => {
  const now = '2026-11-18T00:00:00.000Z';
  // 待機側に載っていた曲の文脈を保持し、seconds は0以上の数値なら
  // 整数化して持つ
  assert.deepEqual(
    sanitizeEvent({ type: 'deck_overlap', feed_id: 'feed-a', article_id: 'art-9', article_title: '次曲', seconds: 42.7 }, now),
    [now, 'deck_overlap', 'feed-a', '', 'art-9', '次曲', 42]
  );
  // seconds が無くても行は捨てない (位置は任意の手がかり)。
  // 不正な seconds は空にするだけで、行自体は残す
  assert.deepEqual(
    sanitizeEvent({ type: 'deck_overlap', feed_id: 'feed-a', article_id: 'art-9' }, now),
    [now, 'deck_overlap', 'feed-a', '', 'art-9', '', '']
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'deck_overlap', feed_id: 'feed-a', article_id: 'art-9', seconds: 'abc' }, now),
    [now, 'deck_overlap', 'feed-a', '', 'art-9', '', '']
  );
});

test('sanitizeEvent: 開始チェック系の診断種別 (play_rejected_* / start_*) を行にし、seconds は持たない', () => {
  const now = '2026-11-21T00:00:00.000Z';
  // play() の拒否理由は種別で区別して保持し、対象の曲の文脈を残す。
  // seconds は意味を持たないため、送られても保存しない (空)。
  const types = [
    'play_rejected_not_allowed',
    'play_rejected_not_supported',
    'play_rejected_other',
    'start_retry',
    'start_fallback',
    'start_failed',
  ];
  for (const type of types) {
    assert.deepEqual(
      sanitizeEvent({ type, feed_id: 'feed-a', article_id: 'art-1', article_title: '曲1', seconds: 5 }, now),
      [now, type, 'feed-a', '', 'art-1', '曲1', '']
    );
  }
  // 似た名前でも、許可リストに無い種別は従来どおり捨てる。
  assert.equal(sanitizeEvent({ type: 'play_rejected', feed_id: 'feed-a' }, now), null);
  assert.equal(sanitizeEvent({ type: 'start_unknown', feed_id: 'feed-a' }, now), null);
});

test('sanitizeEvent: 回線系の診断種別 (route_*) を行にし、route_reload の seconds だけ任意で保持する', () => {
  const now = '2026-11-22T00:00:00.000Z';
  // 回線イベントは対象の曲の文脈を残し、seconds は持たない。
  for (const type of ['route_offline', 'route_online']) {
    assert.deepEqual(
      sanitizeEvent({ type, feed_id: 'feed-a', article_id: 'art-1', article_title: '曲1', seconds: 5 }, now),
      [now, type, 'feed-a', '', 'art-1', '曲1', '']
    );
  }
  // route_reload の seconds は読み直し位置として保持する
  // (deck_overlap と同じ任意扱い: 数値でなければ空にする)。
  assert.deepEqual(
    sanitizeEvent({ type: 'route_reload', feed_id: 'feed-a', article_id: 'art-1', article_title: '曲1', seconds: 273 }, now),
    [now, 'route_reload', 'feed-a', '', 'art-1', '曲1', 273]
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'route_reload', feed_id: 'feed-a', article_id: 'art-1' }, now),
    [now, 'route_reload', 'feed-a', '', 'art-1', '', '']
  );
  assert.deepEqual(
    sanitizeEvent({ type: 'route_reload', feed_id: 'feed-a', article_id: 'art-1', seconds: 'abc' }, now),
    [now, 'route_reload', 'feed-a', '', 'art-1', '', '']
  );
  // 似た名前でも、許可リストに無い種別は従来どおり捨てる。
  assert.equal(sanitizeEvent({ type: 'route_change', feed_id: 'feed-a' }, now), null);
});

test('sanitizeEventBatch: 文字列は上限で切り、1リクエスト最大50件', () => {
  const now = '2026-11-17T00:00:00.000Z';
  const rows = sanitizeEventBatch([
    { type: 'feed_view', feed_id: 'x'.repeat(200), feed_title: 'y'.repeat(300) },
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2].length, 128);
  assert.equal(rows[0][3].length, 200);
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ type: 'feed_view', feed_id: 'f' + i });
  assert.equal(sanitizeEventBatch(many, now).length, 50);
  assert.deepEqual(sanitizeEventBatch('not-an-array', now), []);
  assert.deepEqual(sanitizeEventBatch(undefined, now), []);
});

test('handleLogEvents: events タブを遅延作成して一括追記し、保存件数を返す', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  try {
    const result = handleLogEvents({
      events: [
        { type: 'feed_view', feed_id: 'feed-a', feed_title: 'フィードA', ts: '2026-11-16T10:00:00.000Z' },
        { type: 'bogus', feed_id: 'feed-a' },
        { type: 'play', feed_id: 'feed-a', article_id: 'art-1', seconds: 42 },
      ],
    }, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(result, { ok: true, saved: 2 });
    const rows = ss.sheets['events'].rows;
    assert.deepEqual(rows[0], EVENTS_HEADERS_ROW);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], ['2026-11-16T10:00:00.000Z', 'feed_view', 'feed-a', 'フィードA', '', '', '']);
    assert.deepEqual(rows[2], ['2026-11-17T00:00:00.000Z', 'play', 'feed-a', '', 'art-1', '', 42]);
    // 2回目は既存行の後ろへ追記される
    const again = handleLogEvents({ events: [{ type: 'feed_view', feed_id: 'feed-b' }] }, '2026-11-17T01:00:00.000Z');
    assert.deepEqual(again, { ok: true, saved: 1 });
    assert.equal(ss.sheets['events'].rows.length, 4);
    assert.equal(ss.sheets['events'].rows[3][2], 'feed-b');
    // 保存できる行が無ければタブも作らず saved: 0
    const ss2 = new FakeSpreadsheet({});
    const restore2 = installSpreadsheet(ss2);
    try {
      assert.deepEqual(handleLogEvents({ events: [{ type: 'bogus' }] }), { ok: true, saved: 0 });
      assert.equal(ss2.sheets['events'], undefined);
    } finally { restore2(); }
  } finally { restore(); }
});

test('doPost log_events: オーナーは実行でき、readonly は forbidden、無セッションは unauthorized', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    assert.deepEqual(post({ action: 'log_events', events: [] }), { ok: false, error: 'unauthorized' });
    const readonly = issueSession('readonly');
    assert.deepEqual(
      post({ action: 'log_events', sessionToken: readonly.sessionToken, events: [{ type: 'feed_view', feed_id: 'f' }] }),
      { ok: false, error: 'forbidden' }
    );
    assert.equal(ss.sheets['events'], undefined);
    const owner = issueSession('owner');
    const logged = post({
      action: 'log_events',
      sessionToken: owner.sessionToken,
      events: [{ type: 'feed_view', feed_id: 'feed-a' }, { type: 'bogus', feed_id: 'x' }],
    });
    assert.deepEqual(logged, { ok: true, saved: 1 });
    // stats アクションは廃止したので unknown_action になる
    assert.deepEqual(post({ action: 'stats', sessionToken: owner.sessionToken }), { ok: false, error: 'unknown_action' });
  } finally { restore(); }
});

test('aggregateFeedStats: 利用を表す4種だけをフィード別に集計し、診断系は数えない', () => {
  const events = [
    { ts: '2026-11-20T10:00:00.000Z', type: 'play', feed_id: 'feed-a', seconds: 61 },
    { ts: '2026-11-21T10:00:00.000Z', type: 'play', feed_id: 'feed-a', seconds: '30' },
    { ts: '2026-11-19T10:00:00.000Z', type: 'article_open', feed_id: 'feed-a' },
    { ts: '2026-11-22T10:00:00.000Z', type: 'expand', feed_id: 'feed-a' },
    { ts: '2026-11-18T10:00:00.000Z', type: 'feed_view', feed_id: 'feed-a' },
    // 診断系は利用に数えない (lastAt も進めない)
    { ts: '2026-11-23T10:00:00.000Z', type: 'stall', feed_id: 'feed-a', seconds: 999 },
    { ts: '2026-11-23T11:00:00.000Z', type: 'advance_swap', feed_id: 'feed-a' },
    { ts: '2026-11-23T12:00:00.000Z', type: 'scroll', feed_id: 'feed-a' },
    // feed_id が無い行・壊れた行は読み飛ばす
    { ts: '2026-11-23T13:00:00.000Z', type: 'play', feed_id: '', seconds: 10 },
    null,
    { ts: '2026-11-17T10:00:00.000Z', type: 'play', feed_id: 'feed-b', seconds: -5 },
  ];
  assert.deepEqual(aggregateFeedStats(events), {
    'feed-a': { plays: 2, playSeconds: 91, opens: 1, expands: 1, views: 1, lastAt: '2026-11-22T10:00:00.000Z' },
    'feed-b': { plays: 1, playSeconds: 0, opens: 0, expands: 0, views: 0, lastAt: '2026-11-17T10:00:00.000Z' },
  });
  assert.deepEqual(aggregateFeedStats([]), {});
  assert.deepEqual(aggregateFeedStats(null), {});
});

test('doPost feed_stats: オーナーは集計を取得でき、readonly は forbidden、events が無ければ空', () => {
  const ss = new FakeSpreadsheet({
    events: [EVENTS_HEADERS_ROW,
      ['2026-11-20T10:00:00.000Z', 'play', 'feed-a', 'A', 'art-1', '', 120],
      ['2026-11-21T10:00:00.000Z', 'feed_view', 'feed-a', 'A', '', '', ''],
      ['2026-11-21T11:00:00.000Z', 'stall', 'feed-a', 'A', 'art-1', '', 5],
    ],
  });
  const restore = installSpreadsheet(ss);
  const post = (obj) => JSON.parse(doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  try {
    assert.deepEqual(post({ action: 'feed_stats' }), { ok: false, error: 'unauthorized' });
    const readonly = issueSession('readonly');
    assert.deepEqual(post({ action: 'feed_stats', sessionToken: readonly.sessionToken }), { ok: false, error: 'forbidden' });
    const owner = issueSession('owner');
    assert.deepEqual(post({ action: 'feed_stats', sessionToken: owner.sessionToken }), {
      ok: true,
      stats: { 'feed-a': { plays: 1, playSeconds: 120, opens: 0, expands: 0, views: 1, lastAt: '2026-11-21T10:00:00.000Z' } },
    });
    // events タブが無いスプレッドシートでは空の集計
    const ss2 = new FakeSpreadsheet({});
    const restore2 = installSpreadsheet(ss2);
    try {
      assert.deepEqual(buildFeedStatsPayload(), { ok: true, stats: {} });
    } finally { restore2(); }
  } finally { restore(); }
});

test('planEventPrune: 90日超の生ログだけを間引き対象にし、ts が読めない行は残す', () => {
  const now = '2026-11-17T00:00:00.000Z'; // 90日前 = 2026-08-19T00:00:00.000Z
  const events = [
    { ts: '2026-08-10T00:00:00.000Z', type: 'play', feed_id: 'feed-a' },
    { ts: '2026-08-18T23:59:59.000Z', type: 'play', feed_id: 'feed-b' },
    { ts: '2026-08-19T00:00:00.000Z', type: 'play', feed_id: 'feed-a' },
    { ts: '2026-11-10T00:00:00.000Z', type: 'play', feed_id: 'feed-a' },
    { ts: 'bad', type: 'play', feed_id: 'feed-a' },
  ];
  // 90日ちょうど (8/19) と新しい行と ts が読めない行は残す
  assert.deepEqual(planEventPrune(events, now), [0, 1]);
});

test('pruneOldEvents: 90日超の生ログだけを間引き、再実行しても何も消えない', () => {
  const ss = new FakeSpreadsheet({
    events: [EVENTS_HEADERS_ROW,
      ['2026-08-10T00:00:00.000Z', 'play', 'feed-a', 'A', 'art-0', '', 10],
      ['2026-11-10T00:00:00.000Z', 'feed_view', 'feed-a', 'A', '', '', ''],
      ['2026-11-10T01:00:00.000Z', 'play', 'feed-a', 'A', 'art-1', '', 60],
      ['2026-11-16T10:00:00.000Z', 'play', 'feed-a', 'A', 'art-2', '', 999],
    ],
  });
  const restore = installSpreadsheet(ss);
  try {
    assert.deepEqual(pruneOldEvents('2026-11-17T00:00:00.000Z'), { ok: true, pruned: 1 });
    // 90日超の行だけ消え、それ以外は残る
    assert.deepEqual(ss.sheets['events'].rows.map((r) => r[4]), ['article_id', '', 'art-1', 'art-2']);
    assert.deepEqual(pruneOldEvents('2026-11-17T01:00:00.000Z'), { ok: true, pruned: 0 });
    // events タブが無い場合は何もしない
    const ss2 = new FakeSpreadsheet({});
    const restore2 = installSpreadsheet(ss2);
    try {
      assert.deepEqual(pruneOldEvents('2026-11-17T00:00:00.000Z'), { ok: true, pruned: 0 });
    } finally { restore2(); }
  } finally { restore(); }
});

test('maybePruneOldEvents: 最終実行から7日空いたときだけ走る', () => {
  const ss = new FakeSpreadsheet({
    events: [EVENTS_HEADERS_ROW,
      ['2026-08-10T00:00:00.000Z', 'play', 'feed-a', 'A', 'art-0', '', 10],
      ['2026-11-10T00:00:00.000Z', 'feed_view', 'feed-a', 'A', '', '', ''],
    ],
  });
  const props = fakePropertiesService({ SPREADSHEET_ID: 'fake-spreadsheet-id' });
  const restore = installGasGlobals({
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: props.service,
    Utilities: fakeUtilities,
  });
  try {
    const t0 = Date.parse('2026-11-17T00:00:00.000Z');
    assert.equal(maybePruneOldEvents(t0), true);
    assert.equal(props.store['EVENT_PRUNE_LAST_RUN_AT'], String(t0));
    // 90日超の行が間引かれている
    assert.equal(ss.sheets['events'].rows.length, 2);
    // 1時間後は走らない
    assert.equal(maybePruneOldEvents(t0 + 60 * 60 * 1000), false);
    // 8日後は再び走る (新しい間引き対象は無い)
    assert.equal(maybePruneOldEvents(t0 + 8 * 24 * 60 * 60 * 1000), true);
    assert.equal(ss.sheets['events'].rows.length, 2);
  } finally { restore(); }
});

test('scroll イベント: log_events で保存される', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  try {
    const logged = handleLogEvents({
      events: [
        { type: 'scroll', feed_id: 'feed-a', feed_title: 'A', ts: '2026-11-10T00:00:00.000Z' },
        { type: 'scroll', feed_id: 'feed-a', feed_title: 'A', ts: '2026-11-11T00:00:00.000Z' },
        { type: 'feed_view', feed_id: 'feed-a', feed_title: 'A', ts: '2026-11-10T01:00:00.000Z' },
        { type: 'scroll', feed_id: 'feed-a', feed_title: 'A', ts: '2026-11-16T10:00:00.000Z' },
      ],
    }, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(logged, { ok: true, saved: 4 });
    // scroll 行は seconds を持たずに保存される
    assert.deepEqual(ss.sheets['events'].rows[1],
      ['2026-11-10T00:00:00.000Z', 'scroll', 'feed-a', 'A', '', '', '']);
  } finally { restore(); }
});

test('expand イベント: log_events で保存される', () => {
  const ss = new FakeSpreadsheet({});
  const restore = installSpreadsheet(ss);
  try {
    const logged = handleLogEvents({
      events: [
        { type: 'expand', feed_id: 'feed-a', feed_title: 'A', article_id: 'art-1', article_title: '記事1', ts: '2026-11-10T00:00:00.000Z' },
        { type: 'expand', feed_id: 'feed-a', feed_title: 'A', article_id: 'art-2', article_title: '記事2', ts: '2026-11-11T00:00:00.000Z' },
        { type: 'article_open', feed_id: 'feed-a', feed_title: 'A', article_id: 'art-1', ts: '2026-11-10T01:00:00.000Z' },
        { type: 'expand', feed_id: 'feed-a', feed_title: 'A', article_id: 'art-3', article_title: '記事3', ts: '2026-11-16T10:00:00.000Z' },
      ],
    }, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(logged, { ok: true, saved: 4 });
    // expand 行は seconds を持たず、article_id / article_title を保持して保存される
    assert.deepEqual(ss.sheets['events'].rows[1],
      ['2026-11-10T00:00:00.000Z', 'expand', 'feed-a', 'A', 'art-1', '記事1', '']);
  } finally { restore(); }
});
