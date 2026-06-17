#!/usr/bin/env node
'use strict';

const {
  DEFAULT_STATE_PATH,
  DEFAULT_THREAD_ID,
  DEFAULT_THREAD_TITLE,
  DEFAULT_THREAD_URL,
  buildDailySummaries,
  buildPageUrl,
  buildTelegramMessages,
  createNotificationPlan,
  isWithinPushHours,
  loadState,
  parsePosts,
  saveState,
  sendTelegramMessage,
  translatePostsToChinese,
} = require('./lib/bakusai-monitor');
const { fetchText } = require('./lib/http-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

function envInt(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

async function fetchPosts(threadUrl, maxPages) {
  const postsByNum = new Map();

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = buildPageUrl(threadUrl, page);
    console.log(`[bakusai] fetching page ${page}: ${pageUrl}`);
    const html = await fetchText(pageUrl, {
      ua: UA,
      timeout: envInt('BAKUSAI_TIMEOUT_MS', 20000),
      retries: envInt('BAKUSAI_RETRIES', 1),
      throwOnHttpError: false,
    });

    const posts = parsePosts(html);
    console.log(`[bakusai] page ${page}: ${posts.length} posts`);
    for (const post of posts) postsByNum.set(post.num, post);
    if (posts.length === 0) break;
  }

  return [...postsByNum.values()].sort((a, b) => a.num - b.num);
}

async function main() {
  const enforcePushHours = envFlag('TG_ENFORCE_PUSH_HOURS', true);
  if (enforcePushHours && !isWithinPushHours(new Date())) {
    console.log('[tg] outside push hours in Asia/Tokyo; skipping silently');
    return;
  }

  const threadUrl = process.env.BAKUSAI_THREAD_URL || DEFAULT_THREAD_URL;
  const threadId = process.env.BAKUSAI_THREAD_ID || DEFAULT_THREAD_ID;
  const threadTitle = process.env.BAKUSAI_THREAD_TITLE || DEFAULT_THREAD_TITLE;
  const statePath = process.env.BAKUSAI_STATE_PATH || DEFAULT_STATE_PATH;
  const maxPages = envInt('BAKUSAI_MAX_PAGES', 30);
  const notifyOnFirstRun = envFlag('TG_NOTIFY_ON_FIRST_RUN', false);
  const notifyHistoryWhenNoNew = envFlag('TG_NOTIFY_HISTORY_WHEN_NO_NEW', true);
  const translateToChinese = envFlag('TG_TRANSLATE_TO_ZH', true);
  const maxMessageChars = envInt('TG_MAX_MESSAGE_CHARS', 3500);

  const posts = await fetchPosts(threadUrl, maxPages);
  if (posts.length === 0) {
    throw new Error('No Bakusai posts were parsed from the monitored page.');
  }

  const previousState = loadState(statePath);
  const plan = createNotificationPlan(posts, previousState, {
    threadId,
    notifyOnFirstRun,
    notifyHistoryWhenNoNew,
  });

  console.log(`[bakusai] firstRun=${plan.firstRun} newPosts=${plan.newPosts.length} notificationKind=${plan.notificationKind} notificationPosts=${plan.notificationPosts.length} lastSeen=${plan.nextState.lastSeenPostNum}`);

  if (plan.shouldNotify) {
    const dailySummaries = translateToChinese
      ? await buildDailySummaries(plan.notificationPosts)
      : {};
    const notificationPosts = translateToChinese
      ? await translatePostsToChinese(plan.notificationPosts)
      : plan.notificationPosts;
    const messages = buildTelegramMessages({
      threadTitle,
      threadUrl,
      newPosts: notificationPosts,
      notificationKind: plan.notificationKind,
      dailySummaries,
      maxMessageChars,
    });

    for (let i = 0; i < messages.length; i++) {
      console.log(`[tg] sending message ${i + 1}/${messages.length}: chars=${messages[i].length}`);
      await sendTelegramMessage(
        process.env.TELEGRAM_BOT_TOKEN,
        process.env.TELEGRAM_CHAT_ID,
        messages[i],
      );
      console.log(`[tg] message sent (${i + 1}/${messages.length})`);
    }
  } else if (plan.firstRun) {
    console.log('[tg] first run baseline created; no posts pushed');
  } else {
    console.log('[tg] no new posts');
  }

  saveState(plan.nextState, statePath);
  console.log(`[state] saved ${statePath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('FATAL:', error.message);
    process.exit(1);
  });
}

module.exports = {
  fetchPosts,
};
