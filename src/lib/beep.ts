/**
 * Tiny Web Audio beeper: one beep = ball locked & armed, two beeps = shot
 * captured. Uses an oscillator — no assets, instant start.
 */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * AudioContexts created outside a user gesture stay suspended on iOS/Safari.
 * Calling this once from a pointerdown warms the context up so the beeps
 * (which fire from camera callbacks) are audible.
 */
export function warmupAudio() {
  audioCtx();
}

function tone(t0: number, freq: number, dur: number, gain: number) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
  g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Play `times` short beeps. */
export function beep(times = 1) {
  const ac = audioCtx();
  if (!ac) return;
  if (times === 1) {
    tone(ac.currentTime, 880, 0.12, 0.18);
    return;
  }
  for (let i = 0; i < times; i++) {
    tone(ac.currentTime + i * 0.17, 660, 0.11, 0.2);
  }
}
