/**
 * lib/normalize-ja.js — 日文搜尋正規化
 *
 * 學自 zofusai (fumizo07/zofusai) 的 utils.py normalize_for_search，
 * 用 Node.js 重新實作。
 *
 * 功能：
 *   - Unicode NFKC 正規化（全角→半角數字/英文、㈱→株 等）
 *   - カタカナ → ひらがな 統一
 *   - 小書き母音（ぁぃぅぇぉ）→ 通常母音（あいうえお）
 *   - 小書きカナ（ゃゅょっ etc）→ 通常
 *   - 長音記号（ー）保留（風俗名前常用）
 *   - 半角カナ → 全角（NFKC 已處理）
 *   - 連續空白壓縮 + trim + lowercase
 *
 * 用法：
 *   const { normalizeForSearch, toHiragana, toKatakana } = require('./lib/normalize-ja');
 *   normalizeForSearch('ミニ') === 'みに'
 *   normalizeForSearch('ﾐﾆ') === 'みに'  // 半角カナ
 */

'use strict';

/**
 * カタカナ → ひらがな
 * U+30A1..U+30F6 → U+3041..U+3096 (offset = 0x60)
 */
function toHiragana(s) {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // カタカナ range: ァ(30A1) ~ ヶ(30F6)
    if (code >= 0x30A1 && code <= 0x30F6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * ひらがな → カタカナ
 * U+3041..U+3096 → U+30A1..U+30F6 (offset = +0x60)
 */
function toKatakana(s) {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // ひらがな range: ぁ(3041) ~ ゖ(3096)
    if (code >= 0x3041 && code <= 0x3096) {
      out += String.fromCharCode(code + 0x60);
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * 小書き仮名 → 通常仮名（ひらがな版）
 * ぁ→あ ぃ→い ぅ→う ぇ→え ぉ→お ゃ→や ゅ→ゆ ょ→よ っ→つ ゎ→わ
 */
const SMALL_KANA_MAP = {
  '\u3041': '\u3042', // ぁ→あ
  '\u3043': '\u3044', // ぃ→い
  '\u3045': '\u3046', // ぅ→う
  '\u3047': '\u3048', // ぇ→え
  '\u3049': '\u304A', // ぉ→お
  '\u3083': '\u3084', // ゃ→や
  '\u3085': '\u3086', // ゅ→ゆ
  '\u3087': '\u3088', // ょ→よ
  '\u3063': '\u3064', // っ→つ
  '\u308E': '\u308F', // ゎ→わ
};

function normalizeSmallKana(s) {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += SMALL_KANA_MAP[s[i]] || s[i];
  }
  return out;
}

/**
 * 搜尋用完整正規化
 *
 * 1. NFKC（全角→半角英數、半角カナ→全角カナ等）
 * 2. カタカナ→ひらがな
 * 3. 小書き仮名→通常仮名
 * 4. lowercase
 * 5. 空白壓縮 + trim
 */
function normalizeForSearch(s) {
  if (s == null) return '';
  // NFKC: ＡＢＣ→ABC, ﾐﾆ→ミニ, ①→1 etc.
  s = s.normalize('NFKC');
  // カタカナ→ひらがな
  s = toHiragana(s);
  // 小書き→通常
  s = normalizeSmallKana(s);
  // lowercase
  s = s.toLowerCase();
  // 連續空白壓縮
  s = s.replace(/[\s\u3000]+/g, ' ').trim();
  return s;
}

/**
 * 生成搜尋用的所有表記變體（用於 SQL LIKE 或 FTS 查詢）
 * 輸入一個名前，回傳 [原文, ひらがな, カタカナ] 的 NFKC 正規化版本
 */
function searchVariants(name) {
  if (!name) return [];
  const nfkc = name.normalize('NFKC').trim();
  if (!nfkc) return [];
  
  const hira = toHiragana(nfkc);
  const kata = toKatakana(hira);
  
  // 去重
  const set = new Set([nfkc, hira, kata]);
  // 也加上 lowercase 版本
  set.add(nfkc.toLowerCase());
  set.add(hira.toLowerCase());
  set.add(kata.toLowerCase());
  
  return [...set].filter(Boolean);
}

module.exports = {
  toHiragana,
  toKatakana,
  normalizeSmallKana,
  normalizeForSearch,
  searchVariants,
  SMALL_KANA_MAP,
};
