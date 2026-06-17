'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DEFAULT_THREAD_URL = 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/#tab=0';
const DEFAULT_THREAD_ID = '13315868';
const DEFAULT_THREAD_TITLE = 'Bakusai monitor';
const DEFAULT_STATE_PATH = path.resolve(__dirname, '..', '..', '.crawler-state', 'bakusai-monitor.json');

function decodeEntities(text) {
  return String(text || '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parsePosts(html) {
  const posts = [];
  const $ = cheerio.load(html || '');

  let articles = $('dl#res_list .res_list_article');
  if (articles.length === 0) {
    articles = $('[id^="res"]').filter((_, el) => /^res\d+$/.test($(el).attr('id') || ''));
  }

  articles.each((_, el) => {
    const $el = $(el);
    const idAttr = $el.attr('id') || '';
    const idMatch = idAttr.match(/^res(\d+)$/);
    let num = idMatch ? Number.parseInt(idMatch[1], 10) : 0;

    if (!num) {
      const numbText = $el.find('.resnumb a').first().text();
      const numbMatch = numbText.match(/#?(\d+)/);
      if (numbMatch) num = Number.parseInt(numbMatch[1], 10);
    }
    if (!num) return;

    const time = $el.find('[itemprop="commentTime"]').text().trim() || null;
    const content = decodeEntities(
      $el.find('.resbody[itemprop="commentText"], .res_body').first().text().trim(),
    );
    if (!content) return;

    const quoteMatches = content.match(/>>(\d+)/g) || [];
    const quotes = quoteMatches.map(match => Number.parseInt(match.slice(2), 10));
    const author = $el.find('.name span').first().text().trim() || '匿名';

    posts.push({ num, time, content, author, quotes });
  });

  posts.sort((a, b) => a.num - b.num);
  return posts;
}

function stripUrlNoise(rawUrl) {
  return String(rawUrl || '').trim().split('#')[0].split('?')[0];
}

function buildPageUrl(rawUrl, page) {
  const clean = stripUrlNoise(rawUrl || DEFAULT_THREAD_URL).replace(/\/+$/, '');
  const withoutPage = clean.replace(/\/p=\d+$/, '');
  if (!page || page <= 1) return `${withoutPage}/`;
  return `${withoutPage}/p=${page}/`;
}

function createNotificationPlan(posts, previousState, options = {}) {
  const sortedPosts = [...(posts || [])].sort((a, b) => a.num - b.num);
  const maxPostNum = sortedPosts.reduce((max, post) => Math.max(max, post.num || 0), 0);
  const threadId = options.threadId || previousState?.threadId || DEFAULT_THREAD_ID;
  const now = options.now || new Date().toISOString();

  if (!previousState || !Number.isFinite(previousState.lastSeenPostNum)) {
    const firstRunPosts = options.notifyOnFirstRun ? sortedPosts : [];
    return {
      firstRun: true,
      shouldNotify: firstRunPosts.length > 0,
      newPosts: firstRunPosts,
      nextState: {
        threadId,
        lastSeenPostNum: maxPostNum,
        updatedAt: now,
      },
    };
  }

  const lastSeen = previousState.lastSeenPostNum || 0;
  const newPosts = sortedPosts.filter(post => post.num > lastSeen);

  return {
    firstRun: false,
    shouldNotify: newPosts.length > 0,
    newPosts,
    nextState: {
      ...previousState,
      threadId,
      lastSeenPostNum: Math.max(lastSeen, maxPostNum),
      updatedAt: now,
    },
  };
}

function truncate(text, maxLength) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function buildBarkPayload({ threadTitle, threadUrl, newPosts }) {
  const posts = [...(newPosts || [])].sort((a, b) => b.num - a.num);
  const visiblePosts = posts.slice(0, 3);
  const lines = visiblePosts.map(post => {
    const time = post.time ? ` ${post.time}` : '';
    return `#${post.num}${time}\n${truncate(post.content, 180)}`;
  });
  if (posts.length > visiblePosts.length) {
    lines.push(`...and ${posts.length - visiblePosts.length} more`);
  }

  return {
    title: `${threadTitle || DEFAULT_THREAD_TITLE}: ${posts.length} new posts`,
    body: lines.join('\n\n'),
    url: buildPageUrl(threadUrl || DEFAULT_THREAD_URL, 1),
    group: 'bakusai-monitor',
  };
}

function normalizeBarkEndpoint(endpoint) {
  const value = String(endpoint || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

async function sendBarkNotification(endpoint, payload) {
  const url = normalizeBarkEndpoint(endpoint);
  if (!url) throw new Error('BARK_API_URL is required when new posts are found.');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bark push failed: HTTP ${response.status} ${text}`.trim());
  }

  return response.json().catch(() => ({}));
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function saveState(state, statePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

module.exports = {
  DEFAULT_STATE_PATH,
  DEFAULT_THREAD_ID,
  DEFAULT_THREAD_TITLE,
  DEFAULT_THREAD_URL,
  buildBarkPayload,
  buildPageUrl,
  createNotificationPlan,
  loadState,
  normalizeBarkEndpoint,
  parsePosts,
  saveState,
  sendBarkNotification,
};
