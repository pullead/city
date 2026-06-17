'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const DEFAULT_THREAD_URL = 'https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/#tab=0';
const DEFAULT_THREAD_ID = '13315868';
const DEFAULT_THREAD_TITLE = 'Bakusai monitor';
const DEFAULT_STATE_PATH = path.resolve(__dirname, '..', '..', '.crawler-state', 'bakusai-monitor.json');
const DEFAULT_NOTIFICATION_POST_LIMIT = 20;
const DEFAULT_DAY_WINDOW = 4;
const DEFAULT_BARK_BODY_CHAR_LIMIT = 3000;
const DEFAULT_BARK_REQUEST_BYTE_LIMIT = 3800;
const DEFAULT_SPLIT_POST_CHAR_LIMIT = 120;
const DEFAULT_SPLIT_SUMMARY_CHAR_LIMIT = 140;
const DEFAULT_TELEGRAM_MESSAGE_CHAR_LIMIT = 3500;
const DAY_LABELS = [
  { ja: '今日', zh: '今天' },
  { ja: '昨日', zh: '昨天' },
  { ja: '一昨日', zh: '前天' },
  { ja: '3日前', zh: '大前天' },
];

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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateKeyFromDate(date, timeZone = 'Asia/Tokyo') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, dayDelta) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function getRecentDayBuckets(options = {}) {
  const now = options.now || new Date();
  const timeZone = options.timeZone || 'Asia/Tokyo';
  const dayWindow = options.dayWindow || DEFAULT_DAY_WINDOW;
  const todayKey = formatDateKeyFromDate(now, timeZone);

  return Array.from({ length: dayWindow }, (_, index) => ({
    key: shiftDateKey(todayKey, -index),
    ...(DAY_LABELS[index] || { ja: `${index}日前`, zh: `${index}天前` }),
    order: index,
  }));
}

function parsePostDateKey(time, options = {}) {
  const value = String(time || '');
  const full = value.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (full) return `${full[1]}-${pad2(full[2])}-${pad2(full[3])}`;

  const short = value.match(/(?:^|\D)(\d{1,2})[/-](\d{1,2})(?:\D|$)/);
  if (!short) return '';

  const currentYear = formatDateKeyFromDate(options.now || new Date(), options.timeZone || 'Asia/Tokyo').slice(0, 4);
  return `${currentYear}-${pad2(short[1])}-${pad2(short[2])}`;
}

function parsePostTimeLabel(time) {
  const match = String(time || '').match(/(\d{1,2}):(\d{2})/);
  return match ? `${pad2(match[1])}:${match[2]}` : '--:--';
}

function selectRecentDayPosts(posts, options = {}) {
  const buckets = getRecentDayBuckets(options);
  const orderByDate = new Map(buckets.map(bucket => [bucket.key, bucket.order]));

  return [...(posts || [])]
    .map(post => ({ ...post, dateKey: parsePostDateKey(post.time, options) }))
    .filter(post => orderByDate.has(post.dateKey))
    .sort((a, b) => {
      const dayOrder = orderByDate.get(a.dateKey) - orderByDate.get(b.dateKey);
      if (dayOrder !== 0) return dayOrder;
      return (a.num || 0) - (b.num || 0);
    });
}

function cleanSummarySnippet(text) {
  return truncate(
    String(text || '')
      .replace(/>>\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    56,
  );
}

function buildDailySummaryJa(dayPosts, bucket) {
  const posts = [...(dayPosts || [])].sort((a, b) => (a.num || 0) - (b.num || 0));
  if (posts.length === 0) {
    return 'この日の投稿はありませんでした。新しい話題は確認できません。前後の日付の投稿を確認してください。';
  }

  const snippets = posts.map(post => cleanSummarySnippet(post.content)).filter(Boolean);
  const lines = [
    `この日は${posts.length}件の投稿がありました。`,
    snippets[0]
      ? `主な話題は「${snippets[0]}」です。`
      : '主な話題は短い反応や確認が中心です。',
    snippets[1]
      ? `続いて「${snippets[1]}」という内容も見られました。`
      : '追加の具体的な反応は限られています。',
    snippets[2]
      ? `ほかにも「${snippets[2]}」に関する投稿があります。`
      : '全体として、スレッド内で情報交換と感想の共有が続いています。',
  ];

  return lines.join('');
}

async function buildDailySummaries(posts, options = {}) {
  const buckets = getRecentDayBuckets(options);
  const recentPosts = selectRecentDayPosts(posts || [], options);
  const postsByDate = new Map();
  for (const post of recentPosts) {
    if (!postsByDate.has(post.dateKey)) postsByDate.set(post.dateKey, []);
    postsByDate.get(post.dateKey).push(post);
  }

  const summaries = {};
  for (const bucket of buckets) {
    const ja = buildDailySummaryJa(postsByDate.get(bucket.key) || [], bucket);
    let zh;
    try {
      zh = await translateTextJaToZh(ja, options);
    } catch (error) {
      zh = '（中文摘要翻译失败）';
    }
    summaries[bucket.key] = { ja, zh };
  }
  return summaries;
}

function isWithinPushHours(now = new Date(), options = {}) {
  const timeZone = options.timeZone || 'Asia/Tokyo';
  const hourText = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const hour = Number.parseInt(hourText, 10);
  return hour >= 7 && hour <= 23;
}

function createNotificationPlan(posts, previousState, options = {}) {
  const sortedPosts = [...(posts || [])].sort((a, b) => a.num - b.num);
  const recentPosts = selectRecentDayPosts(sortedPosts, options);
  const maxPostNum = sortedPosts.reduce((max, post) => Math.max(max, post.num || 0), 0);
  const threadId = options.threadId || previousState?.threadId || DEFAULT_THREAD_ID;
  const now = options.now || new Date().toISOString();
  const historyPosts = options.notifyHistoryWhenNoNew
    ? recentPosts
    : [];

  if (!previousState || !Number.isFinite(previousState.lastSeenPostNum)) {
    const firstRunPosts = options.notifyOnFirstRun ? recentPosts : [];
    const notificationPosts = firstRunPosts.length > 0 ? firstRunPosts : historyPosts;
    const notificationKind = firstRunPosts.length > 0 ? 'new' : 'history';
    return {
      firstRun: true,
      shouldNotify: notificationPosts.length > 0,
      newPosts: firstRunPosts,
      historyPosts,
      notificationPosts,
      notificationKind,
      nextState: {
        threadId,
        lastSeenPostNum: maxPostNum,
        updatedAt: now,
      },
    };
  }

  const lastSeen = previousState.lastSeenPostNum || 0;
  const newPosts = recentPosts.filter(post => post.num > lastSeen);
  const notificationPosts = newPosts.length > 0 ? recentPosts : historyPosts;
  const notificationKind = newPosts.length > 0 ? 'new' : 'history';

  return {
    firstRun: false,
    shouldNotify: notificationPosts.length > 0,
    newPosts,
    historyPosts,
    notificationPosts,
    notificationKind,
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

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(text, maxBytes) {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return '...'.slice(0, maxBytes);

  let output = '';
  let used = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (used + charBytes > maxBytes - 3) break;
    output += char;
    used += charBytes;
  }
  return `${output}...`;
}

function clampPayloadToByteLimit(payload, maxRequestBytes) {
  if (!Number.isFinite(maxRequestBytes) || maxRequestBytes <= 0) return payload;
  if (jsonByteLength(payload) <= maxRequestBytes) return payload;

  const marker = '\n\n（内容过长，已自动压缩。请点开通知查看原帖。）';
  const payloadWithoutBody = { ...payload, body: '' };
  const fixedBytes = jsonByteLength(payloadWithoutBody);
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const availableBodyBytes = maxRequestBytes - fixedBytes - markerBytes - 16;

  return {
    ...payload,
    body: availableBodyBytes > 0
      ? `${truncateUtf8(payload.body, availableBodyBytes)}${marker}`
      : '内容过长，已自动压缩。请点开通知查看原帖。',
  };
}

function clampPayloadToLimits(payload, maxBodyChars, maxRequestBytes) {
  let nextPayload = payload;
  if (Number.isFinite(maxBodyChars) && maxBodyChars > 0 && nextPayload.body.length > maxBodyChars) {
    nextPayload = {
      ...nextPayload,
      body: truncate(nextPayload.body, maxBodyChars),
    };
  }
  return clampPayloadToByteLimit(nextPayload, maxRequestBytes);
}

function buildBarkPayload({
  threadTitle,
  threadUrl,
  newPosts,
  notificationKind = 'new',
  now,
  timeZone = 'Asia/Tokyo',
  dailySummaries = {},
  includeEmptyDays = true,
  includeDailySummaries = true,
  maxPostChars = 180,
  maxSummaryChars = Infinity,
}) {
  const buckets = getRecentDayBuckets({ now, timeZone });
  const posts = selectRecentDayPosts(newPosts || [], { now, timeZone });
  const postsByDate = new Map();
  for (const post of posts) {
    if (!postsByDate.has(post.dateKey)) postsByDate.set(post.dateKey, []);
    postsByDate.get(post.dateKey).push(post);
  }

  const lines = [
    notificationKind === 'history'
      ? '📚 新着なし / 暂无新帖：直近4日分を再送します'
      : '🆕 新着あり / 有新帖：直近4日分をまとめて送信します',
    '',
  ];

  for (const bucket of buckets) {
    const dayPosts = postsByDate.get(bucket.key) || [];
    if (!includeEmptyDays && dayPosts.length === 0) continue;

    lines.push(`📅 ${bucket.ja} / ${bucket.zh} ${bucket.key}`);
    lines.push('━━━━━━━━━━━━');
    if (includeDailySummaries) {
      const summary = dailySummaries[bucket.key] || {
        ja: buildDailySummaryJa(dayPosts, bucket),
        zh: '（中文摘要不可用）',
      };
      lines.push('📝 まとめ / 摘要');
      lines.push(truncate(summary.ja, maxSummaryChars));
      lines.push(truncate(summary.zh, maxSummaryChars));
      lines.push('');
    }
    if (dayPosts.length === 0) {
      lines.push('投稿なし');
      lines.push('无帖子');
    } else {
      dayPosts.forEach((post, index) => {
        if (index > 0) lines.push('');
        lines.push(`🧾 #${post.num} · ${parsePostTimeLabel(post.time)}`);
        lines.push(truncate(post.content, maxPostChars));
        lines.push(truncate(post.contentZh || '（中文翻译不可用）', maxPostChars));
      });
    }
    lines.push('');
  }

  return {
    title: notificationKind === 'history'
      ? `📚 ${threadTitle || DEFAULT_THREAD_TITLE}｜4日分まとめ｜${posts.length}件`
      : `🆕 ${threadTitle || DEFAULT_THREAD_TITLE}｜4日分まとめ｜${posts.length}件`,
    body: lines.join('\n').trim(),
    url: buildPageUrl(threadUrl || DEFAULT_THREAD_URL, 1),
    group: 'bakusai-monitor',
  };
}

function buildBarkPayloads(options = {}) {
  const maxBodyChars = options.maxBodyChars || DEFAULT_BARK_BODY_CHAR_LIMIT;
  const maxRequestBytes = options.maxRequestBytes || DEFAULT_BARK_REQUEST_BYTE_LIMIT;
  const posts = selectRecentDayPosts(options.newPosts || [], options);

  if (posts.length === 0) {
    return [clampPayloadToLimits(buildBarkPayload(options), maxBodyChars, maxRequestBytes)];
  }

  const payloads = [];
  let currentPosts = [];

  const makeSplitPayload = (chunkPosts, compactness = 0) => {
    const postLimit = compactness >= 2 ? 40 : compactness >= 1 ? 80 : (options.maxPostChars || DEFAULT_SPLIT_POST_CHAR_LIMIT);
    const summaryLimit = compactness >= 1 ? 80 : (options.maxSummaryChars || DEFAULT_SPLIT_SUMMARY_CHAR_LIMIT);
    return buildBarkPayload({
      ...options,
      newPosts: chunkPosts,
      includeEmptyDays: false,
      maxPostChars: postLimit,
      maxSummaryChars: summaryLimit,
    });
  };

  const fits = payload => (
    payload.body.length <= maxBodyChars
    && jsonByteLength(payload) <= maxRequestBytes
  );

  const fitPayload = (chunkPosts) => {
    for (const compactness of [0, 1, 2]) {
      const payload = makeSplitPayload(chunkPosts, compactness);
      if (fits(payload)) return payload;
    }
    return clampPayloadToLimits(makeSplitPayload(chunkPosts, 2), maxBodyChars, maxRequestBytes);
  };

  for (const post of posts) {
    const candidatePosts = [...currentPosts, post];
    const candidatePayload = makeSplitPayload(candidatePosts);

    if (currentPosts.length > 0 && !fits(candidatePayload)) {
      payloads.push(fitPayload(currentPosts));
      currentPosts = [post];
    } else {
      currentPosts = candidatePosts;
    }
  }

  if (currentPosts.length > 0) {
    payloads.push(fitPayload(currentPosts));
  }

  if (payloads.length <= 1) return payloads;

  return payloads.map((payload, index) => clampPayloadToLimits({
    ...payload,
    title: `${payload.title} (${index + 1}/${payloads.length})`,
  }, maxBodyChars, maxRequestBytes));
}

function splitTelegramText(text, maxChars = DEFAULT_TELEGRAM_MESSAGE_CHAR_LIMIT) {
  const value = String(text || '').trim();
  const limit = Math.max(1, maxChars);
  if (!value) return [];
  if (value.length <= limit) return [value];

  const chunks = [];
  let remaining = value;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf('\n', limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildTelegramMessages(options = {}) {
  const maxChars = options.maxMessageChars || DEFAULT_TELEGRAM_MESSAGE_CHAR_LIMIT;
  const payloads = buildBarkPayloads({
    ...options,
    maxBodyChars: Math.max(500, maxChars - 300),
    maxRequestBytes: Number.MAX_SAFE_INTEGER,
  });
  const messages = [];

  for (const payload of payloads) {
    const text = [
      payload.title,
      '',
      payload.body,
      '',
      payload.url,
    ].filter(line => line !== '').join('\n');
    messages.push(...splitTelegramText(text, maxChars));
  }

  if (messages.length <= 1) return messages;

  const numberedMessages = [];
  for (let index = 0; index < messages.length; index++) {
    const prefix = `[${index + 1}/${messages.length}]\n`;
    const chunks = splitTelegramText(messages[index], Math.max(1, maxChars - prefix.length));
    for (const chunk of chunks) numberedMessages.push(`${prefix}${chunk}`);
  }
  return numberedMessages;
}

function parseGoogleTranslateResponse(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  return payload[0]
    .filter(part => Array.isArray(part) && typeof part[0] === 'string')
    .map(part => part[0])
    .join('');
}

async function translateTextJaToZh(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return '';

  const fetchImpl = options.fetchImpl || fetch;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=zh-CN&dt=t&q=${encodeURIComponent(value)}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': options.ua || 'Mozilla/5.0',
    },
  });
  if (!response.ok) {
    throw new Error(`translation failed: HTTP ${response.status}`);
  }
  return parseGoogleTranslateResponse(await response.json());
}

async function translatePostsToChinese(posts, options = {}) {
  const translated = [];
  for (const post of posts || []) {
    let contentZh = post.contentZh;
    if (!contentZh) {
      try {
        contentZh = await translateTextJaToZh(post.content, options);
      } catch (error) {
        contentZh = '（中文翻译失败，显示日文原文）';
      }
    }
    translated.push({ ...post, contentZh });
  }
  return translated;
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

async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  const token = String(botToken || '').trim();
  const targetChatId = String(chatId || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required when posts are found.');
  if (!targetChatId) throw new Error('TELEGRAM_CHAT_ID is required when posts are found.');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: targetChatId,
      text,
      disable_web_page_preview: options.disableWebPagePreview ?? false,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw new Error(`Telegram push failed: HTTP ${response.status} ${responseText}`.trim());
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
  DEFAULT_NOTIFICATION_POST_LIMIT,
  DEFAULT_BARK_REQUEST_BYTE_LIMIT,
  DEFAULT_TELEGRAM_MESSAGE_CHAR_LIMIT,
  buildBarkPayload,
  buildBarkPayloads,
  buildDailySummaries,
  buildPageUrl,
  buildTelegramMessages,
  jsonByteLength,
  createNotificationPlan,
  isWithinPushHours,
  loadState,
  normalizeBarkEndpoint,
  parsePosts,
  saveState,
  sendBarkNotification,
  sendTelegramMessage,
  splitTelegramText,
  translatePostsToChinese,
  translateTextJaToZh,
};
