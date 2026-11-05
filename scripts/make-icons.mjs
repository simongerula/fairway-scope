// Generates PWA icons (plain PNGs, no image libraries — raw RGBA + zlib).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG writer ----------
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- icon art ----------
/**
 * @param {number} size
 * @param {boolean} maskable - full-bleed background (OS applies its own mask)
 */
function drawIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const S = size;
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  const bgOuter = [11, 15, 21];
  const bgInner = [23, 29, 38];

  const corner = j => Math.round(size * 0.22);
  const crc = corner(S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // radial gradient
      const cx = S / 2, cy = S * 0.42;
      const d = Math.hypot(x - cx, y - cy) / (S * 0.75);
      const t = Math.min(1, Math.max(0, 1 - d));
      let r = bgInner[0] + (bgOuter[0] - bgInner[0]) * (1 - t);
      let g = bgInner[1] + (bgOuter[1] - bgInner[1]) * (1 - t);
      let b = bgInner[2] + (bgOuter[2] - bgInner[2]) * (1 - t);

      if (!maskable) {
        // rounded-square mask
        const inX = Math.min(x, S - 1 - x);
        const inY = Math.min(y, S - 1 - y);
        const inside =
          (inX < crc && inY < crc)
            ? Math.hypot(crc - inX, crc - inY) <= crc
            : true;
        if (!inside) {
          set(x, y, 0, 0, 0, 0);
          continue;
        }
      }

      set(x, y, Math.round(r), Math.round(g), Math.round(b));
    }
  }

  const ballR = S * (maskable ? 0.085 : 0.105);
  const ballX = S * (maskable ? 0.42 : 0.42);
  const ballY = S * (maskable ? 0.68 : 0.7);

  // trajectory: arc from launch point to top-right
  const drawTraj = (thickness, color) => {
    const steps = 220;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      // scaled arc relative to ball position
      const x0 = ballX, y0 = ballY;
      const apexX = x0 + S * 0.18, apexY = y0 - S * (maskable ? 0.2 : 0.26);
      const endX = x0 + S * (maskable ? 0.34 : 0.36), endY = y0 - S * (maskable ? 0.06 : 0.1);
      const xu = x0 + (endX - x0) * u;
      const yu = y0 + (apexY - y0) * 4 * u * (1 - u) + (endY - y0) * u;
      const rad = thickness / 2;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy <= rad * rad) {
            const xi = xu + dx, yi = yu + dy;
            const i = (Math.round(yi) * S + Math.round(xi)) * 4;
            if (i >= 0 && i < px.length) {
              px[i] = color[0];
              px[i + 1] = color[1];
              px[i + 2] = color[2];
              px[i + 3] = 255;
            }
          }
        }
      }
    }
  };
  // dashed trajectory segments
  for (let i = 0; i <= 220; i++) {
    const u = i / 220;
    if (Math.floor(u * 14) % 2 === 1) continue; // dashed
    const x0 = ballX, y0 = ballY;
    const apexY = ballY - S * (maskable ? 0.2 : 0.26);
    const endX = ballX + S * (maskable ? 0.34 : 0.36), endY = ballY - S * (maskable ? 0.06 : 0.1);
    const xu = x0 + (endX - x0) * u;
    const yu = y0 + (apexY - y0) * 4 * u * (1 - u) + (endY - y0) * u;
    const rad = S * 0.012;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++)
        if (dx * dx + dy * dy <= rad * rad) {
          set(Math.round(xu + dx), Math.round(yu + dy), 56, 224, 138);
        }
  }

  // ball with dimple shading
  for (let y = Math.floor(ballY - ballR - 2); y <= Math.ceil(ballY + ballR + 2); y++) {
    for (let x = Math.floor(ballX - ballR - 2); x <= Math.ceil(ballX + ballR + 2); x++) {
      const d = Math.hypot(x - ballX, y - ballY);
      if (d <= ballR) {
        const shade = 250 - Math.round(35 * (d / ballR)) + (y < ballY ? 6 : -6);
        set(x, y, shade, shade, Math.min(255, shade + 2));
      }
    }
  }
  // small tee/ground line
  const groundY = ballY + ballR * 1.6;
  for (let x = ballX - S * 0.16; x < ballX + S * 0.16; x++) {
    for (let dy = -S * 0.004; dy <= S * 0.004; dy++) {
      set(Math.round(x), Math.round(groundY + dy), 139, 148, 163, 160);
    }
  }

  return encodePNG(S, S, px);
}

writeFileSync(join(OUT, 'icon-192.png'), drawIcon(192, false));
writeFileSync(join(OUT, 'icon-512.png'), drawIcon(512, false));
writeFileSync(join(OUT, 'maskable-512.png'), drawIcon(512, true));
writeFileSync(join(OUT, 'apple-touch-icon.png'), drawIcon(180, true));
console.log('Icons written to', OUT);
