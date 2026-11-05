/** Tiny IndexedDB wrapper for shot storage (metrics + optional clip blob). */

export interface ShotRecord {
  id: string;
  createdAt: number;
  club: string;
  ballSpeedMps: number;
  launchDeg: number;
  spinRpm: number;
  carryM: number;
  totalM: number;
  apexM: number;
  hangSec: number;
  previewDataUrl: string | null;
  clip: Blob | null;
}

const DB_NAME = 'launch-monitor';
const STORE = 'shots';

function withDB<T>(fn: (db: IDBDatabase) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const result = fn(db);
        if (result && 'onsuccess' in result) {
          result.onsuccess = () => resolve(result.result);
          result.onerror = () => reject(result.error);
        } else {
          resolve(undefined);
        }
      } finally {
        db.close();
      }
    };
  });
}

export function saveShot(shot: ShotRecord): Promise<void> {
  return withDB((db) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(shot);
  }) as Promise<void>;
}

export function listShots(): Promise<ShotRecord[]> {
  return withDB((db) => {
    const req = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .index('createdAt')
      .getAll() as IDBRequest<ShotRecord[]>;
    return req;
  }).then((shots) => (shots ?? []).sort((a, b) => b.createdAt - a.createdAt));
}

export function deleteShot(id: string): Promise<void> {
  return withDB((db) => {
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
  }) as Promise<void>;
}

export function clearShots(): Promise<void> {
  return withDB((db) => {
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  }) as Promise<void>;
}

export function shotsToCSV(shots: ShotRecord[], clubOf: (id: string) => string): string {
  const headers = [
    'iso_time', 'club', 'ball_speed_mph', 'ball_speed_kmh', 'launch_deg',
    'spin_rpm', 'carry_yd', 'carry_m', 'total_yd', 'total_m', 'apex_ft', 'apex_m', 'hang_s'
  ];
  const rows = shots
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => {
      const d = new Date(s.createdAt).toISOString();
      return [
        d, clubOf(s.id), (s.ballSpeedMps * 2.23694).toFixed(1), (s.ballSpeedMps * 3.6).toFixed(1),
        s.launchDeg.toFixed(1), Math.round(s.spinRpm), (s.carryM * 1.09361).toFixed(1), s.carryM.toFixed(1),
        (s.totalM * 1.09361).toFixed(1), s.totalM.toFixed(1), (s.apexM * 3.28084).toFixed(1), s.apexM.toFixed(2),
        s.hangSec.toFixed(2)
      ].join(',');
    });
  return [headers.join(','), ...rows].join('\n');
}
