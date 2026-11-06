import { useEffect, useRef, useState } from 'react';
import { ShotDetector, shotFps } from '../lib/detector';
import { openCamera, makeRecorder, type CameraHandle } from '../lib/camera';
import { simulateShot, speedDisplay, distDisplay, mToFt } from '../lib/physics';
import { spinFor, type Settings } from '../lib/settings';
import { saveShot, type ShotRecord } from '../lib/storage';
import { beep, warmupAudio } from '../lib/beep';

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  onOpenSetup: () => void;
}const STATE_TEXT: Record<string, string> = {
  waiting: 'Place the ball anywhere in view — it locks automatically…',
  arming: 'Confirming ball — hold still…',
  armed: 'BALL LOCKED — swing away',
  recording: 'Capturing…',
  cooldown: 'Processing…'
};

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function Practice({ settings, patch, onOpenSetup }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const procRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detRef = useRef<ShotDetector | null>(null);
  const camRef = useRef<CameraHandle | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const configuredForRef = useRef('');
  const stateRef = useRef('');
  const clipUrlRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const [camError, setCamError] = useState<string | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [aspect, setAspect] = useState('16/9');
  const [fps, setFps] = useState(0);
  const [status, setStatus] = useState<string>(STATE_TEXT.waiting);
  const [statusKind, setStatusKind] = useState<'waiting' | 'armed' | 'recording' | 'cooldown'>('waiting');
  const [lastShot, setLastShot] = useState<ShotRecord | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // beeps fire from camera callbacks, which iOS forbids unless the page has
  // already had a user gesture — warm the AudioContext on first tap
  useEffect(() => {
    const h = () => warmupAudio();
    window.addEventListener('pointerdown', h, { once: true });
    return () => window.removeEventListener('pointerdown', h);
  }, []);

  // lives in a ref so the camera effect can call it and it always sees
  // fresh settings (club, spin defaults…)
  const eventHandlerRef = useRef<(e: Parameters<ShotDetector['onEvent']>[0]) => void>(() => {});

  function showToast(msg: string, ms = 3500) {
    setToast(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ms);
  }

  // ---- recorder helpers -------------------------------------------------
  function startRecorder() {
    const cam = camRef.current;
    if (!cam || !settingsRef.current.enableClip) return;
    const rec = makeRecorder(cam.stream);
    if (!rec) return;
    chunksRef.current = [];
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) chunksRef.current.push(ev.data);
    };
    rec.start(250);
    recRef.current = rec;
  }

  function stopRecorder(keep: boolean, done: (blob: Blob | null) => void) {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) {
      done(null);
      return;
    }
    rec.onstop = () => {
      const blob =
        keep && chunksRef.current.length > 0
          ? new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' })
          : null;
      chunksRef.current = [];
      done(blob);
    };
    try {
      rec.stop();
    } catch {
      done(null);
    }
  }

  // ---- camera + main loop ----------------------------------------------
  const calKey = JSON.stringify(settings.cal ?? null);
  useEffect(() => {    let disposed = false;
    let raf = 0;

    (async () => {
      try {
        if (!settingsRef.current.cal) return; // guarded in render too
        const cam = await openCamera(settings.deviceId);
        if (disposed) {
          cam.stop();
          return;
        }
        camRef.current = cam;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = cam.stream;
        v.muted = true;
        v.playsInline = true;
        try {
          await v.play();
        } catch {
          /* autoplay quirks — next user tap resumes */
        }
        const st = cam.settings();
        if (st?.width && st?.height) setAspect(`${st.width}/${st.height}`);

        const det = new ShotDetector();
        det.attach(procRef.current!);
        det.onEvent = (e) => eventHandlerRef.current(e);
        detRef.current = det;
        det.configure(settingsRef.current.cal!, v.videoWidth || 1280, v.videoHeight || 720, settingsRef.current.sensitivity);
        setCamReady(true);
        setStatus(STATE_TEXT.waiting);
        setStatusKind('waiting');
      } catch (e) {
        if (!disposed) {
          setCamError(
            e instanceof Error
              ? `Camera error: ${e.message}. Allow camera access (and use HTTPS or localhost).`
              : 'Camera unavailable'
          );
        }
      }
    })();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const det = detRef.current;
      if (!v || !det || v.readyState < 2) return;
      const cal = settingsRef.current.cal;
      if (!cal) return;
      const key = `${v.videoWidth}x${v.videoHeight}|${settingsRef.current.sensitivity}|${calKey}`;
      if (configuredForRef.current !== key) {
        configuredForRef.current = key;
        det.configure(cal, v.videoWidth, v.videoHeight, settingsRef.current.sensitivity);
      }

      const ev = det.update(v, v.currentTime, performance.now());
      // armed/recording events are RETURNED by update() (ballDetected comes
      // through det.onEvent instead) — discarding this kills every shot
      if (ev) eventHandlerRef.current(ev);

      if (det.state !== stateRef.current) {
        stateRef.current = det.state;
        setStatus(STATE_TEXT[det.state] ?? det.state);
        setStatusKind(det.state as typeof statusKind);
      }
      // arming has an extra phase (3s hold -> beep) only visible in the text
      const stateKey = det.state === 'armed' && det.isLockConfirmed() ? 'armed' : det.state === 'armed' ? 'arming' : det.state;
      if (stateKey !== stateRef.current) {
        stateRef.current = stateKey;
        setStatus(STATE_TEXT[stateKey] ?? stateKey);
      }
      drawOverlay();
    };
    raf = requestAnimationFrame(loop);

    const fpsTimer = window.setInterval(() => setFps(Math.round(shotFps.value * 10) / 10), 1000);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearInterval(fpsTimer);
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        try {
          rec.stop();
        } catch { /* noop */ }
      }
      camRef.current?.stop();
      camRef.current = null;
      detRef.current = null;
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.deviceId, settings.sensitivity, calKey]);

  function handleDetectorEvent(e: Parameters<ShotDetector['onEvent']>[0]) {
    if (e.type === 'ballDetected') {
      // no beep yet — the lock is confirmed only after the 3s hold
      startRecorder();
    } else if (e.type === 'lockConfirmed') {
      beep(1); // position locked — swing away
    } else if (e.type === 'armedTimeout') {
      stopRecorder(false, () => {});
      showToast('Armed timed out — waiting for a new ball.', 2500);
    } else if (e.type === 'trackAborted') {
      if (e.reason === 'ball-removed') {
        stopRecorder(false, () => {});
      }
      // reason 'no-ball-motion' (hand/body/club passing) keeps the recorder
      // rolling so clips still cover the next real swing
    } else if (e.type === 'shotDisqualified') {
      stopRecorder(false, () => {});
      showToast('Ball not tracked — place the ball and swing again.', 3000);
    } else if (e.type === 'shot') {
      beep(2); // shot captured — confirmation
      const cal = settingsRef.current.cal!;
      stopRecorder(true, (clip) => finalizeShot(e.metrics.ballSpeedMps, e.metrics.launchDeg, e.metrics.trackCount, clip, cal));
    }
  }

  // route every detector event (onEvent + update() returns) to the handler;
  // the camera-loop callbacks call through this ref, so keep it current
  eventHandlerRef.current = handleDetectorEvent;

  function finalizeShot(
    ballSpeedMps: number,
    launchDeg: number,
    trackCount: number,
    clip: Blob | null,
    _cal: NonNullable<Settings['cal']>
  ) {
    const s = settingsRef.current;
    const spin = spinFor(s);
    const sim = simulateShot(ballSpeedMps, launchDeg, spin);

    let preview: string | null = null;
    const proc = procRef.current;
    if (proc) {
      try {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = Math.max(1, Math.round((320 * proc.height) / proc.width));
        const cx = c.getContext('2d');
        if (cx) {
          cx.drawImage(proc, 0, 0, c.width, c.height);
          preview = c.toDataURL('image/jpeg', 0.55);
        }
      } catch { /* preview is best-effort */ }
    }

    const record: ShotRecord = {
      id: newId(),
      createdAt: Date.now(),
      club: s.club,
      ballSpeedMps,
      launchDeg,
      spinRpm: spin,
      carryM: sim.carry,
      totalM: sim.total,
      apexM: sim.apex,
      hangSec: sim.hang,
      previewDataUrl: preview,
      clip
    };

    saveShot(record).catch(() => showToast('Could not save shot (storage).', 2500));
    setLastShot(record);
    if (clip) {
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      const url = URL.createObjectURL(clip);
      clipUrlRef.current = url;
      setClipUrl(url);
    } else {
      setClipUrl(null);
    }
  }

  // ---- overlay drawing ----------------------------------------------------
  function drawOverlay() {
    const overlay = overlayRef.current;
    const det = detRef.current;
    if (!overlay || !det) return;
    const g = det.zoneGeometry();
    const { w: pw, h: ph } = det.procSize();
    if (overlay.width !== pw || overlay.height !== ph) {
      overlay.width = pw;
      overlay.height = ph;
    }
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.clearRect(0, 0, pw, ph);

    const st = det.state;
    const zoneColor =
      st === 'armed'
        ? 'rgba(64, 222, 128, 0.95)'
        : st === 'recording'
          ? 'rgba(255, 92, 92, 0.95)'
          : st === 'cooldown'
            ? 'rgba(255, 200, 90, 0.9)'
            : 'rgba(255, 255, 255, 0.55)';

    // flight path arrow
    const arrowFromX = g.ballX + g.hitDir * g.ballR * 2.2;
    const arrowToX = g.ballX + g.hitDir * g.ballR * 7;
    octx.strokeStyle = 'rgba(120, 220, 170, 0.6)';
    octx.lineWidth = 2;
    octx.setLineDash([]);
    octx.beginPath();
    octx.moveTo(arrowFromX, g.ballY);
    octx.lineTo(arrowToX, g.ballY);
    octx.stroke();
    const tip = arrowToX;
    const tipBack = arrowToX - g.hitDir * g.ballR * 1.4;
    octx.beginPath();
    octx.moveTo(tip, g.ballY);
    octx.lineTo(tipBack, g.ballY - g.ballR * 0.9);
    octx.moveTo(tip, g.ballY);
    octx.lineTo(tipBack, g.ballY + g.ballR * 0.9);
    octx.stroke();

    // ball zone circle (dashed) + exact ball-size ring
    octx.setLineDash([6, 5]);
    octx.strokeStyle = zoneColor;
    octx.lineWidth = 2.5;
    octx.beginPath();
    octx.arc(g.ballX, g.ballY, g.ballR * 2.4, 0, Math.PI * 2);
    octx.stroke();
    octx.setLineDash([]);
    octx.lineWidth = 1;
    octx.strokeStyle = 'rgba(255,255,255,0.35)';
    octx.beginPath();
    octx.arc(g.ballX, g.ballY, g.ballR, 0, Math.PI * 2);
    octx.stroke();

    // live tracking dots
    if (st === 'recording') {
      octx.fillStyle = 'rgba(255, 92, 92, 0.9)';
      for (const p of det.livePoints()) {
        octx.beginPath();
        octx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        octx.fill();
      }
    }
  }

  // ---- render ---------------------------------------------------------------
  const s = settings;

  if (!s.calibrated || !s.cal) {
    return (
      <div className="cam-error">
        <h2>One-time setup needed</h2>
        <p>
          Calibrate the camera and ball position first — after that you can start practicing right
          away.
        </p>
        <button className="btn primary big" onClick={onOpenSetup}>
          Start setup
        </button>
      </div>
    );
  }

  return (
    <div className="practice">
      {camError ? (
        <div className="cam-error">
          <h2>Camera unavailable</h2>
          <p>{camError}</p>
          <button className="btn" onClick={() => location.reload()}>
            Retry
          </button>
          <button className="btn ghost" onClick={onOpenSetup}>
            Open setup
          </button>
        </div>
      ) : (
        <>
          <div className="camera-shell" style={{ aspectRatio: aspect }}>
            <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
            <canvas ref={overlayRef} className="camera-overlay" />
            <div className="hud">
              <div className={`status-pill kind-${statusKind}`}>{status}</div>
              {fps > 0 && <div className="fps">{fps} fps · est.</div>}
              <div className="ver">
                v{__APP_VERSION__} · built {new Date(__BUILD_TS__).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            {!camReady && <div className="cam-loading">Starting camera…</div>}
          </div>

          {toast && <div className="toast">{toast}</div>}

          <div className="controller">
            <div className="quick-controls">
              <label className="field">
                <span>Club</span>
                <select
                  value={s.club}
                  onChange={(e) => patch({ club: e.target.value })}
                >
                  {CLUB_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field slider">
                <span>Sensitivity</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={s.sensitivity}
                  onChange={(e) => patch({ sensitivity: Number(e.target.value) })}
                />
              </label>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={s.enableClip}
                  onChange={(e) => patch({ enableClip: e.target.checked })}
                />
                <span>Save clips</span>
              </label>
            </div>

            {lastShot ? <ShotCard shot={lastShot} clipUrl={clipUrl} units={s.units} speedUnit={s.speedUnit} /> : <ShotCardPlaceholder />}

            <div className="practice-actions">
              <button className="btn ghost" onClick={onOpenSetup}>
                Recalibrate
              </button>
            </div>
          </div>
        </>
      )}
      <canvas ref={procRef} style={{ display: 'none' }} />
    </div>
  );
}

const CLUB_OPTIONS = [
  'Driver', '3 Wood', '5 Wood', '4 Iron', '5 Iron', '6 Iron',
  '7 Iron', '8 Iron', '9 Iron', 'PW', 'GW', 'SW', 'LW'
];

function ShotCardPlaceholder() {
  return (
    <div className="shot-card empty">
      <p>No shots yet.</p>
      <p className="hint">
        1. Set the phone ~0.5–1 m to the side of the ball, at ball height.
        <br />2. Place a clean painting-taped or marked ball anywhere in view.
        <br />3. The app finds the ball anywhere in view, locks on and records your swing automatically.
      </p>
    </div>
  );
}

function ShotCard({
  shot,
  clipUrl,
  units,
  speedUnit
}: {
  shot: ShotRecord;
  clipUrl: string | null;
  units: 'yd' | 'm';
  speedUnit: 'mph' | 'km/h';
}) {
  const speed = speedDisplay(shot.ballSpeedMps, speedUnit);
  const carry = distDisplay(shot.carryM, units);
  const total = distDisplay(shot.totalM, units);
  const apex = units === 'm' ? shot.apexM : mToFt(shot.apexM);
  const apexUnit = units === 'm' ? 'm' : 'ft';

  return (
    <div className="shot-card">
      <div className="shot-head">
        <span className="club">{shot.club}</span>
        <span className="time">
          {new Date(shot.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      <div className="metric-grid">
        <div className="metric primary">
          <div className="value">{speed.value.toFixed(1)}</div>
          <div className="unit">BALL SPEED {speed.unit}</div>
        </div>
        <div className="metric primary">
          <div className="value">{carry.value.toFixed(1)}</div>
          <div className="unit">CARRY {carry.unit}</div>
        </div>
        <div className="metric">
          <div className="value">{shot.launchDeg.toFixed(1)}°</div>
          <div className="unit">LAUNCH</div>
        </div>
        <div className="metric">
          <div className="value">{total.value.toFixed(1)}</div>
          <div className="unit">TOTAL {total.unit}</div>
        </div>
        <div className="metric">
          <div className="value">{apex.toFixed(1)}</div>
          <div className="unit">APEX {apexUnit}</div>
        </div>
        <div className="metric">
          <div className="value">{Math.round(shot.spinRpm).toLocaleString()}</div>
          <div className="unit">SPIN rpm (est.)</div>
        </div>
      </div>
      {clipUrl && (
        <video className="clip" src={clipUrl} controls autoPlay loop muted playsInline />
      )}
      {shot.previewDataUrl && !clipUrl && (
        <img className="preview" src={shot.previewDataUrl} alt="Shot trail" />
      )}
      <p className="hint tiny">
        Camera estimates: launch &amp; speed tracked optically; spin is a club-default model, not
        measured. Calibrate with real turf distances when possible.
      </p>
    </div>
  );
}
