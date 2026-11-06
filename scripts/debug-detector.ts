/* frame-by-frame probe for the falling scenarios */
import { ShotDetector } from '../src/lib/detector';
import type { Calibration, DetectorEvent } from '../src/lib/types';

const PW = 480, PH = 270;
const TURF_LUM = 110, BALL_LUM = 215;
const CAL: Calibration = { ballNX: 0.25, ballNY: 0.5, ballNR: 0.028, hitDir: 1 };
const BALL_X = CAL.ballNX * PW, BALL_Y = CAL.ballNY * PH, BALL_R = CAL.ballNR * PH;
const FPS = 60;

const ball = { on: false, x: BALL_X, y: BALL_Y, px: BALL_X, py: BALL_Y };

let noiseSeed = 999;
function noise(): number { noiseSeed = (noiseSeed * 1103515245 + 12345) % 2147483648; return ((noiseSeed >>> 7) % 7) - 3; }

function distSeg(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const abx = bx - ax, aby = by - ay, apx = px - ax, apy = py - ay;
  const l2 = abx * abx + aby * aby;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / l2));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function lumAt(px: number, py: number): number {
  let l = TURF_LUM + noise();
  if (ball.on && distSeg(ball.px, ball.py, ball.x, ball.y, px, py) <= BALL_R) l = BALL_LUM + noise() * 0.3;
  return l;
}

const fakeCtx = {
  drawImage: () => {},
  getImageData(x: number, y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    let k = 0;
    for (let y2 = 0; y2 < h; y2++) for (let x2 = 0; x2 < w; x2++) {
      const l = lumAt(x + x2, y + y2);
      data[k++] = l; data[k++] = l; data[k++] = l; data[k++] = 255;
    }
    return { data, width: w, height: h };
  }
};
const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0 };
const fakeVideo = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;

const mode = process.argv[2] ?? 'pickup';
const det = new ShotDetector();
const events: DetectorEvent[] = [];
let frameIdx = 0;
det.onEvent = (e) => { events.push(e); console.log(`  [ev] frame ${frameIdx}: ${JSON.stringify(e)}`); };
det.attach(fakeCanvas as unknown as HTMLCanvasElement);
det.configure(CAL, 1280, 720, 55);

function step(n: number, label: string) {
  for (let i = 0; i < n; i++) {
    det.update(fakeVideo, frameIdx / FPS, frameIdx * 1000 / FPS);
    frameIdx++;
    if (modes.includes('verbose')) console.log(`frame ${frameIdx - 1} state=${det.state} t=${(frameIdx / FPS).toFixed(3)}`);
  }
  if (label) console.log(`after ${label}: state=${det.state} frames=${frameIdx}`);
}
const modes = process.argv.slice(3);

// arm
ball.on = true;
step(120, 'arm');

if (mode === 'pickup') {
  ball.on = false;
  step(40, 'pickup');
}
if (mode === 'strike') {
  const speedPx = (40 * (BALL_R / 0.04267)) / FPS;
  for (let i = 0; i < 12; i++) {
    ball.px = ball.x; ball.py = ball.y;
    ball.x += speedPx;
    ball.y -= speedPx * Math.tan((10 * Math.PI) / 180);
    step(1, '');
    console.log(`  f${frameIdx - 1} state=${det.state} ball=(${ball.x.toFixed(0)},${ball.y.toFixed(0)})`);
  }
}
console.log('events:', JSON.stringify(events));
