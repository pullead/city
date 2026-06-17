'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { req } = require('./db');
const { createCityHeavenFetcher, DEFAULT_UA } = require('./ch-fetch');

const cheerio = req('cheerio');

const CH_ORIGIN = 'https://www.cityheaven.net';
const DELAY_MS_DIARIES = 800;
const DELAY_MS_LIMITED = 1500;
const DELAY_MS_REVIEWS = 500;
const ROOT = path.resolve(__dirname, '..', '..');
const COOKIE_JSON = process.env.CH_COOKIE_JSON || path.join(ROOT, 'state', 'ch-playwright-cookies.json');

const CH_DIARY_SHOPS = [
  {
    name: 'Muteki Platinum',
    shop_id: 37142,
    slug: 'muteki_platinum',
    base: 'https://www.cityheaven.net/osaka/A2702/A270202/muteki_platinum/diarylist/',
  },
  {
    name: 'platleg',
    shop_id: 25536,
    slug: 'kitty_osaka',
    base: 'https://www.cityheaven.net/osaka/A2702/A270203/kitty_osaka/diarylist/',
  },
];

const CH_REVIEW_SHOPS = [
  {
    id: 'Muteki Platinum',
    slug: 'muteki_platinum',
    area: 'A270202',
    base: 'https://www.cityheaven.net/osaka/A2702/A270202/muteki_platinum/reviews/',
  },
  {
    id: 'platleg',
    slug: 'kitty_osaka',
    area: 'A270203',
    base: 'https://www.cityheaven.net/osaka/A2702/A270203/kitty_osaka/reviews/',
  },
];

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_SP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getArg(args, name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

function createChFetcherFromArgs(args, options = {}) {
  const fetchWarnings = options.warnings || [];
  const fetcher = createCityHeavenFetcher({
    ua: options.ua || DEFAULT_UA,
    useScrapling: args.includes('--scrapling-fetch') || process.env.USE_SCRAPLING_FETCH === '1',
    scraplingFetcher: getArg(args, '--scrapling-fetcher', process.env.SCRAPLING_FETCHER || 'http'),
    scraplingMode: getArg(args, '--scrapling-mode', process.env.CH_SCRAPLING_MODE || 'fallback'),
    timeout: parseInt(getArg(args, '--fetch-timeout', process.env.CH_FETCH_TIMEOUT || process.env.SCRAPLING_TIMEOUT || String(options.defaultTimeout || 30)), 10),
    failFast: args.includes('--fail-fast') || process.env.CH_FAIL_FAST === '1',
    warnings: fetchWarnings,
    logger: options.logger || (msg => console.error(`  ${msg}`)),
  });
  return { fetcher, fetchWarnings };
}

function ensureChLogin(scriptsDir = path.resolve(__dirname, '..')) {
  execFileSync('node', [path.join(scriptsDir, 'ch-login.js')], { stdio: 'inherit', timeout: 30000 });
}

function toCityHeavenAbsoluteUrl(url) {
  return url && url.startsWith('http') ? url : `${CH_ORIGIN}${url}`;
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/　/g, '')
    .toLowerCase();
}

function parseDiaryList(html, shop) {
  const $ = cheerio.load(html);
  const entries = [];

  $('.diary_item').each((_, el) => {
    const item = $(el);
    const link = item.find('a[href*="/diary/pd-"]').first().attr('href') || '';
    const girlMatch = link.match(/girlid-(\d+)/);
    const diaryMatch = link.match(/pd-(\d+)/);
    if (!girlMatch || !diaryMatch) return;

    const title = item.find('.diary_title').text().trim()
      || item.find('.diary_headding').text().trim();
    const timeText = item.find('.diary_time').text().trim();
    const writer = item.find('.diary_writer').text().trim();
    const content = item.find('.diary_detail').text().trim();

    let posted_at = '';
    if (timeText) {
      const m = timeText.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        const year = new Date().getFullYear();
        posted_at = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')} ${m[3].padStart(2, '0')}:${m[4]}`;
      }
    }

    const is_limited = /マイガール限定|マイヘブン限定/.test(content) ? 1 : 0;
    entries.push({
      ch_girlid: girlMatch[1],
      ch_diary_id: diaryMatch[1],
      title,
      posted_at,
      writer,
      content: is_limited ? '' : content,
      diary_url: toCityHeavenAbsoluteUrl(link),
      shop_name: shop.name,
      shop_id: shop.shop_id,
      is_limited,
    });
  });

  return {
    entries,
    nextPage: $('link[rel="next"]').attr('href') || null,
  };
}

function isDuplicateDiary(db, gal_id, title, posted_at) {
  if (!gal_id || !title) return false;

  const day = posted_at ? posted_at.slice(0, 10) : null;
  if (day) {
    const existing = db.prepare(`
      SELECT diary_id FROM diaries
      WHERE gal_id = ? AND title = ? AND posted_at LIKE ? AND source != 'cityheaven'
      LIMIT 1
    `).get(gal_id, title, `${day}%`);
    if (existing) return true;
  }

  const existing2 = db.prepare(`
    SELECT diary_id FROM diaries
    WHERE gal_id = ? AND title = ? AND source != 'cityheaven'
    LIMIT 1
  `).get(gal_id, title);
  return !!existing2;
}

function buildChGirlMaps(db) {
  const girlMap = new Map();
  const girlNameMap = new Map();
  const girls = db.prepare("SELECT gal_id, name, shop, cityheaven_url, created_at FROM girls WHERE gal_id IS NOT NULL ORDER BY datetime(created_at) DESC").all();
  for (const g of girls) {
    if (g.cityheaven_url) {
      const m = g.cityheaven_url.match(/girlid-(\d+)/);
      if (m && !girlMap.has(m[1])) girlMap.set(m[1], g.gal_id);
    }
    const key = `${g.shop}::${normalizeName(g.name)}`;
    if (!girlNameMap.has(key)) girlNameMap.set(key, g.gal_id);
  }
  return { girlMap, girlNameMap };
}

function pendingLimitedDiaries(db) {
  return db.prepare(`
    SELECT diary_id, diary_url, girl_name, title
    FROM diaries
    WHERE source = 'cityheaven' AND is_limited = 1 AND (content IS NULL OR content = '')
    ORDER BY posted_at DESC
  `).all();
}

function isUnlockedLimitedContent(content) {
  return Boolean(content && !/マイガール限定の日記/.test(content));
}

function escapeLike(s) {
  return String(s).replace(/[%_]/g, c => '\\' + c);
}

function reviewNameVariants(name) {
  if (!name) return [];
  const cleaned = String(name).replace(/\[\d+歳\]/g, '').trim();
  const variants = new Set();
  for (const part of cleaned.split('/').map(p => p.trim()).filter(Boolean)) {
    variants.add(part);
    const base = part.split('・')[0]?.trim();
    if (base) variants.add(base);
  }
  return [...variants].filter(v => v.length >= 2);
}

async function findGirlByReviewName(db, shopId, reviewName) {
  const variants = reviewNameVariants(reviewName);
  for (const p of variants) {
    const ep = escapeLike(p);
    const g = await db.get(
      `SELECT gal_id FROM girls
       WHERE shop = ? AND gal_id IS NOT NULL AND (
         name = ?
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
       )
       ORDER BY id LIMIT 1`,
      [shopId, p, `${ep}/%`, `%/${ep}`, `%/${ep}・%`, `${ep}・%`]
    );
    if (g) return g;
  }
  return null;
}

function extractReviewLinks(html, shop) {
  const links = new Set();
  const re = new RegExp(`href="(/osaka/A2702/${shop.area}/${shop.slug}/reviews/rv-(\\d+)[^"]*)"`, 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    links.add(`https://www.cityheaven.net/osaka/A2702/${shop.area}/${shop.slug}/reviews/rv-${m[2]}/`);
  }
  return Array.from(links);
}

function between(html, startTag, endTag, fromIdx = 0) {
  const start = html.indexOf(startTag, fromIdx);
  if (start === -1) return null;
  const end = html.indexOf(endTag, start + startTag.length);
  if (end === -1) return null;
  return html.substring(start + startTag.length, end);
}

function stripTags(s) {
  return s ? s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : null;
}

function parseScoreText(text, scores) {
  const scoreM = String(text || '').match(/(.+?)\s+([\d.]+)/);
  if (!scoreM) return;
  const label = scoreM[1];
  const val = parseFloat(scoreM[2]);
  if (label.includes('女の子')) scores.girl = val;
  else if (label.includes('プレイ')) scores.play = val;
  else if (label.includes('料金')) scores.cost = val;
  else if (label.includes('スタッフ')) scores.staff = val;
  else if (label.includes('写真')) scores.photo = val;
}

function parseReview(html) {
  let reviewer = null;
  const reviewerM = html.match(/class="userrank_nickname_shogo"[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>/);
  if (reviewerM) reviewer = stripTags(reviewerM[1]);

  let rating = null;
  const ratingM = html.match(/<span class="total_rate">([\d.]+)<\/span>/);
  if (ratingM) rating = parseFloat(ratingM[1]);

  let title = null;
  const titleM = html.match(/class="review_bold">([\s\S]*?)<\/span>/);
  if (titleM) title = stripTags(titleM[1]);

  let comment = null;
  const commentM = html.match(/<p class="review-item-post">([\s\S]*?)<\/p>/);
  if (commentM) comment = stripTags(commentM[1]);

  let date = null;
  const dateM = html.match(/掲載日：(\d{4})[\/年](\d{2})[\/月](\d{2})/);
  if (dateM) date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;

  let girl_name = null;
  const girlSection = between(html, '遊んだ女の子', '</dl>');
  if (girlSection) {
    const ddM = girlSection.match(/<dd>([\s\S]*?)<\/dd>/);
    if (ddM) girl_name = stripTags(ddM[1]).split('・')[0].split('[')[0].trim();
  }

  let shop_reply = null;
  const replyM = html.match(/<p class="review-item-reply-body">([\s\S]*?)<\/p>/);
  if (replyM) shop_reply = stripTags(replyM[1]);
  if (shop_reply && shop_reply.length < 5) shop_reply = null;

  let reviewId = null;
  const ridM = html.match(/data-review-id="(\d+)"/);
  if (ridM) reviewId = ridM[1];

  const scores = { girl: null, play: null, cost: null, staff: null, photo: null };
  const rateBlock = html.match(/<ul class="review-item-rate">([\s\S]*?)<\/ul>/);
  if (rateBlock) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
    let liM;
    while ((liM = liRegex.exec(rateBlock[1])) !== null) {
      parseScoreText(stripTags(liM[1]).trim(), scores);
    }
  }

  return { reviewer, rating, title, comment, date, girl_name, shop_reply, reviewId, scores };
}

function parseBackfillScores($, el) {
  const scores = { girl: null, play: null, cost: null, staff: null, photo: null };
  el.find('ul.review-item-rate li').each((_, li) => {
    parseScoreText($(li).text().trim(), scores);
  });
  return scores;
}

function reviewSourceUrlFromListItem($, el, shop) {
  const reviewId = el.attr('data-review-id');
  const linkEl = el.find('a[href*="/reviews/rv-"]');
  if (linkEl.length) {
    const href = linkEl.attr('href');
    const rvM = href.match(/\/reviews\/rv-(\d+)/);
    if (rvM) return `https://www.cityheaven.net/osaka/A2702/${shop.area}/${shop.slug}/reviews/rv-${rvM[1]}/`;
  }
  if (reviewId) return `https://www.cityheaven.net/osaka/A2702/${shop.area}/${shop.slug}/reviews/rv-${reviewId}/`;
  return null;
}

module.exports = {
  CH_ORIGIN,
  CH_DIARY_SHOPS,
  CH_REVIEW_SHOPS,
  COOKIE_JSON,
  DEFAULT_UA,
  UA_PC,
  UA_SP,
  DELAY_MS_DIARIES,
  DELAY_MS_LIMITED,
  DELAY_MS_REVIEWS,
  cheerio,
  sleep,
  getArg,
  createChFetcherFromArgs,
  ensureChLogin,
  toCityHeavenAbsoluteUrl,
  normalizeName,
  parseDiaryList,
  isDuplicateDiary,
  buildChGirlMaps,
  pendingLimitedDiaries,
  isUnlockedLimitedContent,
  escapeLike,
  reviewNameVariants,
  findGirlByReviewName,
  extractReviewLinks,
  between,
  stripTags,
  parseReview,
  parseBackfillScores,
  reviewSourceUrlFromListItem,
};
