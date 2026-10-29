/**
 * 参数扫描（开发工具）：一次渲染多个造型变体，拼成一张对比图。
 *   node tools/sweep.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHORLS, buildFlowerParticles, buildMotes } from '../src/flowerGeometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'preview-out');
mkdirSync(outDir, { recursive: true });

/* ---------- PNG ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([l, body, c]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 渲染 ---------- */
const TW = 700, TH = 480;
const FOV = (34 * Math.PI) / 180, TAN = Math.tan(FOV / 2);
const ASPECT = TW / TH;
const PITCH = 0.62;
const EXPOSURE = 1.0;
const GAIN = 0.95;

const KSTEPS = 128;
const KERNEL = new Float32Array(KSTEPS);
for (let i = 0; i < KSTEPS; i++) {
  const d = i / (KSTEPS - 1);
  KERNEL[i] = Math.pow(1 - d, 2.1) * 0.8 + Math.pow(1 - d, 10) * 0.85;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ss = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-9)); return t * t * (3 - 2 * t); };
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function makeCam(bounds) {
  const rNeed = bounds.radius * 1.14;
  const hUp = bounds.radius * Math.sin(PITCH) + (bounds.maxY - bounds.centerY) * Math.cos(PITCH);
  const hDn = bounds.radius * Math.sin(PITCH) + (bounds.centerY - bounds.minY) * Math.cos(PITCH);
  const halfH = Math.max(hUp, hDn) * 1.12;
  const dist = Math.max(rNeed / (TAN * ASPECT), halfH / TAN);
  const dir = [0, Math.sin(PITCH), Math.cos(PITCH)];
  const eye = [dir[0] * dist, dir[1] * dist, dir[2] * dist];
  const fwd = [-dir[0], -dir[1], -dir[2]];
  const right = norm3(cross3(fwd, [0, 1, 0]));
  const up = norm3(cross3(right, fwd));
  return { eye, fwd, right, up };
}

function splat(buf, cx, cy, radius, r, g, b, gain) {
  if (!(radius > 0.4)) radius = 0.4;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(TW - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(TH - 1, Math.ceil(cy + radius));
  const inv = 1 / radius;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const k = KERNEL[Math.min(KSTEPS - 1, (Math.sqrt(d2) * (KSTEPS - 1)) | 0)] * gain;
      const i = (y * TW + x) * 3;
      buf[i] += r * k; buf[i + 1] += g * k; buf[i + 2] += b * k;
    }
  }
}

function renderTile(p, spread, look = { sizeMul: 1, gain: GAIN, exposure: EXPOSURE }) {
  const { bud, bloom, normalBud, normalBloom, color, size, delay, count, bounds } = p;
  const cam = makeCam(bounds);
  const pscale = (TH * 0.5) / TAN;
  const HDR = new Float32Array(TW * TH * 3);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const nx = (x / TW) * 2 - 1, ny = (y / TH) * 2 - 1;
      const rr = Math.hypot(nx * 0.8, ny);
      const glow = Math.exp(-rr * rr * 2.4) * 0.07;
      const i = (y * TW + x) * 3;
      HDR[i] = 0.010 + glow * 0.5; HDR[i + 1] = 0.026 + glow * 1.0; HDR[i + 2] = 0.020 + glow * 0.8;
    }
  }
  const motes = buildMotes(160);
  for (let i = 0; i < motes.count; i++) {
    const rel = [motes.pos[i * 3] - cam.eye[0], motes.pos[i * 3 + 1] - cam.eye[1], motes.pos[i * 3 + 2] - cam.eye[2]];
    const cz = dot3(rel, cam.fwd);
    if (cz < 0.3) continue;
    const sx = (dot3(rel, cam.right) / (cz * TAN * ASPECT) + 1) * 0.5 * TW;
    const sy = (1 - dot3(rel, cam.up) / (cz * TAN)) * 0.5 * TH;
    splat(HDR, sx, sy, (motes.size[i] * pscale) / cz * 0.5, motes.color[i * 3], motes.color[i * 3 + 1], motes.color[i * 3 + 2], 0.5);
  }
  const L = norm3([-0.32, 0.72, 0.62]);
  for (let i = 0; i < count; i++) {
    const s = ss(delay[i], delay[i] + 0.62, spread);
    const px = bud[i * 3] + (bloom[i * 3] - bud[i * 3]) * s;
    const py = bud[i * 3 + 1] + (bloom[i * 3 + 1] - bud[i * 3 + 1]) * s - bounds.centerY;
    const pz = bud[i * 3 + 2] + (bloom[i * 3 + 2] - bud[i * 3 + 2]) * s;
    let nx = normalBud[i * 3] + (normalBloom[i * 3] - normalBud[i * 3]) * s;
    let ny = normalBud[i * 3 + 1] + (normalBloom[i * 3 + 1] - normalBud[i * 3 + 1]) * s;
    let nz = normalBud[i * 3 + 2] + (normalBloom[i * 3 + 2] - normalBud[i * 3 + 2]) * s;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const rel = [px - cam.eye[0], py - cam.eye[1], pz - cam.eye[2]];
    const cz = dot3(rel, cam.fwd);
    if (cz < 0.15) continue;
    const sx = (dot3(rel, cam.right) / (cz * TAN * ASPECT) + 1) * 0.5 * TW;
    const sy = (1 - dot3(rel, cam.up) / (cz * TAN)) * 0.5 * TH;
    const diff = Math.abs(nx * L[0] + ny * L[1] + nz * L[2]);
    const rim = Math.pow(1 - Math.abs(nz), 2.0);
    const shade = 0.34 + 0.82 * diff + 0.55 * rim;
    const dim = 0.60 + 0.40 * s;
    const rad = ((size[i] * look.sizeMul * (0.78 + 0.36 * s) * pscale) / cz) * 0.5;
    splat(HDR, sx, sy, rad, color[i * 3] * shade * dim, color[i * 3 + 1] * shade * dim, color[i * 3 + 2] * shade * dim, look.gain);
  }
  const out = Buffer.alloc(TW * TH * 4);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const i = (y * TW + x) * 3, o = (y * TW + x) * 4;
      const nx = (x / TW) * 2 - 1, ny = (y / TH) * 2 - 1;
      const vig = 1 - 0.45 * Math.pow(Math.hypot(nx * 0.88, ny) / 1.414, 2.1);
      for (let c = 0; c < 3; c++) {
        let v = HDR[i + c] * vig;
        v = 1 - Math.exp(-v * look.exposure);
        out[o + c] = Math.round(clamp01(v) * 255);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ---------- 曝光扫描：验证「过曝抹平色差」这个判断 ---------- */
const particles = buildFlowerParticles({ count: 14000 });
console.log(`r=${particles.bounds.radius.toFixed(2)} h=${particles.bounds.height.toFixed(2)}`);

const looks = [
  ['gain 0.40（当前）', { sizeMul: 1, gain: 0.40, exposure: 1.0 }],
  ['gain 0.26', { sizeMul: 1, gain: 0.26, exposure: 1.0 }],
  ['gain 0.16', { sizeMul: 1, gain: 0.16, exposure: 1.0 }],
  ['gain 0.10', { sizeMul: 1, gain: 0.10, exposure: 1.0 }],
];

const tiles = [];
for (const [name, look] of looks) {
  tiles.push(renderTile(particles, 1, look));
  console.log(`  ${name}`);
}

const SW = TW * 2, SH = TH * 2;
const sheet = Buffer.alloc(SW * SH * 4);
for (let t = 0; t < 4; t++) {
  const ox = (t % 2) * TW, oy = Math.floor(t / 2) * TH;
  for (let y = 0; y < TH; y++) {
    tiles[t].copy(sheet, ((oy + y) * SW + ox) * 4, y * TW * 4, (y + 1) * TW * 4);
  }
}
writeFileSync(join(outDir, 'sweep.png'), encodePNG(SW, SH, sheet));
console.log('wrote sweep.png');
