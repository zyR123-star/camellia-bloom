/**
 * 白山茶 · 粒子几何生成器
 * ---------------------------------------------------------------
 * 这一层是**纯数学**，不 import three.js。
 * 好处：同一份数据既能喂给 WebGL，也能被 tools/preview.mjs
 * 在 Node 里做离线软件渲染，方便没有显卡时调形。
 *
 * 核心思路
 *   一朵花 = 3 轮花瓣（外/中/内）+ 花蕊，共 18 片花瓣。
 *   每片花瓣先用参数曲面 P(s, a) 描述：
 *       s ∈ [0,1]  由花瓣基部到尖端
 *       a ∈ [-1,1] 横向（a=±1 是花瓣左右边缘）
 *   再把这个参数曲面求值两次：
 *       一次用「花苞」姿态（beta 小、半径大、强杯曲、尖端内卷、螺旋扭转）
 *       一次用「盛放」姿态（beta 大、锥形展开、轻微外翻）
 *   得到 bud / bloom 两套顶点，着色器里按 spread 做插值。
 *
 * 花瓣轮廓（极坐标化的宽度函数）
 *   W(s) = Wmax · [ sin(π · s^1.45) ]^0.55
 *   - s=0 处 W→0，得到白山茶那种「楔形窄基」
 *   - 最宽处在 s≈0.62（倒卵形 obovate）
 *   - 指数 0.55 < 1 使 s→1 时 dW/ds→-∞，即轮廓与中轴垂直相交，
 *     视觉上就是**圆钝的花瓣顶**（山茶属的典型特征）
 */

const TAU = Math.PI * 2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* 调色：按「显示空间」给值（自定义着色器不做线性化，保持所见即所得）    */
/* ------------------------------------------------------------------ */
export const PALETTE = {
  petalBase: [1.0, 0.985, 0.945], // 花瓣基部：极轻的暖白
  petalMid: [1.0, 1.0, 1.0],      // 花瓣中段：纯白
  petalTip: [0.972, 0.988, 1.0],  // 花瓣边缘：几乎纯白（只留一丝冷）
  rim: [1.0, 0.99, 0.97],         // 花瓣边缘描边
  filament: [1.0, 0.845, 0.470],  // 花丝：明确的金
  anther: [1.0, 0.700, 0.130],    // 花药：饱和琥珀金
  core: [1.0, 0.885, 0.470],      // 花心辉光
  motes: [1.0, 0.906, 0.706],     // 空气浮尘
};

/* ------------------------------------------------------------------ */
/* 三轮花瓣的姿态参数                                                  */
/*   beta  : 花瓣与花轴的夹角（0=竖直向上，π/2=完全摊平）              */
/*   L/W   : 花瓣长度 / 最大半宽                                       */
/*   rBase : 花瓣基部到花轴的距离                                      */
/*   cup   : 横向杯曲（越大越卷，两侧向花轴包）                        */
/*   curl  : 纵向卷曲（正=尖端内扣，负=尖端外翻）                      */
/*   twist : 沿花瓣长度的螺旋扭转（花苞期层层包裹）                    */
/*   y0    : 花瓣基部的世界高度                                        */
/* ------------------------------------------------------------------ */
export const WHORLS = [
  {
    // 外轮：宽大的倒卵形花瓣，接近水平、瓣尖微微外翻（山茶开足时的样子）
    name: 'outer',
    petals: 7,
    azOffset: 0.0,
    delay: 0.0,
    bud: { beta: 0.150, L: 0.690, W: 0.290, rBase: 0.200, cup: 0.72, curl: 0.30, twist: 0.26, y0: -0.30 },
    bloom: { beta: 1.285, L: 0.880, W: 0.505, rBase: 0.100, cup: 0.98, curl: 0.16, twist: 0.0, y0: -0.15 },
  },
  {
    // 中轮：立起来的浅杯，花瓣中脊受光
    name: 'middle',
    petals: 6,
    azOffset: 0.55,
    delay: 0.09,
    bud: { beta: 0.105, L: 0.750, W: 0.250, rBase: 0.155, cup: 0.62, curl: 0.26, twist: 0.30, y0: -0.28 },
    bloom: { beta: 1.010, L: 0.850, W: 0.470, rBase: 0.140, cup: 1.02, curl: 0.36, twist: 0.0, y0: -0.13 },
  },
  {
    // 内轮：向上收拢成杯口，围住金色花蕊
    name: 'inner',
    petals: 5,
    azOffset: 1.10,
    delay: 0.18,
    bud: { beta: 0.060, L: 0.785, W: 0.225, rBase: 0.115, cup: 0.54, curl: 0.20, twist: 0.34, y0: -0.26 },
    bloom: { beta: 0.700, L: 0.710, W: 0.380, rBase: 0.180, cup: 1.05, curl: 0.56, twist: 0.0, y0: -0.12 },
  },
];

/* 花蕊：白山茶的金色花蕊球是最好认的特征，给足分量 */
export const STAMEN = {
  bloom: { yBase: 0.09, count: 88, rMin: 0.050, rMax: 0.345, hMin: 0.05, hMax: 0.30 },
  bud: { y: 0.245, radius: 0.040 },
};

/* ------------------------------------------------------------------ */
/* 随机数：确定性 PRNG，保证每次生成一致（便于离线比对）               */
/* ------------------------------------------------------------------ */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* 花瓣曲面                                                            */
/* ------------------------------------------------------------------ */
/**
 * 花瓣半宽轮廓：倒卵形 + 宽圆的瓣顶
 *
 *   W(t) = Wmax · t^0.55 · (1 − t⁴)^0.5
 *
 *   · t^0.55    → 基部窄（山茶的楔形瓣爪），但不是 0 宽度的一根线
 *   · (1−t⁴)^.5 → 到 t≈0.75 才收顶，t=0.95 时仍有约一半宽度
 *
 * 这一点很关键：如果轮廓在尖端直接收敛到 0（像 sin 曲线），
 * 粒子云的瓣尖就会变成一个个尖角，看起来像百合或者碎冰；
 * 保持宽圆收口，才会出现山茶那种「圆钝花瓣」的轮廓。
 */
export function petalWidthProfile(s) {
  const t = clamp01(s);
  return Math.pow(t, 0.55) * Math.pow(1 - Math.pow(t, 4), 0.5);
}

/**
 * 花瓣曲面上的一点。
 * 局部正交基：
 *   切向 u = (-sin az, 0, cos az)
 *   长度 v = ( sinβ·cos az, cosβ, sinβ·sin az )
 *   法向 n = u × v = ( -cosβ·cos az, sinβ, -cosβ·sin az )   // 指向花轴（凹陷侧）
 */
export function evaluatePetal(pose, s, a, out) {
  const t = clamp01(s);
  const wave = 1 + (pose.wob || 0) * Math.sin(t * 6.2 + (pose.ph || 0));
  const w = petalWidthProfile(t) * pose.W * wave;
  const across = a * w;
  const along = t * pose.L;
  // 横向杯曲（a² 让两侧往回包）+ 纵向卷曲（s² 让尖端收/放）
  const lift = pose.cup * a * a * pose.W + pose.curl * t * t * pose.L;

  const az = pose.az + pose.twist * t;
  const cs = Math.cos(az);
  const sn = Math.sin(az);
  const cb = Math.cos(pose.beta);
  const sb = Math.sin(pose.beta);

  out[0] = pose.rBase * cs - sn * across + sb * cs * along - cs * cb * lift;
  out[1] = pose.y0 + cb * along + sb * lift;
  out[2] = pose.rBase * sn + cs * across + sb * sn * along - sn * cb * lift;
  return out;
}

const _p0 = [0, 0, 0];
const _p1 = [0, 0, 0];
const _p2 = [0, 0, 0];

/** 数值微分求花瓣法向（用于假光照，做出立体明暗） */
export function evaluatePetalNormal(pose, s, a, out) {
  const ds = 0.004;
  const da = 0.006;
  const s0 = clamp01(s);
  const a0 = a < -0.995 ? -0.995 : a > 0.995 ? 0.995 : a;
  const s1 = s0 + ds <= 1 ? s0 + ds : s0 - ds;
  const a1 = a0 + da <= 1 ? a0 + da : a0 - da;

  evaluatePetal(pose, s0, a0, _p0);
  evaluatePetal(pose, s1, a0, _p1);
  evaluatePetal(pose, s0, a1, _p2);

  const ux = (_p1[0] - _p0[0]) / (s1 - s0);
  const uy = (_p1[1] - _p0[1]) / (s1 - s0);
  const uz = (_p1[2] - _p0[2]) / (s1 - s0);
  const vx = (_p2[0] - _p0[0]) / (a1 - a0);
  const vy = (_p2[1] - _p0[1]) / (a1 - a0);
  const vz = (_p2[2] - _p0[2]) / (a1 - a0);

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
  return out;
}

/* ------------------------------------------------------------------ */
/* 颜色                                                                */
/* ------------------------------------------------------------------ */
function petalColorAt(s, out) {
  const a = PALETTE.petalBase;
  const b = PALETTE.petalMid;
  const c = PALETTE.petalTip;
  if (s < 0.42) {
    const t = smoothstep(0.0, 0.42, s);
    out[0] = lerp(a[0], b[0], t);
    out[1] = lerp(a[1], b[1], t);
    out[2] = lerp(a[2], b[2], t);
  } else {
    const t = smoothstep(0.42, 1.0, s);
    out[0] = lerp(b[0], c[0], t);
    out[1] = lerp(b[1], c[1], t);
    out[2] = lerp(b[2], c[2], t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 花瓣清单：先算好每片花瓣的姿态与个体差异，本体/描边两趟复用          */
/* ------------------------------------------------------------------ */
function buildPetalList(rand) {
  const list = [];
  for (const whorl of WHORLS) {
    for (let k = 0; k < whorl.petals; k++) {
      // 每片花瓣的个体差异，打破「数学完美」的塑料感
      const az = whorl.azOffset + (k / whorl.petals) * TAU + (rand() - 0.5) * 0.16;
      const varL = 0.975 + rand() * 0.055;
      const varW = 0.965 + rand() * 0.07;
      const varB = (rand() - 0.5) * 0.17;
      const varI = 0.82 + rand() * 0.30; // 单片花瓣的明暗
      const ph = rand() * TAU;
      const warm = (rand() - 0.5) * 0.13;  // 单片花瓣的冷暖偏移

      const mk = (base) => ({
        ...base,
        az,
        L: base.L * varL,
        W: base.W * varW,
        beta: base.beta + varB,
        wob: 0.008,
        ph,
      });

      list.push({
        whorl,
        az,
        intensity: varI,
        warm,
        bud: mk(whorl.bud),
        bloom: mk(whorl.bloom),
      });
    }
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */
/**
 * @param {object} [opts]
 * @param {number} [opts.count]  粒子总数 5000~20000
 * @param {number} [opts.seed]   随机种子
 * @param {number} [opts.petalShare] 花瓣占比
 * @param {number} [opts.rimShare]   花瓣边缘描边占比
 */
export function buildFlowerParticles(opts = {}) {
  const count = Math.max(3000, Math.min(24000, Math.round(opts.count ?? 14000)));
  const seed = opts.seed ?? 20260130;
  // 不再单独铺「描边」粒子：花瓣的层次交给明暗与景深，
  // 亮边会在粒子云里变成一条条发光的线，反而像碎冰。
  const petalShare = opts.petalShare ?? 0.86;
  const rimShare = opts.rimShare ?? 0.0;

  const rand = mulberry32(seed);

  const nPetal = Math.floor(count * petalShare);
  const nRim = Math.floor(count * rimShare);
  const nStamen = count - nPetal - nRim;

  const bud = new Float32Array(count * 3);
  const bloom = new Float32Array(count * 3);
  const normalBud = new Float32Array(count * 3);
  const normalBloom = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seedArr = new Float32Array(count);
  const delay = new Float32Array(count);

  let cursor = 0;
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const col = [0, 0, 0];

  const petals = buildPetalList(rand);

  /* ---------------- 1. 花瓣本体 ---------------- */
  // 按「花瓣面积」分配预算，大花瓣粒子更密
  const totalArea = petals.reduce((acc, pt) => acc + pt.bloom.L * pt.bloom.W, 0);

  // 采样 s 的 CDF（按宽度加权，使曲面上粒子近似均匀）
  const NBIN = 64;
  const cdf = new Float32Array(NBIN + 1);
  for (let i = 0; i < NBIN; i++) {
    cdf[i + 1] = cdf[i] + petalWidthProfile((i + 0.5) / NBIN) + 0.055;
  }
  const cdfMax = cdf[NBIN];
  const sampleS = () => {
    const u = rand() * cdfMax;
    let lo = 0, hi = NBIN;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(0, lo - 1);
    const t = (u - cdf[i]) / Math.max(1e-6, cdf[i + 1] - cdf[i]);
    return (i + t) / NBIN;
  };

  for (const pt of petals) {
    const quota = Math.max(24, Math.round((nPetal * pt.bloom.L * pt.bloom.W) / totalArea));
    for (let j = 0; j < quota; j++) {
      if (cursor >= nPetal) break;
      const s = sampleS();
      // 横向：略微偏向两侧边缘，让轮廓更清晰
      const u = rand();
      let a = u * 2 - 1;
      a = Math.sign(a) * Math.pow(Math.abs(a), 0.78);
      // 少量粒子越过花瓣边界并压暗 → 毛茸茸的边缘，不像几何片
      let edgeSpray = 1;
      if (rand() < 0.055) {
        a = Math.sign(a || 1) * (1 + rand() * 0.13);
        edgeSpray = 0.42;
      }

      evaluatePetal(pt.bud, s, a, p);
      const bx = p[0], by = p[1], bz = p[2];
      evaluatePetal(pt.bloom, s, a, p);
      const ox = p[0], oy = p[1], oz = p[2];

      evaluatePetalNormal(pt.bud, s, a, n);
      const nbx = n[0], nby = n[1], nbz = n[2];
      evaluatePetalNormal(pt.bloom, s, a, n);
      const nox = n[0], noy = n[1], noz = n[2];

      const thick = (rand() - 0.5) * 0.008;
      const jitter = (0.94 + rand() * 0.12) * pt.intensity;
      petalColorAt(s, col);
      // 花瓣中脊的一道高光（蜡质反光），是「山茶」最直观的质感线索
      const sheen = 1 + 0.14 * Math.exp(-a * a * 3.4) * smoothstep(0.06, 0.50, s);
      // 边缘渐隐：粒子密度在瓣缘柔化，避免出现一条几何描边
      const edgeFade = 0.62 + 0.38 * smoothstep(1.02, 0.66, Math.abs(a));

      const i = cursor++;
      bud[i * 3] = bx + nbx * thick;
      bud[i * 3 + 1] = by + nby * thick;
      bud[i * 3 + 2] = bz + nbz * thick;
      bloom[i * 3] = ox + nox * thick;
      bloom[i * 3 + 1] = oy + noy * thick;
      bloom[i * 3 + 2] = oz + noz * thick;
      normalBud[i * 3] = nbx; normalBud[i * 3 + 1] = nby; normalBud[i * 3 + 2] = nbz;
      normalBloom[i * 3] = nox; normalBloom[i * 3 + 1] = noy; normalBloom[i * 3 + 2] = noz;
      // 花心纵向环境光遮蔽：花瓣基部被上层花瓣压住，本来就该暗一圈。
      // 这一圈阴影是「金色花蕊」作为一个独立色块跳出来的前提。
      const rb = Math.hypot(ox, oz);
      const ao = 0.46 + 0.54 * smoothstep(0.10, 0.64, rb);

      const k = jitter * sheen * edgeSpray * edgeFade * ao;
      color[i * 3] = col[0] * k * (1 + pt.warm);
      color[i * 3 + 1] = col[1] * k;
      color[i * 3 + 2] = col[2] * k * (1 - pt.warm);
      size[i] = 0.0140 + rand() * 0.0095;
      seedArr[i] = rand();
      delay[i] = pt.whorl.delay + rand() * 0.05;
    }
  }

  /* ---------------- 2. 花瓣边缘描边（让轮廓利落） ---------------- */
  const rimEnd = Math.min(count, nPetal + nRim);
  const perPetalRim = Math.max(6, Math.floor(nRim / petals.length));
  for (const pt of petals) {
    for (let j = 0; j < perPetalRim && cursor < rimEnd; j++) {
      const s = rand() * 0.985;
      const side = rand() < 0.5 ? -1 : 1;
      const a = side * (0.62 + rand() * 0.18);

      evaluatePetal(pt.bud, s, a, p);
      const bx = p[0], by = p[1], bz = p[2];
      evaluatePetal(pt.bloom, s, a, p);

      evaluatePetalNormal(pt.bud, s, a, n);
      const nbx = n[0], nby = n[1], nbz = n[2];
      evaluatePetalNormal(pt.bloom, s, a, n);

      // 越靠近尖端越亮，做出「透光边」
      const tipGlow = (0.50 + 0.60 * smoothstep(0.25, 1.0, s)) * pt.intensity;
      const i = cursor++;
      bud[i * 3] = bx; bud[i * 3 + 1] = by; bud[i * 3 + 2] = bz;
      bloom[i * 3] = p[0]; bloom[i * 3 + 1] = p[1]; bloom[i * 3 + 2] = p[2];
      normalBud[i * 3] = nbx; normalBud[i * 3 + 1] = nby; normalBud[i * 3 + 2] = nbz;
      normalBloom[i * 3] = n[0]; normalBloom[i * 3 + 1] = n[1]; normalBloom[i * 3 + 2] = n[2];
      color[i * 3] = PALETTE.rim[0] * tipGlow;
      color[i * 3 + 1] = PALETTE.rim[1] * tipGlow;
      color[i * 3 + 2] = PALETTE.rim[2] * tipGlow;
      size[i] = 0.0090 + rand() * 0.0055;
      seedArr[i] = rand();
      delay[i] = pt.whorl.delay + rand() * 0.05;
    }
  }

  /* ---------------- 3. 花蕊 ---------------- */
  const st = STAMEN;
  // 花丝要「细」：粒子少而小，累积起来才不会糊成米黄
  const perFilament = Math.max(2, Math.round((nStamen * 0.30) / st.bloom.count));
  const antherPer = 3;
  let si = cursor;
  const stamenEnd = count;

  for (let f = 0; f < st.bloom.count && si < stamenEnd; f++) {
    const theta = rand() * TAU;
    const rEnd = lerp(st.bloom.rMin, st.bloom.rMax, Math.pow(rand(), 0.75));
    const hEnd = lerp(st.bloom.hMin, st.bloom.hMax, rand()) + rEnd * 0.30;
    const bend = 0.35 + rand() * 0.5;

    for (let j = 0; j < perFilament && si < stamenEnd; j++) {
      const t = (j + rand() * 0.7) / perFilament;
      const r = rEnd * Math.pow(t, 0.82);
      const h = st.bloom.yBase + hEnd * Math.pow(t, 1.25);
      const wob = (rand() - 0.5) * 0.014;
      const px = Math.cos(theta) * r + Math.cos(theta + Math.PI / 2) * wob * bend;
      const pz = Math.sin(theta) * r + Math.sin(theta + Math.PI / 2) * wob * bend;

      // 花苞态：塌缩到花苞顶端的小球
      const br = st.bud.radius * Math.pow(rand(), 0.5);
      const bth = rand() * TAU;
      const bph = Math.acos(rand() * 2 - 1);
      const bxp = Math.sin(bph) * Math.cos(bth) * br;
      const byp = st.bud.y + Math.cos(bph) * br * 1.15;
      const bzp = Math.sin(bph) * Math.sin(bth) * br;

      const i = si++;
      bud[i * 3] = bxp; bud[i * 3 + 1] = byp; bud[i * 3 + 2] = bzp;
      bloom[i * 3] = px; bloom[i * 3 + 1] = h; bloom[i * 3 + 2] = pz;
      normalBud[i * 3] = 0; normalBud[i * 3 + 1] = 1; normalBud[i * 3 + 2] = 0;
      normalBloom[i * 3] = Math.cos(theta) * 0.4;
      normalBloom[i * 3 + 1] = 0.6;
      normalBloom[i * 3 + 2] = Math.sin(theta) * 0.4;
      const fade = 0.50 + 0.50 * t;
      color[i * 3] = PALETTE.filament[0] * fade;
      color[i * 3 + 1] = PALETTE.filament[1] * fade;
      color[i * 3 + 2] = PALETTE.filament[2] * fade;
      size[i] = 0.0090 + rand() * 0.0055;
      seedArr[i] = rand();
      delay[i] = 0.26 + rand() * 0.05;
    }

    // 花药：花丝顶端一小簇金色亮点
    for (let j = 0; j < antherPer && si < stamenEnd; j++) {
      const spread = 0.024;
      const ax = Math.cos(theta) * rEnd + (rand() - 0.5) * spread;
      const az2 = Math.sin(theta) * rEnd + (rand() - 0.5) * spread;
      const ay = st.bloom.yBase + hEnd + (rand() - 0.5) * spread;
      const i = si++;
      const br = st.bud.radius * 0.9 * Math.pow(rand(), 0.5);
      const bth = rand() * TAU;
      bud[i * 3] = Math.sin(bth) * br;
      bud[i * 3 + 1] = st.bud.y + (rand() - 0.5) * br;
      bud[i * 3 + 2] = Math.cos(bth) * br;
      bloom[i * 3] = ax; bloom[i * 3 + 1] = ay; bloom[i * 3 + 2] = az2;
      normalBud[i * 3] = 0; normalBud[i * 3 + 1] = 1; normalBud[i * 3 + 2] = 0;
      normalBloom[i * 3] = 0; normalBloom[i * 3 + 1] = 1; normalBloom[i * 3 + 2] = 0;
      const gl = 0.9 + rand() * 0.45;
      color[i * 3] = PALETTE.anther[0] * gl;
      color[i * 3 + 1] = PALETTE.anther[1] * gl;
      color[i * 3 + 2] = PALETTE.anther[2] * gl;
      size[i] = 0.0150 + rand() * 0.0080;
      seedArr[i] = rand();
      delay[i] = 0.26 + rand() * 0.05;
    }
  }

  /* ---------------- 4. 花心核光 ---------------- */
  while (si < count) {
    const r = 0.22 * Math.pow(rand(), 0.8);
    const th = rand() * TAU;
    const i = si++;
    bud[i * 3] = (rand() - 0.5) * 0.05;
    bud[i * 3 + 1] = st.bud.y - 0.02 + rand() * 0.05;
    bud[i * 3 + 2] = (rand() - 0.5) * 0.05;
    bloom[i * 3] = Math.cos(th) * r;
    bloom[i * 3 + 1] = st.bloom.yBase + 0.02 + rand() * 0.05;
    bloom[i * 3 + 2] = Math.sin(th) * r;
    normalBud[i * 3] = 0; normalBud[i * 3 + 1] = 1; normalBud[i * 3 + 2] = 0;
    normalBloom[i * 3] = 0; normalBloom[i * 3 + 1] = 1; normalBloom[i * 3 + 2] = 0;
    const g = 0.20 + rand() * 0.16; // 暗金薄雾，别把金蕊糊成白
    color[i * 3] = PALETTE.core[0] * g;
    color[i * 3 + 1] = PALETTE.core[1] * g;
    color[i * 3 + 2] = PALETTE.core[2] * g;
    size[i] = 0.0125 + rand() * 0.0075;
    seedArr[i] = rand();
    delay[i] = 0.30 + rand() * 0.04;
  }

  /* ---------------- 5. 包围盒 ---------------- */
  let radius = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = bloom[i * 3], y = bloom[i * 3 + 1], z = bloom[i * 3 + 2];
    const rr = Math.hypot(x, z);
    if (rr > radius) radius = rr;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    count,
    bud,
    bloom,
    normalBud,
    normalBloom,
    color,
    size,
    seed: seedArr,
    delay,
    bounds: { radius, height: maxY - minY, centerY: (maxY + minY) / 2, minY, maxY },
    stats: { petal: nPetal, rim: Math.max(0, rimEnd - nPetal), stamen: count - rimEnd },
  };
}

/* ------------------------------------------------------------------ */
/* 空气浮尘（氛围粒子）                                                */
/* ------------------------------------------------------------------ */
export function buildMotes(count = 320, seed = 7717) {
  const rand = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seedArr = new Float32Array(count);
  const color = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 0.7 + Math.pow(rand(), 0.6) * 1.9;
    const th = rand() * TAU;
    pos[i * 3] = Math.cos(th) * r;
    pos[i * 3 + 1] = (rand() - 0.35) * 1.9;
    pos[i * 3 + 2] = Math.sin(th) * r * 0.75;
    size[i] = 0.006 + rand() * 0.012;
    seedArr[i] = rand();
    const g = 0.32 + rand() * 0.6;
    color[i * 3] = PALETTE.motes[0] * g;
    color[i * 3 + 1] = PALETTE.motes[1] * g;
    color[i * 3 + 2] = PALETTE.motes[2] * g;
  }
  return { count, pos, size, seed: seedArr, color };
}




















