/**
 * 白山茶 · 手控绽放 —— 应用主控
 * ---------------------------------------------------------------
 * 数据流：
 *   摄像头帧 → MediaPipe Hands → 21 关键点 → tension(0~1)
 *          → 阈值映射 smoothstep(0.32, 0.66) → targetSpread
 *          → 缓动 spread → 顶点着色器插值 → 花朵绽放
 *
 * 相机识别不可用时自动进入「演示模式」，花朵依然会呼吸、也能用
 * 指针／触摸模拟握拳与张开，页面永远不会停在白屏。
 */

import * as THREE from 'three';
import { Camellia } from './flower.js';
import { HandTracker } from './handTracker.js';
import { Backdrop } from './backdrop.js';
import { HandPreview } from './handPreview.js';

/* ------------------------------------------------------------------ */
/* 可调参数                                                            */
/* ------------------------------------------------------------------ */
const CFG = {
  // 阈值：tension < 0.32 合拢为花苞，> 0.66 完全绽放
  CLOSED_AT: 0.32,
  OPEN_AT: 0.66,
  // 观众要求的那条缓动公式的系数（60fps 下的每帧比例）
  SPREAD_EASE: 0.1,
  // tension 自身的平滑（秒），开掌稍慢、握拳稍快
  TENSION_TAU_OPEN: 0.085,
  TENSION_TAU_CLOSE: 0.055,
  // 空闲呼吸
  IDLE_SPEED: 0.42,
};

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const params = new URLSearchParams(location.search);
const FORCED_SPREAD = params.has('spread') ? Number(params.get('spread')) : null;
const FORCE_DEMO = params.get('demo') === '1';
const PARTICLE_COUNT = Math.max(
  3000,
  Math.min(24000, Number(params.get('particles')) || (IS_MOBILE ? 9000 : 16000))
);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
};
/** 帧率无关的指数趋近：tau 秒 */
const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
/** 帧率无关的「每帧比例 k」：60fps 时等价于 k */
const frameEase = (k, dt) => 1 - Math.pow(1 - k, dt * 60);

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 应用                                                                */
/* ------------------------------------------------------------------ */
class App {
  constructor() {
    this.canvas = $('gl-layer');
    this.hud = $('hud');
    this.hint = $('hint');

    this.tension = 0;
    this.spread = 0;
    this.targetTension = 0;
    this.mode = 'intro';       // intro | camera | demo
    this.tracker = null;
    this.video = null;
    this.stream = null;
    this.lastHandAt = 0;
    this.handVisible = false;

    // 花朵的位置/缩放缓动值
    this.anchor = new THREE.Vector3(0, 0, 0);
    this.anchorTarget = new THREE.Vector3(0, 0, 0);
    this.scaleCur = 1;
    this.scaleTarget = 1;

    // 拖拽旋转
    this.yaw = 0;
    this.pitch = 0;
    this.yawTarget = 0;
    this.pitchTarget = 0;
    this.dragging = false;
    this.pointerDown = false;
    this.spaceHold = false;
    this.demoPress = 0;
    this.paused = false;

    this._initRenderer();
    this._initUI();
    this._bindEvents();

    this.clock = new THREE.Clock();
    this._tick = this._tick.bind(this);
    this.renderer.setAnimationLoop(this._tick);
  }

  /* --------------------------- 渲染器 --------------------------- */
  _initRenderer() {
    // 画布必须不透明：粒子的加色混合要在一块不透明画布上才是正确叠加
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(0x040b08, 1);
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 100);

    this.flower = new Camellia({
      scene: this.scene,
      camera: this.camera,
      count: PARTICLE_COUNT,
    });

    this.bg = new Backdrop();
    this.pip = new HandPreview($('pip-canvas'));
    this.pipOn = true;
    this._pipTick = 0;
  }

  /* --------------------------- UI --------------------------- */
  _initUI() {
    $('btn-start').addEventListener('click', () => this.startCamera());
    $('btn-demo').addEventListener('click', () => this.enterDemo());

    $('btn-pip').addEventListener('click', () => {
      this.setPip($('btn-pip').getAttribute('aria-pressed') !== 'true');
    });

    $('btn-skeleton').addEventListener('click', () => {
      const btn = $('btn-skeleton');
      const on = btn.getAttribute('aria-pressed') !== 'false';
      btn.setAttribute('aria-pressed', String(!on));
      this.pip.showSkeleton = !on;
    });

    $('btn-help').addEventListener('click', () => this.toggleHelp(true));
    $('btn-help-close').addEventListener('click', () => this.toggleHelp(false));
    $('help').addEventListener('click', (e) => {
      if (e.target === $('help')) this.toggleHelp(false);
    });
  }

  _bindEvents() {
    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 220));

    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
    });

    // 拖拽旋转（鼠标 / 触摸）
    const stage = $('stage');
    let lastX = 0;
    let lastY = 0;

    stage.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.pointerDown = true;
      lastX = e.clientX;
      lastY = e.clientY;
      stage.setPointerCapture?.(e.pointerId);
    });

    stage.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.yawTarget = clamp(this.yawTarget + dx * 0.005, -0.65, 0.65);
      this.pitchTarget = clamp(this.pitchTarget + dy * 0.004, -0.42, 0.42);
    });

    const endDrag = () => {
      this.dragging = false;
      this.pointerDown = false;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    stage.addEventListener('pointerleave', () => {
      this.dragging = false;
    });

    // 键盘
    window.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') $('btn-skeleton').click();
      else if (e.key === 'c' || e.key === 'C') $('btn-pip').click();
      else if (e.key === '?') this.toggleHelp(true);
      else if (e.key === 'Escape') this.toggleHelp(false);
      else if (e.code === 'Space') {
        e.preventDefault();
        this.spaceHold = !this.spaceHold;
        if (this.spaceHold) this.toast('自动演示已开启');
      }
    });
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.flower.resize();
    this.pip.resize();
  }

  /* --------------------------- 流程 --------------------------- */
  async startCamera() {
    if (this.mode === 'camera') return;
    this.setIntroNote('正在请求摄像头权限…');

    if (!navigator.mediaDevices?.getUserMedia) {
      this.toast('当前浏览器不支持摄像头，已切换到演示模式');
      this.enterDemo();
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 960 },
          height: { ideal: 720 },
        },
      });
    } catch (err) {
      this._handleCameraError(err);
      return;
    }

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    this.video = video;
    try {
      await video.play();
    } catch {
      /* 某些浏览器需要用户手势后才允许播放，这里已经发生在点击里 */
    }

    this.mode = 'camera';
    this.pip.resize();
    this.setPip(this.pipOn);
    this.hideIntro();
    this.hud.classList.add('on');
    $('mode-label').textContent = '实时';

    // 手部模型（失败不影响主渲染）
    try {
      this.tracker = new HandTracker();
      await this.tracker.init();
      this.toast('正在加载手部模型…', 2400);
      // 首次推理才会真正拉 wasm/模型，后台跑，别卡住渲染
      this.tracker
        .warmup(video)
        .then(() => this.toast('举起手 · 掌心朝向摄像头', 3200))
        .catch((err) => {
          console.warn('[camellia] hand model warmup failed:', err);
          this.tracker?.close();
          this.tracker = null;
          $('mode-label').textContent = '演示';
          $('hint').classList.remove('on');
          this.toast('手部模型加载失败 · 已进入演示模式（按住屏幕模拟张开手掌）', 5200);
        });
    } catch (err) {
      this.tracker = null;
      $('mode-label').textContent = '演示';
      this.toast('手部识别组件加载失败 · 已进入演示模式（按住屏幕模拟张开手掌）', 5200);
      console.warn('[camellia] hand tracker init failed:', err);
    }
  }

  _handleCameraError(err) {
    const name = err && err.name;
    let msg = '无法访问摄像头，已进入演示模式';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      msg = '摄像头权限被拒绝 · 已进入演示模式';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      msg = '没有找到可用的摄像头 · 已进入演示模式';
    } else if (name === 'NotReadableError') {
      msg = '摄像头被其它程序占用 · 已进入演示模式';
    }
    console.warn('[camellia] getUserMedia failed:', err);
    this.toast(msg, 4200);
    this.enterDemo();
  }

  enterDemo() {
    if (this.mode === 'camera') return;
    this.mode = 'demo';
    this.hideIntro();
    this.hud.classList.add('on');
    $('mode-label').textContent = '演示';
    this.toast('按住鼠标 / 屏幕，模拟张开手掌', 3600);
  }

  hideIntro() {
    $('intro').classList.add('gone');
    this.setIntroNote('');
  }

  setIntroNote(text, warn = false) {
    const el = $('intro-note');
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.classList.toggle('warn', warn);
    } else {
      el.textContent = '画面仅在本机处理，不会上传任何数据';
      el.classList.remove('warn');
    }
  }

  /** 手部捕捉小窗开关 */
  setPip(on) {
    this.pipOn = on;
    $('btn-pip').setAttribute('aria-pressed', String(on));
    $('pip').classList.toggle('on', on && this.mode === 'camera');
  }

  _drawPip(hand, dt) {
    if (!this.pipOn || this.mode !== 'camera') return;
    this.pip.draw({ video: this.video, hand, tension: this.tension, dt });
    if (++this._pipTick % 4) return;
    $('pip-num').textContent = this.tension.toFixed(2);
    $('pip-fill').style.width = `${(clamp01(this.tension) * 100).toFixed(0)}%`;
    $('pip-state').textContent = !this.tracker ? '无模型' : hand ? '跟踪中' : '等待手部';
    $('pip-dot').classList.toggle('live', !!hand);
  }

  toggleHelp(on) {
    $('help').classList.toggle('on', on);
    $('help').setAttribute('aria-hidden', String(!on));
  }

  toast(text, ms = 2600) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }

  /* --------------------------- 每帧 --------------------------- */
  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    const t = this.clock.elapsedTime;

    // 1) 手部推理（内部节流）
    let hand = null;
    if (this.tracker && this.video && !this.paused) {
      this.tracker.update(this.video, now);
      if (this.tracker.isPresent(now)) hand = this.tracker.state;
    }
    this.handVisible = !!hand;
    if (hand) this.lastHandAt = now;

    // 2) 决定 targetTension
    const idle = this._idleTension(t);
    let targetTension;
    if (hand) {
      targetTension = hand.tension;
    } else if (this.mode === 'camera') {
      targetTension = idle; // 没人 → 呼吸待机
    } else {
      // 演示模式：按住=张开，否则缓慢呼吸
      const pressed = this.pointerDown || this.spaceHold ? 1 : 0;
      this.demoPress = approach(this.demoPress, pressed, dt, 0.12);
      targetTension = Math.max(idle * 0.9, this.demoPress);
    }
    this.targetTension = targetTension;

    // 3) tension 平滑（开掌慢一点、握拳快一点，手感更「活」）
    const tau = targetTension > this.tension ? CFG.TENSION_TAU_OPEN : CFG.TENSION_TAU_CLOSE;
    this.tension = approach(this.tension, targetTension, dt, tau);

    // 4) 阈值映射 + 缓动 —— 核心那一步
    const targetSpread = smoothstep(CFG.CLOSED_AT, CFG.OPEN_AT, this.tension);
    // currentSpread += (targetSpread - currentSpread) * 0.1（60fps 等价，且帧率无关）
    this.spread += (targetSpread - this.spread) * frameEase(CFG.SPREAD_EASE, dt);

    // 5) 花朵跟随手
    this._followHand(hand, dt);

    // 6) 拖拽旋转阻尼
    this.yaw = approach(this.yaw, this.yawTarget, dt, 0.18);
    this.pitch = approach(this.pitch, this.pitchTarget, dt, 0.18);
    this.flower.setUserRotation(this.yaw, this.pitch);

    // 7) 更新花朵 + 叠加层
    const spread = FORCED_SPREAD !== null ? FORCED_SPREAD : this.spread;
    this.flower.update(dt, spread);
    this.bg.update(dt);

    // 背景渐变 → 花，同一条不透明管线
    this.renderer.clear(true, true, true);
    this.bg.render(this.renderer);
    this.renderer.render(this.scene, this.camera);

    this._drawPip(hand, dt);

    // 8) HUD
    this._updateHud(hand);
  }

  _idleTension(t) {
    // 0..1 的慢呼吸，映射到 0.16~0.82 的张开度
    const cycle = 0.5 + 0.5 * Math.sin(t * CFG.IDLE_SPEED - Math.PI / 2);
    return 0.16 + 0.66 * cycle;
  }

  _followHand(hand, dt) {
    const W = window.innerWidth;
    const H = window.innerHeight;

    if (hand) {
      // 大画面里没有摄像头了，所以不需要像素级对齐：
      // 直接把手的归一化位置映射成画面中的**有限位移**（横向 ±30%、纵向 ±24%），
      // 手怎么动花就跟着漂，但幅度收住，不会飞出构图。
      const mx = 1 - hand.palm.x; // 镜像，跟照镜子一致
      const ox = clamp((mx - 0.5) * 2, -1, 1);
      const oy = clamp((hand.palm.y - 0.5) * 2, -1, 1);

      const ax = W * (0.5 + ox * 0.30);
      const ay = H * (0.5 + oy * 0.24);
      this.anchorTarget.copy(this.flower.screenToPlane(ax, ay));

      // 手离镜头越近（归一化尺寸越大），花越大
      this.scaleTarget = clamp(hand.palmSize / 0.165, 0.72, 1.12);

      // 指尖排斥
      const tx = W * (0.5 + clamp((1 - hand.tip.x - 0.5) * 2, -1, 1) * 0.30);
      const ty = H * (0.5 + clamp((hand.tip.y - 0.5) * 2, -1, 1) * 0.24);
      this.flower.setFingertip(this.flower.screenToPlane(tx, ty), 0.35 + 0.65 * this.spread);
    } else {
      // 没人：回到画面中央，缓缓呼吸
      this.anchorTarget.set(0, 0, 0);
      this.scaleTarget = 1;
      this.flower.setFingertip(null, 0);
    }

    this.anchor.lerp(this.anchorTarget, frameEase(0.09, dt));
    this.scaleCur = approach(this.scaleCur, this.scaleTarget, dt, 0.25);

    this.flower.root.position.copy(this.anchor);
    this.flower.root.scale.setScalar(this.scaleCur);
  }

  _updateHud(hand) {
    const tension = this.tension;
    const spread = FORCED_SPREAD !== null ? FORCED_SPREAD : this.spread;

    let label = '花苞';
    if (tension >= CFG.OPEN_AT) label = '盛放';
    else if (tension >= 0.5) label = '半开';
    else if (tension >= CFG.CLOSED_AT) label = '初绽';

    $('state-label').textContent = label;
    $('meter-fill').style.width = `${(clamp01(tension) * 100).toFixed(1)}%`;
    $('num-tension').textContent = tension.toFixed(2);
    $('num-spread').textContent = spread.toFixed(2);

    const dot = $('hud-dot');
    dot.classList.toggle('live', this.handVisible);

    if (this.mode === 'camera') {
      $('mode-label').textContent = !this.tracker ? '演示' : this.handVisible ? '跟踪中' : '待机';
      this.hint.classList.toggle('on', !!this.tracker && !this.handVisible && this.tension < 0.45);
    } else if (this.mode !== 'intro') {
      this.hint.classList.remove('on');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
function boot() {
  // WebGL 兜底
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) {
    const note = document.getElementById('intro-note');
    if (note) {
      note.textContent = '当前浏览器不支持 WebGL，无法渲染花朵';
      note.classList.add('warn');
    }
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-demo').disabled = true;
    return;
  }

  const app = new App();
  window.__camellia = app;

  // 调试/截图用：?spread=1 固定绽放度
  if (FORCED_SPREAD !== null) {
    app.spread = FORCED_SPREAD;
    app.hideIntro();
    app.hud.classList.add('on');
  }

  if (FORCE_DEMO) {
    app.enterDemo();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}







