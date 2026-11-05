// Sanity-check the physics model against well-known Trackman-style numbers.
import { simulateShot, mpsToMph, mToYd, mToFt } from '../src/lib/physics';

interface Case {
  name: string;
  ballSpeedMps: number;
  launchDeg: number;
  spinRpm: number;
}

const cases: Case[] = [
  { name: 'Driver', ballSpeedMps: 74.7, launchDeg: 11, spinRpm: 2700 },
  { name: '3 Wood', ballSpeedMps: 67.0, launchDeg: 13, spinRpm: 3400 },
  { name: '5 Iron', ballSpeedMps: 51.0, launchDeg: 18, spinRpm: 5000 },
  { name: '7 Iron', ballSpeedMps: 46.0, launchDeg: 22, spinRpm: 7000 },
  { name: '9 Iron', ballSpeedMps: 38.0, launchDeg: 29, spinRpm: 8800 },
  { name: 'PW', ballSpeedMps: 33.0, launchDeg: 32, spinRpm: 9500 },
  { name: 'LW', ballSpeedMps: 25.0, launchDeg: 45, spinRpm: 10800 }
];

console.log(
  'club'.padEnd(8),
  'mph'.padStart(7),
  'launch'.padStart(7),
  'spin'.padStart(7),
  'carry yd'.padStart(9),
  'carry m'.padStart(9),
  'total yd'.padStart(9),
  'apex ft'.padStart(8),
  'hang s'.padStart(7),
  'landº'.padStart(6)
);
let ok = true;
for (const c of cases) {
  const r = simulateShot(c.ballSpeedMps, c.launchDeg, c.spinRpm);
  const line = [
    c.name.padEnd(8),
    mpsToMph(c.ballSpeedMps).toFixed(1).padStart(7),
    String(c.launchDeg).padStart(7),
    String(c.spinRpm).padStart(7),
    (mToYd(r.carry)).toFixed(1).padStart(9),
    r.carry.toFixed(1).padStart(9),
    (mToYd(r.total)).toFixed(1).padStart(9),
    (mToFt(r.apex)).toFixed(0).padStart(8),
    r.hang.toFixed(2).padStart(7),
    r.landAngleDeg.toFixed(0).padStart(6)
  ].join(' ');
  console.log(line);
}
console.log('\nReference expectations (Trackman-ish, carry yd):');
console.log('Driver ~262-275 | 3W ~220-235 | 5i ~165-180 | 7i ~155-170 | 9i ~115-130 | PW ~105-115 | LW ~65-80');
