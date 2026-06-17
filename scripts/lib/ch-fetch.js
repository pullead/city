'use strict';

/**
 * CityHeaven HTML fetch helper.
 *
 * Design intent:
 * - Production/default path stays plain curl with CH cookie support.
 * - Scrapling is an optional fallback/bypass adapter for age-gate or brittle HTTP.
 * - Callers can opt into bounded fail-fast behavior so Discord/search agents do not
 *   hang on diary/review pagination when CityHeaven is unreachable from the VM.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchHtmlWithScrapling } = require('./scrapling-fetch');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_COOKIE_PATH = process.env.CH_COOKIE_PATH || path.join(ROOT, 'state', 'ch-cookies-curl.txt');

function isCityHeavenAgeGate(html) {
  return String(html || '').length < 5000
    && (String(html || '').includes('cs/nenrei') || String(html || '').includes('当サイトは風俗コンテンツを含んで'));
}

function isTimeoutLike(text) {
  return /timed out|Timeout|Failed to connect|curl: \(28\)|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(String(text || ''));
}

function createCityHeavenFetcher(options = {}) {
  const ua = options.ua || DEFAULT_UA;
  const cookiePath = options.cookiePath || DEFAULT_COOKIE_PATH;
  const timeout = Number(options.timeout || process.env.CH_FETCH_TIMEOUT || process.env.SCRAPLING_TIMEOUT || 30);
  const connectTimeout = Number(options.connectTimeout || Math.min(10, timeout));
  const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
  const useScrapling = Boolean(options.useScrapling || process.env.USE_SCRAPLING_FETCH === '1');
  const scraplingFetcher = options.scraplingFetcher || process.env.SCRAPLING_FETCHER || 'http';
  const scraplingMode = options.scraplingMode || process.env.CH_SCRAPLING_MODE || 'fallback'; // fallback | first | only
  const networkIdle = options.networkIdle ?? (scraplingFetcher !== 'http');
  const failFast = Boolean(options.failFast || process.env.CH_FAIL_FAST === '1');
  const logger = options.logger || (() => {});
  const warnings = options.warnings || [];

  let failureCount = 0;

  function warn(message) {
    warnings.push(message);
    logger(message);
  }

  function fetchWithCurl(url) {
    const args = ['-sL', '-A', ua, '--connect-timeout', String(connectTimeout), '--max-time', String(timeout)];
    if (fs.existsSync(cookiePath)) args.push('-b', cookiePath);
    args.push(url);

    try {
      const html = execFileSync('curl', args, { encoding: 'utf8', maxBuffer });
      if (isCityHeavenAgeGate(html)) {
        warn(`curl age-gate: ${url}`);
        return { ok: false, html: '', reason: 'age-gate' };
      }
      return { ok: true, html, reason: null };
    } catch (err) {
      const reason = err?.message || String(err);
      warn(`curl failed: ${url}${reason ? ` (${reason.slice(0, 160)})` : ''}`);
      return { ok: false, html: '', reason };
    }
  }

  function fetchWithScrapling(url) {
    const res = fetchHtmlWithScrapling(url, {
      fetcher: scraplingFetcher,
      timeout,
      networkIdle,
      maxBuffer,
    });

    if (res.ok && !isCityHeavenAgeGate(res.html)) {
      if (res.stderr) logger(`[scrapling:${scraplingFetcher}] ${res.stderr}`);
      return { ok: true, html: res.html, reason: null };
    }

    const reason = res.ok ? 'age-gate/short page' : (res.stderr || 'unknown error');
    warn(`scrapling:${scraplingFetcher} failed: ${url}${reason ? ` (${reason.slice(0, 240)})` : ''}`);
    return { ok: false, html: '', reason };
  }

  function fetch(url) {
    if (failFast && failureCount > 0) {
      warn(`fail-fast skip after previous network failure: ${url}`);
      return '';
    }

    const attempts = [];
    if (useScrapling && scraplingMode === 'only') {
      attempts.push(fetchWithScrapling);
    } else if (useScrapling && scraplingMode === 'first') {
      attempts.push(fetchWithScrapling, fetchWithCurl);
    } else {
      attempts.push(fetchWithCurl);
      if (useScrapling) attempts.push(fetchWithScrapling);
    }

    const reasons = [];
    for (const attempt of attempts) {
      const result = attempt(url);
      if (result.ok) return result.html;
      reasons.push(result.reason || 'failed');
    }

    if (reasons.some(isTimeoutLike)) failureCount++;
    return '';
  }

  return {
    fetch,
    warnings,
    hasWarnings: () => warnings.length > 0,
    getFailureCount: () => failureCount,
    isAgeGate: isCityHeavenAgeGate,
  };
}

module.exports = {
  DEFAULT_UA,
  DEFAULT_COOKIE_PATH,
  createCityHeavenFetcher,
  isCityHeavenAgeGate,
};
