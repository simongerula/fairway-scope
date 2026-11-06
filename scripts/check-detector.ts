/**
 * Offline simulation of the ShotDetector state machine.
 *
 * Feeds synthetic 480x270 luminance frames (turf + ball + hand) into a real
 * ShotDetector through a fake canvas context, then asserts the transitions:
 *
 *   A  ball freshly placed      -> waiting -> armed (diff path)
 *   B  ball already on the tee  -> waiting -> armed (bright-disc path)
 *   C  ball picked up           -> armed -> waiting ('ball-removed')
 *   D  hand waved over the ball -> armed -> armed (quiet abort, no shot)
 *   E  real strike at 40 m/s   -> armed -> shot with sane metrics
 *   F  soft chip at 12 m/s     -> armed -> shot
 *
 * Run: npm run check:detector
 */
import { ShotDetector } from '../src/lib/detector';
import type { Calibration, DetectorEvent } from '../src/lib/types';

const PW = 480;
const PH = 270;
const FPS = 60;

const TURF_LUM = 110;
const BALL_LUM = 215;
const HAND_LUM = 160;
const HAND_R = 20;

const CAL: Calibration = { ballNX: 0.25, ballNY: 0.5, ballNR: 0.028, hitDir: 1 };
const BALL_X = CAL.ballNX * PW;      // 120
const BALL_Y = CAL.ballNY * PH;      // 135
const BALL_R = CAL.ballNR * PH;      // 7.56

interface BallState {
  on: boolean;
  x: number;
  y: number;
  /** previous position this frame — draws the motion-blur capsule */
  px: number;
  py: number;
}

const ball: BallState = { on: false, x: BALL_X, y: BALL_Y, px: BALL_X, py: BALL_Y };
let hand: { x: number; y: number } | null = null;

let noiseSeed = 12345;
function noise(): number {
  noiseSeed = (noiseSeed * 1103515245 + 12345) % 2147483648;
  return ((noiseSeed >>> 7) % 7) - 3;
}

function distToSegment(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function lumAt(px: number, py: number): number {
  let lum = TURF_LUM + noise();
  if (hand && Math.hypot(px - hand.x, py - hand.y) <= HAND_R) lum = HAND_LUM + noise() * 0.3;
  if (ball.on && distToSegment(ball.px, ball.py, ball.x, ball.y, px, py) <= BALL_R) lum = BALL_LUM + noise() * 0.3;
  return lum;
}

function buildFrame(w: number, h: number, ox: number, oy: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  let k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lum = lumAt(ox + x, oy + y);
      data[k++] = lum; data[k++] = lum; data[k++] = lum; data[k++] = 255;
    }
  }
  return data;
}

const fakeCtx = {
  drawImage: () => {},
  getImageData(x: number, y: number, w: number, h: number) {
    return { data: buildFrame(w, h, x, y), width: w, height: h };
  }
};

const fakeCanvas = {
  getContext: () => fakeCtx,
  width: 0,
  height: 0
};

const fakeVideo = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;

let frameIdx = 0;
function step(det: ShotDetector, events: DetectorEvent[], frames: number) {
  for (let i = 0; i < frames; i++) {
    const ev = det.update(fakeVideo, frameIdx / FPS, 5000 + (frameIdx * 1000) / FPS);
    if (ev) events.push(ev); // same contract as the app: consume returned events
    frameIdx++;
  }
}

let failures = 0;
(globalThis as { __DBG_DET?: boolean }).__DBG_DET = process.env.DBG_DET === '1';
function expect(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

function makeDetector(): { det: ShotDetector; events: DetectorEvent[] } {
  const det = new ShotDetector();
  const events: DetectorEvent[] = [];
  det.onEvent = (e) => events.push(e);
  det.attach(fakeCanvas as unknown as HTMLCanvasElement);
  det.configure(CAL, 1280, 720, 55);
  return { det, events };
}

function placeBall(dx: number, dy: number) {
  ball.on = true;
  ball.x = BALL_X + dx;
  ball.y = BALL_Y + dy;
  ball.px = ball.x;
  ball.py = ball.y;
}

function removeBall() {
  ball.on = false;
}

// scenario A: fresh placement -----------------------------------------------
console.log('A: ball freshly placed -> armed');
{
  const { det, events } = makeDetector();
  step(det, events, 40);
  expect(det.state === 'waiting', 'still waiting with empty tee');
  placeBall(-4, -4); // slightly off-center, like a real placement
  step(det, events, 110);
  expect(events.some((e) => e.type === 'ballDetected'), 'ballDetected emitted');
  expect(det.state === 'armed', 'armed after placement');
}

// scenario B: ball already on the tee from the start ------------------------
console.log('B: ball already on tee -> armed (bright-disc path)');
{
  const { det, events } = makeDetector();
  placeBall(5, -3); // present before scanning starts
  step(det, events, 120);
  expect(events.some((e) => e.type === 'ballDetected'), 'ballDetected emitted');
  expect(det.state === 'armed', 'armed via bright disc');
}

// scenario C: pickup ---------------------------------------------------------
console.log('C: ball picked up -> back to waiting (ball-removed)');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 120);
  expect(det.state === 'armed', 'armed first');
  removeBall();
  step(det, events, 60);
  const aborted = events.some((e) => e.type === 'trackAborted' && e.reason === 'ball-removed');
  expect(aborted, "trackAborted(ball-removed) emitted");
  expect(det.state === 'waiting', 'waiting after pickup');
  // re-place -> arms again
  placeBall(-2, 2);
  step(det, events, 120);
  const armedAgain = events.filter((e) => e.type === 'ballDetected').length >= 2;
  expect(armedAgain && det.state === 'armed', 're-arms on new placement');
}

// scenario D: hand waved over the armed ball --------------------------------
console.log('D: slow hand wave crossing the zone -> no shot, stays armed');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 120);
  expect(det.state === 'armed', 'armed first');
  // hand sweeps right-to-left-to-right past the ball at ~6 m/s
  const startX = BALL_X + 80;
  const speedPx = (6 * (BALL_R / 0.04267)) / FPS; // 6 m/s in px/frame
  for (let i = 0; i < 40; i++) {
    hand = { x: startX - i * speedPx, y: BALL_Y };
    step(det, events, 1);
  }
  hand = null;
  step(det, events, 40);
  const shot = events.some((e) => e.type === 'shot');
  const backArmed = det.state === 'armed';
  expect(!shot, 'no fake shot from the hand');
  expect(backArmed, 'still armed after the wave');
}

// scenario E: real strike -----------------------------------------------------
console.log('E: real strike 40 m/s @ 10° -> shot with sane metrics');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 230); // past the 3s lock confirmation (armed ~0.2s in)
  expect(det.state === 'armed', 'armed first');
  expect(events.some((e) => e.type === 'lockConfirmed'), 'lock confirmed before the strike');
  // 40 m/s at 60 fps, 10° launch
  const speedPx = (40 * (BALL_R / 0.04267)) / FPS; // ~118 px/frame
  for (let i = 0; i < 40; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += speedPx;
    ball.y -= speedPx * Math.tan((10 * Math.PI) / 180);
    step(det, events, 1);
  }
  const shot = events.find((e) => e.type === 'shot') as
    | { type: 'shot'; metrics: { ballSpeedMps: number; launchDeg: number; trackCount: number } }
    | undefined;
  expect(!!shot, 'shot event emitted');
  if (shot) {
    console.log(`       ballSpeed=${shot.metrics.ballSpeedMps.toFixed(1)} m/s, launch=${shot.metrics.launchDeg.toFixed(1)}°, points=${shot.metrics.trackCount}`);
    expect(shot.metrics.ballSpeedMps > 33 && shot.metrics.ballSpeedMps < 50, `speed plausible (${shot.metrics.ballSpeedMps.toFixed(1)})`);
    expect(shot.metrics.launchDeg > 5 && shot.metrics.launchDeg < 20, `launch plausible (${shot.metrics.launchDeg.toFixed(1)}°)`);
    expect(shot.metrics.trackCount >= 2, `enough track points (${shot.metrics.trackCount})`);
  }
  expect(det.state === 'cooldown' || det.state === 'waiting', `shot finishes into cooldown/waiting (got ${det.state})`);
}

// scenario F: soft chip 12 m/s ------------------------------------------------
console.log('F: soft chip 12 m/s -> shot');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 230); // past the 3s lock confirmation
  expect(det.state === 'armed', 'armed first');
  expect(events.some((e) => e.type === 'lockConfirmed'), 'lock confirmed before the chip');
  const speedPx = (12 * (BALL_R / 0.04267)) / FPS; // ~35 px/frame
  for (let i = 0; i < 40; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += speedPx;
    ball.y -= speedPx * Math.tan((25 * Math.PI) / 180);
    step(det, events, 1);
  }
  const shot = events.find((e) => e.type === 'shot') as
    | { type: 'shot'; metrics: { ballSpeedMps: number; launchDeg: number } }
    | undefined;
  expect(!!shot, 'shot event emitted');
  if (shot) {
    console.log(`       ballSpeed=${shot.metrics.ballSpeedMps.toFixed(1)} m/s, launch=${shot.metrics.launchDeg.toFixed(1)}°`);
    expect(shot.metrics.ballSpeedMps > 10 && shot.metrics.ballSpeedMps < 15, `speed plausible (${shot.metrics.ballSpeedMps.toFixed(1)})`);
  }
}

// scenario G: wedge flight only visible for one frame at the camera (30fps
// phones) -> departure shot estimated from the single streak position --------
console.log('G: 1-frame wedge departure -> estimated shot');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 200); // past the 3s lock confirmation
  expect(events.some((e) => e.type === 'lockConfirmed'), 'lockConfirmed after 3s');
  const speed = 12; // m/s
  const speedPx = (speed * (BALL_R / 0.04267)) / FPS;
  // 55° wedge: exits the top of the analysis strip after ~3 frames
  const vx = speedPx * Math.cos((55 * Math.PI) / 180);
  const vy = speedPx * Math.sin((55 * Math.PI) / 180);
  let visible = 0;
  for (let i = 0; i < 40; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += vx;
    ball.y -= vy;
    const stillIn = ball.y > BALL_Y - BALL_R * 14 && ball.x < PW;
    if (stillIn) visible++;
    if (!stillIn) {
      ball.on = false;
      break;
    }
    step(det, events, 1);
  }
  step(det, events, 30);
  const shot = events.find((e) => e.type === 'shot') as
    | { type: 'shot'; metrics: { ballSpeedMps: number; launchDeg: number; trackCount: number } }
    | undefined;
  expect(!!shot, `shot event emitted (streak visible ${visible} frames)`);
  if (shot) {
    console.log(`       est ballSpeed=${shot.metrics.ballSpeedMps.toFixed(1)} m/s, launch=${shot.metrics.launchDeg.toFixed(1)}°, track=${shot.metrics.trackCount}`);
    expect(shot.metrics.ballSpeedMps > 9 && shot.metrics.ballSpeedMps < 18, `speed estimate plausible (${shot.metrics.ballSpeedMps.toFixed(1)})`);
    expect(shot.metrics.launchDeg > 30 && shot.metrics.launchDeg <= 70, `launch estimate plausible (${shot.metrics.launchDeg.toFixed(1)}°)`);
  }
}

// scenario H: pickup after the lock beep is still not a hit ------------------
console.log('H: slow pickup after lock confirmation -> no shot');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 200);
  expect(events.some((e) => e.type === 'lockConfirmed'), 'lock confirmed');
  removeBall(); // gently pick the ball up: no ball-like motion anywhere
  step(det, events, 60);
  expect(!events.some((e) => e.type === 'shot'), 'no shot from a pickup');
  expect(events.some((e) => e.type === 'trackAborted' && e.reason === 'ball-removed'), 'ball-removed signal emitted');
  expect(det.state === 'waiting', 'waiting again after pickup');
}

// scenario I: early departure (before the 3s beep) does not count ------------
console.log('I: removal before lock confirmation -> no shot');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 60); // only 1s < LOCK_CONFIRM_MS
  expect(!events.some((e) => e.type === 'lockConfirmed'), 'not confirmed yet');
  removeBall();
  step(det, events, 60);
  expect(!events.some((e) => e.type === 'shot'), 'no shot before lock confirmation');
}

// scenario J: ball placed ~1s then moved quickly (their exact report) -> no
// shot, detector re-scans and re-locks at the moved position ------------------
console.log('J: quick ball move before the beep -> no shot, re-locks at new spot');
{
  const { det, events } = makeDetector();
  placeBall(0, 0);
  step(det, events, 60); // only 1s < LOCK_CONFIRM_MS
  expect(!events.some((e) => e.type === 'lockConfirmed'), 'not confirmed yet');
  const spotX = det.zoneGeometry().ballX;
  // move the ball quickly down-right (still plainly visible): 3 fast frames
  const movePerFrame = (12 * (BALL_R / 0.04267)) / FPS;
  for (let i = 0; i < 3; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += movePerFrame * 2;
    ball.y += movePerFrame * 0.5;
    step(det, events, 1);
  }
  ball.px = ball.x; ball.py = ball.y;
  step(det, events, 80); // ball now resting elsewhere: departure resolves
  expect(!events.some((e) => e.type === 'shot'), 'no shot from a pre-beep ball move');
  // re-lock at the moved position, then a departure counts again
  step(det, events, 230);
  expect(events.some((e) => e.type === 'lockConfirmed'), 're-locked at the moved position');
  const movedX = det.zoneGeometry().ballX;
  expect(movedX > spotX + 50, `lock moved to the new resting spot (${spotX.toFixed(0)} -> ${movedX.toFixed(0)})`);
  // strike: horizontal fast departure, still in frame for 2 frames
  for (let i = 0; i < 40; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += movePerFrame * 2;
    step(det, events, 1);
  }
  step(det, events, 40);
  const shot = events.find((e) => e.type === 'shot') as { type: 'shot'; metrics: { ballSpeedMps: number } } | undefined;
  expect(!!shot, 'departure after re-lock counts as a shot');
  if (shot) {
    console.log(`       recorded speed=${shot.metrics.ballSpeedMps.toFixed(1)} m/s (moved ~24 m/s)`);
    expect(shot.metrics.ballSpeedMps > 6 && shot.metrics.ballSpeedMps < 40, `plausible estimate (${shot.metrics.ballSpeedMps.toFixed(1)})`);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
