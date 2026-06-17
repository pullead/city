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
const { searchResponses } = require('./bakusai');
const { normalizeForSearch } = require('./normalize-ja');

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_SP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const GIRLS = [
  {
    id: '36256910',
    name: '井上キキ',
    shop: 'むきたまご堺東店',
    profileUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/girlid-36256910/?lo=1',
    reservationUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/S6ShopReservation/?girl_id=36256910&lo=1',
    diaryUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/girlid-36256910/diary/?lo=1#menus',
    reviewsUrl: 'https://www.cityheaven.net/osaka/A2702/A270203/mukitama_sakulan/reviews/?girlid=36256910&lo=1',
    bakusaiUrls: [
      'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=410/tid=12867698/ttgid=105/p=1/',
      'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=1227/tid=10030739/p=1/',
    ],
    searchBoards: [
      { areaCode: '7', boardId: '410' },
      { areaCode: '7', boardId: '1227' },
    ],
    keywords: ['井上キキ', 'キキ', 'きき'],
  },
  {
    id: '36454537',
    name: '清水あさひ',
    shop: '神戸妻',
    diaryUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe-duma/girlid-36454537/diary/?lo=1#menus',
    reviewsUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe-duma/reviews/?girlid=36454537&lo=1',
    bakusaiUrls: [
      'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13281329/',
    ],
    searchBoards: [
      { areaCode: '18', boardId: '436' },
    ],
    keywords: ['清水あさひ', 'あさひ', 'アサヒ'],
  },
  {
    id: '63862566',
    name: '渋谷りなの',
    shop: '神戸マダムロイヤル',
    profileUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe_madam_royal/girlid-63862566',
    diaryUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe_madam_royal/girlid-63862566/diary/?lo=1#menus',
    reviewsUrl: 'https://www.cityheaven.net/hyogo/A2801/A280102/kobe_madam_royal/reviews/?girlid=63862566&lo=1',
    bakusaiUrls: [
      'https://bakusai.com/thr_tl/acode=18/ctgid=103/bid=436/',
      'https://bakusai.com/thr_tl/acode=18/ctgid=103/bid=239/',
    ],
    searchBoards: [
      { areaCode: '18', boardId: '436' },
      { areaCode: '18', boardId: '239' },
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

function splitTextByLength(text, maxLength) {
  const value = cleanText(text);
  if (!value) return [];
  const limit = Math.max(1, maxLength);
  const chunks = [];
  let remaining = value;
  while (remaining.length > limit) {
    let splitAt = -1;
    for (const marker of ['。', '！', '？', '!', '?', '、', '，', ' ']) {
      const index = remaining.lastIndexOf(marker, limit);
      if (index > Math.floor(limit * 0.45)) {
        splitAt = index + marker.length;
        break;
      }
    }
    if (splitAt < 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function appendTextBlock(lines, label, text, indent = '    ', maxLineChars = 900) {
  const chunks = splitTextByLength(text, maxLineChars);
  if (chunks.length === 0) return;
  lines.push(`${indent}${label}`);
  for (const chunk of chunks) lines.push(`${indent}  ${chunk}`);
}

function dateKeyInTokyo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseMonthDayDateKey(text, now = new Date()) {
  const value = String(text || '').normalize('NFKC');
  const full = value.match(/(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})/);
  if (full) return `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')}`;
  const short = value.match(/(\d{1,2})[\/月.-](\d{1,2})/);
  if (!short) return '';
  return `${dateKeyInTokyo(now).slice(0, 4)}-${String(short[1]).padStart(2, '0')}-${String(short[2]).padStart(2, '0')}`;
}

function isCurrentMonthDate(dateKey, now = new Date()) {
  return Boolean(dateKey && dateKey.slice(0, 7) === dateKeyInTokyo(now).slice(0, 7));
}

function isTodayDate(dateKey, now = new Date()) {
  return Boolean(dateKey && dateKey === dateKeyInTokyo(now));
}

function absoluteUrl(url, base = 'https://www.cityheaven.net') {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return `https:${url}`;
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

function parseDiaries(html, pageUrl, options = {}) {
  const $ = cheerio.load(html || '');
  const diaries = [];
  const seen = new Set();
  const limit = options.limit || 20;
  const now = options.now || new Date();

  $('.girls-img-thumbnail, .diary_item, li[class*="diary"], article[class*="diary"], a[href*="/diary/pd-"]').each((_, el) => {
    const item = $(el);
    const linkEl = item.is('a') ? item : item.find('a[href*="/diary/pd-"]').first();
    const href = linkEl.attr('href') || '';
    if (href && !href.includes('/diary/pd-')) return;
    const url = absoluteUrl(href, pageUrl);
    const girlName = item.find('.diary-name').first().text().trim();
    const title = cleanText(
      item.find('.diary-title').first().text()
      || item.find('.diary_title, .diary_headding, [class*="title"]').first().text()
      || linkEl.text()
      || item.text(),
    ).replace(girlName, '').trim();
    const date = cleanText(item.find('.diary_time, time, [class*="date"], [class*="time"]').first().text());
    const snippet = cleanText(item.find('.diary_detail, [class*="text"], [class*="body"]').first().text());
    const key = `${title}|${url}`;
    if (!title || title.length < 2 || seen.has(key)) return;
    if (/^(写メ日記|日記|詳細|リンク)$/i.test(title)) return;
    if (/JavaScript|display:\s*none|noScriptArea|写メ日記はありません/i.test(`${title} ${snippet}`)) return;
    seen.add(key);
    diaries.push({
      title: truncate(title, 80),
      date: truncate(date, 30),
      dateKey: parseMonthDayDateKey(`${date} ${title}`, now),
      snippet: truncate(snippet, 180),
      url,
      imageUrls: item.find('img').map((_, img) => absoluteUrl($(img).attr('data-src') || $(img).attr('src') || '', pageUrl)).get()
        .filter(isDiaryMediaUrl)
        .slice(0, 3),
      videoUrls: item.find('video source, video').map((_, video) => absoluteUrl($(video).attr('src') || '', pageUrl)).get().filter(Boolean).slice(0, 2),
    });
  });

  return diaries.slice(0, limit);
}

function parseDiaryNextPage(html, pageUrl) {
  const $ = cheerio.load(html || '');
  let href = $('link[rel="next"]').attr('href')
    || $('a[rel="next"]').attr('href')
    || $('a').filter((_, el) => /次|次へ|next/i.test(cleanText($(el).text()))).first().attr('href')
    || '';
  if (!href) return '';
  return absoluteUrl(href, pageUrl);
}

function parseDiaryPanelUrl(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const href = $('a[href*="/diary/panel/"]').first().attr('href') || '';
  return href ? absoluteUrl(href, pageUrl) : '';
}

function diaryPanelUrlFromDiaryUrl(url) {
  const clean = String(url || '').split('#')[0].split('?')[0].replace(/\/+$/, '');
  if (clean.includes('/diary/panel')) return `${clean}/`;
  if (clean.endsWith('/diary')) return `${clean}/panel/`;
  return url;
}

function parseDiaryMetaFromTitle(titleText) {
  const value = String(titleText || '');
  const match = value.match(/写メ日記『([^』]+)』[\s\S]*?\((\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})\)/);
  if (!match) return {};
  return {
    title: match[1],
    date: `${match[2]}/${String(match[3]).padStart(2, '0')}/${String(match[4]).padStart(2, '0')} ${String(match[5]).padStart(2, '0')}:${match[6]}`,
    dateKey: `${match[2]}-${String(match[3]).padStart(2, '0')}-${String(match[4]).padStart(2, '0')}`,
  };
}

function isDiaryMediaUrl(url) {
  return Boolean(
    url
    && /\/img\/(girls|deco)\//i.test(url)
    && /grdr|deco/i.test(url)
    && !/dummy|logo|banner|icon|loading|btn_|btn|reserve|footBtn|gric|grpb|grpe/i.test(url)
  );
}

function diaryIdFromUrl(url) {
  const match = String(url || '').match(/\/diary\/pd-(\d+)/);
  return match ? match[1] : '';
}

function mediaMatchesDiaryId(url, diaryId) {
  if (!diaryId) return true;
  const value = String(url || '');
  return value.includes(diaryId) || value.includes(`0${diaryId}`);
}

function cleanDiaryBodyText(text, title, date) {
  let value = cleanText(text);
  const titleIndex = title ? value.indexOf(title) : -1;
  if (titleIndex >= 0) value = value.slice(titleIndex + title.length);
  const dateLabel = date ? date.replace(/^\d{4}\//, '').replace(/^0/, '') : '';
  const dateIndex = dateLabel ? value.indexOf(dateLabel) : -1;
  if (dateIndex >= 0) value = value.slice(dateIndex + dateLabel.length);
  value = value
    .replace(/^(みたよ|マイガール|キープ|ヨヤク|\s)+/g, '')
    .split('こちらの写メ日記も')[0]
    .split('この写メ日記を通報')[0]
    .trim();
  return value;
}

function parseDiaryDetail(html, pageUrl, base = {}) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript, iframe, header, footer, nav').remove();
  const diaryId = diaryIdFromUrl(pageUrl || base.url);
  const meta = parseDiaryMetaFromTitle($('title').text());
  const rawTitle = cleanText($('h1, .diary_title, .diary_headding, [class*="title"]').first().text());
  const title = meta.title || (rawTitle && !/^(新着通知|写メ日記|日記|詳細)$/i.test(rawTitle) ? rawTitle : (base.title || rawTitle || ''));
  const date = meta.date || cleanText($('time, .diary_time, [class*="date"], [class*="time"]').first().text()) || base.date || '';
  const rawBody = $('.girldiary_detail, .diary_detail, .diary_body, .diary_text, .diary_post, article, main').first().text();
  const body = cleanDiaryBodyText(rawBody, title, date) || base.snippet || '';
  const imageUrls = $('img').map((_, img) => absoluteUrl($(img).attr('data-src') || $(img).attr('src') || '', pageUrl)).get()
    .filter(url => isDiaryMediaUrl(url) && mediaMatchesDiaryId(url, diaryId))
    .slice(0, 4);
  const videoUrls = $('video source, video, a[href*=".mp4"], a[href*=".mov"], a[href*=".m3u8"]').map((_, video) => absoluteUrl($(video).attr('src') || $(video).attr('href') || '', pageUrl)).get()
    .filter(Boolean)
    .slice(0, 2);

  return {
    ...base,
    title: truncate(title, 80),
    date: truncate(date, 30),
    dateKey: meta.dateKey || parseMonthDayDateKey(date || base.date),
    snippet: truncate(body, 360),
    body,
    imageUrls: [...new Set([...(base.imageUrls || []), ...imageUrls])]
      .filter(url => isDiaryMediaUrl(url) && mediaMatchesDiaryId(url, diaryId))
      .slice(0, 4),
    videoUrls: [...new Set([...(base.videoUrls || []), ...videoUrls])].slice(0, 2),
    url: pageUrl || base.url,
  };
}

function diaryPageCandidates(startUrl, page) {
  if (page <= 1) return [startUrl];
  const clean = String(startUrl || '').split('#')[0];
  const withoutQuery = clean.split('?')[0].replace(/\/+$/, '');
  return [
    `${withoutQuery}/${page}/`,
    `${withoutQuery}/p=${page}/`,
    `${clean}${clean.includes('?') ? '&' : '?'}page=${page}`,
  ];
}

async function collectMonthlyDiaries(girl, options = {}) {
  if (!girl.diaryUrl) return [];
  const now = options.now || new Date();
  const maxPages = options.maxPages || 4;
  const maxDetails = options.maxDetails || 60;
  const entries = [];
  const seenUrls = new Set();
  let nextUrl = girl.diaryUrl;

  for (let page = 1; page <= maxPages; page++) {
    const urls = nextUrl
      ? [nextUrl, diaryPanelUrlFromDiaryUrl(nextUrl)]
      : diaryPageCandidates(girl.diaryUrl, page);
    let html = '';
    let pageUrl = '';
    for (const candidate of urls) {
      try {
        html = await fetchHtml(candidate, { ua: UA_SP });
        pageUrl = candidate;
        break;
      } catch (_) {
        // try next candidate
      }
    }
    if (!html) break;

    let diaries = parseDiaries(html, pageUrl, { now, limit: 30 });
    if (diaries.length === 0) {
      const panelUrl = parseDiaryPanelUrl(html, pageUrl);
      if (panelUrl && panelUrl !== pageUrl) {
        try {
          html = await fetchHtml(panelUrl, { ua: UA_SP });
          pageUrl = panelUrl;
          diaries = parseDiaries(html, pageUrl, { now, limit: 30 });
        } catch (_) {
          // Keep the empty diary list and stop naturally below.
        }
      }
    }
    for (const diary of diaries) {
      if (!diary.url || seenUrls.has(diary.url)) continue;
      if (diary.dateKey && !isCurrentMonthDate(diary.dateKey, now)) continue;
      seenUrls.add(diary.url);
      entries.push(diary);
    }
    nextUrl = parseDiaryNextPage(html, pageUrl);
    if (!nextUrl && diaries.length === 0) break;
    if (entries.length >= maxDetails) break;
    await sleep(400);
  }

  const detailed = [];
  for (const diary of entries.slice(0, maxDetails)) {
    try {
      const html = await fetchHtml(diary.url, { ua: UA_SP });
      detailed.push(parseDiaryDetail(html, diary.url, diary));
    } catch (_) {
      detailed.push(diary);
    }
    await sleep(250);
  }

  return detailed
    .filter(diary => !diary.dateKey || isCurrentMonthDate(diary.dateKey, now))
    .sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
}

function extractScheduleFromDiaries(diaries, options = {}) {
  const now = options.now || new Date();
  const rows = [];
  const seen = new Set();
  const schedulePattern = /(出勤|予約|空き|空枠|追加枠|受付|シフト|出勤表|予定|ご案内|満了|完売|休み|キャンセル|枠)/;
  const datePattern = /(\d{1,2}[\/月.-]\d{1,2}(?:日)?|\d{1,2}日|\d{1,2}:\d{2}|\d{1,2}時(?:\d{1,2}分)?)/g;

  for (const diary of diaries || []) {
    const sourceDate = diary.dateKey || parseMonthDayDateKey(diary.date, now);
    const chunks = String(`${diary.title || ''}\n${diary.snippet || ''}\n${diary.body || ''}`)
      .split(/[。！？!?\n]/)
      .map(cleanText)
      .filter(line => line.length >= 3 && line.length <= 140 && schedulePattern.test(line));
    for (const line of chunks) {
      const dateHints = [...line.matchAll(datePattern)].map(match => match[0]).slice(0, 4);
      const key = `${sourceDate}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        date: sourceDate || dateHints[0] || '',
        time: dateHints.join(' / '),
        detail: truncate(line, 90),
        sourceTitle: diary.title,
        sourceUrl: diary.url,
      });
    }
  }

  return rows.slice(0, 10);
}

function isGirlScopedReviewUrl(pageUrl, girl) {
  return Boolean(girl && girl.id && String(pageUrl || '').includes(`girlid=${girl.id}`));
}

function parseReviews(html, pageUrl, girl, options = {}) {
  const $ = cheerio.load(html || '');
  const reviews = [];
  const seen = new Set();
  const requireGirlMatch = options.requireGirlMatch !== false;
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
    if (!text || (requireGirlMatch && !matchesGirl(text, girl))) return;
    const href = item.find('a[href*="/reviews/"]').first().attr('href') || '';
    const title = normalizeReviewTitle(cleanText(item.find('.review-item-title, [class*="title"]').first().text()) || '口コミ');
    const rating = cleanText(item.find('.total_rate, [class*="rate"]').first().text());
    const comment = cleanText(
      item.find('.review-item-post').not('[class*="date"]').first().text()
      || item.find('[class*="post"]').not('[class*="date"]').first().text(),
    ) || text;
    const date = cleanText(item.find('.review-item-post-date, time, [class*="date"]').first().text());
    const url = absoluteUrl(href, pageUrl);
    const key = `${title}|${comment.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    reviews.push({
      title: truncate(title, 50),
      rating,
      comment: truncate(comment, 220),
      date,
      dateKey: parseMonthDayDateKey(date),
      url,
    });
  });

  return reviews.slice(0, 10);
}

function normalizeReviewTitle(title) {
  return cleanText(title)
    .replace(/遊んだ女の子.+?プロフィールを見る/g, '')
    .replace(/T\d+･[^★]+/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '口コミ';
}

function isWithinDays(dateKey, days, now = new Date()) {
  if (!dateKey) return false;
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  const today = new Date(`${dateKeyInTokyo(now)}T00:00:00+09:00`);
  return today - date >= 0 && today - date <= days * 86400000;
}

function pagedUrlWithQuery(startUrl, page) {
  if (page <= 1) return startUrl;
  const [base, query = ''] = String(startUrl || '').split('#')[0].split('?');
  const url = `${base.replace(/\/+$/, '')}/${page}/`;
  return query ? `${url}?${query}` : url;
}

async function collectWeeklyReviews(girl, options = {}) {
  if (!girl.reviewsUrl) return [];
  const now = options.now || new Date();
  const maxPages = options.maxPages || 2;
  const reviews = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = pagedUrlWithQuery(girl.reviewsUrl, page);
    try {
      const html = await fetchHtml(url, { ua: UA_PC });
      for (const review of parseReviews(html, url, girl, {
        requireGirlMatch: !isGirlScopedReviewUrl(girl.reviewsUrl, girl),
      })) {
        const key = `${review.title}|${review.comment.slice(0, 50)}`;
        if (seen.has(key)) continue;
        if (review.dateKey && !isWithinDays(review.dateKey, 7, now)) continue;
        seen.add(key);
        reviews.push(review);
      }
    } catch (_) {
      break;
    }
    await sleep(300);
  }

  const selected = reviews.slice(0, 5);
  return translateItems(selected, ['comment']);
}

function summarizeReviews(reviews) {
  if (!reviews || reviews.length === 0) return [];
  return reviews.slice(0, 3).map(review => ({
    ...review,
    summary: truncate(review.commentZh || review.comment, 70),
  }));
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
    .map(post => ({
      num: post.num,
      time: post.time,
      content: truncate(post.content.replace(/>>\d+/g, ''), 140),
      urlTitle: sourceTitle,
    }));
}

async function collectBakusaiMentions(girl, options = {}) {
  const mentions = [];
  const maxPages = options.maxPages || 4;
  const minMentions = options.minMentions || 10;

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
          if (mentions.length >= minMentions) break;
          await sleep(300);
        }
      }
    } catch (error) {
      mentions.push({ error: `${url}: ${error.message}` });
    }
    await sleep(500);
  }

  if (mentions.filter(item => !item.error).length < minMentions) {
    mentions.push(...await searchBakusaiResponsesForGirl(girl, {
      minMentions,
      existingCount: mentions.filter(item => !item.error).length,
    }));
  }

  if (mentions.filter(item => !item.error).length < minMentions) {
    mentions.push(...await searchWebForBakusaiMentions(girl, {
      minMentions,
      existingCount: mentions.filter(item => !item.error).length,
    }));
  }

  const seen = new Set();
  return mentions.filter(item => {
    const key = `${item.time}|${item.num}|${item.content}|${item.error}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, minMentions);
}

async function searchBakusaiResponsesForGirl(girl, options = {}) {
  const results = [];
  const targetCount = Math.max(0, (options.minMentions || 10) - (options.existingCount || 0));
  if (targetCount <= 0) return results;

  for (const board of girl.searchBoards || []) {
    for (const keyword of girl.keywords || [girl.name]) {
      try {
        const hits = await searchResponses({
          areaCode: board.areaCode,
          boardId: board.boardId,
          keyword,
          maxPages: 2,
        });
        for (const hit of hits) {
          if (!matchesGirl(hit.body, girl)) continue;
          results.push({
            num: null,
            time: hit.date,
            content: truncate(hit.body, 140),
            urlTitle: `${hit.board_label || '爆さい検索'} ${hit.thread_title || ''}`,
          });
          if (results.length >= targetCount) return results;
        }
      } catch (_) {
        // Continue with the next board/keyword and then web fallback.
      }
      await sleep(300);
    }
  }
  return results;
}

async function searchWebForBakusaiMentions(girl, options = {}) {
  const results = [];
  const targetCount = Math.max(0, (options.minMentions || 10) - (options.existingCount || 0));
  if (targetCount <= 0) return results;

  const query = encodeURIComponent(`site:bakusai.com ${girl.name} 爆サイ`);
  try {
    const html = await fetchHtml(`https://duckduckgo.com/html/?q=${query}`, {
      ua: UA_PC,
      timeout: 20000,
      retries: 0,
    });
    const links = parseThreadLinks(html, 'https://duckduckgo.com/html/', girl)
      .filter(link => /bakusai\.com/.test(link.url))
      .slice(0, 4);
    for (const link of links) {
      const threadHtml = await fetchHtml(buildPageUrl(link.url, 1), { ua: UA_PC });
      results.push(...filterBakusaiPosts(parsePosts(threadHtml), girl, link.title));
      if (results.length >= targetCount) break;
      await sleep(300);
    }
  } catch (_) {
    // Public search is a best-effort fallback only.
  }

  return results.slice(0, targetCount);
}

async function translateItems(items, fields) {
  const translated = [];
  for (const item of items || []) {
    const next = { ...item };
    for (const field of fields) {
      if (!next[field]) continue;
      try {
        next[`${field}Zh`] = await translateLongTextJaToZh(next[field]);
      } catch (_) {
        next[`${field}Zh`] = '';
      }
      await sleep(150);
    }
    translated.push(next);
  }
  return translated;
}

async function translateLongTextJaToZh(text, options = {}) {
  const chunks = splitTextByLength(text, options.maxChars || 1200);
  const translated = [];
  for (const chunk of chunks) {
    translated.push(await translateTextJaToZh(chunk, options));
    await sleep(120);
  }
  return translated.join('');
}

async function collectGirlDigest(girl) {
  const result = {
    girl,
    profile: [],
    reservation: [],
    diarySchedule: [],
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
      const monthlyDiaries = await collectMonthlyDiaries(girl);
      result.diarySchedule = extractScheduleFromDiaries(monthlyDiaries);
      const todayDiaries = monthlyDiaries.filter(diary => isTodayDate(diary.dateKey));
      result.diaries = await translateItems(todayDiaries, ['title', 'body']);
    }
  } catch (error) {
    result.warnings.push(`写メ日記取得失败: ${error.message}`);
  }

  try {
    if (girl.reviewsUrl) {
      result.reviews = summarizeReviews(await collectWeeklyReviews(girl));
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

  lines.push('🗓 日记提取出勤表');
  if (digest.diarySchedule && digest.diarySchedule.length) {
    for (const row of digest.diarySchedule.slice(0, 5)) {
      lines.push(`  - ${row.date || '日期不明'}｜${row.time || '时间未提取'}｜${truncate(row.detail, 54)}`);
    }
  } else {
    lines.push('  - 当月日记里暂未提取到明确出勤/预约内容');
  }

  lines.push('📅 官方预约页');
  for (const item of lineList(digest.reservation, '暂无可解析的出勤/预约信息')) {
    lines.push(`  - ${truncate(item, 90)}`);
  }

  lines.push('📝 今日写メ日記');
  for (const diary of digest.diaries.length ? digest.diaries : [{ title: '暂无今天日记' }]) {
    lines.push(`  - ${diary.date ? `${diary.date} ` : ''}${diary.title}`);
    if (diary.titleZh) lines.push(`    🔵 ${truncate(diary.titleZh, 70)}`);
    appendTextBlock(lines, '🇯🇵 原文：', diary.body || diary.snippet, '    ');
    appendTextBlock(lines, '🔵 中文：', diary.bodyZh || diary.snippetZh, '    ');
    if (diary.imageUrls && diary.imageUrls.length) {
      for (const imageUrl of diary.imageUrls.slice(0, 4)) lines.push(`    📷 ${imageUrl}`);
    }
    if (diary.videoUrls && diary.videoUrls.length) {
      for (const videoUrl of diary.videoUrls.slice(0, 2)) lines.push(`    🎬 ${videoUrl}`);
    }
  }

  if (girl.reviewsUrl) {
    lines.push('⭐ 近一周口コミ总结');
    for (const review of digest.reviews.length ? digest.reviews : [{ title: '近一周暂无匹配口コミ' }]) {
      lines.push(`  - ${review.date ? `${review.date} ` : ''}${review.rating ? `★${review.rating} ` : ''}${review.title}`);
      if (review.summary) lines.push(`    🔵 客人大概说：${truncate(review.summary, 80)}`);
      else if (review.comment) lines.push(`    🇯🇵 ${truncate(review.comment, 80)}`);
    }
  }

  lines.push('💬 爆さい相关提及（最新尽量10条）');
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
    lines.push(`    🇯🇵 ${truncate(mention.content, 72)}`);
    if (mention.contentZh) lines.push(`    🔵 ${truncate(mention.contentZh, 72)}`);
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
    '当月日记出勤表・今日日记媒体・一周口コミ・爆さい提及',
    '',
    ...(digests || []).map(formatGirlSection).flatMap((section, index) => (
      index === 0 ? [section] : ['━━━━━━━━━━━━', section]
    )),
  ].join('\n').trim();
}

function splitGirlsDigestMessage(message, maxChars = 3500) {
  const value = String(message || '').trim();
  if (value.length <= maxChars) return value ? [value] : [];

  const parts = value.split('\n━━━━━━━━━━━━\n');
  if (parts.length <= 1) return splitTelegramText(value, maxChars);

  const chunks = [];
  let current = parts[0];
  for (const section of parts.slice(1)) {
    const candidate = `${current}\n━━━━━━━━━━━━\n${section}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(...splitTelegramText(current, maxChars));
    current = section;
    if (current.length > maxChars) {
      chunks.push(...splitTelegramText(current, maxChars));
      current = '';
    }
  }
  if (current) chunks.push(...splitTelegramText(current, maxChars));
  return chunks;
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
  collectMonthlyDiaries,
  collectWeeklyReviews,
  extractScheduleFromDiaries,
  formatGirlSection,
  matchesGirl,
  parseDiaries,
  parseDiaryDetail,
  parseDiaryNextPage,
  parseProfile,
  parseReservation,
  parseReviews,
  parseThreadLinks,
  searchBakusaiResponsesForGirl,
  searchWebForBakusaiMentions,
  sendGirlsDigestToTelegram,
  splitGirlsDigestMessage,
};
