/**
 * 手部捕捉小窗（Picture-in-Picture）
 * ---------------------------------------------------------------
 * 大画面里的摄像头是为了衬托花朵，被刻意压暗、去饱和；
 * 这个右下角小窗则是**不加压暗**的实时取景器：
 * 镜像画面 + 21 点骨架 + 张开度圆环，用来确认手到底有没有被捕捉到。
 */

import { drawSkeleton } from './skeleton.js';

export class HandPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.dpr = 1;
    this.w = 236;
    this.h = 177;
    this.rect = { x: 0, y: 0, w: this.w, h: this.h };
    this.flash = 0;
    this.showSkeleton = true;
    this.resize();
  }

  resize() {
    // 用 offsetWidth/Height（布局尺寸）而不是 getBoundingClientRect，
    // 否则面板的入场缩放 transform 会让画布分辨率被算小、画面发虚
    this.w = Math.max(80, Math.round(this.canvas.offsetWidth || this.w));
    this.h = Math.max(60, Math.round(this.canvas.offsetHeight || this.h));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 归一化视频坐标 → 小窗像素坐标（镜像 + cover） */
  _map(vw, vh, nx, ny) {
    const s = Math.max(this.w / vw, this.h / vh);
    const dw = vw * s;
    const dh = vh * s;
    const ox = (this.w - dw) / 2;
    const oy = (this.h - dh) / 2;
    return { x: ox + (1 - nx) * dw, y: oy + ny * dh };
  }

  /**
   * @param {object} o
   * @param {HTMLVideoElement|null} o.video
   * @param {object|null} o.hand
   * @param {number} o.tension
   * @param {number} o.dt
   */
  draw({ video, hand, tension = 0, dt = 0.016 }) {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    // 底：深色
    ctx.fillStyle = 'rgba(4, 12, 9, 0.92)';
    ctx.fillRect(0, 0, W, H);

    if (video && video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.max(W / vw, H / vh);
      const dw = vw * s;
      const dh = vh * s;

      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      try {
        // 比大画面亮得多：这是给你看清手用的
        ctx.filter = 'saturate(0.85) brightness(0.95) contrast(1.02)';
      } catch { /* 老浏览器忽略 */ }
      ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
      ctx.filter = 'none';
    }

    // 轻暗角，让骨架更跳
    const g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(2,9,7,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 骨架
    const hasHand = !!(hand && hand.landmarks);
    if (hasHand && this.showSkeleton) {
      const vw = video?.videoWidth || 1;
      const vh = video?.videoHeight || 1;
      const pts = hand.landmarks.map((p) => this._map(vw, vh, p.x, p.y));
      const palm = this._map(vw, vh, hand.palm.x, hand.palm.y);
      drawSkeleton(ctx, pts, {
        tension,
        palm,
        k: 0.72,
        rings: true,
        glow: true,
      });
    } else if (!hasHand) {
      // 没手时画一条扫描线，表示还在找
      const t = performance.now() / 1000;
      const y = (0.5 + 0.5 * Math.sin(t * 1.6)) * H;
      const lg = ctx.createLinearGradient(0, y - 14, 0, y + 14);
      lg.addColorStop(0, 'rgba(134,211,178,0)');
      lg.addColorStop(0.5, 'rgba(134,211,178,0.16)');
      lg.addColorStop(1, 'rgba(134,211,178,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, y - 14, W, 28);
    }

    // 检测到手时，取景框亮起来
    this.flash = hasHand
      ? Math.min(1, this.flash + dt * 6)
      : Math.max(0, this.flash - dt * 3);

    // 取景框四角
    this._corners(ctx, W, H, 0.18 + 0.42 * this.flash);

    // 顶部渐隐，压住画面亮部让 DOM 标题可读
    const top = ctx.createLinearGradient(0, 0, 0, 34);
    top.addColorStop(0, 'rgba(3,10,8,0.72)');
    top.addColorStop(1, 'rgba(3,10,8,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, 34);
  }

  _corners(ctx, W, H, alpha) {
    const L = 12;
    const m = 5;
    ctx.strokeStyle = `rgba(226, 244, 236, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 左上
    ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
    // 右上
    ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
    // 右下
    ctx.moveTo(W - m, H - m - L); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m - L, H - m);
    // 左下
    ctx.moveTo(m + L, H - m); ctx.lineTo(m, H - m); ctx.lineTo(m, H - m - L);
    ctx.stroke();
  }
}
