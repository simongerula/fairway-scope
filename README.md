# Home Launch Monitor

A camera-based golf launch monitor that runs in the browser and installs as a PWA.
Inspired by ShotVision-style apps: phone on a tripod **side-on** to the ball, no external
sensors, all estimates computed on-device.

## What it measures

| Metric | Method |
| --- | --- |
| Ball speed | Optical tracking: ball position between frames ÷ frame time, scaled by a one-time ball-diameter calibration |
| Launch angle | Direction of the tracked displacement vector |
| Carry / total / apex / hang | RK4 projectile integration with drag + Magnus lift (spin decays in flight), club-typical spin model |
| Spin | **Not measured** — modeled per club (tunable offset ±25%) |
| Swing clip | MediaRecorder starts when the ball is detected, stops after the shot |

Numbers are honest *estimates* — expect ±5–10% on speed/carry, launch angle roughly ±2–3°.
Calibrate against real turf distanaces and tune the spin offset to taste.

## The capture loop (as requested)

1. **Place the ball** in the marked circle on the live camera preview.
2. After ~10 stable frames the app **locks on** (`BALL LOCKED — swing away`) and starts recording.
3. Swing — motion detection tracks the ball for the first ~10–20 frames.
4. Recording stops, the shot is processed, metrics + clip are saved (IndexedDB), and
   the app waits for the next placed ball.

If the armed state times out (60 s) the recorder is discarded and the app goes back to waiting.
Whiffs / untracked balls raise a toast instead of saving a bogus shot.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (localhost is allowed camera access)
```

For phone use you need **HTTPS** (camera access restriction). Either:

```bash
npx vite-cfw ...   # or any tunnel
npm run build && npx serve dist --ssl
```

…or deploy `dist/` to any static host (Netlify/Vercel/GitHub Pages — free tier is plenty;
it's a pure client-side app).

### On iPhone

- iOS 16.4+ supports camera + PWA in Home Screen web apps.
- Open the site in Safari → Share → **Add to Home Screen** → launch from the icon.
- Landscape or portrait both work; keep the phone at **ball height**.

## Calibration (first run, ~2 minutes)

1. **Camera** — grant access, pick the back camera.
2. **Aim** — choose whether the ball flies left or right on screen.
3. **Ball** — drag the dashed circle onto the ball, size it to match the ball exactly
   (this sets the pixels-per-meter scale; a regulation ball is 42.67 mm).
4. **Test** — lock a ball, take practice swings, tune sensitivity.
5. **Defaults** — club, units, spin offset.

Reopen Setup → recalibrate any time (drill press, new mat height, different distance…).

## Tuning tips

- Plain background behind the ball beats a busy room.
- The faster the camera the better: iPhone gives 60 fps in good light (Frame-rate shows in the HUD);
  240 fps *only* works in dedicated Camera app modes, so don't expect it here.
- Bright, even light → less motion blur → better speed estimates.
- Distance from phone to ball: 0.5–1 m, at ball height, perpendicular to flight.

## Architecture

```
src/
  lib/
    types.ts      calibration + event types
    settings.ts   localStorage settings, club/spin table, sensitivity→threshold
    detector.ts   frame-diff motion detector + shot state machine (waiting→armed→recording→cooldown)
    physics.ts    RK4 w/ drag + Magnus lift + spin decay, unit helpers
    camera.ts     getUserMedia/MediaRecorder helpers
    storage.ts    IndexedDB shots (metrics, preview JPEG, clip blob), CSV export
  components/
    SetupWizard.tsx  5-step first-run calibration
    Practice.tsx     live view, HUD, auto-record, last-shot card w/ clip
    History.tsx      grouped shot log, averages, CSV export
  App.tsx / main.tsx / styles.css
```

## Dev extras

```bash
npm run check:physics   # sanity table vs. known Trackman-style numbers
npm run icons           # regenerate PWA icons (pure Node, no image deps)
```
