import type { Calibration } from './types';

const KEY = 'launchmonitor.settings.v1';

export interface Settings {
  units: 'yd' | 'm';
  speedUnit: 'mph' | 'km/h';
  club: string;
  /** -25..25 percent adjustment applied to the club's default spin */
  spinAdjustPct: number;
  /** 0..100, higher = triggers on subtler motion */
  sensitivity: number;
  enableClip: boolean;
  deviceId: string | null;
  cal: Calibration | null;
  calibrated: boolean;
}

export const CLUBS: Record<string, { spin: number }> = {
  Driver: { spin: 2600 },
  '3 Wood': { spin: 3500 },
  '5 Wood': { spin: 4200 },
  '4 Iron': { spin: 4600 },
  '5 Iron': { spin: 5000 },
  '6 Iron': { spin: 6000 },
  '7 Iron': { spin: 7000 },
  '8 Iron': { spin: 8000 },
  '9 Iron': { spin: 8800 },
  'PW': { spin: 9500 },
  'GW': { spin: 10200 },
  'SW': { spin: 10500 },
  'LW': { spin: 11000 }
};

export const CLUB_NAMES = Object.keys(CLUBS);

export const defaultSettings: Settings = {
  units: 'yd',
  speedUnit: 'mph',
  club: '7 Iron',
  spinAdjustPct: 0,
  sensitivity: 55,
  enableClip: true,
  deviceId: null,
  cal: null,
  calibrated: false
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) } as Settings;
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage full / private mode — ignore
  }
}

export function spinFor(settings: Settings): number {
  const base = CLUBS[settings.club]?.spin ?? 7000;
  return Math.max(400, Math.round(base * (1 + settings.spinAdjustPct / 100)));
}

/** Greyscale difference (0..255) that counts as motion. Higher sensitivity -> lower threshold. */
export function thresholdFor(sensitivity: number): number {
  // sens 0 => 48 (insensitive), sens 100 => 16 (very sensitive)
  return Math.round(48 - (48 - 16) * (Math.min(100, Math.max(0, sensitivity)) / 100));
}
