'use strict';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetry(error, response) {
  if (response && [408, 429, 500, 502, 503, 504].includes(response.status)) return true;
  return /AbortError|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(String(error?.name || error?.message || error || ''));
}

async function fetchResponse(url, options = {}) {
  const timeout = options.timeout ?? 30000;
  const retries = options.retries ?? 1;
  const retryDelay = options.retryDelay ?? 500;
  const headers = {
    'User-Agent': options.ua || DEFAULT_UA,
    ...(options.headers || {}),
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        signal: options.signal || controller.signal,
      });
      if (!response.ok && shouldRetry(null, response) && attempt < retries) {
        lastError = new Error(`HTTP ${response.status}: ${url}`);
        await sleep(retryDelay * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt >= retries) throw error;
      await sleep(retryDelay * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);
  if (!response.ok && options.throwOnHttpError !== false) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetchResponse(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok && options.throwOnHttpError !== false) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

module.exports = {
  DEFAULT_UA,
  fetchResponse,
  fetchText,
  fetchJson,
};
