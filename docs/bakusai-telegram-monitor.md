# Bakusai Telegram Monitor

This repository includes a GitHub Actions workflow that monitors this Bakusai thread once per hour and pushes updates to Telegram:

```text
https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/#tab=0
```

## Telegram Secrets

Do not commit the Telegram bot token or chat ID into the repository.

Create these GitHub Actions repository secrets:

```text
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
```

The workflow reads those secrets and sends Telegram messages when it runs.

When new Bakusai posts are found, the notification contains all posts from today, yesterday, two days ago, and three days ago, in that order. When there are no new posts, the workflow still sends all posts from the same four-day window.

Each post is formatted with the Japanese original first and the Chinese translation on the next line.

Each day section starts with a short Japanese discussion summary and its Chinese translation.

## Duplicate Prevention

GitHub-hosted runners are temporary, so the workflow stores the last seen Bakusai post number in:

```text
.crawler-state/bakusai-monitor.json
```

The workflow stores the last seen response number so it can tell new posts from historical posts. It still sends historical posts when there is nothing new.

The workflow fetches enough pages to cover the four-day window:

```text
BAKUSAI_MAX_PAGES: '30'
TG_TRANSLATE_TO_ZH: 'true'
TG_ENFORCE_PUSH_HOURS: 'true'
TG_MAX_MESSAGE_CHARS: '3500'
```

Pushes are sent hourly from 07:00 through 23:00 Japan time. Outside that window, the workflow exits without sending Telegram messages.
Large four-day digests are split into multiple Telegram messages to avoid Telegram's message length limit.

## Local Run

```bash
npm ci
TELEGRAM_BOT_TOKEN="<your-bot-token>" TELEGRAM_CHAT_ID="<your-chat-id>" npm run bakusai:tg
```
