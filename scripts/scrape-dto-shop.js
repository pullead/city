#!/usr/bin/env node
/**
 * DTO.jp 共用店舗爬蟲（在籍 + 新人偵測 + 出勤更新）
 * 
 * Usage:
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 37142
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 25536
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 37142 --newface-only
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 37142 --schedule-only
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 37142 --girls-only
 *   xvfb-run -a node scripts/scrape-dto-shop.js --shop 37142 --gal-id 5255646
 */

const { req, DB_PATH, ensureSchema } = require('./lib/db');
const { chromium } = req('playwright');
const sqlite3 = req('sqlite3');
const { open } = req('sqlite');

const SHOPS = {
  '37142': { name: 'Muteki Platinum', ch_url: 'https://www.cityheaven.net/osaka/A2702/A270202/muteki_platinum/reviews/' },
  '25536': { name: 'platleg', ch_url: 'https://www.cityheaven.net/osaka/A2702/A270203/kitty_osaka/reviews/' },
};

const args = process.argv.slice(2);
const getArg = (name, def = null) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
const hasArg = (name) => args.includes(name);

const shopId = getArg('--shop');
if (!shopId || !SHOPS[shopId]) {
  console.error('Usage: --shop 37142|25536 [--newface-only|--schedule-only|--girls-only|--gal-id <id>]');
  process.exit(1);
}

const SHOP = SHOPS[shopId];
const SHOP_NAME = SHOP.name;
const DTO_BASE = `https://www.dto.jp/shop/${shopId}`;

const NEWFACE_ONLY = hasArg('--newface-only');
const SCHEDULE_ONLY = hasArg('--schedule-only');
const GIRLS_ONLY = hasArg('--girls-only');
const SINGLE_GAL = getArg('--gal-id');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// DTO 個人頁面解析（PC版）
async function parseGalPage(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    // 名前：「名前\tXXX」行
    const nameLine = lines.find(l => l.startsWith('名前\t'));
    const name = nameLine ? nameLine.split('\t').slice(1).join('').trim() : null;

    // Q&A 欄位（tab-separated: 「質問\t回答」）
    const getField = (key) => {
      const line = lines.find(l => l.startsWith(key + '\t'));
      return line ? line.split('\t').slice(1).join('\t').trim() : null;
    };

    const age = getField('年齢');
    const height = getField('身長');
    const sizes = getField('3サイズ');
    const course = getField('所属コース');
    const foreignerOk = getField('外国籍の方は？');
    const paipan = getField('パイパンですか？');

    // スペック解析
    let bust = null, waist = null, hip = null;
    if (sizes) {
      const m = sizes.match(/(\d+)\(([A-Z]+)\)[^\d]*(\d+)[^\d]*(\d+)/);
      if (m) { bust = m[1] + '(' + m[2] + ')'; waist = m[3]; hip = m[4]; }
    }

    // 可能オプション
    let options_list = null;
    const optLine = lines.find(l => l.startsWith('可能オプションは？\t'));
    if (optLine) options_list = optLine.split('\t').slice(1).join('\t').trim();

    // Q&A 追加欄位
    const onani = getField('週何回オナニーしますか？');
    const nure = getField('濡れやすいですか？');
    const feel = getField('1番感じるところは？');
    const tokui = getField('得意なプレイは？');
    const taisei = getField('好きな体位は？');
    const hKibun = getField('Hな気分はどんな時!?');
    const hTaiken = getField('忘れられないHな体験は!?');
    const tattoo = getField('タトゥーはありますか？');
    const delivery = getField('自宅デリバリーは？');

    // 基本プレイ（「基本プレイ」〜「オプションプレイ」の間）
    let basic_play = null;
    const basicIdx = lines.findIndex(l => l.includes('基本プレイ'));
    const optPlayIdx = lines.findIndex(l => l.includes('オプションプレイ'));
    if (basicIdx !== -1) {
      const endIdx = optPlayIdx !== -1 ? optPlayIdx : basicIdx + 5;
      basic_play = lines.slice(basicIdx + 1, endIdx).join('\n').trim();
    }

    // キャッチフレーズ（☆...☆ パターン）
    let catchphrase = null;
    const catchM = text.match(/☆(.+?)☆/);
    if (catchM) catchphrase = catchM[1];

    // メッセージ（「メッセージ」セクション以降、料金の前まで）
    let message = null;
    const msgIdx = lines.findIndex(l => l === 'メッセージ' || l === ' メッセージ');
    if (msgIdx !== -1) {
      const endIdx = lines.findIndex((l, i) => i > msgIdx && l.match(/^\d{2,3}分[\d,]+円/));
      const msgLines = lines.slice(msgIdx + 1, endIdx !== -1 ? endIdx : msgIdx + 30);
      message = msgLines.filter(l => l.length > 0 && !l.startsWith('ネット予約')).join('\n').substring(0, 1500);
    }

    // 紹介文 description（メッセージの後半、★★ や ☆ 以外の長文段落）
    // 如果只有一句標語沒有長文，fallback 成 message 本身，避免 no_desc
    let description = null;
    if (message) {
      const descLines = message.split('\n');
      const startIdx = descLines.findIndex(l => l.length > 20 && !l.match(/^[★☆※◆◇●○■□▼▲]/));
      if (startIdx >= 0) {
        description = descLines.slice(startIdx).join('\n').substring(0, 1500);
      } else {
        description = message.substring(0, 1500);
      }
    }

    // 料金
    const prices = {};
    const priceRegex = /(\d{2,3})分([\d,]+)円/g;
    let pm;
    while ((pm = priceRegex.exec(text)) !== null) {
      prices[pm[1]] = pm[2].replace(/,/g, '');
    }

    // gal_id from URL
    const urlMatch = location.href.match(/\/gal\/(\d+)/);
    const gal_id = urlMatch ? parseInt(urlMatch[1]) : null;

    // スケジュール
    const tables = document.querySelectorAll('table');
    let schedule = null;
    for (const t of tables) {
      if (t.innerText.match(/月|火|水|木|金|土|日/)) { schedule = t.innerText.trim(); break; }
    }

    return {
      name, gal_id,
      age: age ? parseInt(age) : null,
      height: height ? parseInt(height) : null,
      bust, waist: waist ? parseInt(waist) : null, hip: hip ? parseInt(hip) : null,
      price_60: prices['60'] || null,
      price_90: prices['90'] || null,
      price_120: prices['120'] || null,
      course, foreigner_ok: foreignerOk, paipan,
      options_list, basic_play, catchphrase,
      message, description, schedule,
    };
  });
}

// 店家預設價格（個頁沒寫時 fallback）
async function getShopDefaultPrices(page) {
  try {
    await page.goto(DTO_BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(500);
    return await page.evaluate(() => {
      const prices = {};
      const tables = Array.from(document.querySelectorAll('.contents.price table.style2'));
      for (const table of tables) {
        const heading = table.querySelector('th')?.innerText?.trim() || '';
        if (!heading.includes('プラチナコース')) continue;
        const rows = table.querySelectorAll('tr');
        if (rows.length < 3) continue;
        const mins = Array.from(rows[1].querySelectorAll('td div')).map(el => (el.innerText.match(/(\d{2,3})分/) || [])[1] || null);
        const vals = Array.from(rows[2].querySelectorAll('td div')).map(el => (el.innerText || '').replace(/[^\d]/g, ''));
        mins.forEach((m, i) => {
          if (m && vals[i]) prices[m] = vals[i];
        });
        if (Object.keys(prices).length > 0) break;
      }
      return prices;
    });
  } catch (_) {
    return {};
  }
}

// 全女孩 URL 取得
async function getGalUrls(page) {
  const galUrls = [];
  for (let p = 1; p <= 10; p++) {
    const url = p === 1 ? `${DTO_BASE}/gals` : `${DTO_BASE}/gals?page=${p}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);

    const links = await page.evaluate(() => {
      return [...new Set(
        Array.from(document.querySelectorAll('a[href*="/gal/"]'))
          .map(a => a.href)
          .filter(h => h.match(/\/gal\/\d+\/?$/))
          .map(h => h.replace('s.dto.jp', 'www.dto.jp').replace(/\/$/, ''))
      )];
    });

    const unique = links.filter(l => !galUrls.includes(l));
    galUrls.push(...unique);
    console.log(`[GalList] Page ${p}: +${unique.length} (total: ${galUrls.length})`);

    if (unique.length === 0) break;
    await sleep(600);
  }
  return galUrls;
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await ensureSchema(db);

  await db.run('PRAGMA busy_timeout=10000');
  // gal_id 欄位確認（如果還沒加）
  try { await db.run('ALTER TABLE girls ADD COLUMN gal_id INTEGER'); } catch (_) {}

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

  try {
    // ===========================
    // 單一 gal_id 模式
    // ===========================
    if (SINGLE_GAL) {
      log(`=== 單一更新 gal_id: ${SINGLE_GAL} ===`);
      const url = `https://www.dto.jp/gal/${SINGLE_GAL}`;
      const defaultPrices = await getShopDefaultPrices(page);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(500);
      const g = await parseGalPage(page);
      if (!g.name) { log('解析失敗'); return; }
      g.price_60 = g.price_60 || defaultPrices['60'] || null;
      g.price_90 = g.price_90 || defaultPrices['90'] || null;
      g.price_120 = g.price_120 || defaultPrices['120'] || null;

      const existing = await db.get('SELECT id FROM girls WHERE gal_id = ? OR dto_url LIKE ?', 
        [parseInt(SINGLE_GAL), `%/gal/${SINGLE_GAL}%`]);

      if (existing) {
        await db.run(`UPDATE girls SET name=?, age=?, height=?, bust=?, waist=?, hip=?,
          price_60=?, price_90=?, price_120=?, course=?, foreigner_ok=?, paipan=?,
          options_list=?, basic_play=?, catchphrase=?, message=?, description=?, schedule=?, gal_id=?
          WHERE id=?`,
          [g.name, g.age, g.height, g.bust, g.waist, g.hip,
           g.price_60, g.price_90, g.price_120, g.course, g.foreigner_ok, g.paipan,
           g.options_list, g.basic_play, g.catchphrase, g.message, g.description, g.schedule, g.gal_id, existing.id]);
        log(`✓ 更新：${g.name}`);
      } else {
        await db.run(`INSERT INTO girls (name, age, height, bust, waist, hip, 
          price_60, price_90, price_120, course, foreigner_ok, paipan,
          options_list, basic_play, catchphrase, message, description, schedule, dto_url, shop, gal_id, sources)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [g.name, g.age, g.height, g.bust, g.waist, g.hip,
           g.price_60, g.price_90, g.price_120, g.course, g.foreigner_ok, g.paipan,
           g.options_list, g.basic_play, g.catchphrase, g.message, g.description, g.schedule, url, SHOP_NAME, g.gal_id, 'dto']);
        log(`✓ 新增：${g.name}`);
      }
      log(`外人: ${g.foreigner_ok} | パイパン: ${g.paipan} | 料金90: ${g.price_90}`);
      await browser.close();
      await db.close();
      process.exit(0);
    }

    // ===========================
    // 出勤更新模式（從 schedule 頁面一次取得）
    // ===========================
    if (SCHEDULE_ONLY) {
      log(`=== 出勤更新 (${SHOP_NAME}) ===`);
      await page.goto(`${DTO_BASE}/schedule`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      const scheduleData = await page.$$eval('a[href*="/gal/"]', els =>
        els.map(e => ({
          url: e.href,
          text: e.innerText.trim().substring(0, 300)
        })).filter(e => e.text.length > 10)
      );
      log(`出勤頁面: ${scheduleData.length} 名`);

      const girls = await db.all('SELECT id, name, dto_url, gal_id FROM girls WHERE shop=?', [SHOP_NAME]);
      const girlByGalId = {};
      for (const g of girls) {
        const gid = g.gal_id || g.dto_url?.match(/\/gal\/(\d+)/)?.[1];
        if (gid) girlByGalId[String(gid)] = g;
      }

      let updated = 0;
      for (const item of scheduleData) {
        const galId = item.url.match(/\/gal\/(\d+)/)?.[1];
        if (!galId || !girlByGalId[galId]) continue;
        const lines = item.text.split('\n').map(l => l.trim()).filter(l => l);
        const status = lines.find(l => l.includes('待ち') || l.includes('満員') || l.includes('受付'));
        const timeSlot = lines.find(l => l.match(/\d+:\d+～\d+:\d+/));
        const jst = new Date(Date.now() + 9*3600000);
        const today = `${jst.getUTCMonth()+1}/${jst.getUTCDate()}`;
        const scheduleStr = [today, status, timeSlot].filter(Boolean).join(' ');
        await db.run('UPDATE girls SET schedule=? WHERE id=?', [scheduleStr, girlByGalId[galId].id]);
        updated++;
      }
      log(`出勤更新: ${updated} 名`);
      await browser.close(); await db.close();
      return;
    }

    // ===========================
    // 新人偵測 + 在籍更新
    // ===========================
    const galUrls = await getGalUrls(page);
    log(`dto.jp 找到 ${galUrls.length} 名`);

    // 既存 URL（全 shop 查詢，避免跨店重複偵測為新人）
    const existing = await db.all('SELECT dto_url, gal_id, shop, shops FROM girls WHERE dto_url IS NOT NULL');
    const normalizeUrl = (u) => u.replace(/\/$/, '').replace('://s.dto.jp/', '://www.dto.jp/');
    const existingUrls = new Set(existing.map(r => normalizeUrl(r.dto_url)));
    // 同店既存（用於判斷 insert vs update）
    const sameShopUrls = new Set(existing.filter(r => r.shop === SHOP_NAME || (r.shops && r.shops.includes(SHOP_NAME))).map(r => normalizeUrl(r.dto_url)));

    const newGalUrls = galUrls.filter(u => !existingUrls.has(normalizeUrl(u)));
    // 跨店已存在但本店未登錄的（需要追加 shops）
    const crossShopUrls = galUrls.filter(u => existingUrls.has(normalizeUrl(u)) && !sameShopUrls.has(normalizeUrl(u)));
    const existingGalUrls = galUrls.filter(u => sameShopUrls.has(normalizeUrl(u)));

    // 跨店追加 shops（不需要重新爬頁面）
    if (crossShopUrls.length > 0) {
      log(`跨店追加: ${crossShopUrls.length} 名`);
      for (const url of crossShopUrls) {
        const nu = normalizeUrl(url);
        const row = existing.find(r => normalizeUrl(r.dto_url) === nu);
        if (row) {
          const currentShops = row.shops || row.shop || '';
          if (!currentShops.includes(SHOP_NAME)) {
            const newShops = currentShops ? `${currentShops},${SHOP_NAME}` : SHOP_NAME;
            await db.run('UPDATE girls SET shops=? WHERE dto_url=? OR dto_url=?', [newShops, nu, nu + '/']);
            log(`⊕ 跨店: ${row.shop} → +${SHOP_NAME} (${nu})`);
          }
        }
      }
    }

    if (NEWFACE_ONLY) {
      log(`新人: ${newGalUrls.length} 名`);
      if (newGalUrls.length === 0) {
        log('新人なし');
        return;
      }
    }

    // 要爬的 URL
    const urlsToScrape = NEWFACE_ONLY ? newGalUrls : galUrls;
    const defaultPrices = await getShopDefaultPrices(page);
    log(`爬取對象: ${urlsToScrape.length} 名${NEWFACE_ONLY ? '（新人のみ）' : GIRLS_ONLY ? '（全員更新）' : ''}`);

    let inserted = 0, updated = 0, errors = 0;

    for (const url of urlsToScrape) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(300);

        const g = await parseGalPage(page);
        if (!g.name || g.name.length < 2) { errors++; continue; }
        g.price_60 = g.price_60 || defaultPrices['60'] || null;
        g.price_90 = g.price_90 || defaultPrices['90'] || null;
        g.price_120 = g.price_120 || defaultPrices['120'] || null;

        const isNew = !existingUrls.has(normalizeUrl(url));
        const storeUrl = normalizeUrl(url);

        if (isNew) {
          await db.run(`INSERT OR IGNORE INTO girls 
            (name, age, height, bust, waist, hip, price_60, price_90, price_120,
             course, foreigner_ok, paipan, options_list, basic_play, catchphrase,
             message, description, schedule, dto_url, shop, shops, gal_id, sources, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            [g.name, g.age, g.height, g.bust, g.waist, g.hip,
             g.price_60, g.price_90, g.price_120, g.course, g.foreigner_ok, g.paipan,
             g.options_list, g.basic_play, g.catchphrase, g.message, g.description, g.schedule,
             storeUrl, SHOP_NAME, SHOP_NAME, g.gal_id, 'dto,newface']);
          inserted++;
          log(`✓ 新人: ${g.name}`);
        } else {
          await db.run(`UPDATE girls SET name=?, age=?, height=?, bust=?, waist=?, hip=?,
            price_60=?, price_90=?, price_120=?, course=?, foreigner_ok=?, paipan=?,
            options_list=?, basic_play=?, catchphrase=?, message=?, description=?, schedule=?, gal_id=?
            WHERE dto_url=? OR dto_url=?`,
            [g.name, g.age, g.height, g.bust, g.waist, g.hip,
             g.price_60, g.price_90, g.price_120, g.course, g.foreigner_ok, g.paipan,
             g.options_list, g.basic_play, g.catchphrase, g.message, g.description, g.schedule, g.gal_id,
             storeUrl, storeUrl + '/']);
          updated++;
        }

        if ((inserted + updated + errors) % 20 === 0) {
          log(`進度: ${inserted + updated + errors}/${urlsToScrape.length} (新:${inserted} 更新:${updated} 失敗:${errors})`);
        }
      } catch (e) {
        errors++;
        log(`✗ ${url}: ${e.message.substring(0, 80)}`);
      }
      await sleep(500);
    }

    // 統計
    const total = await db.get('SELECT COUNT(*) as n FROM girls WHERE shop=?', [SHOP_NAME]);
    log(`=== ${SHOP_NAME} 完成 ===`);
    log(`新人: +${inserted} | 更新: ${updated} | 失敗: ${errors} | 在籍: ${total.n}`);

  } finally {
    await browser.close();
    await db.close();
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
