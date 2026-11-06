/**
 * Tiny Web Audio beeper: one beep = ball locked & armed, two beeps = shot
 * captured. Uses an oscillator — no assets, instant start.
 *
 * iOS notes:
 *  - An AudioContext created outside a user gesture stays "suspended" — we
 *    create/resume it on the first pointerdown (warmupAudio, Practice).
 *  - Tones scheduled while the context is still suspended are silently
 *    dropped, so beep() resumes the context and only schedules once it is
 *    actually running.
 *  - The ringer/silent switch mutes WebAudio on iOS — if no sound is heard
 *    despite beeps firing, the phone's silent switch is the likely culprit.
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
  const ac = audioCtx();
  if (!ac) return;
  if (ac.state !== 'running') {
    void ac.resume();
    // resume() resolves asynchronously; a second attempt here is harmless and
    // usually lets the context reach 'running' within the same gesture clock
    void ac.resume().catch(() => {});
  }
}

function tone(t0: number, freq: number, dur: number, gain: number) {
  if (!ctx || ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
  g.gain.linearRampToValueAtTime(gain * 0.85, t0 + dur * 0.8); // sustain, then release
  g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Play `times` short beeps. Safe to call from camera callbacks (async internally). */
export function beep(times = 1) {
  const ac = audioCtx();
  if (!ac) return;
  void (async () => {
    // never schedule into a suspended (or not-yet-resumed) context — iOS
    // drops queued tones and the beep simply never sounds
    if (ac.state !== 'running') {
      try {
        await ac.resume();
      } catch {
        return;
      }
      // (as string: TS types state as narrowed even though resume() may change it)
      const state: string = ac.state;
      if (state !== 'running') return;
    }
    if (times === 1) {
      tone(ac.currentTime + 0.01, 950, 0.16, 0.34); // locked — higher, longer, louder
      return;
    }
    for (let i = 0; i < times; i++) {
      tone(ac.currentTime + 0.01 + i * 0.19, 660, 0.13, 0.34); // shot captured
    }
  })();
}

