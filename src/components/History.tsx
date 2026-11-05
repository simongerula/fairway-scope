import { useEffect, useState } from 'react';
import { clearShots, deleteShot, listShots, shotsToCSV, type ShotRecord } from '../lib/storage';
import { speedDisplay, distDisplay, mToFt } from '../lib/physics';

export default function History() {
  const [shots, setShots] = useState<ShotRecord[] | null>(null);

  useEffect(() => {
    listShots().then(setShots).catch(() => setShots([]));
  }, []);

  async function remove(id: string) {
    await deleteShot(id);
    setShots(await listShots());
  }

  async function clearAll() {
    if (!confirm('Delete all saved shots?')) return;
    await clearShots();
    setShots([]);
  }

  function exportCSV() {
    if (!shots || shots.length === 0) return;
    const csv = shotsToCSV(shots, (id) => shots.find((s) => s.id === id)?.club ?? '—');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `launch-monitor-shots-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (shots === null) {
    return <div className="page-center">Loading shots…</div>;
  }

  if (shots.length === 0) {
    return (
      <div className="page-center">
        <p className="lead">No shots yet — hit the range (your living room) first! ⛳</p>
      </div>
    );
  }

  // group by calendar day
  const byDay = new Map<string, ShotRecord[]>();
  for (const s of shots) {
    const day = new Date(s.createdAt).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(s);
  }

  const speeds = shots.map((s) => s.ballSpeedMps);
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / shots.length;
  const avgCarry = shots.reduce((a, s) => a + s.carryM, 0) / shots.length;
  const bestCarry = Math.max(...shots.map((s) => s.carryM));

  return (
    <div className="history">
      <div className="history-top">
        <h2>Shots ({shots.length})</h2>
        <div className="history-actions">
          <button className="btn small" onClick={exportCSV}>
            Export CSV
          </button>
          <button className="btn small danger" onClick={clearAll}>
            Clear
          </button>
        </div>
      </div>

      <div className="summary-row">
        <div className="summary">
          <div className="value">{speedDisplay(avgSpeed, 'mph').value.toFixed(1)}</div>
          <div className="label">AVG BALL SPEED mph</div>
        </div>
        <div className="summary">
          <div className="value">{distDisplay(avgCarry, 'yd').value.toFixed(1)}</div>
          <div className="label">AVG CARRY yd</div>
        </div>
        <div className="summary">
          <div className="value">{distDisplay(bestCarry, 'yd').value.toFixed(1)}</div>
          <div className="label">BEST CARRY yd</div>
        </div>
      </div>

      {[...byDay.entries()].map(([day, dayShots]) => (
        <div key={day} className="day-group">
          <h3>{day}</h3>
          <div className="shot-table">
            <div className="row head">
              <span>Club</span>
              <span>Speed</span>
              <span>Launch</span>
              <span>Carry</span>
              <span>Total</span>
              <span />
            </div>
            {dayShots.map((s) => {
              const sp = speedDisplay(s.ballSpeedMps, 'mph');
              const ca = distDisplay(s.carryM, 'yd');
              const to = distDisplay(s.totalM, 'yd');
              return (
                <div key={s.id} className="row">
                  <span className="club">{s.club}</span>
                  <span>{sp.value.toFixed(1)} mph</span>
                  <span>{s.launchDeg.toFixed(1)}°</span>
                  <span>{ca.value.toFixed(0)} yd</span>
                  <span>{to.value.toFixed(0)} yd</span>
                  <button className="icon-btn" onClick={() => remove(s.id)} title="Delete">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="hint tiny">
        Apex on average shots: {mToFt(shots.reduce((a, s) => a + s.apexM, 0) / shots.length).toFixed(0)} ft ·
        hang time {shots.reduce((a, s) => a + s.hangSec, 0).toFixed(1)} s total
      </p>
    </div>
  );
}
