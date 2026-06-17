# CityHeaven / DTO / 爆サイ 爬蟲包

這包是從 OpenClaw workspace 抽出來的 standalone 版本，只包含爬蟲程式與本地 SQLite schema。
不包含原本的 `cast.db`、cookie、token、Discord 資料或任何私人資料。

## 需求

- Node.js 20+
- npm
- macOS / Linux / WSL
- `curl`（CityHeaven HTTP 抓取會用到）
- DTO 爬蟲需要 Playwright Chromium

## 安裝

```bash
npm install
npx playwright install chromium
npm run init-db
```

資料庫預設會建立在：

```text
data/crawlers.sqlite
```

如果要指定 DB 位置：

```bash
CRAWLER_DB_PATH=/path/to/crawlers.sqlite npm run init-db
```

## 快速執行

### CityHeaven 口コミ

```bash
npm run ch:reviews
npm run ch:reviews -- --shop muteki
npm run ch:reviews -- --shop platleg
```

如果普通 curl 被年齡確認頁擋住，可以先試：

```bash
npm run ch:reviews -- --scrapling-fetch --scrapling-mode fallback
```

Scrapling 是 Python 套件，可選安裝：

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
SCRAPLING_PYTHON="$PWD/.venv/bin/python" npm run ch:reviews -- --scrapling-fetch
```

### DTO 店家在籍 / 新人 / 出勤

```bash
npm run dto:shop -- --shop 37142
npm run dto:shop -- --shop 25536
npm run dto:shop -- --shop 37142 --newface-only
npm run dto:shop -- --shop 37142 --schedule-only
npm run dto:shop -- --shop 37142 --gal-id 5255646
```

### DTO 口コミ

```bash
npm run dto:reviews
npm run dto:reviews -- --shop muteki
npm run dto:reviews -- --shop platleg
```

### 爆サイ thread

```bash
npm run bakusai
npm run bakusai -- --thread 12991152
npm run bakusai -- --shop "Muteki Platinum"
npm run bakusai -- --full
```

`--full` 會從設定的 thread 頁面掃到比較深，跑比較久；平常增量更新不用加。

## 要改店家或 thread 的地方

目前保留原本兩家店的設定，朋友要爬別家時改這幾段：

- CityHeaven 口コミ：`scripts/lib/ch-scrape-core.js` 的 `CH_REVIEW_SHOPS`
- DTO 在籍 / 新人 / 出勤：`scripts/scrape-dto-shop.js` 的 `SHOPS`
- DTO 口コミ：`scripts/scrape-dto-reviews.js` 的 `SHOPS`
- 爆サイ：`scripts/scrape-bakusai.js` 的 `THREADS`

CityHeaven shop 設定範例：

```js
{
  id: 'shop-name',
  slug: 'cityheaven_slug',
  area: 'A270202',
  base: 'https://www.cityheaven.net/osaka/A2702/A270202/cityheaven_slug/reviews/',
}
```

DTO shop 設定範例：

```js
'37142': {
  name: 'Muteki Platinum',
  ch_url: 'https://www.cityheaven.net/osaka/A2702/A270202/muteki_platinum/reviews/'
}
```

爆サイ thread 設定範例：

```js
{
  thread_id: '12991152',
  shop: 'Muteki Platinum',
  title: '日本橋 Muteki Platinum ①',
  base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12991152/ttgid=104/p={PAGE}'
}
```

## DB schema

主要表：

- `girls`：DTO 個人資料、價格、出勤、URL、gal_id
- `reviews`：CityHeaven / DTO 口コミ
- `bakusai_posts`：爆サイレス

可以直接用 SQLite 查：

```bash
sqlite3 data/crawlers.sqlite '.tables'
sqlite3 data/crawlers.sqlite 'select shop, count(*) from reviews group by shop;'
sqlite3 data/crawlers.sqlite 'select thread_title, count(*) from bakusai_posts group by thread_title;'
```

匯出 CSV：

```bash
sqlite3 -header -csv data/crawlers.sqlite 'select * from reviews;' > reviews.csv
sqlite3 -header -csv data/crawlers.sqlite 'select * from girls;' > girls.csv
sqlite3 -header -csv data/crawlers.sqlite 'select * from bakusai_posts;' > bakusai_posts.csv
```

## 常見錯誤

### `Cannot find module`

先跑：

```bash
npm install
```

### Playwright 找不到 browser

```bash
npx playwright install chromium
```

Linux server 如果缺系統套件：

```bash
npx playwright install --with-deps chromium
```

### CityHeaven 只抓到年齡確認頁

先試 Scrapling fallback：

```bash
npm run ch:reviews -- --scrapling-fetch --scrapling-mode fallback
```

如果有自己的 curl cookie，可以放在：

```text
state/ch-cookies-curl.txt
```

或指定：

```bash
CH_COOKIE_PATH=/path/to/ch-cookies-curl.txt npm run ch:reviews
```

### SQLite DB 想重建

刪掉 `data/crawlers.sqlite` 後重跑：

```bash
npm run init-db
```

## 注意

- 爬蟲請放慢頻率，不要高併發打站。
- 網站 HTML 結構改版時，selector 可能需要更新。
- 這包只做資料抓取與本地保存，不含分析、Discord、OpenClaw MCP、embedding、搜尋服務。
