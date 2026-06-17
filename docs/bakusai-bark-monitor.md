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

The workflow reads that secret and sends one Bark notification when new Bakusai posts are found.

## Duplicate Prevention

GitHub-hosted runners are temporary, so the workflow stores the last seen Bakusai post number in:

```text
.crawler-state/bakusai-monitor.json
```

The first successful run creates this baseline and does not push historical posts. Later runs notify only posts with a higher response number.

To force notifications on the first run, set this environment variable in the workflow:

```text
BARK_NOTIFY_ON_FIRST_RUN: 'true'
```

## Local Run

```bash
npm ci
BARK_API_URL="https://api.day.app/<your-bark-key>" npm run bakusai:bark
```
