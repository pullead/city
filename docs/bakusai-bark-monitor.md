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

When new Bakusai posts are found, the notification contains the new posts. When there are no new posts, the notification contains the latest historical posts from the thread.

## Duplicate Prevention

GitHub-hosted runners are temporary, so the workflow stores the last seen Bakusai post number in:

```text
.crawler-state/bakusai-monitor.json
```

The workflow stores the last seen response number so it can tell new posts from historical posts. It still sends historical posts when there is nothing new.

The number of historical posts is controlled by this workflow environment variable:

```text
BARK_HISTORY_POST_LIMIT: '3'
```

## Local Run

```bash
npm ci
BARK_API_URL="https://api.day.app/<your-bark-key>" npm run bakusai:bark
```
