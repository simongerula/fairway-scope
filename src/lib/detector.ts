import type { Calibration, DetectorEvent, DetectorState, TrackedPoint } from './types';
import { GOLF_BALL_DIAMETER_M } from './types';
import { thresholdFor } from './settings';

/**
 * Frame-difference motion detector with a small state machine per shot:
 *
 *  waiting   -> scan the ball zone for a small, stable blob (the placed ball),
 *               then freeze the background there -> armed
 *  armed     -> recorder runs (owned by the UI). Trigger when the ball leaves
 *               the ball zone and/or fast motion appears near the ball.
 *  recording -> track the moving blob (the ball) frame to frame until it
 *               disappears or times out, then emit a shot.
 *  cooldown  -> let the background re-adapt, then back to waiting.
 *
 * All processing happens on a downscaled canvas (480 px wide). Calibration is
 * stored normalized, so zone geometry is derived from the current proc frame.
 */

const PROC_W = 480;
const CELL = 4; // px per analysis cell

export const shotFps = { value: 0 }; // rolling fps, for diagnostics display

export interface ZoneGeometry {
  rect: { x0: number; y0: number; w: number; h: number };
  ballX: number;
  ballY: number;
  ballR: number;
  hitDir: 1 | -1;
}

interface Component {
  cx: number;
  cy: number;
  cells: number;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
];

export interface DetectorOptions {
  /** min plausible ball speed, m/s */
  minSpeedMps: number;
  /** max plausible ball speed, m/s */
  maxSpeedMps: number;
}

const DEFAULT_OPTS: DetectorOptions = { minSpeedMps: 8, maxSpeedMps: 110 };

/** after arming, hold triggers this long so the hand leaving the ball doesn't fire */
const QUIET_HOLD_MS = 250;

/** after a false-trigger abort, hold triggers this long so the intruder doesn't re-fire
 *  (short: a real departure signal arrives 2-3 frames behind an aborted wobble) */
const ABORT_QUIET_MS = 250;

/** the ball must hold its spot this long (with a beep) before hits are accepted */
export const LOCK_CONFIRM_MS = 3000;

export class ShotDetector {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private procH = 360;
  private cols = 0;
  private rows = 0;
  private threshold = 26;

  private bg: Float32Array = new Float32Array(0);
  /** 1 = cell lies over the resting ball; never adapt those cells while waiting/armed. */
  private ballProtect: Uint8Array = new Uint8Array(0);
  /** summed-area table buffer for the free-placement scan */
  private satBuf: Float32Array = new Float32Array(0);
  /** number of motion-active cells in the last frame (scene-change guard). */
  private lastActiveCount = 0;
  private lastVideoT = -1;

  state: DetectorState = 'waiting';
  opts: DetectorOptions = { ...DEFAULT_OPTS };
  onEvent: (e: DetectorEvent) => void = () => {};

  // zone geometry (proc px)
  private ballX = 240;
  private ballY = 180;
  private ballR = 6;
  private hitDir: 1 | -1 = 1;
  private gx0 = 0;
  private gy0 = 0;
  private gw = PROC_W;
  private gh = 360;

  // waiting-state ball candidate
  private candFrames = 0;
  private lastCandX = -1;
  private lastCandY = -1;
  /** radius (px) of the last stable candidate — gates the 10-frame stability count */
  private candR = 0;
  /** direction of the current shot's flight as actually observed (+1 = right)
   *  — set from the first tracked flight point, not from the calibrated arrow */
  private shotDir: 1 | -1 = 1;

  private armedAtWall = 0;
  private goneFrames = 0;
  /** what fired the current recording: fast motion band or the spot-change signal */
  private triggeredBy: 'motion' | 'gone' = 'motion';
  /** true once the ball has held its spot for LOCK_CONFIRM_MS — then any
   * ball-like departure counts as a hit even without a full flight track */
  private lockConfirmed = false;
  /** video timestamp when the spot change was first seen (speed estimation) */
  private goneStartVideoT = -1;
  /** video timestamp when the current capture began */
  private recStartVideoT = -1;

  private points: TrackedPoint[] = [];
  private recStartWall = 0;
  private staleFrames = 0;
  private cooldownUntilWall = 0;
  /** wall time until which triggers are held after a false-trigger abort */
  private quietUntilWall = 0;
  /** wall time of the most recent update() call (used for wall-clock timers) */
  private lastWallT = performance.now();

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.bg = new Float32Array(0);
  }

  /** Call whenever the camera frame size or calibration changes. */
  configure(cal: Calibration, videoW: number, videoH: number, sensitivity: number) {
    const vh = Math.max(1, Math.round((videoH / videoW) * PROC_W));
    if (this.canvas && (this.canvas.width !== PROC_W || this.canvas.height !== vh)) {
      this.canvas.width = PROC_W;
      this.canvas.height = vh;
    }
    this.procH = vh;
    this.threshold = thresholdFor(sensitivity);
    this.hitDir = cal.hitDir;

    // full-frame analysis: the ball can be placed anywhere in view
    this.gx0 = 0;
    this.gy0 = 0;
    this.gw = PROC_W;
    this.gh = vh;
    this.cols = Math.ceil(this.gw / CELL);
    this.rows = Math.ceil(this.gh / CELL);
    this.bg = new Float32Array(this.cols * this.rows).fill(-1);

    if (this.state === 'waiting') {
      // cal position/size are just priors for the scan (where the user
      // *intends* to place + expected ball size), not a hard requirement
      this.ballX = cal.ballNX * PROC_W;
      this.ballY = cal.ballNY * vh;
      this.ballR = Math.max(3, cal.ballNR * vh);
      this.ballProtect = new Uint8Array(this.cols * this.rows); // empty until locked
    } else {
      // keep the currently locked ball anchored; refresh its protection mask
      this.rebuildBallProtect();
    }
  }

  procSize(): { w: number; h: number } {
    return { w: PROC_W, h: this.procH };
  }

  zoneGeometry(): ZoneGeometry {
    return { rect: { x0: this.gx0, y0: this.gy0, w: this.gw, h: this.gh }, ballX: this.ballX, ballY: this.ballY, ballR: this.ballR, hitDir: this.hitDir };
  }

  /** Points tracked for the shot currently being recorded (for the trail overlay). */
  livePoints(): readonly TrackedPoint[] {
    return this.points;
  }

  resetToWaiting() {
    this.state = 'waiting';
    this.points = [];
    this.candFrames = 0;
    this.goneFrames = 0;
    this.shotDir = 1;
    this.lockConfirmed = false;
    this.goneStartVideoT = -1;
    this.recStartVideoT = -1;
    this.staleFrames = 0;
    this.quietUntilWall = 0;
    if (this.bg.length) this.bg.fill(-1);
  }

  /**
   * Process one frame.
   * @param videoT exact video.currentTime (s) — used for frame timing
   * @param wallT performance.now() — used for wall-clock timeouts
   */
  update(video: HTMLVideoElement, videoT: number, wallT: number): DetectorEvent | null {
    const ctx = this.ctx;
    if (!ctx || !this.canvas || !video.videoWidth || videoT === this.lastVideoT) return null;
    const dt = this.lastVideoT < 0 ? 1 / 60 : videoT - this.lastVideoT;
    this.lastVideoT = videoT;
    this.lastWallT = wallT;
    shotFps.value = shotFps.value * 0.9 + (1 / dt) * 0.1;

    ctx.drawImage(
      video,
      0, 0, video.videoWidth, video.videoHeight,
      0, 0, PROC_W, this.procH
    );
    const grid = this.lumGrid(ctx);

    switch (this.state) {
      case 'waiting': {
        this.stepWaiting(grid, wallT);
        break;
      }
      case 'armed': {
        return this.stepArmed(grid, videoT, wallT);
      }
      case 'recording': {
        return this.stepRecording(grid, videoT, wallT);
      }
      case 'cooldown': {
        this.adaptBackground(grid, 0.25);
        if (wallT >= this.cooldownUntilWall) {
          this.state = 'waiting';
          this.resetCandidate();
        }
        break;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ states

  private resetCandidate() {
    this.candFrames = 0;
    this.lastCandX = -1;
    this.lastCandY = -1;
    this.candR = 0;
  }

  private expectedBallArea(): number {
    // ceil(diameter/CELL)^2 in cells
    const d = (2 * this.ballR) / CELL;
    return Math.max(1, d * d);
  }

  /** Rebuild the protection mask for the current anchored ball position. */
  private rebuildBallProtect() {
    this.ballProtect = new Uint8Array(this.cols * this.rows);
    const protR = this.ballR * 2.5;
    const pxL = this.ballX - this.gx0;
    const pyL = this.ballY - this.gy0;
    for (let r = 0; r < this.rows; r++) {
      const cellY = r * CELL + CELL / 2;
      if (Math.abs(cellY - pyL) > protR) continue;
      for (let c = 0; c < this.cols; c++) {
        const cellX = c * CELL + CELL / 2;
        if (Math.abs(cellX - pxL) <= protR) this.ballProtect[r * this.cols + c] = 1;
      }
    }
  }

  private stepWaiting(grid: Float32Array, wallT: number) {
    // free placement: scan the whole frame for a bright ball-sized disc
    const cand = this.scanBallCandidate(grid);
    let stable = false;
    if (cand) {
      stable =
        this.lastCandX >= 0 &&
        Math.hypot(cand.cx - this.lastCandX, cand.cy - this.lastCandY) < Math.max(3, cand.r * 0.7) &&
        Math.abs(cand.r - this.candR) <= Math.max(1, this.candR * 0.35);
      this.candFrames = stable ? this.candFrames + 1 : 1;
      this.lastCandX = cand.cx;
      this.lastCandY = cand.cy;
      this.candR = cand.r;
    } else {
      this.resetCandidate();
    }

    if (stable && this.candFrames >= 10 && cand) {
      this.ballX = cand.cx;
      this.ballY = cand.cy;
      this.ballR = Math.max(3, cand.r);
      this.rebuildBallProtect();
      this.armBall(grid, wallT);
    }
  }

  /** True once the ball has held its spot long enough to accept hits. */
  isLockConfirmed(): boolean {
    return this.lockConfirmed;
  }

  /** Arm on a confirmed ball: seed the whole frame (ball included) as armed bg. */
  private armBall(grid: Float32Array, wallT: number) {
    this.seedBackground(grid);
    this.state = 'armed';
    this.armedAtWall = wallT;
    this.lockConfirmed = false;
    this.goneFrames = 0;
    this.resetCandidate();
    this.onEvent({ type: 'ballDetected' });
  }

  /**
   * True when a ball-sized disc clearly brighter than the surrounding ring
   * sits near the calibrated spot. The disc is searched over small offsets so
   * a slightly off-center placement still counts.
   */
  private brightBallAtSpot(grid: Float32Array): boolean {
    const ringAvg = this.avgCellsAround(grid, this.ballR * 2.8, this.ballR * 1.7, this.ballY, this.ballX);
    if (ringAvg === null) return false;
    let best: number | null = null;
    const step = this.ballR * 0.6;
    for (let oy = -this.ballR * 1.2; oy <= this.ballR * 1.2 + 1e-6; oy += step) {
      for (let ox = -this.ballR * 1.2; ox <= this.ballR * 1.2 + 1e-6; ox += step) {
        const diskAvg = this.avgCellsAround(grid, this.ballR * 1.1, 0, this.ballY + oy, this.ballX + ox);
        if (diskAvg !== null && (best === null || diskAvg > best)) best = diskAvg;
      }
    }
    if (best === null) return false;
    return best - ringAvg > 40 && best > 90; // bright disc + contrast
  }

  /**
   * Scan the whole frame for a bright ball-sized disc on a uniformly darker
   * ring. Uses a summed-area table so every candidate window is O(1):
   * candidate positions on a 4px lattice × candidate radii, then the winner
   * is verified (and its radius refined) with exact disc/ring averages.
   */
  private scanBallCandidate(grid: Float32Array): { cx: number; cy: number; r: number } | null {
    const W = this.cols + 1;
    const sat = this.satBuf.length === W * (this.rows + 1) ? this.satBuf : new Float32Array(W * (this.rows + 1));
    this.satBuf = sat;
    for (let c = 0; c < W; c++) sat[c] = 0;
    for (let r = 0; r < this.rows; r++) {
      sat[(r + 1) * W] = 0;
      let rowSum = 0;
      for (let c = 0; c < this.cols; c++) {
        rowSum += grid[r * this.cols + c];
        sat[(r + 1) * W + c + 1] = sat[r * W + c + 1] + rowSum;
      }
    }
    const boxSum = (r0: number, r1: number, c0: number, c1: number) =>
      sat[(r1 + 1) * W + c1 + 1] - sat[r0 * W + c1 + 1] - sat[(r1 + 1) * W + c0] + sat[r0 * W + c0];

    const RADIIS = [4, 6, 8, 10, 12, 14]; // px
    let best: { cx: number; cy: number; r: number; score: number } | null = null;
    for (const rpx of RADIIS) {
      const half = Math.max(1, Math.round(rpx / CELL)); // disk half-window (cells)
      const ringTop = Math.round(half * 1.9);           // ring outer half (cells)
      for (let cr = ringTop; cr < this.rows - ringTop; cr++) {
        for (let cc = ringTop; cc < this.cols - ringTop; cc++) {
          const innerArea = (2 * half) * (2 * half);
          const outerArea = (2 * ringTop) * (2 * ringTop);
          const diskAvg = boxSum(cr - half, cr + half - 1, cc - half, cc + half - 1) / innerArea;
          const ringSum =
            boxSum(cr - ringTop, cr + ringTop - 1, cc - ringTop, cc + ringTop - 1) -
            boxSum(cr - half, cr + half - 1, cc - half, cc + half - 1);
          const ringAvg = ringSum / (outerArea - innerArea);
          // the ball's surrounding must be uniformly darker — this rejects
          // bright-background edges (wall/floor lines, shoe silhouettes)
          const topSum = boxSum(cr - ringTop, cr - half - 1, cc - ringTop, cc + ringTop - 1);
          const botSum = boxSum(cr + half, cr + ringTop - 1, cc - ringTop, cc + ringTop - 1);
          const bandArea = (ringTop - half) * (2 * ringTop);
          const uniform = Math.abs(topSum / bandArea - botSum / bandArea) < 26;
          if (!uniform) continue;
          const score = diskAvg - ringAvg;
          // slight bias toward the calibrated spot (the user's intent)
          const bx = cc * CELL + CELL / 2;
          const by = cr * CELL + CELL / 2;
          const biased = score + (Math.hypot(bx - this.ballX, by - this.ballY) < this.ballR * 4 && diskAvg > 90 ? 15 : 0);
          if (biased > 40 && (!best || biased > best.score)) {
            best = { cx: bx, cy: by, r: rpx, score: biased };
          }
        }
      }
    }
    if (!best) return null;

    // verify + measure the true radius by bright-area counting: the number of
    // cell centers above the disc/ring midpoint inside a probe window differs
    // from the disc area by a known factor for a circular disc, so
    //   n*CELL^2 = pi*r^2  ->  r = sqrt(n*CELL^2/pi)
    const px = best.cx;
    const py = best.cy;
    const disk = this.avgCellsAround(grid, best.r * 1.2, 0, py, px);
    const ring = this.avgCellsAround(grid, best.r * 2.8, best.r * 1.7, py, px);
    if (disk === null || ring === null) return null;
    if (disk - ring < 40) return null;
    const mid = ring + 0.5 * (disk - ring);
    const probe = Math.min(3.2 * best.r, 40);
    const cyL = py - this.gy0;
    const cxL = px - this.gx0;
    const win = Math.ceil(probe / CELL) + 1;
    const row0 = Math.max(0, Math.floor(cyL / CELL) - win);
    const row1 = Math.min(this.rows - 1, Math.ceil(cyL / CELL) + win);
    const col0 = Math.max(0, Math.floor(cxL / CELL) - win);
    const col1 = Math.min(this.cols - 1, Math.ceil(cxL / CELL) + win);
    let n = 0;
    for (let ri = row0; ri <= row1; ri++) {
      for (let ci = col0; ci <= col1; ci++) {
        // local coords in px relative to the ball center
        const lx = ci * CELL + CELL / 2 - cxL;
        const ly = ri * CELL + CELL / 2 - cyL;
        if (lx * lx + ly * ly > probe * probe) continue;
        // the grid starts at gy0/gx0; keep it a local full-frame index grid
        if (grid[ri * this.cols + ci] > mid) n++;
      }
    }
    const rMeasured = Math.sqrt((n * CELL * CELL) / Math.PI);
    const r = Math.min(24, Math.max(3, rMeasured));
    return { cx: px, cy: py, r };
  }

  /** count motion-active cells within ballR*2.4 of the spot (early exit at `needed`) */
  private activeCellsNearSpot(grid: Float32Array, needed: number): number {
    const r = this.ballR * 2.4;
    const win = Math.ceil(r / CELL) + 1;
    const cyL = this.ballY - this.gy0;
    const cxL = this.ballX - this.gx0;
    const row0 = Math.max(0, Math.floor(cyL / CELL) - win);
    const row1 = Math.min(this.rows - 1, Math.ceil(cyL / CELL) + win);
    const col0 = Math.max(0, Math.floor(cxL / CELL) - win);
    const col1 = Math.min(this.cols - 1, Math.ceil(cxL / CELL) + win);
    const th = this.threshold;
    let count = 0;
    for (let ri = row0; ri <= row1; ri++) {
      for (let ci = col0; ci <= col1; ci++) {
        const b = ri * this.cols + ci;
        if (this.bg[b] < 0) continue;
        if (Math.hypot(ci * CELL + CELL / 2 - cxL, ri * CELL + CELL / 2 - cyL) > r) continue;
        if (Math.abs(grid[b] - this.bg[b]) > th) {
          count++;
          if (count >= needed) return count;
        }
      }
    }
    return count;
  }

  /** average luminance of cells whose center lies within [r0, r1] of (cy, cx) */
  private avgCellsAround(
    grid: Float32Array,
    r1: number,
    r0: number,
    cyAbs: number,
    cxAbs: number
  ): number | null {
    let sum = 0;
    let cnt = 0;
    const ry = cyAbs - this.gy0;
    const rx = cxAbs - this.gx0;
    const maxR = Math.ceil(r1 / CELL) + 1;
    const row0 = Math.max(0, Math.floor(ry / CELL) - maxR);
    const row1 = Math.min(this.rows - 1, Math.ceil(ry / CELL) + maxR);
    const col0 = Math.max(0, Math.floor(rx / CELL) - maxR);
    const col1 = Math.min(this.cols - 1, Math.ceil(rx / CELL) + maxR);
    for (let r = row0; r <= row1; r++) {
      for (let c = col0; c <= col1; c++) {
        const cellX = c * CELL + CELL / 2;
        const cellY = r * CELL + CELL / 2;
        const d = Math.hypot(cellX - rx, cellY - ry);
        if (d < r0 || d > r1) continue;
        sum += grid[r * this.cols + c];
        cnt++;
      }
    }
    return cnt > 0 ? sum / cnt : null;
  }

  private stepArmed(grid: Float32Array, videoT: number, wallT: number): DetectorEvent | null {
    if (wallT - this.armedAtWall > 60_000) {
      this.resetToWaiting();
      return { type: 'armedTimeout' };
    }

    // after the ball holds its spot for LOCK_CONFIRM_MS, departures count as
    // hits even without a full flight track (30fps phones simply can't track
    // fast balls long enough)
    if (!this.lockConfirmed && wallT - this.armedAtWall >= LOCK_CONFIRM_MS) {
      this.lockConfirmed = true;
      this.onEvent({ type: 'lockConfirmed' });
      return null;
    }

    // right after a false trigger (hand/body crossing the zone) hold still for
    // a moment so the intruder doesn't immediately re-trigger the detector
    if (wallT - this.armedAtWall < QUIET_HOLD_MS || wallT < this.quietUntilWall) {
      this.adaptBackground(grid, 0.05, true);
      this.goneFrames = 0;
      return null;
    }

    const comps = this.findComponents(grid, true);

    // someone/something moved most of the scene (a body walks through, big
    // light change): adapt around the protected ball and skip the fast-motion
    // pre-trigger. The spot-change check below stays live — suppressing it
    // here would swallow real swings (club sweep + blur light up the ROI at
    // impact), and its false positives resolve through the outcome logic.
    let bigSceneChange = false;
    if (this.lastActiveCount > grid.length * 0.35) {
      bigSceneChange = true;
      this.adaptBackground(grid, 0.3, true);
    }

    const expected = this.expectedBallArea();
    const goneCells = expected * 0.5;

    // fast motion near the ball => shot in progress
    if (!bigSceneChange) {
      for (const c of comps) {
        const dxRange = (c.cx - this.ballX) * this.hitDir;
        const dyRange = Math.abs(c.cy - this.ballY);
        if (
          dxRange > this.ballR * 2 &&
          dxRange < this.ballR * 14 &&
          dyRange < this.ballR * 5 &&
          c.cells >= expected * 0.4
        ) {
          this.beginRecording(wallT, 'motion', videoT);
          return null;
        }
      }
    }

    // otherwise: did the ball vanish from its spot?
    // (count motion cells near the spot itself — a leaving ball's streak is
    // still connected to the spot for a frame, so blob centroids mislead)
    const gone = this.activeCellsNearSpot(grid, goneCells);
    if (gone >= goneCells) {
      if (this.goneFrames === 0) this.goneStartVideoT = videoT; // first changed frame
      this.goneFrames++;
      if (this.goneFrames >= 2) {
        this.beginRecording(wallT, 'gone', videoT);
        return null;
      }
    } else {
      this.goneFrames = 0;
    }
    // adapt everything except the ball's own footprint, so a swinging stance
    // or lighting drift never erases the lock (bigSceneChange already adapted)
    if (!bigSceneChange) this.adaptBackground(grid, 0.05, true);
    return null;
  }

  private beginRecording(wallT: number, by: 'motion' | 'gone', videoT: number) {
    this.state = 'recording';
    this.triggeredBy = by;
    this.recStartVideoT = videoT;
    this.recStartWall = wallT;
    this.points = [];
    this.staleFrames = 0;
    this.goneFrames = 0;
  }

  private stepRecording(grid: Float32Array, videoT: number, wallT: number): DetectorEvent | null {
    const comps = this.findComponents(grid, true);
    const expected = this.expectedBallArea();
    const pxPerMeter = this.ballR / GOLF_BALL_DIAMETER_M;

    // nearest plausible blob to the previous point
    let best: Component | null = null;
    const last = this.points[this.points.length - 1];
    for (const c of comps) {
      // upper bound is generous: motion blur spreads a fast ball into a long
      // streak (a 30+ m/s ball paints many times the resting-ball area)
      if (c.cells < expected * 0.18 || c.cells > expected * 40) continue;
      if (this.points.length === 0) {
        // first flight point: accept ANY direction (the calibrated arrow is
        // only a hint). The trigger already consumed the frame where the ball
        // left the spot, so by now a fast ball's streak is 1-2 frames of
        // flight away — allow generous reach, the second point's speed gate
        // (and for gone-triggers the departure estimator) does the filtering.
        const dist0 = Math.hypot(cx(c) - this.ballX, c.cy - this.ballY);
        if (dist0 <= this.ballR * 1.1 || dist0 > this.ballR * 40) continue;
        // reject geometry that no struck ball produces: farther below the
        // spot's line than outward
        if (c.cy - this.ballY > 0.9 * dist0) continue;
      } else {
        // later blobs must stay on the side the flight actually went
        if ((cx(c) - this.ballX) * this.shotDir < this.ballR * 1.1) continue;
      }
      if (!best) { best = c; continue; }
      const ref = last ?? { x: this.ballX, y: this.ballY };
      if (Math.hypot(cx(c) - ref.x, c.cy - ref.y) < Math.hypot(cx(best) - ref.x, best.cy - ref.y)) {
        best = c;
      }
    }

    let advanced = false;
    if (best) {
      if (!last) {
        this.points.push({ t: videoT, x: cx(best), y: best.cy });
        advanced = true;
      } else {
        const dx = cx(best) - last.x;
        const dy = best.cy - last.y;
        const dtF = videoT - last.t;
        if (dtF > 0) {
          const dpx = Math.hypot(dx, dy);
          const speedMps = dpx / dtF / pxPerMeter;
          if (this.points.length === 1) {
            // first pair: the flight's own motion fixes its direction
            this.shotDir = dx >= 0 ? 1 : -1;
          }
          const dirOk = dx * this.shotDir > 0;
          // distance cap is the whole view: a real ball at 30-70 m/s jumps
          // 100+ px per frame, anything tighter would reject every shot
          if (dirOk && speedMps > this.opts.minSpeedMps && speedMps < this.opts.maxSpeedMps && dpx < PROC_W) {
            this.points.push({ t: videoT, x: best.cx, y: best.cy });
            advanced = true;
          }
        }
      }
    }

    this.staleFrames = advanced ? 0 : this.staleFrames + 1;

    const elapsed = wallT - this.recStartWall;
    if (this.staleFrames >= 4 || this.points.length >= 24 || elapsed > 1500) {
      if (this.points.length >= 2) return this.finishShot();

      // 0-1 points is never a track. Estimate what actually moved:
      // a lone point's distance from the spot since the departure implies a
      // speed — ball-like means a real (partially tracked) hit.
      const dtStart = this.triggeredBy === 'gone' ? this.goneStartVideoT : this.recStartVideoT;
      const p0 = this.points[0];
      let impliedMps = 0;
      if (p0) {
        // the ball left ~1 frame BEFORE the spot change was first registered
        const fps = Math.max(10, shotFps.value || 30);
        const departureT = dtStart - 1 / fps;
        const dt = p0.t - departureT;
        if (dt > 1e-3) {
          impliedMps = Math.hypot(p0.x - this.ballX, p0.y - this.ballY) / pxPerMeter / dt;
        }
      }
      if (p0 && impliedMps >= this.opts.minSpeedMps) {
        if (this.triggeredBy === 'gone') {
          // ball-like departure from its known spot: a real (partially
          // tracked) hit — estimate metrics
          return this.finishDepartureShot(pxPerMeter);
        }
        // motion-triggered: a single blob can't be trusted, stay armed
        return this.abortRecordingToArmed(wallT);
      }
      if (this.triggeredBy === 'gone') {
        // the ball left its spot with no ball-like motion: it was picked up,
        // not struck — start over so the next placement fresh-arms
        this.resetToWaiting();
        return { type: 'trackAborted', reason: 'ball-removed' };
      }
      // motion-triggered (fast blob passed the band): hand/body/club — stay armed
      return this.abortRecordingToArmed(wallT);
    }
    this.adaptBackground(grid, 0.015);
    return null;
  }

  /**
   * A confirmed hit whose flight we only caught in one frame (30fps phones).
   * Speed is estimated from the streak's displacement since the spot change,
   * launch angle from its direction — practice-grade, not lab-grade.
   */
  private finishDepartureShot(pxPerMeter: number): DetectorEvent {
    const p0 = this.points[0];
    const pointsSnapshot = this.points.slice();
    this.points = [];
    this.state = 'cooldown';
    this.cooldownUntilWall = this.lastWallT + 1100;
    if (this.bg.length) this.bg.fill(-1); // ball is gone: re-seed background
    const fps = Math.max(10, shotFps.value || 30);
    const dtStart = this.triggeredBy === 'gone' ? this.goneStartVideoT : this.recStartVideoT;
    const departureT = dtStart - 1 / fps;
    const dt = Math.max(1e-3, p0.t - departureT);
    const raw = Math.hypot(p0.x - this.ballX, p0.y - this.ballY) / pxPerMeter / dt;
    const speed = Math.min(this.opts.maxSpeedMps, Math.max(this.opts.minSpeedMps, raw));
    const dirDx = Math.abs(p0.x - this.ballX); // forward component is direction-independent
    const dirDyUp = -(p0.y - this.ballY);
    const launchDeg = Math.min(70, Math.max(-25, Math.atan2(dirDyUp, dirDx) * (180 / Math.PI)));
    return { type: 'shot', metrics: { ballSpeedMps: speed, launchDeg, trackCount: 1 }, points: pointsSnapshot };
  }

  /** False trigger (motion without ball-like track): quietly return to armed. */
  private abortRecordingToArmed(wallT: number): DetectorEvent {
    this.state = 'armed';
    this.points = [];
    this.staleFrames = 0;
    this.goneFrames = 0;
    // if the 3s lock-confirmation hadn't finished yet, restart its timer
    if (!this.lockConfirmed) this.armedAtWall = wallT;
    this.quietUntilWall = wallT + ABORT_QUIET_MS;
    return { type: 'trackAborted', reason: 'no-ball-motion' };
  }

  private finishShot(): DetectorEvent | null {
    const pts = this.points;
    this.points = [];
    this.state = 'cooldown';
    this.cooldownUntilWall = this.lastWallT + 1100;
    // the ball has left: the background no longer describes the scene
    // (protected spot cells still show the ball). Wipe so the cooldown
    // re-seeds from the real current frame.
    if (this.bg.length) this.bg.fill(-1);
    if (pts.length < 2) {
      return { type: 'shotDisqualified', reason: 'no-ball-track' };
    }
    const pxPerMeter = this.ballR / GOLF_BALL_DIAMETER_M;
    const speeds: number[] = [];
    const angles: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const dtS = Math.max(1e-3, pts[i].t - pts[i - 1].t);
      speeds.push(Math.hypot(dx, dy) / dtS / pxPerMeter);
      // launch angle: displacement above horizontal, in flight direction
      // (direction-independent: |dx| as the forward component — the flight
      // direction is already enforced by the shotDir gate on tracking)
      const dirDx = Math.abs(dx);
      const dirDyUp = -dy;
      angles.push(Math.atan2(dirDyUp, dirDx) * (180 / Math.PI));
    }
    let v = speeds.length ? Math.max(...speeds) : 0;
    if (!isFinite(v)) v = 0;
    v = Math.min(110, Math.max(1, v));
    const anglesSorted = angles.slice().sort((a, b) => a - b);
    const median = anglesSorted[Math.floor(anglesSorted.length / 2)] ?? 0;
    const launchDeg = Math.min(70, Math.max(-25, median));
    return { type: 'shot', metrics: { ballSpeedMps: v, launchDeg, trackCount: pts.length }, points: pts };
  }

  // ------------------------------------------------------------------ vision

  private lumGrid(ctx: CanvasRenderingContext2D): Float32Array {
    const img = ctx.getImageData(this.gx0, this.gy0, this.gw, this.gh).data;
    const grid = new Float32Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      const py = r * CELL + (CELL >> 1); // local to the ROI image
      if (py >= this.gh) break;
      for (let c = 0; c < this.cols; c++) {
        const px = c * CELL + (CELL >> 1);
        if (px >= this.gw) break;
        const i = (py * this.gw + px) * 4;
        const gi = r * this.cols + c;
        if (i + 2 < img.length) {
          grid[gi] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
        }
      }
    }
    return grid;
  }

  private findComponents(grid: Float32Array, freeze = false): Component[] {
    const n = grid.length;
    const comps: Component[] = [];
    if (this.bg.length !== n) return comps;
    const active = new Uint8Array(n);
    const th = this.threshold;
    let activeCount = 0;
    for (let i = 0; i < n; i++) {
      if (this.bg[i] < 0) continue;
      const a = Math.abs(grid[i] - this.bg[i]) > th ? 1 : 0;
      active[i] = a;
      activeCount += a;
    }
    this.lastActiveCount = activeCount;
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!active[i] || seen[i]) continue;
      stack.length = 0;
      stack.push(i);
      seen[i] = 1;
      let sumX = 0, sumY = 0, cnt = 0;
      while (stack.length) {
        const q = stack.pop()!;
        const cc = q % this.cols;
        const rr = (q - cc) / this.cols;
        sumX += this.gx0 + cc * CELL + CELL / 2;
        sumY += this.gy0 + rr * CELL + CELL / 2;
        cnt++;
        for (let d = 0; d < 8; d++) {
          const nc = cc + NEIGHBORS[d][0];
          const nr = rr + NEIGHBORS[d][1];
          if (nc < 0 || nc >= this.cols || nr < 0 || nr >= this.rows) continue;
          const bQ = nr * this.cols + nc;
          if (active[bQ] && !seen[bQ]) {
            seen[bQ] = 1;
            stack.push(bQ);
          }
        }
      }
      if (cnt > 0) {
        comps.push({ cx: sumX / cnt, cy: sumY / cnt, cells: cnt });
      }
      if (comps.length > 40) break;
    }
    comps.sort((a, b) => b.cells - a.cells);
    return comps;
  }

  private adaptBackground(grid: Float32Array, rate: number, protect = false) {
    const n = grid.length;
    for (let i = 0; i < n; i++) {
      // unset cells must always be seeded, including protected ones — a cell
      // that never got a value can never show motion (bg < 0 is skipped in
      // findComponents)
      if (this.bg[i] < 0) {
        this.bg[i] = grid[i];
        continue;
      }
      // after seeding, protected cells (the resting ball) never adapt
      if (protect && this.ballProtect[i]) continue;
      this.bg[i] += (grid[i] - this.bg[i]) * rate;
    }
  }

  /** Seed the running background with the current frame (used when arming). */
  private seedBackground(grid: Float32Array) {
    this.bg.set(grid);
  }
}

function cx(c: Component): number {
  return c.cx;
}
