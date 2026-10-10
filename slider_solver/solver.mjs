#!/usr/bin/env node
/**
 * Solve the XPENG (NetEase Yidun) slider captcha headlessly.
 *
 * The toolkit script `tools/solve_captcha.mjs` renders the real widget at XPENG's
 * own origin and hands a human the slider. Everything except the drag is already
 * there, so this module keeps that scaffolding and replaces the human with:
 *
 *   1. locate the background image, the puzzle piece and the slider handle;
 *   2. find the gap - the piece sprite carries an alpha mask, so the offset is
 *      the x minimising the squared difference between the piece's opaque pixels
 *      and the background at the same y (see findGap);
 *   3. drag the handle there with a human-ish trajectory: ease-out, a small
 *      overshoot, jitter and uneven timing, because the risk engine scores the
 *      path as well as the endpoint;
 *   4. return the `validate` string the SDK hands to onVerify.
 *
 * A miss is cheap and normal: the widget issues a fresh challenge, so `attempts`
 * retries are expected rather than exceptional.
 *
 * Module:
 *     const { solve } = await import('./solver.mjs');
 *     await solve({ captchaId, mode, timeoutMs, attempts, debugDir });
 *
 * CLI (one shot, JSON on stdout, diagnostics on stderr):
 *     node solver.mjs [--captcha-id id] [--headless] [--debug-dir /debug]
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export const APP_CAPTCHA_ID = 'f6c14777879d4a75b683b29be6709db6';
export const WEB_CAPTCHA_ID = 'ee799838945f4771aa5d3dc9bea105d2';
const CAPTCHA_SDK = process.env.XPENG_CAPTCHA_SDK || 'https://cstaticdun.126.net/load.min.js';

function loadChromium() {
  const specifier = process.env.PLAYWRIGHT_DIR
    ? join(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright-core')
    : 'playwright-core';
  try {
    return require(specifier).chromium;
  } catch (err) {
    return require('playwright-core').chromium;
  }
}

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME || '/root', '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const builds = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
  const relatives = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  for (const build of builds) {
    for (const rel of relatives) {
      const candidate = join(root, build, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Launch a browser this process can reuse across solves. */
export async function launchBrowser({ headless = true } = {}) {
  const chromium = loadChromium();
  const executablePath = resolveChrome();
  return chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
}

/**
 * A trajectory that looks like a hand: fast start, deceleration, one overshoot and
 * a correction, plus sub-pixel jitter. Constant-speed motion to the endpoint in a
 * single move is exactly the pattern the risk engine is built to catch.
 */
function trajectory(distance, { steps = 26 } = {}) {
  const points = [];
  const overshoot = distance * (1.01 + Math.random() * 0.03);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = 1 - (1 - t) ** 3;
    let x = overshoot * eased;
    if (i === steps) x = distance;
    const jitter = (Math.random() - 0.5) * Math.max(1, distance * 0.012);
    points.push({ x: Math.max(0, x + jitter), t: 0.012 + Math.random() * 0.026 });
  }
  points.push({ x: distance + (Math.random() - 0.5), t: 0.05 + Math.random() * 0.06 });
  points.push({ x: distance, t: 0.08 + Math.random() * 0.1 });
  return points;
}

/**
 * Find the gap and the handle in the live widget, inside the page.
 *
 * Runs in the browser because the images are already decoded there: drawing them
 * to a canvas needs no image library, and no pixels leave the page.
 */
async function findGap(page) {
  return page.evaluate(async () => {
    const pick = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) return el;
      }
      return null;
    };
    const bg = pick(['.yidun_bg-img', 'img.yidun_bg-img', '[class*="bg-img"]']);
    const piece = pick(['.yidun_jigsaw', 'img.yidun_jigsaw', '[class*="jigsaw"]']);
    // This widget has no .yidun_slider: the knob is the RIGHT EDGE of the progress
    // indicator (.yidun_slide_indicator), whose width grows as the drag proceeds.
    // Using that div's centre starts the drag ~half a track in.
    const indicator = pick(['.yidun_slide_indicator', '[class*="slide_indicator"]']);
    const track = pick(['.yidun_control', '[class*="control"]']);
    const handle = indicator || pick(['.yidun_slider', '[class*="slider"]', '[class*="btn_slide"]', '.yidun_control div']);
    if (!bg || !piece) {
      const container = document.querySelector('#ncc') || document.body;
      return { ok: false, reason: 'slider images not found', html: (container.innerHTML || '').slice(0, 600) };
    }

    const srcOf = (el) => {
      if (el.src) return el.src;
      const computed = getComputedStyle(el).backgroundImage || '';
      const match = computed.match(/url\(["']?(.*?)["']?\)/);
      return match ? match[1] : '';
    };
    const load = (el) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('could not load ' + srcOf(el).slice(0, 80)));
        img.src = srcOf(el);
      });

    let bgImg;
    let pieceImg;
    try {
      [bgImg, pieceImg] = await Promise.all([load(bg), load(piece)]);
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }

    const read = (img) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    const bgData = read(bgImg);
    const pieceData = read(pieceImg);

    const bgRect = bg.getBoundingClientRect();
    const pieceRect = piece.getBoundingClientRect();
    const pieceOffsetY = Math.max(0, Math.round(pieceRect.top - bgRect.top));
    const pieceStartX = Math.max(0, Math.round(pieceRect.left - bgRect.left));

    const gray = (data, x, y) => {
      const i = (y * data.width + x) * 4;
      return {
        v: 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2],
        a: data.data[i + 3],
      };
    };

    // The piece sprite is transparent outside the jigsaw shape; that mask is what
    // makes this a correlation instead of a guess.
    const samples = [];
    for (let y = 0; y < pieceData.height; y += 2) {
      for (let x = 0; x < pieceData.width; x += 2) {
        const { v, a } = gray(pieceData, x, y);
        if (a > 200) samples.push({ x, y, v });
      }
    }
    if (samples.length < 50) {
      return { ok: false, reason: 'piece mask too small (' + samples.length + ' opaque pixels)' };
    }

    // Normalised cross-correlation, not a pixel difference. The hole in the
    // background is the *same photo content* darkened by a translucent overlay, so
    // piece and hole agree up to a gain and an offset - and NCC is invariant to
    // exactly that, as well as to the photo's own contrast. A raw difference can
    // never match inside the hole, which is why the old score curve was noise.
    const n = samples.length;
    let pieceMean = 0;
    for (const s of samples) pieceMean += s.v;
    pieceMean /= n;
    let pieceVar = 0;
    for (const s of samples) pieceVar += (s.v - pieceMean) ** 2;
    pieceVar = Math.sqrt(pieceVar);

    let best = { x: 0, score: Number.NEGATIVE_INFINITY };
    const maxX = Math.max(0, bgData.width - pieceData.width);
    // Skip the piece's own resting place: the widget paints it there, so it
    // correlates perfectly and would answer "the gap is where the piece is".
    const minX = Math.min(24, maxX);
    let runnerUp = Number.NEGATIVE_INFINITY;
    const patch = new Float64Array(n);
    for (let candidate = minX; candidate <= maxX; candidate += 1) {
      let ok = true;
      let patchMean = 0;
      for (let i = 0; i < n; i += 1) {
        const s = samples[i];
        const bx = candidate + s.x;
        const by = pieceOffsetY + s.y;
        if (bx >= bgData.width || by >= bgData.height) { ok = false; break; }
        const v = gray(bgData, bx, by).v;
        patch[i] = v;
        patchMean += v;
      }
      if (!ok) continue;
      patchMean /= n;
      let dot = 0;
      let patchVar = 0;
      for (let i = 0; i < n; i += 1) {
        const dv = patch[i] - patchMean;
        dot += (samples[i].v - pieceMean) * dv;
        patchVar += dv * dv;
      }
      const denom = pieceVar * Math.sqrt(patchVar);
      const score = denom > 0 ? dot / denom : -1;
      if (score > best.score) {
        runnerUp = best.score;
        best = { x: candidate, score };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }

    const handleRect = handle ? handle.getBoundingClientRect() : null;
    const trackRect = track ? track.getBoundingClientRect() : null;
    const knob = handleRect
      ? { x: handleRect.right - handleRect.width / 2,
          y: handleRect.top + handleRect.height / 2,
          width: handleRect.width }
      : null;
    // The background art is usually rendered smaller than its natural size, so the
    // gap's image pixels are not CSS pixels. Dragging 344px of art inside a 320px
    // box overshoots by 7% - far outside the few-pixel tolerance the widget checks.
    const scale = bgRect.width > 0 ? bgRect.width / bgData.width : 1;
    const distance = Math.max(0, best.x * scale - pieceStartX);
    return {
      ok: true,
      gapX: best.x,
      score: best.score,
      scale,
      pieceStartX,
      distance,
      knob,
      track: trackRect ? { left: trackRect.left, width: trackRect.width } : null,
      // A flat score curve means the correlation did not really find anything; the
      // caller logs this so a bad solve is distinguishable from a bad drag. For NCC
      // both numbers live in [-1, 1] and the margin is best minus runner-up.
      margin: Number.isFinite(runnerUp) && runnerUp > Number.NEGATIVE_INFINITY
        ? best.score - runnerUp
        : null,
      bg: { width: bgData.width, height: bgData.height, left: bgRect.left, top: bgRect.top },
      handle: handleRect
        ? { x: handleRect.left + handleRect.width / 2, y: handleRect.top + handleRect.height / 2, width: handleRect.width }
        : null,
      samples: samples.length,
    };
  });
}

/** Drag the handle to `distance` px, as a hand would. */
async function drag(page, handle, distance) {
  const startX = handle ? handle.x : 30;
  const startY = handle ? handle.y : 30;
  await page.mouse.move(startX, startY);
  await page.waitForTimeout(80 + Math.random() * 120);
  await page.mouse.down();
  let last = 0;
  for (const point of trajectory(distance)) {
    const dx = point.x - last;
    last = point.x;
    await page.mouse.move(startX + point.x, startY + (Math.random() - 0.5) * 1.5, { steps: 1 });
    if (dx > 0) await page.waitForTimeout(point.t * 1000);
  }
  const pieceLeft = await readPieceLeft(page);
  await page.waitForTimeout(120 + Math.random() * 200);
  await page.mouse.up();
  // Read again once the widget has settled. A value still short of the request means
  // the widget's mapping really is offset; a value that caught up means the first
  // read was simply mid-animation and no bias is warranted.
  await page.waitForTimeout(600);
  return { early: pieceLeft, settled: await readPieceLeft(page) };
}

async function readPieceLeft(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.yidun_jigsaw');
    if (!el) return null;
    return el.style.left || getComputedStyle(el).left;
  });
}

/** Render the widget at an XPENG origin and wait for the SDK's validate. */
async function openWidget(page, { captchaId, mode }) {
  await page.route('https://login.xpeng.com/__captcha', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><title>captcha</title>' +
        '<style>body{margin:0;padding:8px;font:14px system-ui}#ncc{min-height:360px}</style>' +
        '</head><body><div id="ncc"></div></body></html>',
    }),
  );
  // The puzzle images come from a CDN that sends no CORS headers, so a canvas draw
  // would taint and getImageData would throw. Re-serve those exact bytes through
  // Playwright's own fetch (which is not subject to CORS) with the header added:
  // same image, readable canvas.
  await page.route('https://necaptcha.nosdn.127.net/**', async (route) => {
    try {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'access-control-allow-origin': '*' },
      });
    } catch (err) {
      await route.continue().catch(() => {});
    }
  });
  await page.goto('https://login.xpeng.com/__captcha', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: CAPTCHA_SDK });

  const ready = await page.evaluate(() => typeof initNECaptcha === 'function');
  if (!ready) throw new Error('initNECaptcha missing after loading the SDK');

  await page.evaluate(
    ([id, widgetMode]) =>
      new Promise((resolve) => {
        window.__captchaResult = null;
        window.__captchaReady = false;
        try {
          const instance = initNECaptcha({
            captchaId: id,
            element: '#ncc',
            mode: widgetMode,
            width: '320px',
            onVerify: (err, ret) => {
              if (err) {
                window.__captchaResult = { ok: false, error: String(err).slice(0, 200) };
                return;
              }
              const validate = ret && ret.validate;
              window.__captchaResult = validate
                ? { ok: true, validate: String(validate) }
                : { ok: false, error: 'no validate in ' + JSON.stringify(ret).slice(0, 200) };
            },
            onError: (e) => {
              window.__captchaResult = { ok: false, error: 'onError: ' + String(e).slice(0, 200) };
            },
            onReady: () => {
              window.__captchaReady = true;
            },
          });
          window.__captchaInst = instance;
          setTimeout(() => {
            try {
              if (widgetMode === 'popup' && instance && instance.popUp) instance.popUp();
            } catch (e) {
              /* popup is best effort */
            }
          }, 600);
          resolve(true);
        } catch (err) {
          window.__captchaResult = { ok: false, error: 'init threw: ' + String((err && err.message) || err) };
          resolve(false);
        }
      }),
    [captchaId, mode],
  );
  await page.waitForTimeout(1200);
}

async function readResult(page) {
  return page.evaluate(() => window.__captchaResult || null);
}

/**
 * Verification is asynchronous: the control keeps `yidun_control--moving` until the
 * server answers, so reading the result 900ms after the release (as this used to)
 * reports "no verdict" on attempts that were still in flight.
 */
async function waitForVerdict(page, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readResult(page);
    if (result) return result;
    await page.waitForTimeout(250);
  }
  const control = await page.evaluate(() => {
    const el = document.querySelector('.yidun_control');
    return el ? el.className : null;
  });
  return { ok: false, error: 'no verdict in ' + timeoutMs + 'ms (control: ' + control + ')' };
}

/**
 * Solve a captcha. Returns {ok, validate?, captchaId, attempts, ms, error?}.
 * `debugDir` keeps a screenshot and the DOM of each failed attempt.
 */
/**
 * The widget does not move the piece by the full pointer travel: measured across
 * five drags of 43-203px it landed a constant 10.5px short. So the bias is learned
 * from the first drag in this process (each attempt is a fresh challenge on the
 * same geometry) and applied from the second attempt on, rather than guessed.
 */
let dragBias = Number(process.env.DRAG_BIAS_PX || 0);

export async function solve({
  captchaId = APP_CAPTCHA_ID,
  mode = 'embed',
  timeoutMs = 45000,
  attempts = 4,
  browser = null,
  debugDir = '',
  dragBiasPx = null,
  log = () => {},
} = {}) {
  const started = Date.now();
  // A per-request starting value for the widget's pointer dead-zone. The add-on
  // passes its configured value here rather than through the shell, which is what
  // makes the first attempt of a fresh start land instead of calibrating.
  if (dragBiasPx !== null && Number.isFinite(Number(dragBiasPx))) {
    dragBias = Number(dragBiasPx);
  }
  const own = browser ? null : await launchBrowser({ headless: process.env.HEADLESS !== 'false' });
  const active = browser || own;
  const context = await active.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    viewport: { width: 520, height: 900 },
  });
  const page = await context.newPage();
  page.on('requestfailed', (r) => log('  [reqfail] ' + r.url().slice(0, 100) + ' ' + (r.failure() || {}).errorText));

  let lastError = 'no attempt ran';
  const capture = async (label) => {
    if (!debugDir) return;
    try {
      mkdirSync(debugDir, { recursive: true });
      const shot = join(debugDir, label + '.png');
      await page.screenshot({ path: shot });
      const dom = await page.evaluate(() => (document.querySelector('#ncc') || document.body).innerHTML);
      writeFileSync(join(debugDir, label + '.html'), dom.slice(0, 200000));
      lastError += ' [debug: ' + shot + ']';
    } catch (err) {
      /* artifacts are best effort */
    }
  };

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      log('attempt ' + attempt + '/' + attempts);
      await openWidget(page, { captchaId, mode });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const gap = await findGap(page);
        if (!gap.ok) {
          lastError = gap.reason || 'gap not found';
          log('  gap: ' + lastError);
          await capture('attempt' + attempt + '-nogap');
          await page.waitForTimeout(800);
          continue;
        }
        log("  gap " + gap.gapX + " ncc " + (gap.score || 0).toFixed(4) + " margin "
          + (gap.margin === null ? "n/a" : gap.margin.toFixed(4)) + " scale " + (gap.scale || 1).toFixed(3)
          + " knob " + JSON.stringify(gap.knob) + " track " + JSON.stringify(gap.track)
          + " -> drag " + gap.distance.toFixed(1) + "px");
        const asked = gap.distance + dragBias;
        const landed = await drag(page, gap.knob || gap.handle, asked);
        const settled = parseFloat(String(landed.settled));
        let correction = '';
        if (Number.isFinite(settled)) {
          // The widget moves the piece a constant distance less than the pointer
          // travel, so the residual *is* the bias: assign it. Adding it (as the first
          // version did) drifts upward on every attempt and walks the piece further
          // past the gap each time - visible in the add-on logs as 32.5 -> 43.5 ->
          // 56.5 -> 67.5 with a dead-zone of 11. The guard rejects bogus reads.
          const residual = asked - settled;
          if (residual >= 0 && residual <= 80 && Math.abs(residual) > 2) {
            dragBias = residual;
            correction = ' -> bias ' + dragBias.toFixed(1);
          }
        }
        log("  asked " + asked.toFixed(1) + " (gap " + gap.distance.toFixed(1) + " + bias "
          + dragBias.toFixed(1) + ") landed " + landed.settled + correction);
        const result = await waitForVerdict(page, 6000);
        log("  verdict " + JSON.stringify(result).slice(0, 160));
        if (result && result.ok) {
          return { ok: true, validate: result.validate, captchaId, attempts: attempt, ms: Date.now() - started };
        }
        lastError = result && result.error ? result.error : 'no verdict after the drag';
        log('  widget said: ' + lastError);
        await capture('attempt' + attempt + '-miss');
        break;
      }
    }
  } finally {
    await context.close().catch(() => {});
    if (own) await own.close().catch(() => {});
  }

  return { ok: false, captchaId, attempts, ms: Date.now() - started, error: lastError };
}

// ---- one-shot CLI -----------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('solver.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const result = await solve({
    captchaId: flag('--captcha-id', APP_CAPTCHA_ID),
    mode: flag('--mode', 'embed'),
    timeoutMs: Number(flag('--timeout-ms', 45000)),
    attempts: Number(flag('--attempts', 4)),
    debugDir: flag('--debug-dir', ''),
    log: (...args) => console.error(...args),
  });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
