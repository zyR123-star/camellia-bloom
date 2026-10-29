/**
 * MediaPipe Hands 封装 + 「手掌张开度 tension」计算
 * ---------------------------------------------------------------
 * 用 @mediapipe/hands（legacy solution）而不是 tasks-vision：
 *   legacy 包的 wasm / tflite 模型全都在同一个 npm 包里，
 *   只需一个 CDN 源（jsDelivr）即可跑通，国内网络环境更稳；
 *   tasks-vision 需要额外从 storage.googleapis.com 拉 .task 模型，
 *   那条线路在部分地区不通。
 *
 * 如果它加载失败，上层会自动进入「演示模式」，页面不会白屏。
 */

const MP_VERSION = '0.4.1675469240';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MP_VERSION}`;

/** MediaPipe 的 21 点骨架连线 */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],           // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],      // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],    // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],   // 小指
  [0, 17],                                   // 掌根
];

/* ------------------------------------------------------------------ */
/* 几何小工具                                                          */
/* ------------------------------------------------------------------ */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 三个点构成的夹角（返回 0~π） */
function jointAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y) || 1e-6;
  const n2 = Math.hypot(v2x, v2y) || 1e-6;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
  return Math.acos(cos);
}

/* ------------------------------------------------------------------ */
/* tension：手掌张开度                                                  */
/* ------------------------------------------------------------------ */
/**
 * 五指各自算一个「伸展度」，再按权重平均。
 *
 * 每个手指用两个互补的指标：
 *   ① 伸展比 reach = |指尖-腕| / |指根-腕|
 *        握拳 ≈ 1.0~1.25，完全张开 ≈ 2.0~2.3
 *        reachScore = clamp((reach - 1.18) / (2.05 - 1.18), 0, 1)
 *   ② 指节伸直度：PIP 关节夹角 θ
 *        握拳 θ ≈ 50~80°，伸直 θ ≈ 170~180°
 *        straight = clamp((θ/π - 0.33) / (0.66 - 0.33), 0, 1)
 *     加这一项是为了防止「手向镜头倾斜时距离被透视压缩」导致的误判。
 *
 *   ext_f = 0.62 * reachScore + 0.38 * straight
 *   tension = Σ(w_f · ext_f) / Σ w_f
 */
const FINGERS = [
  { name: 'thumb', mcp: 2, pip: 3, tip: 4, w: 0.70 },
  { name: 'index', mcp: 5, pip: 6, tip: 8, w: 1.00 },
  { name: 'middle', mcp: 9, pip: 10, tip: 12, w: 1.00 },
  { name: 'ring', mcp: 13, pip: 14, tip: 16, w: 0.95 },
  { name: 'pinky', mcp: 17, pip: 18, tip: 20, w: 0.85 },
];

export function measureTension(lm) {
  const wrist = lm[0];
  let sum = 0;
  let wsum = 0;
  for (const f of FINGERS) {
    const reach = dist(wrist, lm[f.tip]) / Math.max(1e-6, dist(wrist, lm[f.mcp]));
    const reachScore = clamp01((reach - 1.18) / 0.87);
    const theta = jointAngle(lm[f.mcp], lm[f.pip], lm[f.tip]);
    const straight = clamp01((theta / Math.PI - 0.33) / 0.33);
    const ext = 0.62 * reachScore + 0.38 * straight;
    sum += ext * f.w;
    wsum += f.w;
  }
  return clamp01(sum / wsum);
}

/** 手掌中心（腕 + 四个掌指关节的平均） */
function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

/**
 * 从 21 点解出上层要用的所有量
 * 归一化坐标（0~1，已按 selfieMode 镜像）
 */
export function buildHandState(lm, handedness = '') {
  const palm = palmCenter(lm);
  const palmSize = dist(lm[0], lm[9]);
  return {
    present: true,
    landmarks: lm,
    handedness,
    tension: measureTension(lm),
    palm,
    palmSize,
    tip: { x: lm[8].x, y: lm[8].y },      // 食指指尖
    thumbTip: { x: lm[4].x, y: lm[4].y },
  };
}

/* ------------------------------------------------------------------ */
/* HandTracker                                                         */
/* ------------------------------------------------------------------ */
export class HandTracker {
  constructor(opts = {}) {
    this.modelComplexity = opts.modelComplexity ?? (this._isMobile() ? 0 : 1);
    this.onStatus = opts.onStatus || (() => {});
    this.state = null;
    this.lastSeen = 0;
    this.busy = false;
    this.ready = false;
    this.failed = false;
    this.frames = 0;
    this._hands = null;
    this._lastSend = 0;
  }

  _isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  async init() {
    this.onStatus({ phase: 'loading', message: '正在加载手部识别模型…' });
    await this._loadScript();
    if (!window.Hands) throw new Error('MediaPipe Hands 未就绪');

    const hands = new window.Hands({
      locateFile: (file) => `${MP_BASE}/${file}`,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: this.modelComplexity,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.55,
      selfieMode: true, // 与镜像显示对齐
    });
    hands.onResults((results) => this._onResults(results));

    this._hands = hands;
    this.ready = true;
    return true;
  }

  _loadScript() {
    return new Promise((resolve, reject) => {
      if (window.Hands) return resolve();
      const s = document.createElement('script');
      s.src = `${MP_BASE}/hands.js`;
      s.crossOrigin = 'anonymous';
      s.async = true;
      const timer = setTimeout(() => {
        s.remove();
        reject(new Error('加载 MediaPipe 超时'));
      }, 20000);
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('无法从 CDN 加载 MediaPipe Hands'));
      };
      document.head.appendChild(s);
    });
  }

  _onResults(results) {
    this.frames++;
    const lm = results.multiHandLandmarks && results.multiHandLandmarks[0];
    if (lm && lm.length === 21 && !lm.some((p) => Number.isNaN(p.x))) {
      const handed = results.multiHandedness?.[0]?.label || '';
      this.state = buildHandState(lm, handed);
      this.lastSeen = performance.now();
    } else {
      this.state = null;
    }
    if (this.frames === 1) this.onStatus({ phase: 'ready', message: '识别已就绪' });
  }

  /**
   * 预热：真正跑一次推理，确认 wasm / 模型都能加载。
   * legacy Hands 的首次 send 才会去拉模型，所以必须「真发一帧」才知道能不能用。
   */
  async warmup(video, timeoutMs = 22000) {
    if (!this.ready) throw new Error('HandTracker 未初始化');
    this.busy = true;
    try {
      const t0 = performance.now();
      while (this.frames === 0) {
        if (performance.now() - t0 > timeoutMs) throw new Error('手部模型加载超时');
        try {
          await this._hands.send({ image: video });
        } catch (err) {
          throw new Error(`手部模型资源加载失败：${err && err.message ? err.message : err}`);
        }
        if (this.frames === 0) await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      this.busy = false;
    }
    return true;
  }
  /** 每帧调用；内部自己节流 + 防重入 */
  update(video, now = performance.now()) {
    if (!this.ready || this.busy || !video || video.readyState < 2) return;
    if (now - this._lastSend < 28) return; // ≈ 30fps 足够
    this._lastSend = now;
    this.busy = true;
    const t0 = performance.now();
    this._hands
      .send({ image: video })
      .catch(() => {})
      .finally(() => {
        this.busy = false;
        this.cost = performance.now() - t0;
      });
  }

  /** 手是否仍然在画面里（用于超时隐藏） */
  isPresent(now = performance.now(), holdMs = 260) {
    return !!this.state && now - this.lastSeen < holdMs;
  }

  close() {
    try { this._hands?.close(); } catch { /* noop */ }
    this._hands = null;
    this.ready = false;
  }
}


