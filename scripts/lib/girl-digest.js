'use strict';

const cheerio = require('cheerio');
const { fetchText } = require('./http-fetch');
const {
  DEFAULT_THREAD_URL,
  buildPageUrl,
  parsePosts,
  sendTelegramMessage,
  splitTelegramText,
  translateTextJaToZh,
} = require('./bakusai-monitor');
const { normalizeForSearch } = require('./normalize-ja');

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_SP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const GIRLS = [
  {
    name: '井上キキ',
    shop: 'むきたまご堺東店',
    profileUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/girlid-36256910/?lo=1',
    reservationUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/S6ShopReservation/?girl_id=36256910&lo=1',
    diaryUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/girlid-36256910/diary/panel/',
    reviewsUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/reviews/?girlid=36256910&lo=1',
    bakusaiUrls: [
      'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=410/tid=12867698/ttgid=105/p=1/',
      'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=1227/tid=10030739/p=1/',
    ],
    keywords: ['井上キキ', 'キキ', 'きき'],
  },
  {
    name: '清水あさひ',
    shop: '神戸妻',
    diaryUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe-duma/girlid-36454537/diary/?lo=1#menus',
    bakusaiUrls: [
      'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13281329/',
    ],
    keywords: ['清水あさひ', 'あさひ', 'アサヒ'],
  },
  {
    name: '渋谷りなの',
    shop: '神戸マダムロイヤル',
    profileUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe_madam_royal/girlid-63862566',
    diaryUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe_madam_royal/girlid-63862566/diary/?lo=1#menus',
    bakusaiUrls: [
      'https://bakusai.com/thr_tl/acode=18/ctgid=103/bid=436/',
      'https://bakusai.com/thr_tl/acode=18/ctgid=103/bid=239/',
    ],
    keywords: ['渋谷りなの', 'りなの', 'リナノ'],
  },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxLength) {
  const value = cleanText(text);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function absoluteUrl(url, base = 'https://www.cityheaven.net') {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return new URL(url, base).toString();
}

function matchesGirl(text, girl) {
  const value = normalizeForSearch(text);
  return (girl.keywords || [girl.name]).some(keyword => value.includes(normalizeForSearch(keyword)));
}

async function fetchHtml(url, options = {}) {
  return fetchText(url, {
    ua: options.ua || UA_PC,
    timeout: options.timeout || 20000,
    retries: options.retries ?? 1,
    throwOnHttpError: false,
  });
}

function parseProfile(html) {
  const $ = cheerio.load(html || '');
  const lines = [];
  const seen = new Set();

  $('[class*="profile"], [class*="prof"], dl, table').find('dt, th').each((_, el) => {
    const label = cleanText($(el).text());
    const value = cleanText($(el).next('dd, td').text());
    if (!label || !value || label.length > 20 || value.length > 80) return;
    const line = `${label}: ${value}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  });

  return lines.slice(0, 6);
}

function parseReservation(html) {
  const $ = cheerio.load(html || '');
  const rows = [];
  const seen = new Set();

  $('tr, li, .schedule_item, [class*="reserve"], [class*="sche"]').each((_, el) => {
    const text = cleanText($(el).text());
    if (!text || text.length < 4 || text.length > 120) return;
    if (!/(\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}|受付|予約|出勤|TEL|電話|満了|空き|休み)/.test(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    rows.push(text);
  });

  return rows.slice(0, 8);
}

function parseDiaries(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const diaries = [];
  const seen = new Set();

  $('.diary_item, li[class*="diary"], article[class*="diary"], a[href*="/diary/pd-"]').each((_, el) => {
    const item = $(el);
    const linkEl = item.is('a') ? item : item.find('a[href*="/diary/pd-"]').first();
    const href = linkEl.attr('href') || '';
    if (href && !href.includes('/diary/pd-')) return;
    const url = absoluteUrl(href, pageUrl);
    const title = cleanText(
      item.find('.diary_title, .diary_headding, [class*="title"]').first().text()
      || linkEl.text()
      || item.text(),
    );
    const date = cleanText(item.find('.diary_time, time, [class*="date"], [class*="time"]').first().text());
    const snippet = cleanText(item.find('.diary_detail, [class*="text"], [class*="body"]').first().text());
    const key = `${title}|${url}`;
    if (!title || title.length < 2 || seen.has(key)) return;
    if (/^(写メ日記|日記|詳細|リンク)$/i.test(title)) return;
    if (/JavaScript|display:\s*none|noScriptArea|写メ日記はありません/i.test(`${title} ${snippet}`)) return;
    seen.add(key);
    diaries.push({ title: truncate(title, 60), date: truncate(date, 24), snippet: truncate(snippet, 100), url });
  });

  return diaries.slice(0, 3);
}

function parseReviews(html, pageUrl, girl) {
  const $ = cheerio.load(html || '');
  const reviews = [];
  const seen = new Set();
  let reviewItems = $('li.review-item');
  if (reviewItems.length === 0) {
    reviewItems = $('[class*="review"]').filter((_, el) => {
      const item = $(el);
      return item.find('[class*="review"]').length === 0 || item.find('.review-item-post, [class*="post"]').length > 0;
    });
  }

  reviewItems.each((_, el) => {
    const item = $(el);
    const text = cleanText(item.text());
    if (!text || !matchesGirl(text, girl)) return;
    const href = item.find('a[href*="/reviews/"]').first().attr('href') || '';
    const title = cleanText(item.find('.review-item-title, [class*="title"]').first().text()) || '口コミ';
    const rating = cleanText(item.find('.total_rate, [class*="rate"]').first().text());
    const comment = cleanText(item.find('.review-item-post, [class*="post"]').first().text()) || text;
    const url = absoluteUrl(href, pageUrl);
    const key = `${title}|${comment.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    reviews.push({ title: truncate(title, 50), rating, comment: truncate(comment, 120), url });
  });

  return reviews.slice(0, 2);
}

function parseThreadLinks(html, pageUrl, girl) {
  const $ = cheerio.load(html || '');
  const links = [];
  const seen = new Set();

  $('a[href*="/thr_res/"]').each((_, el) => {
    const a = $(el);
    const title = cleanText(a.text());
    const href = a.attr('href') || '';
    if (!title || !matchesGirl(title, girl)) return;
    const url = absoluteUrl(href, pageUrl).split('#')[0].split('?')[0];
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ title: truncate(title, 70), url });
  });

  return links.slice(0, 4);
}

function filterBakusaiPosts(posts, girl, sourceTitle = '') {
  return (posts || [])
    .filter(post => matchesGirl(`${post.content} ${sourceTitle}`, girl))
    .slice(-5)
    .map(post => ({
      num: post.num,
      time: post.time,
      content: truncate(post.content.replace(/>>\d+/g, ''), 140),
      urlTitle: sourceTitle,
    }));
}

async function collectBakusaiMentions(girl, options = {}) {
  const mentions = [];
  const maxPages = options.maxPages || 2;

  for (const url of girl.bakusaiUrls || []) {
    try {
      if (url.includes('/thr_tl/')) {
        const html = await fetchHtml(url, { ua: UA_PC });
        const threadLinks = parseThreadLinks(html, url, girl);
        for (const link of threadLinks) {
          await sleep(300);
          const threadHtml = await fetchHtml(buildPageUrl(link.url || DEFAULT_THREAD_URL, 1), { ua: UA_PC });
          mentions.push(...filterBakusaiPosts(parsePosts(threadHtml), girl, link.title));
        }
      } else {
        for (let page = 1; page <= maxPages; page++) {
          const html = await fetchHtml(buildPageUrl(url, page), { ua: UA_PC });
          const posts = parsePosts(html);
          mentions.push(...filterBakusaiPosts(posts, girl));
          if (posts.length === 0) break;
          await sleep(300);
        }
      }
    } catch (error) {
      mentions.push({ error: `${url}: ${error.message}` });
    }
    await sleep(500);
  }

  const seen = new Set();
  return mentions.filter(item => {
    const key = `${item.num}|${item.content}|${item.error}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

async function translateItems(items, fields) {
  const translated = [];
  for (const item of items || []) {
    const next = { ...item };
    for (const field of fields) {
      if (!next[field]) continue;
      try {
        next[`${field}Zh`] = await translateTextJaToZh(next[field]);
      } catch (_) {
        next[`${field}Zh`] = '';
      }
      await sleep(150);
    }
    translated.push(next);
  }
  return translated;
}

async function collectGirlDigest(girl) {
  const result = {
    girl,
    profile: [],
    reservation: [],
    diaries: [],
    reviews: [],
    bakusai: [],
    warnings: [],
  };

  try {
    if (girl.profileUrl && process.env.TG_GIRLS_INCLUDE_PROFILE_DETAILS === '1') {
      result.profile = parseProfile(await fetchHtml(girl.profileUrl, { ua: UA_SP }));
    }
  } catch (error) {
    result.warnings.push(`プロフィール取得失败: ${error.message}`);
  }

  try {
    if (girl.reservationUrl) result.reservation = parseReservation(await fetchHtml(girl.reservationUrl, { ua: UA_SP }));
  } catch (error) {
    result.warnings.push(`出勤/予約取得失败: ${error.message}`);
  }

  try {
    if (girl.diaryUrl) {
      const diaries = parseDiaries(await fetchHtml(girl.diaryUrl, { ua: UA_SP }), girl.diaryUrl);
      result.diaries = await translateItems(diaries, ['title', 'snippet']);
    }
  } catch (error) {
    result.warnings.push(`写メ日記取得失败: ${error.message}`);
  }

  try {
    if (girl.reviewsUrl) {
      const reviews = parseReviews(await fetchHtml(girl.reviewsUrl, { ua: UA_PC }), girl.reviewsUrl, girl);
      result.reviews = await translateItems(reviews, ['comment']);
    }
  } catch (error) {
    result.warnings.push(`口コミ取得失败: ${error.message}`);
  }

  result.bakusai = await translateItems(await collectBakusaiMentions(girl), ['content']);
  return result;
}

function lineList(items, emptyText) {
  return items && items.length ? items : [emptyText];
}

function formatGirlSection(digest) {
  const { girl } = digest;
  const lines = [
    `👤 ${girl.name}｜${girl.shop}`,
  ];

  if (girl.profileUrl) lines.push(`🔗 ${girl.profileUrl}`);
  if (digest.profile.length) {
    lines.push('🏷 プロフィール');
    for (const item of digest.profile.slice(0, 4)) lines.push(`  - ${item}`);
  }

  lines.push('🗓 出勤/预约');
  for (const item of lineList(digest.reservation, '暂无可解析的出勤/预约信息')) {
    lines.push(`  - ${truncate(item, 90)}`);
  }

  lines.push('📝 写メ日記');
  for (const diary of digest.diaries.length ? digest.diaries : [{ title: '暂无新日记' }]) {
    lines.push(`  - ${diary.date ? `${diary.date} ` : ''}${diary.title}`);
    if (diary.titleZh) lines.push(`    🔵 ${truncate(diary.titleZh, 70)}`);
    if (diary.snippet) lines.push(`    🇯🇵 ${truncate(diary.snippet, 90)}`);
    if (diary.snippetZh) lines.push(`    🔵 ${truncate(diary.snippetZh, 90)}`);
  }

  if (girl.reviewsUrl) {
    lines.push('⭐ CityHeaven 口コミ');
    for (const review of digest.reviews.length ? digest.reviews : [{ title: '暂无匹配口コミ' }]) {
      lines.push(`  - ${review.rating ? `★${review.rating} ` : ''}${review.title}`);
      if (review.comment) lines.push(`    🇯🇵 ${truncate(review.comment, 100)}`);
      if (review.commentZh) lines.push(`    🔵 ${truncate(review.commentZh, 100)}`);
    }
  }

  lines.push('💬 爆さい提及');
  if (!digest.bakusai.length) {
    lines.push('  - 暂无匹配提及');
  }
  for (const mention of digest.bakusai) {
    if (mention.error) {
      lines.push(`  - 取得失败: ${truncate(mention.error, 100)}`);
      continue;
    }
    lines.push(`  - ${mention.num ? `#${mention.num} ` : ''}${mention.time || ''}`);
    if (mention.urlTitle) lines.push(`    ${mention.urlTitle}`);
    lines.push(`    🇯🇵 ${truncate(mention.content, 110)}`);
    if (mention.contentZh) lines.push(`    🔵 ${truncate(mention.contentZh, 110)}`);
  }

  if (digest.warnings.length) {
    lines.push('⚠️ 取得メモ');
    for (const warning of digest.warnings) lines.push(`  - ${truncate(warning, 90)}`);
  }

  return lines.join('\n');
}

function buildGirlsDigestMessage(digests, options = {}) {
  const now = options.now || new Date();
  const timeText = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);

  return [
    `🌸 女孩每日关注｜${timeText} JST`,
    '出勤/预约・写メ日記・口コミ・爆さい提及',
    '',
    ...(digests || []).map(formatGirlSection).flatMap((section, index) => (
      index === 0 ? [section] : ['━━━━━━━━━━━━', section]
    )),
  ].join('\n').trim();
}

function splitGirlsDigestMessage(message, maxChars = 3500) {
  return splitTelegramText(message, maxChars);
}

async function collectAllGirlDigests(girls = GIRLS) {
  const digests = [];
  for (const girl of girls) {
    digests.push(await collectGirlDigest(girl));
    await sleep(800);
  }
  return digests;
}

async function sendGirlsDigestToTelegram(options = {}) {
  const digests = await collectAllGirlDigests(options.girls || GIRLS);
  const message = buildGirlsDigestMessage(digests);
  const chunks = splitGirlsDigestMessage(message, options.maxMessageChars || 3500);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[女孩关注 ${i + 1}/${chunks.length}]\n` : '';
    await sendTelegramMessage(options.botToken, options.chatId, `${prefix}${chunks[i]}`);
    await sleep(options.sendDelayMs || 800);
  }
  return { digests, sent: chunks.length };
}

module.exports = {
  GIRLS,
  buildGirlsDigestMessage,
  collectAllGirlDigests,
  collectBakusaiMentions,
  collectGirlDigest,
  formatGirlSection,
  matchesGirl,
  parseDiaries,
  parseProfile,
  parseReservation,
  parseReviews,
  parseThreadLinks,
  sendGirlsDigestToTelegram,
  splitGirlsDigestMessage,
};
