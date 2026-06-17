#!/usr/bin/env node
'use strict';

const {
  GIRLS,
  buildGirlsDigestMessage,
  collectAllGirlDigests,
  sendGirlsDigestToTelegram,
  splitGirlsDigestMessage,
} = require('./lib/girl-digest');

function envInt(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

async function main() {
  const maxMessageChars = envInt('TG_GIRLS_MAX_MESSAGE_CHARS', 3500);
  const dryRun = /^(1|true|yes|on)$/i.test(process.env.TG_GIRLS_DRY_RUN || '');

  console.log(`[girls] collecting ${GIRLS.length} girl digests`);

  if (dryRun) {
    const digests = await collectAllGirlDigests(GIRLS);
    const message = buildGirlsDigestMessage(digests);
    const chunks = splitGirlsDigestMessage(message, maxMessageChars);
    console.log(`[girls] dryRun chunks=${chunks.length}`);
    chunks.forEach((chunk, index) => {
      console.log(`\n[girls] chunk ${index + 1}/${chunks.length} chars=${chunk.length}`);
      console.log(chunk);
    });
    return;
  }

  const result = await sendGirlsDigestToTelegram({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    maxMessageChars,
  });
  console.log(`[girls] sent ${result.sent} Telegram message(s)`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('FATAL:', error.message);
    process.exit(1);
  });
}
