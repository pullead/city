const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBarkPayload,
  buildBarkPayloads,
  buildDailySummaries,
  buildPageUrl,
  createNotificationPlan,
  isWithinPushHours,
  translatePostsToChinese,
  normalizeBarkEndpoint,
  parsePosts,
} = require('../scripts/lib/bakusai-monitor');

test('parsePosts extracts Bakusai response numbers, authors, times, content, and quotes', () => {
  const html = `
    <dl id="res_list">
      <div class="res_list_article" id="res101">
        <span class="name"><span>匿名さん</span></span>
        <span itemprop="commentTime">2026/06/17 12:34</span>
        <div class="resbody" itemprop="commentText">新しい投稿です &gt;&gt;99</div>
      </div>
      <div class="res_list_article" id="res102">
        <span itemprop="commentTime">2026/06/17 12:40</span>
        <div class="resbody" itemprop="commentText">次の投稿</div>
      </div>
    </dl>
  `;

  assert.deepEqual(parsePosts(html), [
    {
      num: 101,
      time: '2026/06/17 12:34',
      content: '新しい投稿です >>99',
      author: '匿名さん',
      quotes: [99],
    },
    {
      num: 102,
      time: '2026/06/17 12:40',
      content: '次の投稿',
      author: '匿名',
      quotes: [],
    },
  ]);
});

test('createNotificationPlan initializes state without notifying on first run', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, time: '2026/06/17 10:00', content: 'old' },
      { num: 102, time: '2026/06/17 11:00', content: 'latest' },
    ],
    null,
    {
      threadId: '13315868',
      notifyOnFirstRun: false,
      notifyHistoryWhenNoNew: false,
      now: new Date('2026-06-17T03:00:00Z'),
    },
  );

  assert.equal(plan.shouldNotify, false);
  assert.equal(plan.firstRun, true);
  assert.equal(plan.nextState.lastSeenPostNum, 102);
  assert.deepEqual(plan.newPosts, []);
});

test('createNotificationPlan can notify recent history on first run', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, time: '2026/06/17 10:00', content: 'older' },
      { num: 102, time: '2026/06/17 11:00', content: 'latest' },
    ],
    null,
    {
      threadId: '13315868',
      notifyHistoryWhenNoNew: true,
      now: new Date('2026-06-17T03:00:00Z'),
    },
  );

  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.notificationKind, 'history');
  assert.deepEqual(plan.notificationPosts.map(post => post.num), [101, 102]);
  assert.equal(plan.nextState.lastSeenPostNum, 102);
});

test('createNotificationPlan returns only posts newer than stored state', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, time: '2026/06/17 10:00', content: 'old' },
      { num: 102, time: '2026/06/17 11:00', content: 'newer' },
      { num: 103, time: '2026/06/17 12:00', content: 'newest' },
    ],
    { threadId: '13315868', lastSeenPostNum: 101 },
    { threadId: '13315868', notifyOnFirstRun: false, now: new Date('2026-06-17T03:00:00Z') },
  );

  assert.equal(plan.shouldNotify, true);
  assert.deepEqual(plan.newPosts.map(post => post.num), [102, 103]);
  assert.equal(plan.nextState.lastSeenPostNum, 103);
});

test('createNotificationPlan sends all posts from today through three days ago in date order', () => {
  const plan = createNotificationPlan(
    [
      { num: 91, time: '2026/06/13 23:00', content: 'too old' },
      { num: 101, time: '2026/06/17 10:00', content: 'today first' },
      { num: 103, time: '2026/06/17 12:00', content: 'today second' },
      { num: 95, time: '2026/06/16 09:00', content: 'yesterday' },
      { num: 92, time: '2026/06/15 08:00', content: 'two days ago' },
      { num: 90, time: '2026/06/14 07:00', content: 'three days ago' },
    ],
    { threadId: '13315868', lastSeenPostNum: 100 },
    {
      threadId: '13315868',
      notifyHistoryWhenNoNew: true,
      now: new Date('2026-06-17T03:00:00Z'),
    },
  );

  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.notificationKind, 'new');
  assert.deepEqual(plan.newPosts.map(post => post.num), [101, 103]);
  assert.deepEqual(plan.notificationPosts.map(post => post.num), [101, 103, 95, 92, 90]);
  assert.equal(plan.nextState.lastSeenPostNum, 103);
});

test('createNotificationPlan sends the same four-day window when there are no new posts', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, time: '2026/06/17 10:00', content: 'today' },
      { num: 95, time: '2026/06/16 09:00', content: 'yesterday' },
      { num: 92, time: '2026/06/15 08:00', content: 'two days ago' },
      { num: 90, time: '2026/06/14 07:00', content: 'three days ago' },
    ],
    { threadId: '13315868', lastSeenPostNum: 101 },
    {
      threadId: '13315868',
      notifyHistoryWhenNoNew: true,
      now: new Date('2026-06-17T03:00:00Z'),
    },
  );

  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.notificationKind, 'history');
  assert.deepEqual(plan.newPosts, []);
  assert.deepEqual(plan.notificationPosts.map(post => post.num), [101, 95, 92, 90]);
});

test('buildBarkPayload summarizes new posts and links to the monitored thread', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 監視',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    now: new Date('2026-06-17T03:00:00Z'),
    newPosts: [
      { num: 102, time: '2026/06/17 12:40', content: 'a'.repeat(120), contentZh: '中文1' },
      { num: 103, time: '2026/06/17 12:45', content: '短い本文', contentZh: '简短正文' },
    ],
  });

  assert.equal(payload.title, '🆕 Bakusai 監視｜4日分まとめ｜2件');
  assert.match(payload.body, /📅 今日 \/ 今天 2026-06-17/);
  assert.match(payload.body, /🧾 #102 · 12:40/);
  assert.match(payload.body, /🧾 #103 · 12:45/);
  assert.match(payload.body, /短い本文/);
  assert.match(payload.body, /简短正文/);
  assert.equal(payload.url, 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/');
  assert.equal(payload.group, 'bakusai-monitor');
});

test('buildBarkPayload labels historical posts differently from new posts', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 13315868',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    notificationKind: 'history',
    now: new Date('2026-06-17T03:00:00Z'),
    newPosts: [
      { num: 102, time: '2026/06/17 12:40', content: '最新の履歴投稿', contentZh: '最新的历史帖子' },
    ],
  });

  assert.equal(payload.title, '📚 Bakusai 13315868｜4日分まとめ｜1件');
  assert.match(payload.body, /最新の履歴投稿\n最新的历史帖子/);
});

test('buildBarkPayload groups today yesterday two days ago and three days ago in order', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 13315868',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    now: new Date('2026-06-17T03:00:00Z'),
    newPosts: [
      { num: 101, time: '2026/06/17 10:00', content: 'today ja', contentZh: '今天中文' },
      { num: 95, time: '2026/06/16 09:00', content: 'yesterday ja', contentZh: '昨天中文' },
      { num: 92, time: '2026/06/15 08:00', content: 'two days ja', contentZh: '前天中文' },
      { num: 90, time: '2026/06/14 07:00', content: 'three days ja', contentZh: '大前天中文' },
    ],
  });

  assert.match(
    payload.body,
    /📅 今日 \/ 今天 2026-06-17[\s\S]*today ja\n今天中文[\s\S]*📅 昨日 \/ 昨天 2026-06-16[\s\S]*yesterday ja\n昨天中文[\s\S]*📅 一昨日 \/ 前天 2026-06-15[\s\S]*two days ja\n前天中文[\s\S]*📅 3日前 \/ 大前天 2026-06-14[\s\S]*three days ja\n大前天中文/,
  );
  assert.doesNotMatch(payload.body, /\.\.\.and/);
});

test('buildBarkPayload adds a daily Japanese summary followed by Chinese translation before posts', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 13315868',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    now: new Date('2026-06-17T03:00:00Z'),
    dailySummaries: {
      '2026-06-17': {
        ja: 'この日は料金についての投稿が目立ちました。接客に関する感想も出ています。全体として情報交換が続いています。',
        zh: '这一天关于价格的帖子比较明显。也出现了关于接客的感想。整体上讨论仍在继续。',
      },
    },
    newPosts: [
      { num: 101, time: '2026/06/17 10:00', content: '料金の話題', contentZh: '价格话题' },
    ],
  });

  assert.match(
    payload.body,
    /📝 まとめ \/ 摘要\nこの日は料金についての投稿が目立ちました。接客に関する感想も出ています。全体として情報交換が続いています。\n这一天关于价格的帖子比较明显。也出现了关于接客的感想。整体上讨论仍在继续。[\s\S]*🧾 #101/,
  );
});

test('buildBarkPayloads splits large four-day digests into smaller Bark requests', () => {
  const posts = Array.from({ length: 40 }, (_, index) => ({
    num: index + 1,
    time: '2026/06/17 10:00',
    content: `日本語本文 ${index + 1} ${'あ'.repeat(80)}`,
    contentZh: `中文正文 ${index + 1} ${'中'.repeat(80)}`,
  }));

  const payloads = buildBarkPayloads({
    threadTitle: 'Bakusai 13315868',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    now: new Date('2026-06-17T03:00:00Z'),
    newPosts: posts,
    maxBodyChars: 1800,
    dailySummaries: {
      '2026-06-17': {
        ja: 'この日は投稿数が多く、複数の話題が続いています。',
        zh: '这一天帖子数量较多，多个话题持续出现。',
      },
    },
  });

  assert.ok(payloads.length > 1);
  assert.ok(payloads.every(payload => payload.body.length <= 1800));
  assert.match(payloads[0].title, /\(1\/\d+\)$/);
  assert.match(payloads.at(-1).body, /#40/);
});

test('buildDailySummaries creates translated summaries for each recent day', async () => {
  const summaries = await buildDailySummaries(
    [
      { num: 101, time: '2026/06/17 10:00', content: '料金が話題です' },
      { num: 102, time: '2026/06/17 11:00', content: '接客の感想があります' },
    ],
    {
      now: new Date('2026-06-17T03:00:00Z'),
      fetchImpl: async () => ({
        ok: true,
        json: async () => ([[['中文摘要', '日本語要約']]]),
      }),
    },
  );

  assert.match(summaries['2026-06-17'].ja, /この日は2件の投稿がありました。/);
  assert.equal(summaries['2026-06-17'].zh, '中文摘要');
  assert.match(summaries['2026-06-16'].ja, /この日の投稿はありませんでした。/);
});

test('isWithinPushHours allows 7 through 23 JST and blocks other hours', () => {
  assert.equal(isWithinPushHours(new Date('2026-06-16T22:00:00Z')), true);
  assert.equal(isWithinPushHours(new Date('2026-06-17T14:59:00Z')), true);
  assert.equal(isWithinPushHours(new Date('2026-06-17T15:00:00Z')), false);
  assert.equal(isWithinPushHours(new Date('2026-06-16T21:59:00Z')), false);
});

test('translatePostsToChinese keeps Japanese first and Chinese translation next', async () => {
  const translated = await translatePostsToChinese(
    [{ num: 1, content: 'こんにちは' }],
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ([[['你好', 'こんにちは']]]),
      }),
    },
  );

  assert.equal(translated[0].content, 'こんにちは');
  assert.equal(translated[0].contentZh, '你好');
});

test('normalizeBarkEndpoint accepts a full Bark key URL without committing message text', () => {
  assert.equal(
    normalizeBarkEndpoint('https://api.day.app/example-key/'),
    'https://api.day.app/example-key',
  );
});

test('buildPageUrl keeps the requested first page URL and adds p=N for later pages', () => {
  const base = 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/#tab=0';

  assert.equal(
    buildPageUrl(base, 1),
    'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
  );
  assert.equal(
    buildPageUrl(base, 2),
    'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/p=2/',
  );
});
