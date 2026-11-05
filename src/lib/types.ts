export type HitDir = 1 | -1;

/** Calibration stored in frame-normalized coordinates so it survives
 * resolution changes. Radius is normalized by frame height. */
export interface Calibration {
  /** Ball center x / frame width (0..1) */
  ballNX: number;
  /** Ball center y / frame height (0..1) */
  ballNY: number;
  /** Ball radius / frame height */
  ballNR: number;
  /** 1 = ball flies to the right of the screen, -1 = to the left */
  hitDir: HitDir;
}

export type DetectorState = 'waiting' | 'armed' | 'recording' | 'cooldown';

export interface TrackedPoint {
  /** seconds (video.currentTime) */
  t: number;
  /** processing-resolution px */
  x: number;
  y: number;
}

export interface ShotMetrics {
  ballSpeedMps: number;
  launchDeg: number;
  trackCount: number;
}

export type DetectorEvent =
  | { type: 'ballDetected' }          // ball placed & stable -> armed
  | { type: 'armedTimeout' }          // armed but no shot for a while -> standby again
  | { type: 'shotDisqualified'; reason: 'no-ball-track' } // impact but ball not tracked
  | { type: 'shot'; metrics: ShotMetrics; points: TrackedPoint[] };

export const GOLF_BALL_DIAMETER_M = 0.04267;
