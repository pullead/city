const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GIRLS,
  buildGirlsDigestMessage,
  extractScheduleFromDiaries,
  formatGirlSection,
  matchesGirl,
  parseDiaries,
  parseDiaryDetail,
  parseReservation,
  parseReviews,
  parseThreadLinks,
  splitGirlsDigestMessage,
} = require('../scripts/lib/girl-digest');

test('matchesGirl recognizes configured Japanese name variants', () => {
  assert.equal(matchesGirl('今日は井上キキの話題です', GIRLS[0]), true);
  assert.equal(matchesGirl('清水あさひについて', GIRLS[1]), true);
  assert.equal(matchesGirl('渋谷りなの最新情報', GIRLS[2]), true);
  assert.equal(matchesGirl('別の人の話題', GIRLS[2]), false);
});

test('parseReservation extracts schedule-like rows', () => {
  const rows = parseReservation(`
    <table>
      <tr><td>06/17</td><td>10:00-18:00 予約受付中</td></tr>
      <tr><td>雑談だけの行</td></tr>
    </table>
  `);

  assert.deepEqual(rows, ['06/1710:00-18:00 予約受付中']);
});

test('parseDiaries extracts latest diary cards', () => {
  const diaries = parseDiaries(`
    <div class="diary_item">
      <a href="/osaka/shop/girlid-1/diary/pd-99/">リンク</a>
      <p class="diary_title">今日の日記</p>
      <p class="diary_time">06/17 12:00</p>
      <p class="diary_detail">本文の一部です</p>
      <img src="//img2.cityheaven.net/img/girls/k/shop/grdr0001_0815000000pc.jpg?imgopt=y">
    </div>
  `, 'https://www.cityheaven.net/osaka/shop/girlid-1/diary/');

  assert.equal(diaries[0].title, '今日の日記');
  assert.equal(diaries[0].date, '06/17 12:00');
  assert.equal(diaries[0].dateKey, '2026-06-17');
  assert.equal(diaries[0].snippet, '本文の一部です');
  assert.match(diaries[0].imageUrls[0], /^https:\/\/img2\.cityheaven\.net\/img\/girls/);
  assert.match(diaries[0].url, /^https:\/\/www\.cityheaven\.net/);
});

test('parseDiaries extracts CityHeaven panel cards with cover images', () => {
  const diaries = parseDiaries(`
    <div class="girls-img-thumbnail" data-diaryid="815281781">
      <a class="diary_innr_link" href="/hyogo/shop/girlid-1/diary/pd-815281781/?link=girllist">
        <img class="diary-img" data-src="//img2.cityheaven.net/img/girls/kh/shop/grdr0001.jpg?imgopt=y" src="//img2.cityheaven.net/img/icon/dummy.png">
        <div class="diary-name">渋谷りなの</div>
        <div class="diary-title">６.１７👨🏻ありがとう🩷</div>
      </a>
    </div>
  `, 'https://www.cityheaven.net/hyogo/shop/girlid-1/diary/panel/', { now: new Date('2026-06-17T03:00:00Z') });

  assert.equal(diaries[0].title, '６.１７👨🏻ありがとう🩷');
  assert.equal(diaries[0].dateKey, '2026-06-17');
  assert.match(diaries[0].imageUrls[0], /^https:\/\/img2\.cityheaven\.net\/img\/girls/);
});

test('parseDiaryDetail extracts diary body and media links', () => {
  const longBody = '本日15:00から追加枠あります。'.repeat(30);
  const detail = parseDiaryDetail(`
    <title>写メ日記『追加枠のお知らせ』「井上キキ」(2026年6月17日13:00)：店</title>
    <h1>追加枠のお知らせ</h1>
    <time>06/17 13:00</time>
    <article>井上キキ 店 みたよ マイガール 追加枠のお知らせ 6/17 13:00 ${longBody}こちらの写メ日記もオススメ！ 別日記</article>
    <img src="//img2.cityheaven.net/img/girls/k/shop/grdr0001_0815000000pc.jpg?imgopt=y">
    <video src="/movies/a.mp4"></video>
  `, 'https://www.cityheaven.net/shop/girlid-1/diary/pd-1/');

  assert.equal(detail.title, '追加枠のお知らせ');
  assert.equal(detail.dateKey, '2026-06-17');
  assert.match(detail.body, /本日15:00から追加枠/);
  assert.ok(detail.body.length > 360);
  assert.doesNotMatch(detail.body, /こちらの写メ日記/);
  assert.match(detail.imageUrls[0], /^https:\/\/img2\.cityheaven\.net\/img\/girls/);
  assert.match(detail.videoUrls[0], /\/movies\/a\.mp4$/);
});

test('parseDiaries ignores CityHeaven menu and JavaScript placeholder noise', () => {
  const diaries = parseDiaries(`
    <a href="/shop/girlid-1/diary/">写メ日記</a>
    <div class="noScriptArea">JavaScriptを有効にしてください。</div>
    <div class="diary_item">
      <a href="/shop/girlid-1/diary/pd-100/">詳細</a>
      <p class="diary_title">写メ日記</p>
    </div>
    <div class="diary_item">
      <a href="/shop/girlid-1/diary/pd-101/">詳細</a>
      <p class="diary_title">ちゃんとした日記</p>
    </div>
  `, 'https://www.cityheaven.net/shop/girlid-1/diary/');

  assert.deepEqual(diaries.map(diary => diary.title), ['ちゃんとした日記']);
});

test('parseReviews only keeps reviews matching the target girl', () => {
  const reviews = parseReviews(`
    <li class="review-item">
      <span class="total_rate">4.8</span>
      <span class="review-item-title">良かった</span>
      <p class="review-item-post-date">掲載日：2026/06/17</p>
      <p class="review-item-post">井上キキさんの接客が良かったです。</p>
      <a href="/osaka/shop/reviews/rv-1/">詳細</a>
    </li>
    <li class="review-item">
      <p class="review-item-post">別の人の口コミです。</p>
    </li>
  `, 'https://www.cityheaven.net/osaka/shop/reviews/', GIRLS[0]);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rating, '4.8');
  assert.equal(reviews[0].dateKey, '2026-06-17');
  assert.match(reviews[0].comment, /井上キキ/);
});

test('parseReviews keeps girl-scoped review pages even when the name is omitted', () => {
  const reviews = parseReviews(`
    <li class="review-item">
      <span class="total_rate">4.9</span>
      <span class="review-item-title">楽しかった</span>
      <p class="review-item-post-date">掲載日：2026/06/17</p>
      <p class="review-item-post">とても丁寧で楽しい時間でした。</p>
      <a href="/hyogo/shop/reviews/rv-1/">詳細</a>
    </li>
  `, 'https://www.cityheaven.net/hyogo/shop/reviews/?girlid=36454537&lo=1', GIRLS[1], {
    requireGirlMatch: false,
  });

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rating, '4.9');
  assert.match(reviews[0].comment, /楽しい時間/);
});

test('extractScheduleFromDiaries builds schedule rows from monthly diary text', () => {
  const rows = extractScheduleFromDiaries([
    {
      title: '追加枠ご予約募集のお知らせ',
      dateKey: '2026-06-17',
      body: '本日15:00から17:00まで空き枠あります。ご予約受付中です。',
      url: 'https://example.test/diary',
    },
  ], { now: new Date('2026-06-17T03:00:00Z') });

  assert.ok(rows.length >= 1);
  assert.equal(rows[0].date, '2026-06-17');
  assert.ok(rows.some(row => /空き枠/.test(row.detail)));
});

test('parseThreadLinks keeps board threads matching the target girl', () => {
  const links = parseThreadLinks(`
    <a href="/thr_res/acode=18/ctgid=103/bid=436/tid=1/">渋谷りなの 情報</a>
    <a href="/thr_res/acode=18/ctgid=103/bid=436/tid=2/">別スレ</a>
  `, 'https://bakusai.com/thr_tl/acode=18/ctgid=103/bid=436/', GIRLS[2]);

  assert.equal(links.length, 1);
  assert.match(links[0].url, /tid=1/);
});

test('formatGirlSection creates readable grouped Telegram section', () => {
  const section = formatGirlSection({
    girl: GIRLS[0],
    profile: ['身長: 160cm'],
    reservation: ['06/17 10:00-18:00 予約受付中'],
    diarySchedule: [{ date: '2026-06-17', time: '15:00', detail: '追加枠あります' }],
    diaries: [{ title: '今日の日記', titleZh: '今天的日记', body: '本文です'.repeat(20), bodyZh: '正文'.repeat(20), imageUrls: ['https://example.test/a.jpg'], videoUrls: ['https://example.test/a.mp4'] }],
    reviews: [{ title: '良かった', rating: '4.8', summary: '客人说很开心' }],
    bakusai: [{ num: 12, time: '2026/06/17 10:00', content: 'キキの話題', contentZh: '关于Kiki的话题' }],
    warnings: [],
  });

  assert.match(section, /👤 井上キキ/);
  assert.match(section, /🗓 日记提取出勤表/);
  assert.match(section, /📅 官方预约页/);
  assert.match(section, /🔵 今天的日记/);
  assert.match(section, /🇯🇵 原文：/);
  assert.match(section, /🔵 中文：/);
  assert.match(section, /📷 https:\/\/example\.test\/a\.jpg/);
  assert.match(section, /🎬 https:\/\/example\.test\/a\.mp4/);
  assert.match(section, /客人大概说：客人说很开心/);
  assert.match(section, /💬 爆さい相关提及/);
});

test('formatGirlSection prints empty Bakusai mentions as a plain empty-state line', () => {
  const section = formatGirlSection({
      girl: GIRLS[1],
      profile: [],
      reservation: [],
      diarySchedule: [],
      diaries: [],
      reviews: [],
      bakusai: [],
    warnings: [],
  });

  assert.match(section, /💬 爆さい相关提及（最新尽量10条）\n  - 暂无匹配提及/);
  assert.doesNotMatch(section, /🇯🇵 暂无匹配提及/);
});

test('buildGirlsDigestMessage and splitGirlsDigestMessage support long combined reports', () => {
  const message = buildGirlsDigestMessage([
    {
      girl: GIRLS[0],
      profile: [],
      diarySchedule: [],
      reservation: Array.from({ length: 8 }, (_, index) => `06/${17 + index} 10:00-18:00 予約受付中`),
      diaries: Array.from({ length: 3 }, (_, index) => ({
        title: `日記 ${index + 1}`,
        titleZh: `日记 ${index + 1}`,
        body: '本文です'.repeat(80),
        bodyZh: '这是正文'.repeat(80),
      })),
      reviews: [],
      bakusai: Array.from({ length: 6 }, (_, index) => ({
        num: index + 1,
        time: '2026/06/17 10:00',
        content: '爆さい本文'.repeat(30),
        contentZh: '爆料正文'.repeat(30),
      })),
      warnings: [],
    },
  ], { now: new Date('2026-06-17T03:00:00Z') });
  const chunks = splitGirlsDigestMessage(message, 500);

  assert.match(message, /🌸 女孩每日关注/);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 500));
});
