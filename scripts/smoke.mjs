// reader-gas の本番スモークチェック (デプロイ後の確認用)。
// 匿名で /exec を叩き、ヘルス応答・YouTube フィードの RSS 出力・
// feed_not_found 分岐・認証ゲートの生存を確認する。書き込み系は叩かない。
// 使い方: npm run smoke
// 対象 URL は環境変数 READER_GAS_EXEC_URL で差し替えできる
// (未設定時は本番 /exec。本番 URL はフロントのビルドにも入る公開値)。

const EXEC_URL = process.env.READER_GAS_EXEC_URL
  || 'https://script.google.com/macros/s/AKfycbz-0BmbGrFsfaI9vkVsvc-f_69iq0HIfJMluS_H_SXpUnLxlU6lvYkDgmZpIvw1IpwB/exec';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('ok   ' + name);
  } else {
    failures++;
    console.error('FAIL ' + name + (detail ? ': ' + detail : ''));
  }
}

async function getText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// 1. ヘルス応答 (HTML が返る = 匿名アクセスが失われている)
{
  const { status, text } = await getText(EXEC_URL);
  const json = parseJson(text);
  check('GET /exec が 200', status === 200, 'status=' + status);
  check(
    'GET /exec が {ok:true, service:"reader-gas"}',
    !!json && json.ok === true && json.service === 'reader-gas',
    text.trimStart().startsWith('<') ? 'HTML が返った (匿名アクセス喪失の疑い)' : text.slice(0, 120)
  );
}

// 2. YouTube フィードの RSS 出力
{
  const { text } = await getText(EXEC_URL + '?rss=yt-rakutentech');
  check('?rss=yt-rakutentech が XML で始まる', text.startsWith('<?xml'), text.slice(0, 80));
  check('RSS 2.0 である', text.includes('<rss version="2.0">'));
  const items = text.match(/<item>/g) || [];
  check('item が1件以上ある', items.length >= 1, 'items=' + items.length);
  const guid = /<guid[^>]*>([^<]+)<\/guid>/.exec(text);
  check('guid が空でない', !!guid && guid[1].trim().length > 0);
}

// 3. 実在する非 YouTube フィードは feed_not_found
{
  const { text } = await getText(EXEC_URL + '?rss=nhk');
  const json = parseJson(text);
  check('?rss=nhk が feed_not_found', !!json && json.ok === false && json.error === 'feed_not_found', text.slice(0, 120));
}

// 4. 未知の ID も feed_not_found
{
  const { text } = await getText(EXEC_URL + '?rss=__no_such_feed__');
  const json = parseJson(text);
  check('?rss=__no_such_feed__ が feed_not_found', !!json && json.ok === false && json.error === 'feed_not_found', text.slice(0, 120));
}

// 5. セッション無しの list は unauthorized (認証ゲートの生存確認)
{
  const res = await fetch(EXEC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'list' }),
  });
  const json = parseJson(await res.text());
  check('POST list (セッション無し) が unauthorized', !!json && json.ok === false && json.error === 'unauthorized', JSON.stringify(json));
}

if (failures) {
  console.error('\nsmoke: ' + failures + ' 件失敗');
  process.exit(1);
}
console.log('\nsmoke: すべて成功');
