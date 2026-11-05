import { useEffect, useRef, useState } from 'react';
import { openCamera, listCameras, type CameraHandle } from '../lib/camera';
import { ShotDetector, shotFps } from '../lib/detector';
import type { Calibration, HitDir } from '../lib/types';
import { CLUB_NAMES, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  onDone: () => void;
}

interface Ring {
  nx: number;
  ny: number;
  nr: number; // normalized to frame height
}

const STEP_TITLES = ['Camera', 'Aim', 'Ball calibration', 'Test detection', 'Defaults'];
const CANVAS_W = 480;

export default function SetupWizard({ settings, patch, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [procH, setProcH] = useState(270);
  const [detState, setDetState] = useState('waiting');
  const [fps, setFps] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<CameraHandle | null>(null);
  const detRef = useRef<ShotDetector | null>(null);
  const detStateRef = useRef('');
  const configuredRef = useRef('');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const initHitDir: HitDir = settings.cal?.hitDir ?? 1;
  const [hitDir, setHitDir] = useState<HitDir>(initHitDir);
  const [ring, setRing] = useState<Ring>(
    settings.cal
      ? { nx: settings.cal.ballNX, ny: settings.cal.ballNY, nr: settings.cal.ballNR }
      : { nx: 0.5, ny: 0.5, nr: 0.02 }
  );
  const ringRef = useRef(ring);
  ringRef.current = ring;
  const hitDirRef = useRef(hitDir);
  hitDirRef.current = hitDir;

  const [draftClub, setDraftClub] = useState(settings.club);
  const [draftUnits, setDraftUnits] = useState(settings.units);
  const [draftSpeed, setDraftSpeed] = useState(settings.speedUnit);
  const [draftSpin, setDraftSpin] = useState(settings.spinAdjustPct);

  function calFromRing(r: Ring, dir: 1 | -1): Calibration {
    return { ballNX: r.nx, ballNY: r.ny, ballNR: r.nr, hitDir: dir };
  }

  // ---- camera lifecycle --------------------------------------------------
  const [camOn, setCamOn] = useState(false);
  const advancedRef = useRef(false);

  function startCamera() {
    setError(null);
    setCamOn(true);
  }

  useEffect(() => {
    if (!camOn) return;
    let disposed = false;
    (async () => {
      try {
        const cam = await openCamera(settings.deviceId);
        if (disposed) {
          cam.stop();
          return;
        }
        camRef.current?.stop();
        camRef.current = cam;
        const v = videoRef.current;
        if (v) {
          v.srcObject = cam.stream;
          v.muted = true;
          v.playsInline = true;
          await v.play();
        }
        const devs = await listCameras();
        if (!disposed) {
          setCams(devs);
          if (!advancedRef.current) {
            advancedRef.current = true;
            setStep((s) => (s === 0 ? 1 : s));
          }
        }
      } catch (e) {
        if (!disposed) {
          setError(
            e instanceof Error
              ? `Camera error: ${e.message}. Camera access needs HTTPS or localhost.`
              : 'Camera unavailable'
          );
          setCamOn(false);
        }
      }
    })();
    return () => {
      disposed = true;
      camRef.current?.stop();
      camRef.current = null;
    };
  }, [camOn, settings.deviceId]);

  // detector exists only during the test step
  useEffect(() => {
    configuredRef.current = '';
    detStateRef.current = '';
    setDetState('waiting');
    if (step === 3) {
      const det = new ShotDetector();
      det.attach(canvasRef.current!);
      detRef.current = det;
    }
    return () => {
      detRef.current = null;
    };
  }, [step]);

  // ---- render loop for steps 1..4 -----------------------------------------
  useEffect(() => {
    if (step === 0 || !camOn) return;
    let raf = 0;
    const fpsTimer = window.setInterval(
      () => setFps(Math.round(shotFps.value) || 0),
      1000
    );
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const c = canvasRef.current;
      const cam = camRef.current;
      if (!v || !c || !cam || v.readyState < 2 || !v.videoWidth) return;

      const vh = Math.round((v.videoHeight / v.videoWidth) * CANVAS_W);
      if (c.width !== CANVAS_W || c.height !== vh) {
        c.width = CANVAS_W;
        c.height = vh;
        setProcH(vh);
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;

      if (step === 3) {
        const det = detRef.current;
        if (det) {
          const cal = calFromRing(ringRef.current, hitDirRef.current);
          const key = `${v.videoWidth}x${v.videoHeight}|${settingsRef.current.sensitivity}`;
          if (configuredRef.current !== key) {
            configuredRef.current = key;
            det.configure(cal, v.videoWidth, v.videoHeight, settingsRef.current.sensitivity);
          }
          det.update(v, v.currentTime, performance.now());
          if (det.state !== detStateRef.current) {
            detStateRef.current = det.state;
            setDetState(det.state);
          }
        }
      } else {
        ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, 0, 0, CANVAS_W, vh);
      }
      drawRing(ctx, ringRef.current, CANVAS_W, vh, step === 2);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(fpsTimer);
    };
  }, [step, camOn, hitDir]);

  // ---- navigation ----------------------------------------------------------
  function next() {
    if (step === 2 && ring.nr * 1000 < 4) {
      setError('Ball ring looks too small — match the ball exactly.');
      return;
    }
    setError(null);
    setStep((s) => Math.min(4, s + 1));
  }
  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  function finish() {
    patch({
      cal: calFromRing(ring, hitDir),
      calibrated: true,
      club: draftClub,
      units: draftUnits,
      speedUnit: draftSpeed,
      spinAdjustPct: draftSpin
    });
    onDone();
  }

  // ---- ring dragging ---------------------------------------------------------
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (step !== 2) return;
    canvasRef.current?.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (step !== 2) return;
    const c = canvasRef.current;
    if (!c || !e.buttons) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    setRing((r) => ({ ...r, nx: clamp01(x / CANVAS_W), ny: clamp01(y / c.height) }));
  }

  return (
    <div className="wizard">
      <header className="wizard-head">
        <h1>Setup</h1>
        <div className="steps">
          {STEP_TITLES.map((t, i) => (
            <span key={t} className={i === step ? 'dot active' : i < step ? 'dot done' : 'dot'} />
          ))}
        </div>
        <p className="step-title">
          {step + 1}. {STEP_TITLES[step]}
        </p>
      </header>

      <video ref={videoRef} className="ghost-video" playsInline muted autoPlay />

      {step === 0 && (
        <section className="wizard-body">
          <p className="lead">
            Your phone camera becomes the launch monitor. You place the phone <b>side-on</b>, about
            0.5–1&nbsp;m from the ball at ball height, perpendicular to where you'll hit. The app
            detects the placed ball, records the swing and estimates speed, launch and carry.
          </p>
          <ul className="hint">
            <li>iOS 16.4+ or any modern browser — add to Home Screen for the app experience.</li>
            <li>A plain background behind the ball works much better than a busy room.</li>
            <li>Good, even lighting. Avoid shooting into a bright window.</li>
          </ul>
          <label className="field">
            <span>Camera</span>
            <select
              value={settings.deviceId ?? ''}
              onChange={(e) => patch({ deviceId: e.target.value || null })}
            >
              <option value="">Default (back camera)</option>
              {cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary big" onClick={startCamera}>
            {camRef.current ? 'Restart camera' : 'Start camera'}
          </button>
        </section>
      )}

      {step > 0 && (
        <div className="camera-shell tall" style={{ aspectRatio: `480/${procH}` }}>
          <canvas
            ref={canvasRef}
            className="wizard-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            style={{ touchAction: 'none' }}
          />
          {step === 3 && (
            <div className="hud">
              <div className={`status-pill kind-${detState}`}>
                {detState === 'waiting' && 'Place the ball in the circle…'}
                {detState === 'armed' && 'Ball detected ✓ — detector is ready'}
                {detState === 'recording' && 'Capturing motion…'}
                {detState === 'cooldown' && 'Processing…'}
              </div>
              {fps > 0 && <div className="fps">{fps} fps</div>}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <section className="wizard-body">
          <p className="lead">Which way will the ball fly on screen?</p>
          <div className="dir-pick">
            <button className={hitDir === -1 ? 'dir active' : 'dir'} onClick={() => setHitDir(-1)}>
              ← Left
            </button>
            <button className={hitDir === 1 ? 'dir active' : 'dir'} onClick={() => setHitDir(1)}>
              Right →
            </button>
          </div>
          <p className="hint">
            Stand so the ball is beside the phone and flies across the frame. Position the circle on
            the preview over where the ball will sit — you'll fine-tune it in the next step.
          </p>
        </section>
      )}

      {step === 2 && (
        <section className="wizard-body">
          <p className="lead">
            Put a ball where you'll hit it. <b>Drag the dashed circle</b> so its edge matches the
            ball exactly, then set the size:
          </p>
          <label className="field slider">
            <span>Ring size {(ring.nr * 1000).toFixed(0)}‰ of height</span>
            <input
              type="range"
              min={4}
              max={80}
              value={Math.round(ring.nr * 1000)}
              onChange={(e) => setRing((r) => ({ ...r, nr: Number(e.target.value) / 1000 }))}
            />
          </label>
        </section>
      )}

      {step === 3 && (
        <section className="wizard-body">
          <p className="lead">
            Place the ball in the circle until it locks, then take a practice swing with the ball
            removed — you should not see constant false captures.
          </p>
          <label className="field slider">
            <span>Sensitivity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.sensitivity}
              onChange={(e) => patch({ sensitivity: Number(e.target.value) })}
            />
          </label>
          <button className="btn ghost" onClick={() => setStep(2)}>
            Redo ball calibration
          </button>
        </section>
      )}

      {step === 4 && (
        <section className="wizard-body">
          <label className="field">
            <span>Default club</span>
            <select value={draftClub} onChange={(e) => setDraftClub(e.target.value)}>
              {CLUB_NAMES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <div className="row2">
            <label className="field">
              <span>Distance</span>
              <select value={draftUnits} onChange={(e) => setDraftUnits(e.target.value as 'yd' | 'm')}>
                <option value="yd">Yards</option>
                <option value="m">Meters</option>
              </select>
            </label>
            <label className="field">
              <span>Speed</span>
              <select
                value={draftSpeed}
                onChange={(e) => setDraftSpeed(e.target.value as 'mph' | 'km/h')}
              >
                <option value="mph">mph</option>
                <option value="km/h">km/h</option>
              </select>
            </label>
          </div>
          <label className="field slider">
            <span>
              Spin model offset: {draftSpin > 0 ? '+' : ''}
              {draftSpin}%
            </span>
            <input
              type="range"
              min={-25}
              max={25}
              value={draftSpin}
              onChange={(e) => setDraftSpin(Number(e.target.value))}
            />
          </label>
          <p className="hint tiny">
            Spin is not measured by a camera — the app uses typical values for the selected club.
            Tune the offset if simulated or real flights disagree.
          </p>
        </section>
      )}

      {error && <div className="toast err">{error}</div>}

      <footer className="wizard-foot">
        {step > 0 && (
          <button className="btn ghost" onClick={back}>
            Back
          </button>
        )}
        <div className="spacer" />
        {step >= 1 && step <= 3 && (
          <button className="btn primary" onClick={next}>
            Next
          </button>
        )}
        {step === 4 && (
          <button className="btn primary big" onClick={finish}>
            Save &amp; start practicing
          </button>
        )}
      </footer>
    </div>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function drawRing(
  ctx: CanvasRenderingContext2D,
  ring: Ring,
  w: number,
  h: number,
  dragging: boolean
) {
  const cx = ring.nx * w;
  const cy = ring.ny * h;
  const r = Math.max(6, ring.nr * h);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = dragging ? 'rgba(96, 220, 255, 0.95)' : 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.moveTo(cx - r * 2, cy);
  ctx.lineTo(cx + r * 2, cy);
  ctx.moveTo(cx, cy - r * 2);
  ctx.lineTo(cx, cy + r * 2);
  ctx.stroke();
  ctx.restore();
}
