/**
 * lib/bakusai.js — 爆サイ URL 正規化 + SSRF 防護 + 板マスタ + スレッド検索
 *
 * 學自 zofusai (fumizo07/zofusai) 的 services.py / constants.py，
 * Node.js 重新實作，適配我們的 cast.db 架構。
 *
 * 用法：
 *   const baku = require('./lib/bakusai');
 *   baku.isValidBakusaiUrl('https://bakusai.com/thr_res/...')  // true
 *   baku.canonicalize('https://bakusai.com/thr_res_show/...')   // normalized
 *   baku.extractThreadId('https://bakusai.com/.../tid=12345/')  // '12345'
 *   baku.searchThreads({ areaCode: '7', keyword: 'ムテキ', boardCategory: '103' })
 */

'use strict';

const { URL } = require('url');

// ─── SSRF 防護 ────────────────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set(['bakusai.com', 'www.bakusai.com']);
const ALLOWED_PATH_PATTERNS = ['/thr_res/', '/thr_res_show/', '/thr_tl/', '/sch_thr_res/', '/sch_thr_thread/'];

// curl SSRF 防護用共通フラグ
const CURL_SAFE_FLAGS = [
  '--max-redirs', '3',           // リダイレクト回数制限
  '--proto', '=https,http',      // http/https のみ
  '--no-netrc',                   // .netrc 読み込み禁止
];

/**
 * SSRF 對策：只允許 bakusai.com 的 thread URL
 */
function isValidBakusaiUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;  // no credentials in URL
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return false;
    // block IP-based hostnames
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (host.startsWith('[')) return false;  // IPv6
    return ALLOWED_PATH_PATTERNS.some(p => parsed.pathname.includes(p));
  } catch {
    return false;
  }
}

/**
 * URL 正規化（同一 thread 統一 key）
 * - http → https
 * - thr_res_show → thr_res
 * - 去掉 rrid=N, query, fragment
 * - 末尾斜線統一
 */
function canonicalize(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let u = rawUrl.trim();

  // query / fragment
  u = u.split('#')[0].split('?')[0];

  // rrid=N
  u = u.replace(/rrid=\d+\/?$/, '');

  // http → https
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);

  // thr_res_show → thr_res
  u = u.replace('/thr_res_show/', '/thr_res/');

  // 末尾斜線
  if (u && !u.endsWith('/')) u += '/';

  return u;
}

/**
 * 從 URL 中抽出 thread ID（tid=XXXXX）
 */
function extractThreadId(u) {
  if (!u) return null;
  const m = u.match(/tid=(\d+)/);
  return m ? m[1] : null;
}

/**
 * 從 URL 中抽出結構參數
 */
function extractUrlParams(u) {
  if (!u) return {};
  const params = {};
  const patterns = [
    ['acode', /acode=(\d+)/],
    ['ctgid', /ctgid=(\d+)/],
    ['bid', /bid=(\d+)/],
    ['tid', /tid=(\d+)/],
    ['ttgid', /ttgid=(\d+)/],
  ];
  for (const [key, re] of patterns) {
    const m = u.match(re);
    if (m) params[key] = m[1];
  }
  return params;
}

/**
 * 構建 thread URL
 */
function buildThreadUrl({ acode, ctgid, bid, tid, page }) {
  let url = `https://bakusai.com/thr_res/acode=${acode}/ctgid=${ctgid}/bid=${bid}/tid=${tid}/`;
  if (page && page > 1) url += `p=${page}/`;
  return url;
}

// ─── 板マスタ（風俗板 ctgid=103）─────────────────────────────────────────
// 學自 zofusai constants.py，精選常用的板
const AREA_OPTIONS = [
  { code: '1',  label: '北海道' },
  { code: '14', label: '北東北（青森・岩手・秋田）' },
  { code: '2',  label: '南東北（宮城・山形・福島）' },
  { code: '15', label: '北関東（茨城・栃木・群馬）' },
  { code: '3',  label: '南関東・東京周辺' },
  { code: '4',  label: '甲信越（新潟・長野・山梨）' },
  { code: '6',  label: '北陸（富山・石川・福井）' },
  { code: '5',  label: '東海（愛知・岐阜・静岡・三重）' },
  { code: '18', label: '関西（滋賀・京都・兵庫・奈良・和歌山）' },
  { code: '7',  label: '大阪' },
  { code: '8',  label: '山陽（岡山・広島・山口）' },
  { code: '12', label: '山陰（鳥取・島根）' },
  { code: '9',  label: '四国' },
  { code: '10', label: '北部九州（福岡・佐賀・長崎・大分）' },
  { code: '16', label: '南部九州（熊本・宮崎・鹿児島）' },
  { code: '11', label: '沖縄' },
];

// 風俗掲示板 (ctgid=103) の板一覧 — 主要地區
const BOARD_MASTER_103 = [
  // 北海道
  { id: '442',  label: '札幌風俗・お店', area: '1' },
  // 東京
  { id: '412',  label: '東京風俗・お店', area: '3' },
  { id: '5919', label: '東京デリヘル・お店', area: '3' },
  { id: '5072', label: '吉原ソープ・お店', area: '3' },
  { id: '5073', label: '吉原ソープ・総合', area: '3' },
  { id: '5074', label: '吉原ソープ・個人', area: '3' },
  { id: '5869', label: '東京外国人風俗・お店', area: '3' },
  { id: '2277', label: '西東京風俗・お店', area: '3' },
  // 東海
  { id: '472',  label: '愛知風俗・お店', area: '5' },
  // 関西
  { id: '239',  label: '滋賀風俗・お店', area: '18' },
  { id: '418',  label: '京都風俗・お店', area: '18' },
  { id: '436',  label: '兵庫風俗・お店', area: '18' },
  // 大阪
  { id: '410',  label: '大阪風俗・お店', area: '7' },
  { id: '332',  label: '大阪風俗・総合', area: '7' },
  { id: '5922', label: '大阪デリヘル・お店', area: '7' },
  { id: '5923', label: '大阪デリヘル・個人', area: '7' },
  { id: '5924', label: '大阪デリヘル・総合', area: '7' },
  { id: '3913', label: '大阪遊郭・新地お店', area: '7' },
  { id: '3392', label: '大阪遊郭・新地総合', area: '7' },
  // 福岡
  { id: '447',  label: '福岡風俗・お店', area: '10' },
];

// メンエス (ctgid=136) — 主要地區
const BOARD_MASTER_136 = [
  { id: '1714', label: '大阪メンエス・お店', area: '7' },
  { id: '2168', label: '京都メンエス・お店', area: '18' },
  { id: '1298', label: '兵庫メンエス・お店', area: '18' },
];

/**
 * 取得指定 area + category 的板一覽
 */
function getBoardOptions(areaCode, ctgid = '103') {
  const master = ctgid === '136' ? BOARD_MASTER_136 : BOARD_MASTER_103;
  if (!areaCode) return master;
  return master.filter(b => b.area === areaCode);
}

/**
 * 根據板 ID 查板名
 */
function getBoardLabel(boardId) {
  const all = [...BOARD_MASTER_103, ...BOARD_MASTER_136];
  const found = all.find(b => b.id === boardId);
  return found ? found.label : boardId;
}

// ─── 爆サイ外部搜尋 ──────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36';

/**
 * 爆サイ thread 搜尋（外部 HTTP）
 *
 * @param {Object} opts
 * @param {string} opts.areaCode - 地區碼（必須）
 * @param {string} opts.keyword - 搜尋關鍵字（必須）
 * @param {string} [opts.boardCategory='103'] - カテゴリ ID
 * @param {string} [opts.boardId] - 板 ID
 * @param {number} [opts.maxDays] - 最近 N 天內
 * @returns {Promise<Array<{title: string, url: string, lastPost: string}>>}
 */
async function searchThreads({ areaCode, keyword, boardCategory = '103', boardId, maxDays }) {
  if (!areaCode || !keyword) return [];

  const { execFileSync } = require('child_process');
  const { req } = require('./db');
  let cheerio;
  try { cheerio = req('cheerio'); } catch (_) { cheerio = require('cheerio'); }

  const encKeyword = encodeURIComponent(keyword);
  let url = `https://bakusai.com/sch_thr_thread/acode=${areaCode}/`;
  if (boardCategory) url += `ctgid=${boardCategory}/`;
  if (boardId) url += `bid=${boardId}/`;
  url += `p=1/sch=thr_sch/sch_range=board/word=${encKeyword}/`;

  let html;
  try {
    html = execFileSync('curl', ['-s', '--max-time', '20', '-L', ...CURL_SAFE_FLAGS, url, '-H', `User-Agent: ${UA}`],
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8', timeout: 25000 });
  } catch (e) {
    throw new Error(`爆サイ検索失敗: ${e.message.substring(0, 80)}`);
  }

  const $ = cheerio.load(html);
  const threads = [];
  const seenTids = new Set();

  const threshold = maxDays ? new Date(Date.now() - maxDays * 86400000) : null;

  // 搜尋結果頁面解析
  // 爆サイ搜尋結果：每個結果是一個 <a> with href containing /thr_res/
  // 附帶レス数和板名等資訊在父元素中
  $('a[href*="/thr_res/"]').each((_, el) => {
    const $a = $(el);
    let href = $a.attr('href') || '';
    if (!href.includes('/thr_res/')) return;
    if (!href.startsWith('http')) href = 'https://bakusai.com' + href;

    // SSRF 再確認
    if (!isValidBakusaiUrl(href)) return;

    const text = $a.text().trim();
    if (!text || text.length < 3) return;

    // 過濾不相關板（新聞 ctgid=137 等）
    const urlParams = extractUrlParams(href);
    if (boardCategory && urlParams.ctgid && urlParams.ctgid !== boardCategory) return;

    // 去重（同一 tid 只取第一個）
    const tid = extractThreadId(href);
    if (!tid || seenTids.has(tid)) return;
    seenTids.add(tid);

    // 嘗試抓レス数和板名（在父元素的周圍文字中）
    const parentText = $a.parent().parent().text().trim();
    const resMatch = parentText.match(/レス数\s*(\d+)/);
    const resCount = resMatch ? parseInt(resMatch[1]) : null;

    // 嘗試抓最新投稿時間
    const timeMatch = parentText.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/);
    const lastPost = timeMatch ? timeMatch[1] : '';

    if (threshold && lastPost) {
      try {
        const dt = new Date(lastPost.replace(/\//g, '-'));
        if (dt < threshold) return;
      } catch { /* pass */ }
    }

    // 板名
    const boardName = urlParams.bid ? getBoardLabel(urlParams.bid) : '';

    threads.push({
      title: text.replace(/\s+/g, ' ').substring(0, 200),
      url: canonicalize(href),
      lastPost,
      tid,
      resCount,
      boardName,
      ...urlParams,
    });
  });

  return threads;
}

// ─── 板内レス全文検索（res_sch）─────────────────────────────────────────
/**
 * 爆サイの board 内レス全文検索。
 * URL 例: https://bakusai.com/sch_thr_res/acode=7/ctgid=103/bid=5922/p=1/sch=res_sch/sch_range=board/word=<kw>/
 * 同名嬢対策として、必ず thread_title / thread_url / tid をセットで返す。
 * @param {object} opts - { areaCode, keyword, boardCategory='103', boardId, maxPages=3 }
 * @returns {Array<{date, thread_title, thread_url, tid, body, board_label, ctgid, bid}>}
 */
async function searchResponses({ areaCode, keyword, boardCategory = '103', boardId, maxPages = 3 }) {
  if (!areaCode || !keyword || !boardId) {
    throw new Error('searchResponses: area / keyword / board はすべて必須（同名対策のため board 限定）');
  }

  const { execFileSync } = require('child_process');
  const { req } = require('./db');
  let cheerio;
  try { cheerio = req('cheerio'); } catch (_) { cheerio = require('cheerio'); }

  const encKw = encodeURIComponent(keyword);
  const results = [];
  const seen = new Set();
  const boardLabel = getBoardLabel(boardId) || '';

  for (let page = 1; page <= maxPages; page++) {
    let url = `https://bakusai.com/sch_thr_res/acode=${areaCode}/`;
    if (boardCategory) url += `ctgid=${boardCategory}/`;
    url += `bid=${boardId}/p=${page}/sch=res_sch/sch_range=board/word=${encKw}/`;

    let html;
    try {
      html = execFileSync('curl', ['-s', '--max-time', '20', '-L', ...CURL_SAFE_FLAGS, url, '-H', `User-Agent: ${UA}`],
        { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8', timeout: 25000 });
    } catch (e) {
      throw new Error(`爆サイ板内検索失敗 (p=${page}): ${e.message.substring(0, 80)}`);
    }

    // 行ベースでパース（HTML 構造が XHTML1.1 で複雑なので堅牢性重視）
    const lines = html.split(/\n/).map(l =>
      l.replace(/<[^>]+>/g, '')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim()
    );

    let pageHits = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.includes(keyword)) continue;
      if (l.length < keyword.length + 2) continue;
      // ノイズ行除外
      if (l.includes('検索結果')) continue;
      if (l.includes('のレス検索結果')) continue;
      if (l === keyword) continue;
      if (/^<|^[\s]*$/.test(l)) continue;

      // 後方 18 行以内で thread タイトル + 投稿日時を探す
      let threadTitle = '';
      let date = '';
      for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
        const lj = lines[j];
        if (!threadTitle && /^ピンクコレクション|^OLピンクコレクション|^Pink Collection|^日本橋|^コルドンブルー|^TOKYO BUNNYS|^無敵|^Muteki|^muteki/.test(lj)) {
          threadTitle = lj;
        } else if (!threadTitle && lj.length >= 3 && lj.length <= 80 && /[0-9０-９]/.test(lj) && !/\d{4}\/\d{2}/.test(lj)) {
          // 数字を含む 3-80 字の行はスレ名の可能性（番号付きスレ）
          // より厳格に：boardLabel に類似な文字を含むか、過去ヒットのタイトル形式
          if (boardLabel && lj.includes(boardLabel.split(/[ 　]/)[0] || '')) threadTitle = lj;
        }
        if (!date) {
          const m = lj.match(/レス投稿日時[：:]\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/);
          if (m) { date = m[1]; break; }
        }
      }
      if (!date) continue; // 日付がないものはノイズ

      // thread_url を HTML 内 <a href="/thr_res/..."> から推定
      // まず i 以降 30 行以内の HTML 生行から tid を拾う
      let tid = '';
      let threadUrl = '';
      const htmlSlice = html.split(/\n/).slice(i, i + 30).join('\n');
      const hrefM = htmlSlice.match(/\/thr_res\/acode=(\d+)\/ctgid=(\d+)\/bid=(\d+)\/tid=(\d+)\//);
      if (hrefM) {
        tid = hrefM[4];
        threadUrl = `https://bakusai.com/thr_res/acode=${hrefM[1]}/ctgid=${hrefM[2]}/bid=${hrefM[3]}/tid=${tid}/`;
      }

      const key = date + '|' + l.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        date,
        thread_title: threadTitle || '(不明)',
        thread_url: threadUrl || '',
        tid: tid || null,
        body: l,
        board_label: boardLabel,
        ctgid: boardCategory,
        bid: boardId,
      });
      pageHits++;
    }

    // 次ページが無さそうなら停止
    if (pageHits === 0) break;
    // 礼儀正しく次ページ
    if (page < maxPages) await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
  }

  // 日付降順
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results;
}

// ─── 板ランキング取得 ──────────────────────────────────────────────────
/**
 * 爆サイ板ランキング（おすすめ / 総合アクセス / 急上昇）を取得
 * @param {object} opts - { areaCode, ctgid, bid }
 * @returns {{ osusume: Array, sogo: Array, kyujo: Array }}
 *   各 entry: { rank, name, url, tid }
 */
/**
 * 從爆サイ板列表頁找同店名的續篇 thread（②③④...）
 * @param {string} shopName - 店名關鍵字
 * @param {object} opts - { areaCode, ctgid, bid }
 * @returns {Array<{title, url, tid}>}
 */
async function findRelatedThreads(shopName, { areaCode = '7', ctgid = '103', bid = '5922' } = {}) {
  // 使用既有的外部搜尋
  const results = await searchThreads({ areaCode, keyword: shopName, boardCategory: ctgid, boardId: bid });
  // 過濾：thread title 含店名
  return results.map(r => ({
    title: r.title || '',
    url: r.url || '',
    tid: r.tid || extractThreadId(r.url),
  }));
}

async function fetchBoardRanking({ areaCode, ctgid, bid }) {
  const { req } = require('./db');
  const cheerio = req('cheerio');
  const https = require('https');
  const http = require('http');

  const srcUrl = `https://bakusai.com/thr_tl/acode=${areaCode}/ctgid=${ctgid}/bid=${bid}/`;

  const html = await new Promise((resolve, reject) => {
    const req = https.get(srcUrl, { headers: { 'User-Agent': UA } }, res => {
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const mod = res.headers.location.startsWith('http') ? https : http;
        mod.get(res.headers.location, { headers: { 'User-Agent': UA } }, res2 => {
          let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d));
        }).on('error', reject);
        return;
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });

  const $ = cheerio.load(html);
  const tabs = $('div.thr_rankingTab');

  function parseTab(tabEl) {
    const items = [];
    if (!tabEl || !tabEl.length) return items;
    tabEl.find('dd > a').each((i, a) => {
      const el = $(a);
      const text = el.text().replace(/\s+/g, ' ').trim();
      if (!text.includes('閲覧数') && !text.includes('レス数') && !el.find('.rank_title').length) return;

      const name = el.find('.rank_title').text().trim()
        || (() => { const m = text.match(/\d+\s+(.+?)\s+閲覧数/); return m ? m[1] : text.split('閲覧数')[0].replace(/^\d+\s*/, '').trim(); })();

      let href = el.attr('href') || '';
      if (href && !href.startsWith('http')) href = 'https://bakusai.com' + href;
      const tid = extractThreadId(href);

      items.push({ rank: i + 1, name, url: href, tid });
    });
    return items.slice(0, 10);
  }

  return {
    osusume: parseTab(tabs.eq(0)),
    sogo:    parseTab(tabs.eq(1)),
    kyujo:   parseTab(tabs.eq(2)),
  };
}

module.exports = {
  isValidBakusaiUrl,
  CURL_SAFE_FLAGS,
  canonicalize,
  extractThreadId,
  extractUrlParams,
  buildThreadUrl,
  searchThreads,
  searchResponses,
  findRelatedThreads,
  fetchBoardRanking,
  getBoardOptions,
  getBoardLabel,
  AREA_OPTIONS,
  BOARD_MASTER_103,
  BOARD_MASTER_136,
  UA,
};
