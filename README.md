# xpeng-slider-solver

A container you host that solves the XPENG login slider captcha (NetEase Yidun)
headlessly, so renewing credentials stops needing a human.

**Status: working.** Against the live app captcha it returns a `validate` in about
14 seconds, on the second attempt: the first drag measures the widget's constant
pointer dead-zone (a piece lands ~10.5px short of the pointer travel), and every
attempt after that is aimed with the learned bias. Details in
[NOTES-yidun.md](NOTES-yidun.md).

## Why this exists

The toolkit's onboarding needs exactly one human action: dragging XPENG's slider
so the challenge can be registered and `pwdLogin` can be retried. Everything else
is plain HTTP. That single drag is also the reason an install cannot recover on
its own when its session dies — and sessions do die: we measured three of them on
two accounts, each ending about **two hours after the login** (the access token's
`expiresIn=7200`), with the refresh loop working perfectly until the moment the
server retired the session. A refresh cannot extend it.

So the missing piece for anything unattended is a solver. This is it: the same
approach as the toolkit's `tools/solve_captcha.mjs` — render the real widget at
XPENG's own origin with the real SDK, read the `validate` the SDK returns — with
the drag performed by code instead of a hand.

For your **own** accounts, on infrastructure you control. See Caveats.

## Install

### Home Assistant OS or Supervised - as an add-on

Settings -> Add-ons -> Add-on Store -> the three-dot menu -> Repositories, add
`https://github.com/xpengtoolkit/slider-solver` (this repository is an add-on
repository), then install **XPENG slider solver**.

Set `solver_token` in the add-on's Configuration tab and start it. It is then
reachable at `http://<your-ha-host>:8080`, has a small status panel in the
sidebar, and keeps its debug artifacts under `/data/debug` (persistent).

Notes for the add-on: Chromium is in the image, so expect a 1-2 GB build the
first time; `amd64` and `aarch64` only; one solve at a time, a few hundred MB of
RAM while solving and almost nothing when idle.

### Anywhere Docker runs

```bash
docker build -t xpeng-slider-solver ./slider_solver
docker run -d --name slider-solver \
    -p 8080:8080 \
    -e SOLVER_TOKEN='pick-something-long' \
    -v "$PWD/debug:/debug" \
    xpeng-slider-solver
```

Then:

Without Docker, on a machine with Node 20+ and a Chromium:

```bash
npm install
node slider_solver/solver.mjs --debug-dir ./debug          # one shot, JSON on stdout
```

## API

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/healthz` | liveness, whether the browser is up, solve/failure counters |
| `POST` | `/solve` | `{"captchaId"?, "mode"?, "timeoutMs"?, "attempts"?}` → `{"ok":true,"validate":"…"}` or `{"ok":false,"error":"…"}` |

Defaults: the **app** captcha id (`f6c14777879d4a75b683b29be6709db6`), `mode=embed`,
45 s per attempt, 4 attempts. Solves are serialised — the browser is shared, and
Yidun risk-scores parallel attempts from one address.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `SOLVER_TOKEN` | *(unset)* | if set, required as `Authorization: Bearer …` |
| `DEBUG_DIR` | `/debug` | screenshots + DOM of failed attempts |
| `SOLVE_TIMEOUT_MS` | `45000` | per attempt |
| `SOLVE_ATTEMPTS` | `4` | attempts before giving up |
| `DRAG_BIAS_PX` | `0` (`10.5` in the add-on) | the widget's constant pointer dead-zone; measured on every solve, so this only saves the first attempt after a start |
| `HEADLESS` | `true` | set `false` to watch it solve (needs a display) |
| `XPENG_CAPTCHA_SDK` | `https://cstaticdun.126.net/load.min.js` | override the widget SDK |

## Wiring it into the toolkit (next step)

`tools/onboard_email_login.py` currently launches `solve_captcha.mjs` for the
human drag and then POSTs the returned `validate` to
`/verification/app/v3/drag/validate` with the session's `Xp-Xid` header. The
solver is a drop-in for the drag half:

1. add `--captcha-solver http://host:8080` (and `--captcha-solver-token`);
2. when set, `POST /solve` instead of launching a browser, and use the returned
   `validate` as the validated challenge;
3. everything after that is unchanged — guardian token, `pwdLogin` retry, token
   write.

With that in place the entire onboarding is headless, which is what makes an
automatic re-login on `12010202` (or on a timer shorter than the ~2 h session
cap) a real option instead of a theory.

## When it fails

It will, at first — a captcha solver is never finished, and Yidun tunes its risk
model. Set `DEBUG_DIR` (the compose above bind-mounts `./debug`) and every failed
attempt leaves:

* `attemptN-miss.png` — what the widget looked like,
* `attemptN-miss.html` — its DOM, which is where the selectors come from,
* `attemptN-nogap.html` — the case where the images were not found at all.

Send those two files plus the server log and the fix is usually obvious: either a
selector changed (`findGap` in `solver.mjs` has the candidate list) or the drag
needs a different shape (`trajectory`).

The two fragile parts, in order of how often they break:

1. **Selectors** — `.yidun_bg-img`, `.yidun_jigsaw`, `.yidun_slider`. Yidun
   renames classes between widget versions.
2. **Trajectory** — endpoint-only motion is trivially detectable. The current
   shape is ease-out cubic with overshoot, jitter and uneven frame timing.

The gap detection itself is the robust part: it correlates the piece sprite's
alpha mask against the background, so it does not depend on colour heuristics.

## Caveats

* **Your own accounts, your own host.** This automates a bot-detection challenge
  for accounts you own. Do not turn it into a public service, and do not expose
  it without `SOLVER_TOKEN` — it runs a browser and it can mint credentials for
  whatever account you point it at.
* **Sessions still die every ~2 h** (see above). The solver makes renewing
  painless; it does not remove the cap. Whether the cap is XPENG's policy for
  unattested clients or something about the device identity a login is bound to
  is still being measured.
* **Not a bypass of anything else.** It solves the puzzle; the account password,
  the mTLS client certificate and the tenant still have to be real.
