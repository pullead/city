'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HELPER = path.join(ROOT, 'scripts', 'scrapling-fetch.py');
const POC_PYTHON = path.join(ROOT, 'tmp', 'scrapling-poc', '.venv', 'bin', 'python');

function resolvePython() {
  if (process.env.SCRAPLING_PYTHON) return process.env.SCRAPLING_PYTHON;
  if (fs.existsSync(POC_PYTHON)) return POC_PYTHON;
  return 'python3';
}

function fetchHtmlWithScrapling(url, options = {}) {
  const python = resolvePython();
  const fetcher = options.fetcher || process.env.SCRAPLING_FETCHER || 'http';
  const timeout = String(options.timeout || process.env.SCRAPLING_TIMEOUT || 30);
  const args = [HELPER, url, '--fetcher', fetcher, '--timeout', timeout];
  if (options.networkIdle || process.env.SCRAPLING_NETWORK_IDLE === '1') args.push('--network-idle');
  if (options.headed || process.env.SCRAPLING_HEADED === '1') args.push('--headed');

  const res = spawnSync(python, args, {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });

  if (res.status !== 0 || !res.stdout) {
    return {
      ok: false,
      html: '',
      status: res.status,
      stderr: (res.stderr || '').trim(),
    };
  }

  return {
    ok: true,
    html: res.stdout,
    status: res.status,
    stderr: (res.stderr || '').trim(),
  };
}

module.exports = {
  fetchHtmlWithScrapling,
  resolvePython,
};
