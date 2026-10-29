/**
 * 离线预览渲染器（开发工具，不参与线上运行）
 * ---------------------------------------------------------------
 * 把 src/flowerGeometry.js 生成的粒子，用与顶点/片元着色器**一致**的
 * 投影、假光照、软核叠加逻辑，软件光栅化成 PNG。
 * 没有浏览器/显卡的机器上也能检查造型与观感。
 *
 * 环境变量：
 *   PREVIEW_W / PREVIEW_H   画布尺寸（默认 1200×820）
 *   PREVIEW_PITCH           俯视角弧度（默认 0.62）
 *   STATES                  要渲染的绽放度，逗号分隔（默认 0,0.3,0.55,0.8,1）
 *   STRIP=1                 额外输出横向拼图 bloom-sequence.png
 *   SIZE_MUL / GAIN / EXPOSURE / TONE=clamp|filmic
 *   DEBUG=1                 按轮次上色（红=外 绿=中 蓝=内 黄=花蕊）
 *   PARTICLES               粒子数（默认 14000）
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFlowerParticles, buildMotes } from '../src/flowerGeometry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(__dirname, '..', 'preview-out');
mkdirSync(outDir, { recursive: true });

/* ================================================================== */
/* PNG 编码                                                            */
/* ================================================================== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ================================================================== */
/* 参数                                                                */
/* ================================================================== */
const WIDTH = Number(process.env.PREVIEW_W || 1200);
const HEIGHT = Number(process.env.PREVIEW_H || 820);
const FOV = (34 * Math.PI) / 180;
const TAN = Math.tan(FOV / 2);
const ASPECT = WIDTH / HEIGHT;
const PITCH = Number(process.env.PREVIEW_PITCH || 0.62);
const SIZE_MUL = Number(process.env.SIZE_MUL || 1.4);
const GAIN = Number(process.env.GAIN || 0.4);
const EXPOSURE = Number(process.env.EXPOSURE || 1.0);
const TONE = process.env.TONE || 'clamp';
const DEBUG = process.env.DEBUG === '1';
const BLEND = process.env.BLEND || 'add';
const N = Number(process.env.PARTICLES || 14000);
const STATES = (process.env.STATES || '0,0.3,0.55,0.8,1').split(',').map(Number);

/* ================================================================== */
/* 数学                                                                */
/* ================================================================== */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 与 src/flower.js 完全一致的装框逻辑 */
function makeCamera(bounds) {
  const rNeed = bounds.radius * 1.16;
  const hUp = bounds.radius * Math.sin(PITCH) + (bounds.maxY - bounds.centerY) * Math.cos(PITCH);
  const hDn = bounds.radius * Math.sin(PITCH) + (bounds.centerY - bounds.minY) * Math.cos(PITCH);
  const halfHNeed = Math.max(hUp, hDn) * 1.16;
  const dist = Math.max(rNeed / (TAN * Math.max(0.3, ASPECT)), halfHNeed / TAN);

  const dir = [0, Math.sin(PITCH), Math.cos(PITCH)];
  const eye = [dir[0] * dist, dir[1] * dist, dir[2] * dist];
  const fwd = [-dir[0], -dir[1], -dir[2]];
  const right = norm3(cross3(fwd, [0, 1, 0]));
  const up = norm3(cross3(right, fwd));
  return { eye, fwd, right, up, dist };
}

/* ================================================================== */
/* 光栅化                                                              */
/* ================================================================== */
const KSTEPS = 160;
const KERNEL = new Float32Array(KSTEPS);
for (let i = 0; i < KSTEPS; i++) {
  const d = i / (KSTEPS - 1);
  KERNEL[i] = Math.pow(1 - d, 2.8); // 与片元着色器同一条衰减曲线
}

function splat(buf, cx, cy, radius, r, g, b, gain) {
  if (!(radius > 0.8)) radius = 0.8;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(WIDTH - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(HEIGHT - 1, Math.ceil(cy + radius));
  const inv = 1 / radius;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const k = KERNEL[((Math.sqrt(d2) * (KSTEPS - 1)) | 0)] * gain;
      const i = (y * WIDTH + x) * 3;
      if (BLEND === 'alpha') {
        const a = Math.min(1, k);
        buf[i] = buf[i] * (1 - a) + r * a;
        buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
        buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
      } else {
        buf[i] += r * k;
        buf[i + 1] += g * k;
        buf[i + 2] += b * k;
      }
    }
  }
}

function render(spread, particles, cam, out) {
  const { bud, bloom, normalBud, normalBloom, color, size, delay, count, bounds } = particles;
  const centerY = bounds.centerY;
  const pointScale = (HEIGHT * 0.5) / TAN;
  const { eye, fwd, right, up } = cam;

  const HDR = new Float32Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // 与 src/backdrop.js 完全同一套渐变
      const sx = x / WIDTH;
      const sy = y / HEIGHT;
      const cx = (sx - 0.5);
      const cy = (sy - 0.42) * 0.92;
      const rr = Math.hypot(cx, cy);
      const near = [0.028, 0.080, 0.060];
      const mid = [0.014, 0.042, 0.033];
      const far = [0.006, 0.018, 0.014];
      const t1 = smoothstep(0.0, 0.55, rr);
      const t2 = smoothstep(0.45, 1.05, rr);
      const i = (y * WIDTH + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        HDR[i + ch] = (near[ch] + (mid[ch] - near[ch]) * t1) * (1 - t2) + far[ch] * t2;
      }
    }
  }

  // 花心柔光（对应网页里的 Sprite 光晕）
  const haloR = WIDTH * (0.14 + 0.18 * spread);
  const hx = WIDTH * 0.5;
  const hy = HEIGHT * 0.5;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const d = Math.hypot(x - hx, y - hy) / haloR;
      if (d > 2.6) continue;
      const k = Math.exp(-d * d * 1.5) * (0.015 + 0.05 * spread);
      const i = (y * WIDTH + x) * 3;
      HDR[i] += k;
      HDR[i + 1] += k * 0.97;
      HDR[i + 2] += k * 0.84;
    }
  }

  // 浮尘
  const motes = buildMotes(300);
  for (let i = 0; i < motes.count; i++) {
    const rel = [
      motes.pos[i * 3] - eye[0],
      motes.pos[i * 3 + 1] - eye[1],
      motes.pos[i * 3 + 2] - eye[2],
    ];
    const cz = dot3(rel, fwd);
    if (cz < 0.3) continue;
    const sx = (dot3(rel, right) / (cz * TAN * ASPECT) + 1) * 0.5 * WIDTH;
    const sy = (1 - dot3(rel, up) / (cz * TAN)) * 0.5 * HEIGHT;
    splat(HDR, sx, sy, ((motes.size[i] * pointScale) / cz) * 0.5,
      motes.color[i * 3], motes.color[i * 3 + 1], motes.color[i * 3 + 2], 0.5);
  }

  const L = norm3([-0.32, 0.72, 0.62]);
  let order = null;
  if (BLEND === 'alpha') {
    order = [...Array(count).keys()].sort((a, b) => {
      const za = bud[b * 3 + 2] + (bloom[b * 3 + 2] - bud[b * 3 + 2]) * smoothstep(delay[b], delay[b] + 0.62, spread);
      const zb = bud[a * 3 + 2] + (bloom[a * 3 + 2] - bud[a * 3 + 2]) * smoothstep(delay[a], delay[a] + 0.62, spread);
      return za - zb;
    });
  }
  let minSX = 1e9, maxSX = -1e9, minSY = 1e9, maxSY = -1e9;

  for (let oi = 0; oi < count; oi++) {
    const i = order ? order[oi] : oi;
    const d = delay[i];
    const s = smoothstep(d, d + 0.62, spread);

    const px = bud[i * 3] + (bloom[i * 3] - bud[i * 3]) * s;
    const py = bud[i * 3 + 1] + (bloom[i * 3 + 1] - bud[i * 3 + 1]) * s - centerY;
    const pz = bud[i * 3 + 2] + (bloom[i * 3 + 2] - bud[i * 3 + 2]) * s;

    let nx = normalBud[i * 3] + (normalBloom[i * 3] - normalBud[i * 3]) * s;
    let ny = normalBud[i * 3 + 1] + (normalBloom[i * 3 + 1] - normalBud[i * 3 + 1]) * s;
    let nz = normalBud[i * 3 + 2] + (normalBloom[i * 3 + 2] - normalBud[i * 3 + 2]) * s;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    const rel = [px - eye[0], py - eye[1], pz - eye[2]];
    const cz = dot3(rel, fwd);
    if (cz < 0.15) continue;

    const ndcX = dot3(rel, right) / (cz * TAN * ASPECT);
    const ndcY = dot3(rel, up) / (cz * TAN);
    const sx = (ndcX + 1) * 0.5 * WIDTH;
    const sy = (1 - ndcY) * 0.5 * HEIGHT;

    if (sx < minSX) minSX = sx;
    if (sx > maxSX) maxSX = sx;
    if (sy < minSY) minSY = sy;
    if (sy > maxSY) maxSY = sy;

    const diff = Math.abs(nx * L[0] + ny * L[1] + nz * L[2]);
    const rimT = Math.pow(1 - Math.abs(nz), 2.0);
    const shade = 0.72 + 0.40 * diff + 0.20 * rimT;
    const depthK = smoothstep(cam.dist - bounds.radius * 0.9, cam.dist + bounds.radius * 0.9, cz);
    const dim = (0.62 + 0.42 * s) * (1 - 0.68 * depthK);

    // 花蕊显影，与顶点着色器一致
    const isStamen = delay[i] >= 0.24 ? 1 : 0;
    const reveal = smoothstep(0.34, 0.78, spread);
    const vis = 1 + (reveal - 1) * isStamen;

    let cr = color[i * 3] * shade * dim * vis;
    let cg = color[i * 3 + 1] * shade * dim * vis;
    let cb = color[i * 3 + 2] * shade * dim * vis;

    if (DEBUG) {
      const dl = delay[i];
      if (dl < 0.05) { cr = 0.9; cg = 0.22; cb = 0.18; }
      else if (dl < 0.14) { cr = 0.18; cg = 0.9; cb = 0.32; }
      else if (dl < 0.24) { cr = 0.26; cg = 0.5; cb = 0.95; }
      else { cr = 0.95; cg = 0.8; cb = 0.2; }
    }

    const rad = ((size[i] * SIZE_MUL * (0.78 + 0.36 * s) * pointScale) / cz) * 0.5;
    splat(HDR, sx, sy, rad, cr, cg, cb, DEBUG ? 0.55 : GAIN);
  }

  out.bounds = { minSX, maxSX, minSY, maxSY };

  // 诊断：花区域（亮度 > 0.02）的累计亮度分位数，用来定曝光
  if (process.env.HIST === '1') {
    const vals = [];
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const l = 0.2126 * HDR[i * 3] + 0.7152 * HDR[i * 3 + 1] + 0.0722 * HDR[i * 3 + 2];
      if (l > 0.02) vals.push(l);
    }
    vals.sort((a, b) => a - b);
    const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] || 0;
    out.hist = {
      n: vals.length,
      p50: q(0.5), p75: q(0.75), p90: q(0.9), p97: q(0.97), p99: q(0.99),
      max: vals[vals.length - 1] || 0,
    };
  }

  // 色调映射（clamp 更接近真实 WebGL：加色后直接裁剪）
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      const o = (y * WIDTH + x) * 4;
      const nx = (x / WIDTH) * 2 - 1;
      const ny = (y / HEIGHT) * 2 - 1;
      const vig = 1 - 0.45 * Math.pow(Math.hypot(nx * 0.88, ny) / 1.414, 2.1);
      for (let c = 0; c < 3; c++) {
        let v = HDR[i + c] * vig * EXPOSURE;
        v = TONE === 'clamp' ? Math.min(1, v) : 1 - Math.exp(-v);
        rgba[o + c] = Math.round(clamp01(v) * 255);
      }
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */
const particles = buildFlowerParticles({ count: N });
const cam = makeCamera(particles.bounds);
console.log(
  `particles=${particles.count} radius=${particles.bounds.radius.toFixed(3)} ` +
  `height=${particles.bounds.height.toFixed(3)} centerY=${particles.bounds.centerY.toFixed(3)} dist=${cam.dist.toFixed(2)}`
);

const frames = [];
STATES.forEach((spread, k) => {
  const t0 = Date.now();
  const out = {};
  const rgba = render(spread, particles, cam, out);
  const name = `${String(k).padStart(2, '0')}-spread-${spread.toFixed(2)}`;
  writeFileSync(join(outDir, `${name}.png`), encodePNG(WIDTH, HEIGHT, rgba));
  console.log(
    `  ${name}.png  ${Date.now() - t0}ms  ` +
    `x:[${out.bounds.minSX.toFixed(0)},${out.bounds.maxSX.toFixed(0)}] ` +
    `y:[${out.bounds.minSY.toFixed(0)},${out.bounds.maxSY.toFixed(0)}]`
  );
  if (out.hist) {
    const h = out.hist;
    console.log(
      `    HDR 亮度分位: p50=${h.p50.toFixed(2)} p75=${h.p75.toFixed(2)} ` +
      `p90=${h.p90.toFixed(2)} p97=${h.p97.toFixed(2)} p99=${h.p99.toFixed(2)} max=${h.max.toFixed(2)} (${h.n} px)`
    );
  }
  frames.push(rgba);
});

if (process.env.STRIP === '1' && frames.length > 1) {
  const SW = WIDTH * frames.length;
  const sheet = Buffer.alloc(SW * HEIGHT * 4);
  frames.forEach((f, i) => {
    for (let y = 0; y < HEIGHT; y++) {
      f.copy(sheet, (y * SW + i * WIDTH) * 4, y * WIDTH * 4, (y + 1) * WIDTH * 4);
    }
  });
  writeFileSync(join(outDir, 'bloom-sequence.png'), encodePNG(SW, HEIGHT, sheet));
  console.log(`  bloom-sequence.png  ${SW}x${HEIGHT}`);
}

console.log('done →', outDir);






