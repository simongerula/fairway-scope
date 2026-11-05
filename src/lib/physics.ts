/**
 * Simplified projectile model for a golf ball with aerodynamic drag and
 * Magnus lift. Units are SI. +y is up.
 *
 * Constants (standard sea-level values, regulation ball):
 *   mass 0.04593 kg, radius 0.02135 m, air density 1.225 kg/m^3
 *   Cd = 0.23 (dimpled ball, drag-crisis region), lift Cl linear in the
 *   dimensionless spin parameter S = omega*r/v, capped at 0.35.
 *
 * This is an estimate, not a Trackman — it is meant to give believable,
 * consistent numbers for practice feedback.
 */

const MASS = 0.04593;
const RADIUS = 0.02135;
const AREA = Math.PI * RADIUS * RADIUS;
const RHO = 1.225;
const G = 9.81;
const CD = 0.24;
const LIFT_COEF_MAX = 0.34;
/** Cl = min(CLIFT_MAX, K_LIFT * sqrt(S)) — sqrt keeps descent-stage lift strong */
const K_LIFT = 0.62;
/** spin decays in flight (~35% over a full driver flight) */
const SPIN_DECAY_PER_S = 0.055;

export interface SimResult {
  /** ground distance at first landing, m */
  carry: number;
  /** carry + roll estimate, m */
  total: number;
  /** max height above launch height, m */
  apex: number;
  /** time to first landing, s */
  hang: number;
  /** descent angle below horizontal at landing, deg */
  landAngleDeg: number;
  /** speed at landing, m/s */
  landSpeedMps: number;
}

interface State {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function accel(s: State, omegaR0: number, t: number): { ax: number; ay: number } {
  const v = Math.hypot(s.vx, s.vy);
  let ax = 0;
  let ay = -G;
  if (v > 0.5) {
    const omegaR = omegaR0 * Math.exp(-SPIN_DECAY_PER_S * t);
    const S = Math.min(0.45, omegaR / v);
    const Cl = Math.min(LIFT_COEF_MAX, K_LIFT * Math.sqrt(S));
    // drag crisis: Cd drops slightly at very high speed, rises for slow shots
    const Cd = Math.min(0.29, Math.max(0.235, CD - 0.05 * Math.tanh((v - 62) / 25)));
    const invM = (0.5 * RHO * AREA) / MASS; // * v^2 * Cd/Cl gives accel magnitude
    const drag = invM * Cd * v * v;
    const lift = invM * (S > 0.35 ? 0.42 : Cl) * v * v;
    // drag opposes velocity
    ax -= (drag * s.vx) / v;
    ay -= (drag * s.vy) / v;
    // Magnus lift, perpendicular to velocity, rotated toward "up" in the
    // vertical flight plane (pure backspin assumption, no side axis tilt).
    ax += (lift * -s.vy) / v;
    ay += (lift * s.vx) / v;
  }
  return { ax, ay };
}

function deriv(s: State, omegaR0: number, t: number): State {
  const { ax, ay } = accel(s, omegaR0, t);
  return { x: s.vx, y: s.vy, vx: ax, vy: ay };
}

function addStep(s: State, d: State, dt: number): State {
  return {
    x: s.x + d.x * dt,
    y: s.y + d.y * dt,
    vx: s.vx + d.vx * dt,
    vy: s.vy + d.vy * dt
  };
}

export function simulateShot(ballSpeedMps: number, launchDeg: number, spinRpm: number): SimResult {
  const v = Math.max(1, ballSpeedMps);
  const theta = (Math.max(-30, Math.min(85, launchDeg)) * Math.PI) / 180;
  const omegaR = (Math.max(0, spinRpm) * 2 * Math.PI * RADIUS) / 60;

  let s: State = { x: 0, y: 0, vx: v * Math.cos(theta), vy: v * Math.sin(theta) };
  const dt = 0.002;
  let t = 0;
  let apex = 0;
  let carry = 0;
  let landSpeed = v;
  let maxT = 15;

  while (s.y >= -0.01 && t < maxT) {
    const k1 = deriv(s, omegaR, t);
    const s2 = addStep(s, k1, dt / 2);
    const k2 = deriv(s2, omegaR, t + dt / 2);
    const s3 = addStep(s, k2, dt / 2);
    const k3 = deriv(s3, omegaR, t + dt / 2);
    const s4 = addStep(s, k3, dt);
    const k4 = deriv(s4, omegaR, t + dt);
    const next: State = {
      x: s.x + (dt / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
      y: s.y + (dt / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
      vx: s.vx + (dt / 6) * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx),
      vy: s.vy + (dt / 6) * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy)
    };
    if (next.y > apex) apex = next.y;
    if (next.y < 0 && s.y >= 0) {
      // linear interpolation of landing point between s and next
      const f = s.y / (s.y - next.y);
      carry = s.x + (next.x - s.x) * f;
      landSpeed = Math.hypot(
        s.vx + ((next.vx - s.vx) * f),
        s.vy + ((next.vy - s.vy) * f)
      );
      t += dt;
      break;
    }
    s = next;
    t += dt;
    if (s.y <= 0 && t > 0.05) break;
  }

  const landAngleDeg =
    Math.abs(Math.atan2(s.vy, Math.max(0.1, s.vx)) * 180) / Math.PI;
  const total = carry * (1 + Math.max(0.02, 0.15 - 0.004 * landAngleDeg));

  return {
    carry,
    total,
    apex,
    hang: t,
    landAngleDeg,
    landSpeedMps: landSpeed
  };
}

// ---- unit helpers ----
export const MPH_PER_MPS = 2.23694;
export const KMH_PER_MPS = 3.6;
export const YD_PER_M = 1.09361;
export const FT_PER_M = 3.28084;

export const mpsToMph = (m: number) => m * MPH_PER_MPS;
export const mpsToKmh = (m: number) => m * KMH_PER_MPS;
export const mToYd = (m: number) => m * YD_PER_M;
export const mToFt = (m: number) => m * FT_PER_M;

/** distance in preferred unit */
export function distDisplay(m: number, unit: 'yd' | 'm'): { value: number; unit: string; digits: number } {
  if (unit === 'm') return { value: m, unit: 'm', digits: 1 };
  return { value: mToYd(m), unit: 'yd', digits: 1 };
}

export function speedDisplay(mps: number, unit: 'mph' | 'km/h'): { value: number; unit: string; digits: number } {
  if (unit === 'km/h') return { value: mpsToKmh(mps), unit: 'km/h', digits: 1 };
  return { value: mpsToMph(mps), unit: 'mph', digits: 1 };
}
