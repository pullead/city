#!/usr/bin/env node
/**
 * 爆サイ 掲示板爬蟲
 * Usage:
 *   node scripts/scrape-bakusai.js
 *   node scripts/scrape-bakusai.js --thread 12991152          # 指定 thread
 *   node scripts/scrape-bakusai.js --shop "Muteki Platinum"   # 指定 shop 標記
 */

const { req, DB_PATH, ensureSchema } = require('./lib/db');
const { fetchText } = require('./lib/http-fetch');
const sqlite3 = req('sqlite3');
const { open } = req('sqlite');
const cheerio = req('cheerio');

const path = require('path');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const { normalizeForSearch } = require(path.join(__dirname, 'lib', 'normalize-ja.js'));
const { canonicalize } = require(path.join(__dirname, 'lib', 'bakusai.js'));

const THREADS = [
  // Muteki Platinum
  { thread_id: '12991152', shop: 'Muteki Platinum', title: '日本橋 Muteki Platinum ①',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12991152/ttgid=104/p={PAGE}' },
  { thread_id: '13119226', shop: 'Muteki Platinum', title: '日本橋 Muteki Platinum ②',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=13119226/ttgid=104/p={PAGE}' },
  { thread_id: '13210273', shop: 'Muteki Platinum', title: '日本橋 Muteki Platinum ③',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=13210273/ttgid=104/p={PAGE}' },
  // Platinum Legend
  { thread_id: '12417853', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑩',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12417853/ttgid=104/p={PAGE}' },
  { thread_id: '12467379', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑪',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12467379/ttgid=104/p={PAGE}' },
  { thread_id: '12528975', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑫',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12528975/ttgid=104/p={PAGE}' },
  { thread_id: '12595561', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑬',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12595561/ttgid=104/p={PAGE}' },
  { thread_id: '12683149', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑭',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12683149/ttgid=104/p={PAGE}' },
  { thread_id: '12775847', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑮',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12775847/ttgid=104/p={PAGE}' },
  { thread_id: '12885499', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑯',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12885499/ttgid=104/p={PAGE}' },
  { thread_id: '12974222', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑰',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=12974222/ttgid=104/p={PAGE}' },
  { thread_id: '13124044', shop: 'platleg', title: 'プラチナムレジェンド大阪 ⑱',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=13124044/ttgid=104/p={PAGE}' },
  { thread_id: '13246760', shop: 'platleg', title: '難波 梅田 プラチナムレジェンド大阪 ⑲',
    base: 'https://bakusai.com/thr_res/acode=7/ctgid=103/bid=5922/tid=13246760/ttgid=104/p={PAGE}' },
];

const args = process.argv.slice(2);
const threadFilter = (() => { const i = args.indexOf('--thread'); return i !== -1 ? args[i+1] : null; })();
const shopFilter = (() => { const i = args.indexOf('--shop'); return i !== -1 ? args[i+1] : null; })();
const FULL_SCAN = args.includes('--full');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function strip(s) {
  if (!s) return null;
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&ensp;/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').trim();
}

function parsePosts(html) {
  const posts = [];
  const $ = cheerio.load(html);

  // 爆サイ構造: dl#res_list > .res_list_article (各レス)
  // fallback: id="resN" を持つ要素
  let articles = $('dl#res_list .res_list_article');
  if (articles.length === 0) articles = $('[id^="res"]').filter((_, el) => /^res\d+$/.test($(el).attr('id') || ''));

  articles.each((_, el) => {
    const $el = $(el);

    // レス番号: id="resN" or .resnumb #N
    let num = 0;
    const idAttr = $el.attr('id') || '';
    const idM = idAttr.match(/^res(\d+)$/);
    if (idM) {
      num = parseInt(idM[1]);
    } else {
      const numbText = $el.find('.resnumb a').first().text();
      const numbM = numbText.match(/#?(\d+)/);
      if (numbM) num = parseInt(numbM[1]);
    }
    if (num === 0) return;

    // 時間
    const time = $el.find('[itemprop="commentTime"]').text().trim() || null;

    // 內容: .resbody[itemprop="commentText"] or .res_body
    let content = $el.find('.resbody[itemprop="commentText"], .res_body').first().text().trim();
    if (!content) return;

    // 引用: >>N
    const quotes = [];
    const quoteMatches = content.match(/>>(\d+)/g);
    if (quoteMatches) quoteMatches.forEach(q => quotes.push(parseInt(q.replace('>>', ''))));

    // 用戶名
    const nameText = $el.find('.name span').first().text().trim();
    const author = nameText || '匿名さん';

    posts.push({ num, time, content, author, quotes });
  });

  return posts;
}

async function scrapeThread(db, threadConfig) {
  const { thread_id, shop, title, base } = threadConfig;
  console.log(`\n[${title}] Starting...`);

  // 取得已存在的帖號
  const existing = new Set(
    (await db.all('SELECT post_num FROM bakusai_posts WHERE thread_id = ?', [thread_id]))
      .map(r => r.post_num)
  );
  console.log(`[${title}] Existing: ${existing.size}`);

  let totalInserted = 0;
  let emptyPages = 0;
  let allExistingPages = 0;

  for (let page = 1; page <= 30; page++) {
    const url = base.replace('{PAGE}', page);
    try {
      const html = await fetchText(url, { ua: UA, timeout: 20000, retries: 1, throwOnHttpError: false });

      const posts = parsePosts(html);
      if (posts.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) {
          console.log(`[${title}] No posts on page ${page}, stopping.`);
          break;
        }
        continue;
      }
      emptyPages = 0;

      let pageInserted = 0;
      for (const post of posts) {
        if (existing.has(post.num)) continue;
        try {
          const canonical = canonicalize(base.replace('{PAGE}', '1'));
          await db.run(
            `INSERT OR IGNORE INTO bakusai_posts
             (thread_id, post_num, shop, author, content, content_norm, quotes_json, posted_at, scraped_at, thread_url_canonical, thread_title)
             VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?)`,
            [thread_id, post.num, shop, post.author, post.content, normalizeForSearch(post.content),
             post.quotes.length > 0 ? JSON.stringify(post.quotes) : null,
             post.time, canonical, title]
          );
          pageInserted++;
          existing.add(post.num);
        } catch (e) { /* unique constraint */ }
      }

      totalInserted += pageInserted;
      console.log(`[${title}] Page ${page}: ${posts.length} posts, ${pageInserted} new (total: ${totalInserted})`);

      // 從最新頁面開始掃，如果連續 2 頁全部已存在就停（--full 模式不停）
      if (!FULL_SCAN && pageInserted === 0) {
        allExistingPages++;
        if (allExistingPages >= 2) {
          console.log(`[${title}] All posts existing on page ${page}, stopping.`);
          break;
        }
      } else {
        allExistingPages = 0;
      }

      await sleep(1000 + Math.random() * 500);
    } catch (e) {
      console.error(`[${title}] Page ${page} error: ${e.message.substring(0, 60)}`);
      await sleep(3000);
    }
  }

  console.log(`[${title}] Done: ${totalInserted} inserted`);
  return totalInserted;
}

(async () => {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await ensureSchema(db);

  await db.run('PRAGMA busy_timeout=10000');
  // 建表
  await db.run(`
    CREATE TABLE IF NOT EXISTS bakusai_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      post_num INTEGER NOT NULL,
      shop TEXT,
      author TEXT DEFAULT '匿名さん',
      content TEXT NOT NULL,
      quotes_json TEXT,
      posted_at TEXT,
      scraped_at TEXT,
      UNIQUE(thread_id, post_num)
    )
  `);

  const targets = THREADS.filter(t => {
    if (threadFilter && t.thread_id !== threadFilter) return false;
    if (shopFilter && !t.shop.toLowerCase().includes(shopFilter.toLowerCase())) return false;
    return true;
  });

  if (targets.length === 0) {
    console.error('No matching threads.');
    process.exit(1);
  }

  let grandTotal = 0;
  for (let i = 0; i < targets.length; i++) {
    grandTotal += await scrapeThread(db, targets[i]);
    if (i < targets.length - 1) await sleep(5000); // thread 間 delay（爆サイ反爬對策）
  }

  const counts = await db.all('SELECT thread_id, COUNT(*) as cnt FROM bakusai_posts GROUP BY thread_id');
  console.log('\n=== Final Counts ===');
  counts.forEach(r => console.log(` Thread ${r.thread_id}: ${r.cnt} posts`));

  await db.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
