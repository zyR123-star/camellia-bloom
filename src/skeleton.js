/**
 * 手部骨架绘制（共用）
 * ---------------------------------------------------------------
 * 全屏叠加层和右下角「手部捕捉」小窗都用这一份，
 * 只是传入的点坐标和缩放不同，避免两处画法逐渐分叉。
 */

import { HAND_CONNECTIONS } from './handTracker.js';

const TIPS = new Set([4, 8, 12, 16, 20]);

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number}>} pts 21 个点，已经是画布像素坐标
 * @param {object} [o]
 * @param {number} [o.tension]  0~1，画掌心圆环
 * @param {{x:number,y:number}} [o.palm] 掌心像素坐标
 * @param {number} [o.k]  尺寸系数（小窗里传 <1）
 * @param {boolean} [o.rings] 是否画张力圆环
 * @param {boolean} [o.glow] 是否画指尖辉光
 */
export function drawSkeleton(ctx, pts, o = {}) {
  const k = o.k ?? 1;
  const tension = o.tension ?? 0;
  const palm = o.palm;

  // 连线
  ctx.lineWidth = Math.max(0.6, 1 * k);
  ctx.strokeStyle = 'rgba(206, 238, 255, 0.22)';
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();

  // 指尖之间的连线
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.beginPath();
  ctx.moveTo(pts[4].x, pts[4].y);
  ctx.lineTo(pts[8].x, pts[8].y);
  ctx.moveTo(pts[8].x, pts[8].y);
  ctx.lineTo(pts[12].x, pts[12].y);
  ctx.stroke();

  // 关节点
  for (let i = 0; i < pts.length; i++) {
    const isTip = TIPS.has(i);
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, (isTip ? 2.2 : 1.5) * k, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? 'rgba(255, 252, 235, 0.62)' : 'rgba(220, 240, 255, 0.36)';
    ctx.fill();
  }

  if (o.rings && palm) {
    const rr = Math.max(10, dist(pts[0], pts[9]) * 0.92);
    ctx.lineWidth = Math.max(0.8, 1.2 * k);
    ctx.strokeStyle = 'rgba(220, 240, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, rr, 0, Math.PI * 2);
    ctx.stroke();

    const a0 = -Math.PI / 2;
    const a1 = a0 + tension * Math.PI * 2;
    const grad = ctx.createLinearGradient(palm.x - rr, palm.y - rr, palm.x + rr, palm.y + rr);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    grad.addColorStop(1, 'rgba(255, 214, 150, 0.58)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1, 2 * k);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, rr, a0, a1);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  if (o.glow) {
    const tip = pts[8];
    const r = 26 * k;
    const tg = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, r);
    tg.addColorStop(0, 'rgba(255, 250, 225, 0.30)');
    tg.addColorStop(1, 'rgba(255, 250, 225, 0)');
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
