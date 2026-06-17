/**
 * CityHeaven 評論爬蟲 v4（共用）
 * 純 HTTP (curl) + HTML 解析，不需要 Playwright
 * 使用 PC UA（SP mode 缺少 userrank_box）
 * DOM 結構確認於 2026-03-16
 *
 * Usage:
 *   node scripts/scrape-cityheaven-v4.js                    # 兩家都爬
 *   node scripts/scrape-cityheaven-v4.js --shop muteki      # 只爬無敵白金
 *   node scripts/scrape-cityheaven-v4.js --shop platleg     # 只爬プラレジ
 *
 * 欄位對應：
 *   reviewer    → .userrank_nickname_shogo a
 *   rating      → .total_rate
 *   title       → .review-item-title .review_bold
 *   comment     → p.review-item-post
 *   date        → p.review-item-post-date
 *   girl_name   → 遊んだ女の子 の dd
 *   reply       → p.review-item-reply-body
 */

const { req, DB_PATH, ensureSchema } = require('./lib/db');
const sqlite3 = req('sqlite3');
const { open } = req('sqlite');
const {
  CH_REVIEW_SHOPS,
  DELAY_MS_REVIEWS,
  UA_PC,
  UA_SP,
  cheerio,
  createChFetcherFromArgs,
  extractReviewLinks,
  findGirlByReviewName,
  parseBackfillScores,
  parseReview,
  reviewSourceUrlFromListItem,
  sleep,
} = require('./lib/ch-scrape-core');

const args = process.argv.slice(2);
const shopFilter = (() => { const i = args.indexOf('--shop'); return i !== -1 ? args[i+1] : null; })();

const fetchWarnings = [];
const fetchersByUa = new Map();

function fetchHtml(url, ua) {
  if (!fetchersByUa.has(ua)) {
    fetchersByUa.set(ua, createChFetcherFromArgs(args, {
      ua,
      defaultTimeout: 15,
      warnings: fetchWarnings,
      logger: (msg) => console.error(`  ${msg}`),
    }).fetcher);
  }
  return fetchersByUa.get(ua).fetch(url) || null;
}

async function scrapeShop(db, shop) {
  console.log(`\n[${shop.id}] === CityHeaven v4 (PC mode) ===`);

  // STEP 1: 收集評論連結（最新在前，碰到全已存在就停）
  console.log(`[${shop.id}] STEP 1: Collect links...`);
  const allLinks = new Set();
  let pageNum = 1;
  let consecutiveAllExist = 0;

  // 先取得 DB 已有的 source_url
  const existingUrls = new Set();
  const existingRows = await db.all("SELECT source_url FROM reviews WHERE source='cityheaven' AND source_url LIKE ?", [`%${shop.slug}%`]);
  existingRows.forEach(r => existingUrls.add(r.source_url));
  console.log(`[${shop.id}] DB existing: ${existingUrls.size} links`);

  while (true) {
    const url = pageNum === 1
      ? `${shop.base}?pcmode=sp`
      : `${shop.base}${pageNum}/?pcmode=sp`;
    const html = fetchHtml(url, UA_SP);
    if (!html) { console.log(`  Page ${pageNum}: fetch failed`); break; }

    const links = extractReviewLinks(html, shop);
    if (links.length === 0) {
      console.log(`  Page ${pageNum}: no links, stop`);
      break;
    }

    let newOnPage = 0;
    links.forEach(l => { if (!allLinks.has(l)) { allLinks.add(l); if (!existingUrls.has(l)) newOnPage++; } });
    console.log(`  Page ${pageNum}: +${links.length} (total: ${allLinks.size}, new: ${newOnPage})`);

    // 連續 2 頁沒有新連結就停
    if (newOnPage === 0) {
      consecutiveAllExist++;
      if (consecutiveAllExist >= 2) {
        console.log(`[${shop.id}] 2 pages all existing, stopping link collection.`);
        break;
      }
    } else {
      consecutiveAllExist = 0;
    }

    pageNum++;
    if (pageNum > 30) break;
    await sleep(300);
  }

  console.log(`[${shop.id}] Total links: ${allLinks.size}`);
  if (allLinks.size === 0) {
    console.log(`[${shop.id}] ERROR: no links found`);
    return { scraped: 0, failed: 0, skipped: 0 };
  }

  // STEP 2: 逐個爬取
  console.log(`[${shop.id}] STEP 2: Scrape details...`);
  const reviewArray = Array.from(allLinks);
  let scraped = 0, failed = 0, skipped = 0;

  for (let i = 0; i < reviewArray.length; i++) {
    const url = reviewArray[i];

    const exists = await db.get('SELECT id FROM reviews WHERE source_url=?', [url]);
    if (exists) { skipped++; continue; }

    const html = fetchHtml(url, UA_PC);
    if (!html) { failed++; continue; }

    const r = parseReview(html);

    if (!r.comment || r.comment.length < 10) {
      console.log(`  FAIL (no comment): ${url}`);
      failed++;
      continue;
    }

    try {
      await db.run(
        `INSERT OR IGNORE INTO reviews (girl_name, reviewer, title, comment, rating_overall, rating_looks, rating_play, rating_cost, rating_photo, rating_staff, date, shop, shop_reply, source, source_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cityheaven', ?, datetime('now'))`,
        [r.girl_name, r.reviewer, r.title, r.comment, r.rating, r.scores.girl, r.scores.play, r.scores.cost, r.scores.photo, r.scores.staff, r.date, shop.id, r.shop_reply, url]
      );
      scraped++;

      // 回填既有口コミ缺少的分項評分（source_url 已存在但 rating_looks 為 NULL）
      if (r.scores.girl !== null) {
        await db.run(
          `UPDATE reviews SET rating_looks=?, rating_play=?, rating_cost=?, rating_photo=?, rating_staff=?
           WHERE source_url=? AND rating_looks IS NULL`,
          [r.scores.girl, r.scores.play, r.scores.cost, r.scores.photo, r.scores.staff, url]
        );
      }

      // 回填 gal_id（名前から girls 表検索）
      if (r.girl_name) {
        const g = await findGirlByReviewName(db, shop.id, r.girl_name);
        if (g) {
          await db.run('UPDATE reviews SET gal_id=? WHERE source_url=? AND gal_id IS NULL', [g.gal_id, url]);
        }
      }
    } catch (e) {
      console.error(`  DB ERROR: ${e.message}`);
      failed++;
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  [${shop.id}] Progress: ${i + 1}/${reviewArray.length} (ok:${scraped} fail:${failed})`);
    }

    await sleep(DELAY_MS_REVIEWS);
  }

  console.log(`[${shop.id}] Scraped: ${scraped} | Failed: ${failed} | Skipped: ${skipped}`);
  return { scraped, failed, skipped };
}

// --- 回填模式：用列表頁批量更新分項評分 ---
async function backfillScores(db, shop) {
  const needBackfill = await db.get(
    "SELECT COUNT(*) as c FROM reviews WHERE source='cityheaven' AND source_url LIKE ? AND rating_looks IS NULL",
    [`%${shop.slug}%`]
  );
  if (needBackfill.c === 0) {
    console.log(`[${shop.id}] No backfill needed`);
    return 0;
  }
  console.log(`[${shop.id}] Backfill: ${needBackfill.c} reviews missing scores`);

  let updated = 0;
  let pageNum = 1;
  let noMoreUpdates = 0;

  while (pageNum <= 100) {
    const url = pageNum === 1 ? shop.base : `${shop.base}${pageNum}/`;
    const html = fetchHtml(url, UA_PC);
    if (!html) break;

    const $ = cheerio.load(html);
    const items = $('li.review-item');
    if (items.length === 0) break;

    let pageUpdated = 0;
    for (let i = 0; i < items.length; i++) {
      const el = items.eq(i);
      const sourceUrl = reviewSourceUrlFromListItem($, el, shop);
      if (!sourceUrl) continue;

      // 抽取分項評分
      const scores = parseBackfillScores($, el);

      if (scores.girl === null) continue;

      const result = await db.run(
        `UPDATE reviews SET rating_looks=?, rating_play=?, rating_cost=?, rating_photo=?, rating_staff=?
         WHERE source_url=? AND rating_looks IS NULL`,
        [scores.girl, scores.play, scores.cost, scores.photo, scores.staff, sourceUrl]
      );
      if (result.changes > 0) { updated++; pageUpdated++; }
    }

    console.log(`  Page ${pageNum}: ${items.length} items, ${pageUpdated} updated (total: ${updated}/${needBackfill.c})`);

    if (pageUpdated === 0) {
      noMoreUpdates++;
      if (noMoreUpdates >= 5) break; // 連續 5 頁沒更新就停（中間可能有已回填的區間）
    } else {
      noMoreUpdates = 0;
    }

    if (updated >= needBackfill.c) break;
    pageNum++;
    await sleep(DELAY_MS_REVIEWS);
  }

  console.log(`[${shop.id}] Backfill done: ${updated} updated`);
  return updated;
}

const isBackfill = args.includes('--backfill');

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await ensureSchema(db);
  console.log(`[${new Date().toISOString()}] === CityHeaven v4 ===`);
  await db.run('PRAGMA busy_timeout=10000');

  const shopsToScrape = shopFilter
    ? CH_REVIEW_SHOPS.filter(s => s.id.toLowerCase().includes(shopFilter.toLowerCase()) || s.slug.includes(shopFilter))
    : CH_REVIEW_SHOPS;

  if (shopsToScrape.length === 0) {
    console.error('Unknown shop:', shopFilter);
    process.exit(1);
  }

  for (const shop of shopsToScrape) {
    await scrapeShop(db, shop);
    // 自動回填缺少分項評分的既有口コミ
    await backfillScores(db, shop);
  }

  const total = await db.get("SELECT COUNT(*) as cnt FROM reviews WHERE source='cityheaven'");
  const scored = await db.get("SELECT COUNT(*) as cnt FROM reviews WHERE source='cityheaven' AND rating_looks IS NOT NULL");
  console.log(`\n=== Done === CityHeaven total: ${total.cnt} | with scores: ${scored.cnt}`);

  await db.close();
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
