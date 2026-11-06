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

const DEFAULT_OPTS: DetectorOptions = { minSpeedMps: 4, maxSpeedMps: 110 };

/** after arming, hold triggers this long so the hand leaving the ball doesn't fire */
const QUIET_HOLD_MS = 250;

/** after a false-trigger abort, hold triggers this long so the intruder doesn't re-fire */
const ABORT_QUIET_MS = 700;

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
  private lastCandArea = 0;
  private brightFrames = 0;

  private armedAtWall = 0;
  private goneFrames = 0;
  /** what fired the current recording: fast motion band or the spot-change signal */
  private triggeredBy: 'motion' | 'gone' = 'motion';

  private points: TrackedPoint[] = [];
  private recStartWall = 0;
  private staleFrames = 0;
  private cooldownUntilWall = 0;
  /** wall time until which triggers are held after a false-trigger abort */
  private quietUntilWall = 0;

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

    this.ballX = cal.ballNX * PROC_W;
    this.ballY = cal.ballNY * vh;
    this.ballR = Math.max(3, cal.ballNR * vh);

    // analysis rect = ball area padded generously, plus everything downrange
    const padX = this.ballR * 6;
    const y0 = Math.max(0, Math.floor((this.ballY - this.ballR * 16) / CELL)) * CELL;
    const y1 = Math.min(vh, Math.ceil(this.ballY + this.ballR * 16));
    const x0 = this.hitDir === 1 ? Math.max(0, Math.floor((this.ballX - padX) / CELL)) * CELL : 0;
    const x1 = this.hitDir === 1 ? PROC_W : Math.min(PROC_W, Math.ceil(this.ballX + padX));
    this.gx0 = x0;
    this.gy0 = y0;
    this.gw = Math.max(CELL, x1 - x0);
    this.gh = Math.max(CELL, y1 - y0);

    this.cols = Math.ceil(this.gw / CELL);
    this.rows = Math.ceil(this.gh / CELL);
    this.bg = new Float32Array(this.cols * this.rows).fill(-1);

    // Protect the resting ball's footprint from background adaptation: without
    // this, the running-average background slowly absorbs the white ball and
    // the detector "forgets" it after a couple of seconds.
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
    shotFps.value = shotFps.value * 0.9 + (1 / dt) * 0.1;

    ctx.drawImage(
      video,
      0, 0, video.videoWidth, video.videoHeight,
      0, 0, PROC_W, this.procH
    );
    const grid = this.lumGrid(ctx);

    switch (this.state) {
      case 'waiting': {
        this.stepWaiting(grid);
        break;
      }
      case 'armed': {
        return this.stepArmed(grid, wallT);
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
    this.lastCandArea = 0;
    this.brightFrames = 0;
  }

  private expectedBallArea(): number {
    // ceil(diameter/CELL)^2 in cells
    const d = (2 * this.ballR) / CELL;
    return Math.max(1, d * d);
  }

  private stepWaiting(grid: Float32Array) {
    // freeze: never let the running-average background eat the placed ball
    const comps = this.findComponents(grid, true);
    const expected = this.expectedBallArea();
    let cand: Component | null = null;
    for (const c of comps) {
      const inZone =
        Math.hypot(c.cx - this.ballX, c.cy - this.ballY) <= this.ballR * 2.6;
      if (!inZone) continue;
      const ratio = c.cells / expected;
      if (ratio < 0.25 || ratio > 2.6) continue;
      if (!cand || c.cells > cand.cells) cand = c;
    }

    // Template-free fallback: a white ball on turf/mat is a bright disc on a
    // darker ring. This finds a ball that was ALREADY on the tee when the
    // detector started scanning — it can never appear as a background diff.
    const bright = this.brightBallAtSpot(grid);
    if (bright) this.brightFrames++; else this.brightFrames = 0;

    if (cand) {
      if (
        this.lastCandX >= 0 &&
        Math.hypot(cand.cx - this.lastCandX, cand.cy - this.lastCandY) < this.ballR * 0.4 &&
        Math.abs(cand.cells - this.lastCandArea) / Math.max(1, this.lastCandArea) < 0.55
      ) {
        this.candFrames++;
      } else {
        this.candFrames = 1;
      }
      this.lastCandX = cand.cx;
      this.lastCandY = cand.cy;
      this.lastCandArea = cand.cells;
    } else {
      this.resetCandidate();
      // adapt slowly while waiting, but only when the zone is quiet — and
      // never blend the resting ball into the background
      this.adaptBackground(grid, 0.06, true);
    }

    if (this.candFrames >= 10 || (bright && this.brightFrames >= 10)) {
      this.armBall(grid);
    }
  }

  /** Arm on a confirmed ball: seed the whole frame (ball included) as armed bg. */
  private armBall(grid: Float32Array) {
    this.seedBackground(grid);
    this.state = 'armed';
    this.armedAtWall = performance.now();
    this.goneFrames = 0;
    this.resetCandidate();
    this.onEvent({ type: 'ballDetected' });
  }

  /**
   * True when the ball disc is clearly brighter than the ring around it —
   * a white/marked ball on turf or mat.
   */
  private brightBallAtSpot(grid: Float32Array): boolean {
    const diskAvg = this.avgCellsAround(grid, this.ballR * 1.2, this.ballR * 0, this.ballY, this.ballX);
    const ringAvg = this.avgCellsAround(grid, this.ballR * 2.8, this.ballR * 1.7, this.ballY, this.ballX);
    if (diskAvg === null || ringAvg === null) return false;
    return diskAvg - ringAvg > 40 && diskAvg > 90; // bright disc + contrast
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

  private stepArmed(grid: Float32Array, wallT: number): DetectorEvent | null {
    if (wallT - this.armedAtWall > 60_000) {
      this.resetToWaiting();
      return { type: 'armedTimeout' };
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
    // light change) — re-adapt around the protected ball and skip triggers
    const n = grid.length;
    if (this.lastActiveCount > n * 0.35) {
      this.adaptBackground(grid, 0.3, true);
      this.goneFrames = 0;
      return null;
    }

    const expected = this.expectedBallArea();

    // fast motion near the ball => shot in progress
    for (const c of comps) {
      const dxRange = (c.cx - this.ballX) * this.hitDir;
      const dyRange = Math.abs(c.cy - this.ballY);
      if (
        dxRange > this.ballR * 2 &&
        dxRange < this.ballR * 14 &&
        dyRange < this.ballR * 5 &&
        c.cells >= expected * 0.4
      ) {
        this.beginRecording(wallT, 'motion');
        return null;
      }
    }

    // otherwise: did the ball vanish from its spot?
    let gone = 0;
    for (const c of comps) {
      if (Math.hypot(cx(c) - this.ballX, c.cy - this.ballY) <= this.ballR * 2.4) {
        gone += c.cells;
      }
    }
    const goneCells = expected * 0.5;
    if (gone >= goneCells) {
      this.goneFrames++;
      if (this.goneFrames >= 2) {
        this.beginRecording(wallT, 'gone');
        return null;
      }
    } else {
      this.goneFrames = 0;
    }
    // adapt everything except the ball's own footprint, so a swinging stance
    // or lighting drift never erases the lock
    this.adaptBackground(grid, 0.05, true);
    return null;
  }

  private beginRecording(wallT: number, by: 'motion' | 'gone') {
    this.state = 'recording';
    this.triggeredBy = by;
    this.points = [];
    this.recStartWall = wallT;
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
      const dxRange = (c.cx - this.ballX) * this.hitDir;
      if (dxRange < this.ballR * 1.1) continue;
      if (!best) { best = c; continue; }
      const ref = last ?? { x: this.ballX, y: this.ballY };
      if (Math.hypot(cx(c) - ref.x, c.cy - ref.y) < Math.hypot(cx(best) - ref.x, best.cy - ref.y)) {
        best = c;
      }
    }

    let advanced = false;
    if (best) {
      if (!last) {
        this.points.push({ t: videoT, x: best.cx, y: best.cy });
        advanced = true;
      } else {
        const dx = best.cx - last.x;
        const dy = best.cy - last.y;
        const dtF = videoT - last.t;
        if (dtF > 0) {
          const dpx = Math.hypot(dx, dy);
          const speedMps = dpx / dtF / pxPerMeter;
          const dirOk = dx * this.hitDir > 0;
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
    if (this.staleFrames >= 4 || this.points.length >= 24 || (elapsed > 1500 && this.points.length >= 2)) {
      if (this.points.length >= 2) return this.finishShot();
      if (this.points.length === 0 && elapsed < 900) {
        // no ball-like motion: the trigger came from a hand, body or club
        if (this.triggeredBy === 'gone') {
          // the ball was picked up / removed, not struck: start over so the
          // next placement fresh-arms
          this.resetToWaiting();
          return { type: 'trackAborted', reason: 'ball-removed' };
        }
        // motion-triggered: some hand/body passed the band — stay armed
        return this.abortRecordingToArmed(wallT);
      }
      return this.finishShot(); // 1 point => disqualified with a visible message
    }
    if (elapsed > 1500 && this.points.length < 2) {
      if (this.points.length === 0) {
        if (this.triggeredBy === 'gone') {
          this.resetToWaiting();
          return { type: 'trackAborted', reason: 'ball-removed' };
        }
        return this.abortRecordingToArmed(wallT);
      }
      this.state = 'cooldown';
      this.cooldownUntilWall = wallT + 1000;
      this.points = [];
      return { type: 'shotDisqualified', reason: 'no-ball-track' };
    }
    this.adaptBackground(grid, 0.015);
    return null;
  }

  /** False trigger (motion without ball-like track): quietly return to armed. */
  private abortRecordingToArmed(wallT: number): DetectorEvent {
    this.state = 'armed';
    this.points = [];
    this.staleFrames = 0;
    this.goneFrames = 0;
    this.quietUntilWall = wallT + ABORT_QUIET_MS;
    return { type: 'trackAborted', reason: 'no-ball-motion' };
  }

  private finishShot(): DetectorEvent | null {
    const pts = this.points;
    this.points = [];
    this.state = 'cooldown';
    this.cooldownUntilWall = performance.now() + 1100;
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
      const dirDx = dx * this.hitDir;
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
