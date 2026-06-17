# Bakusai Bark Monitor

This repository includes a GitHub Actions workflow that monitors this Bakusai thread once per hour:

```text
https://bakusai.com/thr_res/acode=18/ctgid=103/bid=436/tid=13315868/tp=1/#tab=0
```

## Bark Secret

Do not commit the Bark device key or full Bark API URL into the repository.

Create a GitHub Actions repository secret named `BARK_API_URL` with this value:

```text
https://api.day.app/<your-bark-key>
```

The workflow reads that secret and sends one Bark notification on every run.

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
BARK_TRANSLATE_TO_ZH: 'true'
BARK_ENFORCE_PUSH_HOURS: 'true'
```

Pushes are sent hourly from 07:00 through 23:00 Japan time. Outside that window, the workflow exits without sending Bark notifications.

## Local Run

```bash
npm ci
BARK_API_URL="https://api.day.app/<your-bark-key>" npm run bakusai:bark
```
