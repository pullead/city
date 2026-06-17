#!/usr/bin/env node
/**
 * DTO.jp 口コミ爬蟲（全店共通）
 * Usage:
 *   xvfb-run -a node scripts/scrape-dto-reviews.js              # 全店
 *   xvfb-run -a node scripts/scrape-dto-reviews.js --shop muteki
 *   xvfb-run -a node scripts/scrape-dto-reviews.js --shop platleg
 */

const { req, DB_PATH, ensureSchema } = require('./lib/db');
const { chromium } = req('playwright');
const sqlite3 = req('sqlite3');
const { open } = req('sqlite');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

const SHOPS = [
  { id: 'Muteki Platinum', dto_shop_id: '37142', max_pages: 500 },
  { id: 'platleg',         dto_shop_id: '25536', max_pages: 300 },
];

const args = process.argv.slice(2);
const shopFilter = (() => { const i = args.indexOf('--shop'); return i !== -1 ? args[i+1] : null; })();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeLike(s) { return String(s).replace(/[%_]/g, c => '\\' + c); }

function reviewNameVariants(name) {
  if (!name) return [];
  const cleaned = String(name).replace(/\[\d+歳\]/g, '').trim();
  const variants = new Set();
  for (const part of cleaned.split('/').map(p => p.trim()).filter(Boolean)) {
    variants.add(part);
    const base = part.split('・')[0]?.trim();
    if (base) variants.add(base);
  }
  return [...variants].filter(v => v.length >= 2);
}

async function findGirlByReviewName(db, shopId, reviewName) {
  const variants = reviewNameVariants(reviewName);
  for (const p of variants) {
    const ep = escapeLike(p);
    const g = await db.get(
      `SELECT gal_id FROM girls
       WHERE shop = ? AND gal_id IS NOT NULL AND (
         name = ?
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
         OR name LIKE ? ESCAPE '\\'
       )
       ORDER BY id LIMIT 1`,
      [shopId, p, `${ep}/%`, `%/${ep}`, `%/${ep}・%`, `${ep}・%`]
    );
    if (g) return g;
  }
  return null;
}

async function scrapeShop(browser, db, shop) {
  console.log(`\n[${shop.id}] Starting DTO review scrape...`);
  const page = await browser.newPage({ userAgent: UA });
  let totalInserted = 0;
  let consecutiveEmpty = 0;

  for (let pageNum = 1; pageNum <= shop.max_pages; pageNum++) {
    const url = pageNum === 1
      ? `https://www.dto.jp/shop/${shop.dto_shop_id}/review`
      : `https://www.dto.jp/shop/${shop.dto_shop_id}/review?page=${pageNum}`;

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(500);

      const items = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('.com_review .frame').forEach(el => {
          // reviewer: .member span.text
          const reviewer = el.querySelector('.member span.text')?.innerText?.trim() || null;

          // girl_name: .gal_name
          const girl_name = el.querySelector('.gal_name')?.innerText?.trim() || null;

          // date: .use_date → "ご利用日 2026年1月28日(水)"
          const useDateText = el.querySelector('.use_date')?.innerText?.trim() || '';
          const dateM = useDateText.match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
          const date = dateM ? dateM[1] : null;

          // rating_overall: .total_rate .num
          const ratingEl = el.querySelector('.total_rate .num');
          const rating_overall = ratingEl ? parseFloat(ratingEl.innerText) : null;

          // rating detail: .rate_detail .detail
          let rating_looks = null, rating_play = null, rating_service = null, rating_staff = null;
          el.querySelectorAll('.rate_detail .detail').forEach(d => {
            const t = d.innerText;
            const numM = t.match(/(\d+(?:\.\d+)?)$/);
            const num = numM ? parseFloat(numM[1]) : null;
            if (t.includes('ルックス'))     rating_looks   = num;
            else if (t.includes('プレイ'))  rating_play    = num;
            else if (t.includes('接客'))    rating_service = num;
            else if (t.includes('スタッフ')) rating_staff  = num;
          });

          // title: span.title
          const title = el.querySelector('span.title')?.innerText?.trim() || null;

          // comment: span.comment
          const commentEl = el.querySelector('span.comment');
          const comment = commentEl ? commentEl.innerText.trim() : null;

          // shop_reply: .reply（reply_title 行を除外）
          const replyEl = el.querySelector('.reply');
          let shop_reply = null;
          if (replyEl) {
            const clone = replyEl.cloneNode(true);
            const titleEl = clone.querySelector('.reply_title');
            if (titleEl) titleEl.remove();
            shop_reply = clone.innerText.trim() || null;
          }

          if (reviewer && date) {
            results.push({ reviewer, girl_name, date, rating_overall,
              rating_looks, rating_play, rating_service, rating_staff,
              title, comment, shop_reply });
          }
        });
        return results;
      });

      if (items.length === 0) {
        console.log(`\n[${shop.id}] No items on page ${pageNum}, stopping.`);
        break;
      }

      let pageInserted = 0;
      for (const item of items) {
        try {
          const result = await db.run(
            `INSERT OR IGNORE INTO reviews
             (shop, girl_name, reviewer, title, comment,
              rating_overall, rating_looks, rating_play, rating_service, rating_staff,
              date, source, source_url, shop_reply)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [shop.id, item.girl_name, item.reviewer, item.title, item.comment,
             item.rating_overall, item.rating_looks, item.rating_play,
             item.rating_service, item.rating_staff,
             item.date, 'dto', url, item.shop_reply]
          );
          if (result.changes > 0) {
            pageInserted++;
            // 回填 gal_id
            if (item.girl_name) {
              const g = await findGirlByReviewName(db, shop.id, item.girl_name);
              if (g) {
                await db.run('UPDATE reviews SET gal_id=? WHERE source_url=? AND girl_name=? AND gal_id IS NULL', [g.gal_id, url, item.girl_name]);
              }
            }
          }
        } catch (e) {
          // unique constraint 違反は無視
        }
      }

      totalInserted += pageInserted;
      if (pageNum % 10 === 0 || pageInserted > 0) {
        process.stdout.write(`\r[${shop.id}] Page ${pageNum}: ${items.length} items, ${pageInserted} new (total: ${totalInserted})`);
      }

      // 連続で新規なし = 全件取得済み（最新が前なので早期停止）
      if (pageInserted === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          console.log(`\n[${shop.id}] 2 consecutive pages fully duplicate, stopping at page ${pageNum}.`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }

      await sleep(pageNum % 20 === 0 ? 1000 : 300);
    } catch (e) {
      console.error(`\n[${shop.id}] Page ${pageNum} error: ${e.message.substring(0, 60)}`);
      await sleep(2000);
    }
  }

  console.log(`\n[${shop.id}] Done: ${totalInserted} inserted`);
  await page.close();
  return totalInserted;
}

(async () => {
  const browser = await chromium.launch();
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await ensureSchema(db);

  await db.run('PRAGMA busy_timeout=10000');
  const targets = shopFilter
    ? SHOPS.filter(s => s.id.toLowerCase().includes(shopFilter.toLowerCase()))
    : SHOPS;

  if (targets.length === 0) {
    console.error('No matching shops. Valid: muteki, platleg');
    process.exit(1);
  }

  let grandTotal = 0;
  for (const shop of targets) {
    grandTotal += await scrapeShop(browser, db, shop);
  }

  const counts = await db.all('SELECT shop, COUNT(*) as cnt FROM reviews WHERE source="dto" GROUP BY shop');
  console.log('\n=== Final DTO Review Counts ===');
  counts.forEach(r => console.log(` ${r.shop}: ${r.cnt}`));
  console.log(` Grand total inserted: ${grandTotal}`);

  await db.close();
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
