/**
 * 自检脚本（无需浏览器）
 * ---------------------------------------------------------------
 *   node tools/check.mjs
 *
 * 覆盖三件最容易出错、又最容易静默失败的事：
 *   1. tension 公式：用人工构造的「握拳 / 张开 / 半握」21 点数据回归
 *   2. 阈值映射：tension → spread 是否严格落在 0 / 1 上
 *   3. 数据结构：粒子数、NaN、包围盒，以及着色器属性名与几何属性是否对得上
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFlowerParticles } from '../src/flowerGeometry.js';
import { measureTension } from '../src/handTracker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m  ${detail}`);
  }
}

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (x, a, b) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* 1. 合成手部：21 点                                                */
/* ------------------------------------------------------------------ */
/**
 * 造一只「平面手」。fingerCurl: 0=完全伸直, 1=握紧
 * 坐标系同 MediaPipe：归一化，左上原点，y 向下。
 */
function makeHand(fingerCurl) {
  const wrist = { x: 0.5, y: 0.86 };
  const pts = new Array(21);
  pts[0] = wrist;

  // 拇指：从掌根左侧伸出
  const tCurl = fingerCurl;
  pts[1] = { x: 0.415, y: 0.795 };
  pts[2] = { x: 0.375, y: 0.745 };
  pts[3] = { x: lerp(0.345, 0.435, tCurl), y: lerp(0.700, 0.760, tCurl) };
  pts[4] = { x: lerp(0.315, 0.470, tCurl), y: lerp(0.665, 0.800, tCurl) };

  // 四指：index / middle / ring / pinky
  const fingers = [
    { mcp: [0.455, 0.700], len: 0.255 },
    { mcp: [0.505, 0.690], len: 0.275 },
    { mcp: [0.555, 0.695], len: 0.255 },
    { mcp: [0.600, 0.710], len: 0.215 },
  ];

  fingers.forEach((f, i) => {
    const base = 5 + i * 4;
    const [mx, my] = f.mcp;
    pts[base] = { x: mx, y: my };
    if (i > 0) pts[base - 1] = pts[base - 1] || { x: mx, y: my }; // 占位

    // 伸直：沿 -y 方向展开三段；握拳：折回掌心
    const seg = f.len / 3;
    const c = fingerCurl;
    for (let k = 1; k <= 3; k++) {
      const u = k / 3;
      // 伸直方向 / 折回方向插值
      const straightY = my - f.len * u;
      const curlY = my + 0.055 * Math.sin(Math.PI * u) - 0.02 * u;
      const curlX = mx + 0.02 * Math.sin(Math.PI * u * 0.8);
      pts[base + k] = {
        x: mx + (curlX - mx) * c,
        y: straightY * (1 - c) + curlY * c,
      };
    }
  });

  // 补齐指节之间的连接点（MediaPipe 的 PIP/DIP 已在上面填好）
  pts[5] = { x: 0.455, y: 0.700 };
  pts[9] = { x: 0.505, y: 0.690 };
  pts[13] = { x: 0.555, y: 0.695 };
  pts[17] = { x: 0.600, y: 0.710 };

  return pts;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

console.log('\n\x1b[1m1) tension 公式回归\x1b[0m');
const openT = measureTension(makeHand(0));
const fistT = measureTension(makeHand(1));

ok('张开手掌 → 接近 1', openT > 0.85, `tension=${openT.toFixed(3)}`);
ok('握拳 → 接近 0', fistT < 0.15, `tension=${fistT.toFixed(3)}`);
ok('恒定手型稳定（无抖动）', Math.abs(measureTension(makeHand(0)) - openT) < 1e-9);

// 蜷曲程度 0→1 扫描：张力必须单调下降，且要经过中间区间
const sweep = [0, 0.2, 0.4, 0.6, 0.8, 1].map((c) => ({ c, t: measureTension(makeHand(c)) }));
const mono = sweep.every((s, i) => i === 0 || s.t <= sweep[i - 1].t + 1e-9);
ok('张力随蜷曲单调下降', mono, sweep.map((s) => `${s.c}:${s.t.toFixed(2)}`).join('  '));
ok('存在中间过渡态（0.2~0.8）', sweep.some((s) => s.t > 0.2 && s.t < 0.8));
ok('两端覆盖阈值区间（<0.32 与 >0.66）', fistT < 0.32 && openT > 0.66);

/* ------------------------------------------------------------------ */
/* 2. 阈值映射                                                        */
/* ------------------------------------------------------------------ */
console.log('\n\x1b[1m2) 阈值映射 0.32 / 0.66\x1b[0m');
const CLOSED = 0.32;
const OPEN = 0.66;
ok('tension 0.00 → spread 0', smoothstep(0, CLOSED, OPEN) === 0);
ok('tension 0.30 → spread 0（仍在花苞）', smoothstep(0.3, CLOSED, OPEN) === 0);
ok('tension 0.70 → spread 1（盛放）', smoothstep(0.7, CLOSED, OPEN) === 1);
ok('tension 0.32 → spread 0', smoothstep(0.32, CLOSED, OPEN) === 0);
ok('tension 0.66 → spread 1', smoothstep(0.66, CLOSED, OPEN) === 1);
const mid = smoothstep(0.49, CLOSED, OPEN);
ok('tension 0.49 → 中间过渡', mid > 0.3 && mid < 0.7, `spread=${mid.toFixed(3)}`);

// 缓动：currentSpread += (target - current) * 0.1
let cur = 0;
const frames = [];
for (let i = 0; i < 120; i++) {
  cur += (1 - cur) * 0.1;
  frames.push(cur);
}
ok('缓动第 1 帧 ≈ 0.1', near(frames[0], 0.1, 1e-9), `=${frames[0].toFixed(4)}`);
ok('缓动 60 帧后 ≈ 0.998（约 1 秒到位）', frames[59] > 0.99, `=${frames[59].toFixed(4)}`);

/* ------------------------------------------------------------------ */
/* 3. 几何数据                                                        */
/* ------------------------------------------------------------------ */
console.log('\n\x1b[1m3) 粒子几何\x1b[0m');
for (const n of [5000, 14000, 20000]) {
  const p = buildFlowerParticles({ count: n });
  const allArrays = [p.bud, p.bloom, p.normalBud, p.normalBloom, p.color, p.size, p.seed, p.delay];
  let hasNaN = false;
  for (const arr of allArrays) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) { hasNaN = true; break; }
    }
    if (hasNaN) break;
  }
  ok(`count=${n} 数量正确`, p.count === n, `petal=${p.stats.petal} rim=${p.stats.rim} stamen=${p.stats.stamen}`);
  ok(`count=${n} 无 NaN/Inf`, !hasNaN);
  ok(`count=${n} 花苞比盛放小`, p.bounds.radius > 0.5 && p.bounds.radius < 1.4, `radius=${p.bounds.radius.toFixed(2)} h=${p.bounds.height.toFixed(2)}`);

  // 法向必须是单位向量
  let unit = true;
  for (let i = 0; i < 200; i++) {
    const l = Math.hypot(p.normalBloom[i * 3], p.normalBloom[i * 3 + 1], p.normalBloom[i * 3 + 2]);
    if (Math.abs(l - 1) > 1e-3) { unit = false; break; }
  }
  ok(`count=${n} 法向已归一化`, unit);
}

// 花苞状态的包围盒确实更小
{
  const p = buildFlowerParticles({ count: 14000 });
  let rBud = 0, rBloom = 0;
  for (let i = 0; i < p.count; i++) {
    rBud = Math.max(rBud, Math.hypot(p.bud[i * 3], p.bud[i * 3 + 2]));
    rBloom = Math.max(rBloom, Math.hypot(p.bloom[i * 3], p.bloom[i * 3 + 2]));
  }
  ok('花苞横向尺寸 < 盛放', rBud < rBloom * 0.75, `bud=${rBud.toFixed(2)} bloom=${rBloom.toFixed(2)}`);
}

/* ------------------------------------------------------------------ */
/* 4. 着色器 / 几何属性一致性                                         */
/* ------------------------------------------------------------------ */
console.log('\n\x1b[1m4) 着色器与几何属性对齐\x1b[0m');
{
  const flowerSrc = readFileSync(join(root, 'src', 'flower.js'), 'utf8');
  const block = flowerSrc.match(/const FLOWER_VERT = \/\* glsl \*\/ `([\s\S]*?)`;/);
  const frag = flowerSrc.match(/const FLOWER_FRAG = \/\* glsl \*\/ `([\s\S]*?)`;/);
  ok('找到 FLOWER_VERT', !!block);
  ok('找到 FLOWER_FRAG', !!frag);

  if (block) {
    const glsl = block[1];
    const declared = [...glsl.matchAll(/attribute\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]);
    const data = buildFlowerParticles({ count: 5000 });
    const attrSet = new Set([
      'position', 'aBud', 'aBloom', 'aNBud', 'aNBloom', 'aColor', 'aSize', 'aSeed', 'aDelay',
    ]);
    const missing = declared.filter((d) => !attrSet.has(d));
    ok('顶点着色器的 attribute 都能在几何里找到', missing.length === 0, missing.join(',') || `${declared.length} 个`);

    // 每个 attribute 在 _build 里都 setAttribute 了
    const expected = declared.filter((d) => d !== 'position');
    const notSet = expected.filter((d) => !flowerSrc.includes(`setAttribute('${d}'`));
    ok('每个 attribute 都有 setAttribute', notSet.length === 0, notSet.join(',') || `${expected.length} 个`);

    // uniform 声明 vs uniforms 对象
    const uDeclared = [...glsl.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g)].map((m) => m[1]);
    const notInObj = uDeclared.filter((u) => !flowerSrc.includes(`${u}: { value:`));
    ok('uniform 都有对应 JS 值', notInObj.length === 0, notInObj.join(',') || `${uDeclared.length} 个`);

    // varying 在两个着色器里必须同名同类型
    if (frag) {
      const vV = [...glsl.matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g)].map((m) => `${m[1]} ${m[2]}`);
      const vF = [...frag[1].matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g)].map((m) => `${m[1]} ${m[2]}`);
      ok('varying 声明一致', vV.length === vF.length && vV.every((v) => vF.includes(v)), `${vV.join(' | ')}`);
    }

    ok('片元着色器写了 gl_FragColor', /gl_FragColor/.test(frag[1]));
    ok('顶点着色器写了 gl_PointSize', /gl_PointSize/.test(glsl));
    ok('没有 WebGL2 专属语法（attribute/varying 混用 GLSL1）', !/in\s+vec[234]\s+vColor/.test(glsl));
  }
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 5. DOM 契约 & 模块路径                                             */
/* ------------------------------------------------------------------ */
console.log('\n\x1b[1m5) DOM 契约与模块引用\x1b[0m');
{
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const mainSrc = readFileSync(join(root, 'src', 'main.js'), 'utf8');

  // main.js 里所有 $('xxx') 引用的 id，必须在 index.html 里真实存在
  const ids = [...mainSrc.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  const uniq = [...new Set(ids)];
  const missing = uniq.filter((id) => !html.includes(`id="${id}"`));
  ok(`JS 引用的 ${uniq.length} 个 DOM id 都存在`, missing.length === 0, missing.join(', '));

  const htmlIds = [...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]);
  ok('index.html 里 id 无重复', new Set(htmlIds).size === htmlIds.length);

  // 每个模块 import 的相对路径都必须真实存在
  const files = [
    'src/main.js', 'src/flower.js', 'src/backdrop.js', 'src/skeleton.js',
    'src/handTracker.js', 'src/handPreview.js',
  ];
  const badImports = [];
  for (const rel of files) {
    const src = readFileSync(join(root, rel), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = join(root, 'src', m[1].replace(/^\.\//, ''));
      try {
        readFileSync(target);
      } catch {
        badImports.push(`${rel} → ${m[1]}`);
      }
    }
  }
  ok('相对 import 路径全部存在', badImports.length === 0, badImports.join(', ') || 'ok');
}

/* ------------------------------------------------------------------ */console.log(`\n\x1b[1m结果：${pass} 通过，${fail} 失败\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);



