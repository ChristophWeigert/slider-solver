# What the live widget actually looks like (measured 2026-10-10)

Recorded from a real solve attempt, so the next pass does not have to rediscover it.

## DOM

```html
<div class="yidun yidun--jigsaw yidun--embed yidun--size-small">
  <div class="yidun_bgimg">                         <!-- wrapper, 320px wide -->
    <img class="yidun_bg-img" src="https://necaptcha.nosdn.127.net/<hash>.jpg">
    <img class="yidun_jigsaw" src="https://necaptcha.nosdn.127.net/<hash>.png" style="left: 185.5px;">
  </div>
  <div class="yidun_control yidun_control--moving" role="button">
    <div class="yidun_slide_indicator" style="height:40px; width:236px"></div>
  </div>
</div>
```

* Background: a **JPG photo**; piece: a **PNG sprite** whose `style.left` is the drag
  result and whose alpha is the jigsaw silhouette.
* There is **no `.yidun_slider`**. The knob is `.yidun_slide_indicator`, and it is a
  *progress bar*: its `width` grows from 0 to the knob's position. So its **right edge**
  is the knob, not its centre. Using the centre (our `.yidun_control div` fallback)
  starts the drag ~118px into the track.
* `left` tracks the mouse delta roughly 1:1 in CSS pixels, so the drag distance must be
  the gap position in CSS pixels, i.e. `gap_x_image * (rendered_width / natural_width)`.
  The art is not 1:1 (we measured scale ≈ 0.94), which is why unscaled drags overshoot.
* Verification is asynchronous. After `mouse.up()` the control still carried
  `yidun_control--moving` when read 900ms later, and `window.__captchaResult` was still
  null: either the widget needs longer, or the release did not end the drag. Query
  `--moving` and wait seconds, not milliseconds.

## Why the current gap detection is wrong

`findGap` minimises the squared difference between the piece's opaque pixels and the
background. For this variant the background **hole is a darkened region**, and the piece
sprite holds the *photo content that belongs in it*: inside the hole the two cannot
match. The score therefore minimises wherever the photo happens to resemble the piece,
which is why the answer was sometimes plausible (247px) and sometimes tiny-margin noise
(margin 264 vs 160000).

Better: score candidates by how much **darker the background is under the piece's alpha
mask than in a ring just outside it** (or brighter, for the inverse variant - take the
absolute difference). That is the hole, and it is what the widget checks.

## Also worth knowing

* The CDN sends no `Access-Control-Allow-Origin`, so the images are re-served through
  Playwright's own fetch with the header added (`openWidget`). Without that,
  `getImageData` throws on a tainted canvas.
* The widget starts as `yidun--loading` and has no images for the first second or two:
  "slider images not found" early in the loop is normal, not a bug.
* `cstaticdun.126.net` served SDK `2.28.5` in every attempt.
* The captcha also offers `yidun_avoid-*` (obstacle) and `yidun_inference*` variants; only
  the jigsaw is handled here.
