#!/usr/bin/env node
/**
 * Tiny HTTP front end for the slider solver, meant to run in a container you
 * host yourself.
 *
 *   GET  /healthz        liveness plus counters
 *   POST /solve          {"captchaId"?, "mode"?, "timeoutMs"?, "attempts"?}
 *                        -> {"ok":true,"validate":"…","ms":…} | {"ok":false,"error":"…"}
 *
 * Auth: if SOLVER_TOKEN is set, every /solve call must carry
 * `Authorization: Bearer <token>` (or `X-Solver-Token: <token>`). Leave it unset
 * only on a network you trust - this endpoint drives a real browser.
 *
 * Concurrency: one solve at a time, queued. Yidun risk-scores simultaneous
 * attempts from one IP, and a second browser buys nothing.
 */

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { APP_CAPTCHA_ID, solve, launchBrowser } from './solver.mjs';

/**
 * A Home Assistant add-on receives its configuration as /data/options.json.
 * Reading it here rather than in run.sh keeps one image serving both the add-on
 * and a plain `docker run` with environment variables - and keeps jq out of the
 * image. Environment variables still win, so a container can always override.
 */
function addonOptions() {
  const path = process.env.OPTIONS_PATH || '/data/options.json';
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn('ignoring unreadable %s: %s', path, err.message);
    return {};
  }
}

const OPTIONS = addonOptions();
const PORT = Number(process.env.PORT || OPTIONS.port || 8080);
const TOKEN = process.env.SOLVER_TOKEN || OPTIONS.solver_token || '';
const DEBUG_DIR = process.env.DEBUG_DIR || OPTIONS.debug_dir || '';
const DEFAULT_TIMEOUT_MS = Number(
  process.env.SOLVE_TIMEOUT_MS || OPTIONS.solve_timeout_ms || 45000);
const DEFAULT_ATTEMPTS = Number(
  process.env.SOLVE_ATTEMPTS || OPTIONS.solve_attempts || 4);

const stats = { startedAt: Date.now(), solves: 0, failures: 0, queued: 0 };
let browser = null;
let queue = Promise.resolve();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorised(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  if (header === 'Bearer ' + TOKEN) return true;
  return req.headers['x-solver-token'] === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Keep one browser for the process; relaunch if it died. */
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await launchBrowser({ headless: process.env.HEADLESS !== 'false' });
  return browser;
}

const server = http.createServer(async (req, res) => {
  // Home Assistant ingress proxies with the prefix left on the path, so
  // /api/hassio_ingress/<token>/solve arrives here as that entire path. The prefix
  // is handed to us in X-Ingress-Path.
  const prefix = req.headers['x-ingress-path'] || '';
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (prefix && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length) || '/';
  }

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    const status = {
      ok: true,
      browser: Boolean(browser && browser.isConnected()),
      uptimeMs: Date.now() - stats.startedAt,
      solves: stats.solves,
      failures: stats.failures,
      queued: stats.queued,
      auth: TOKEN ? 'bearer' : 'open',
      defaultCaptchaId: APP_CAPTCHA_ID,
    };
    if (pathname === '/healthz') return json(res, 200, status);
    // The panel page shown inside Home Assistant.
    const body = '<!doctype html><meta charset="utf-8"><title>XPENG slider solver</title>'
      + '<style>body{font:15px system-ui;margin:2rem;max-width:34rem}dl{display:grid;'
      + 'grid-template-columns:auto 1fr;gap:.4rem 1rem}dt{color:#666}code{background:#f4f4f4;'
      + 'padding:.1rem .3rem;border-radius:3px}</style>'
      + '<h1>XPENG slider solver</h1><dl>'
      + '<dt>solves</dt><dd>' + stats.solves + '</dd>'
      + '<dt>failures</dt><dd>' + stats.failures + '</dd>'
      + '<dt>uptime</dt><dd>' + Math.round((Date.now() - stats.startedAt) / 1000) + 's</dd>'
      + '<dt>auth</dt><dd>' + status.auth + '</dd>'
      + '</dl><p>POST <code>/solve</code> for a captcha validate, '
      + 'GET <code>/healthz</code> for JSON.</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  if (req.method !== 'POST' || pathname !== '/solve') {
    return json(res, 404, { ok: false, error: 'POST /solve or GET /healthz' });
  }

  if (!authorised(req)) return json(res, 401, { ok: false, error: 'unauthorised' });

  let payload = {};
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return json(res, 400, { ok: false, error: String(err.message || err) });
  }

  stats.queued += 1;
  const run = async () => {
    stats.queued -= 1;
    try {
      const result = await solve({
        captchaId: payload.captchaId || APP_CAPTCHA_ID,
        mode: payload.mode || 'embed',
        timeoutMs: Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS),
        attempts: Number(payload.attempts || DEFAULT_ATTEMPTS),
        browser: await getBrowser(),
        debugDir: DEBUG_DIR,
        dragBiasPx: OPTIONS.drag_bias_px ?? null,
        log: (...args) => console.log('[solve]', ...args),
      });
      if (result.ok) stats.solves += 1;
      else stats.failures += 1;
      return result;
    } catch (err) {
      stats.failures += 1;
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  // Serialise: the browser is shared and Yidun dislikes parallel attempts.
  const result = await (queue = queue.then(run, run));
  console.log('[solve] done in %dms ok=%s', result.ms, result.ok);
  return json(res, result.ok ? 200 : 502, result);
});

server.listen(PORT, () => {
  console.log('xpeng-slider-solver listening on :%d (auth=%s, debug=%s)',
    PORT, TOKEN ? 'on' : 'off', DEBUG_DIR || 'off');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    console.log('shutting down (%s)', signal);
    server.close();
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
}
