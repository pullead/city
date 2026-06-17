const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBarkPayload,
  buildPageUrl,
  createNotificationPlan,
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
      { num: 101, content: 'old' },
      { num: 102, content: 'latest' },
    ],
    null,
    { threadId: '13315868', notifyOnFirstRun: false },
  );

  assert.equal(plan.shouldNotify, false);
  assert.equal(plan.firstRun, true);
  assert.equal(plan.nextState.lastSeenPostNum, 102);
  assert.deepEqual(plan.newPosts, []);
});

test('createNotificationPlan can notify recent history on first run', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, content: 'older' },
      { num: 102, content: 'latest' },
    ],
    null,
    {
      threadId: '13315868',
      notifyHistoryWhenNoNew: true,
      historyPostLimit: 1,
    },
  );

  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.notificationKind, 'history');
  assert.deepEqual(plan.notificationPosts.map(post => post.num), [102]);
  assert.equal(plan.nextState.lastSeenPostNum, 102);
});

test('createNotificationPlan returns only posts newer than stored state', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, content: 'old' },
      { num: 102, content: 'newer' },
      { num: 103, content: 'newest' },
    ],
    { threadId: '13315868', lastSeenPostNum: 101 },
    { threadId: '13315868', notifyOnFirstRun: false },
  );

  assert.equal(plan.shouldNotify, true);
  assert.deepEqual(plan.newPosts.map(post => post.num), [102, 103]);
  assert.equal(plan.nextState.lastSeenPostNum, 103);
});

test('createNotificationPlan can notify recent history when there are no new posts', () => {
  const plan = createNotificationPlan(
    [
      { num: 101, content: 'older' },
      { num: 102, content: 'latest' },
    ],
    { threadId: '13315868', lastSeenPostNum: 102 },
    {
      threadId: '13315868',
      notifyHistoryWhenNoNew: true,
      historyPostLimit: 2,
    },
  );

  assert.equal(plan.shouldNotify, true);
  assert.equal(plan.notificationKind, 'history');
  assert.deepEqual(plan.newPosts, []);
  assert.deepEqual(plan.notificationPosts.map(post => post.num), [101, 102]);
  assert.equal(plan.nextState.lastSeenPostNum, 102);
});

test('buildBarkPayload summarizes new posts and links to the monitored thread', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 監視',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    newPosts: [
      { num: 102, time: '2026/06/17 12:40', content: 'a'.repeat(120) },
      { num: 103, time: '2026/06/17 12:45', content: '短い本文' },
    ],
  });

  assert.equal(payload.title, 'Bakusai 監視: 2 new posts');
  assert.match(payload.body, /#103 2026\/06\/17 12:45/);
  assert.match(payload.body, /短い本文/);
  assert.equal(payload.url, 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/');
  assert.equal(payload.group, 'bakusai-monitor');
});

test('buildBarkPayload labels historical posts differently from new posts', () => {
  const payload = buildBarkPayload({
    threadTitle: 'Bakusai 13315868',
    threadUrl: 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/',
    notificationKind: 'history',
    newPosts: [
      { num: 102, time: '2026/06/17 12:40', content: 'latest historical post' },
    ],
  });

  assert.equal(payload.title, 'Bakusai 13315868: latest 1 historical posts');
  assert.match(payload.body, /latest historical post/);
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
