/**
 * 白山茶粒子渲染层（three.js）
 * ---------------------------------------------------------------
 * · 一个 Points + 一个 ShaderMaterial，顶点着色器里做「花苞 ↔ 盛放」插值，
 *   所以整个绽放过程只需要更新一个 uniform，CPU 每帧零顶点计算。
 * · 加色混合（AdditiveBlending）+ 软核精灵，得到通透的发光质感。
 * · 另附：柔光 Sprite（花心光晕）、浮尘 Points（氛围）。
 */

import * as THREE from 'three';
import { buildFlowerParticles, buildMotes, PALETTE } from './flowerGeometry.js';

const DEG = Math.PI / 180;

/* ================================================================== */
/* 着色器                                                              */
/* ================================================================== */
const FLOWER_VERT = /* glsl */ `
  attribute vec3  aBud;
  attribute vec3  aBloom;
  attribute vec3  aNBud;
  attribute vec3  aNBloom;
  attribute vec3  aColor;
  attribute float aSize;
  attribute float aSeed;
  attribute float aDelay;

  uniform float uSpread;
  uniform float uTime;
  uniform float uPointScale;
  uniform float uSizeMul;
  uniform float uGain;
  uniform vec3  uTip;
  uniform float uTipPower;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3  vColor;

  void main() {
    // —— 按粒子各自的延迟错峰绽放，外层花瓣先开 ——
    float sd = smoothstep(aDelay, aDelay + 0.62, uSpread);

    vec3 pos = mix(aBud, aBloom, sd);
    vec3 nrm = normalize(mix(aNBud, aNBloom, sd));

    // —— 呼吸：极轻微的有机抖动 ——
    float ph = aSeed * 6.2831853;
    pos += vec3(
      sin(uTime * 0.85 + ph * 3.1),
      cos(uTime * 1.10 + ph * 2.3),
      sin(uTime * 0.72 + ph * 1.7)
    ) * (0.0035 + 0.009 * sd);

    // —— 指尖排斥：花被手指「拨」动一下 ——
    vec3  d    = pos - uTip;
    float dist = length(d) + 1e-4;
    float fall = exp(-dist * dist * 30.0);
    pos += (d / dist) * fall * uTipPower * 0.045;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // —— 假光照：花瓣两面受光 + 边缘透光 ——
    vec3  wn    = normalize(mat3(modelMatrix) * nrm);
    vec3  L     = normalize(vec3(-0.32, 0.72, 0.62));
    float diff  = abs(dot(wn, L));
    float rimT  = pow(1.0 - abs(wn.z), 2.0);
    float shade = 0.72 + 0.40 * diff + 0.20 * rimT;

    // —— 景深衰减：越靠后的花瓣越暗，拉开层次 ——
    float depthK = smoothstep(uFogNear, uFogFar, -mv.z);
    float dim    = (0.62 + 0.42 * sd) * (1.0 - 0.68 * depthK);

    // —— 细碎闪烁 ——
    float twinkle = 0.88 + 0.20 * sin(uTime * 2.1 + ph * 5.0);

    // —— 花蕊显影：花苞里金蕊是被包住的，随绽放才透出来 ——
    //    delay >= 0.24 的粒子是花蕊/花心（花瓣最晚 0.23）
    float isStamen = step(0.24, aDelay);
    float reveal  = smoothstep(0.34, 0.78, uSpread);
    float vis     = mix(1.0, reveal, isStamen);

    vColor = aColor * shade * dim * twinkle * vis * uGain;

    gl_PointSize = max(1.0, aSize * uSizeMul * (0.78 + 0.36 * sd) * uPointScale / max(0.001, -mv.z));
  }
`;

const FLOWER_FRAG = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2  p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    // 软核衰减，加色混合下叠出通透的花瓣
    float falloff = pow(1.0 - d, 2.8);
    gl_FragColor = vec4(vColor * falloff, 1.0);
  }
`;

const MOTE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;
  attribute vec3  aColor;

  uniform float uTime;
  uniform float uPointScale;
  uniform float uOpacity;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float ph = aSeed * 6.2831853;
    p.y += sin(uTime * 0.22 + ph) * 0.28;
    p.x += cos(uTime * 0.17 + ph * 1.7) * 0.20;
    p.z += sin(uTime * 0.13 + ph * 2.3) * 0.16;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, aSize * uPointScale / max(0.001, -mv.z));

    vColor = aColor;
    vAlpha = uOpacity * (0.30 + 0.70 * fract(aSeed * 17.31)) * (0.6 + 0.4 * sin(uTime * 0.6 + ph));
  }
`;

const MOTE_FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2  p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    float falloff = pow(1.0 - d, 2.2);
    gl_FragColor = vec4(vColor * falloff * vAlpha, 1.0);
  }
`;

/* ================================================================== */
/* 光晕贴图（程序生成，不依赖外部图片）                                 */
/* ================================================================== */
function makeHaloTexture(size = 256) {
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,252,240,0.55)');
  g.addColorStop(0.42, 'rgba(226,244,255,0.16)');
  g.addColorStop(0.72, 'rgba(200,235,255,0.04)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ================================================================== */
/* 花朵                                                                */
/* ================================================================== */
export class Camellia {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {number} [o.count] 粒子数
   */
  constructor({ scene, camera, count = 14000 }) {
    this.scene = scene;
    this.camera = camera;
    this.fov = 34;
    // 俯视角 ≈ 46°（拍花的角度）；可用 ?pitch=0.42 调整（0 = 平视，1.2 = 俯视）
    const p = new URLSearchParams(location.search).get('pitch');
    this.pitch = p !== null && Number.isFinite(Number(p)) ? Math.max(0, Math.min(1.2, Number(p))) : 0.80;
    this.count = count;

    this.bounds = null;
    this.spread = 0;
    this.time = 0;
    this.sizeMul = 1;

    // 场景层级：root（跟手） → tilt（固定姿态） → points
    this.root = new THREE.Group();
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);
    scene.add(this.root);

    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane();
    this._ndc = new THREE.Vector2();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._planeOrigin = new THREE.Vector3(0, 0, 0);
    this._out = new THREE.Vector3();

    this._build(count);
    this.resize();
  }

  _build(count) {
    const data = buildFlowerParticles({ count });
    this.data = data;
    this.bounds = data.bounds;

    const geo = new THREE.BufferGeometry();
    // three 需要 position 属性来定 drawRange；实际位置在着色器里算
    geo.setAttribute('position', new THREE.BufferAttribute(data.bud.slice(), 3));
    geo.setAttribute('aBud', new THREE.BufferAttribute(data.bud, 3));
    geo.setAttribute('aBloom', new THREE.BufferAttribute(data.bloom, 3));
    geo.setAttribute('aNBud', new THREE.BufferAttribute(data.normalBud, 3));
    geo.setAttribute('aNBloom', new THREE.BufferAttribute(data.normalBloom, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(data.color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(data.size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(data.seed, 1));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(data.delay, 1));

    this.uniforms = {
      uSpread: { value: 0 },
      uTime: { value: 0 },
      uPointScale: { value: 800 },
      uSizeMul: { value: 1.5 },
      uGain: { value: 0.8 },
      uTip: { value: new THREE.Vector3(0, 40, 0) },
      uTipPower: { value: 0 },
      uFogNear: { value: 2 },
      uFogFar: { value: 5 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FLOWER_VERT,
      fragmentShader: FLOWER_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.position.y = -this.bounds.centerY;
    this.points.renderOrder = 2;
    this.tilt.add(this.points);

    // 光晕
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeHaloTexture(),
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
      })
    );
    this.halo.scale.setScalar(3.2);
    this.halo.position.set(0, -0.02, -0.35);
    this.halo.renderOrder = 1;
    this.tilt.add(this.halo);

    // 浮尘
    const motes = buildMotes(Math.round(count * 0.025));
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(motes.pos, 3));
    mgeo.setAttribute('aSize', new THREE.BufferAttribute(motes.size, 1));
    mgeo.setAttribute('aSeed', new THREE.BufferAttribute(motes.seed, 1));
    mgeo.setAttribute('aColor', new THREE.BufferAttribute(motes.color, 3));

    this.moteUniforms = {
      uTime: { value: 0 },
      uPointScale: { value: 800 },
      uOpacity: { value: 0.55 },
    };
    const mmat = new THREE.ShaderMaterial({
      uniforms: this.moteUniforms,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.motes = new THREE.Points(mgeo, mmat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 0;
    this.scene.add(this.motes);

  }

  /** 视口变化：重新装框（保证整朵花始终完整可见） */
  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const tan = Math.tan((this.fov * 0.5) * DEG);

    const rNeed = this.bounds.radius * 1.16;
    const hUp = this.bounds.radius * Math.sin(this.pitch) + (this.bounds.maxY - this.bounds.centerY) * Math.cos(this.pitch);
    const hDn = this.bounds.radius * Math.sin(this.pitch) + (this.bounds.centerY - this.bounds.minY) * Math.cos(this.pitch);
    const halfHNeed = Math.max(hUp, hDn) * 1.16;

    const dist = Math.max(rNeed / (tan * Math.max(0.3, aspect)), halfHNeed / tan);
    this.camera.fov = this.fov;
    this.camera.aspect = aspect;
    this.camera.position.set(0, Math.sin(this.pitch) * dist, Math.cos(this.pitch) * dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();

    this.dist = dist;
    this._updatePointScale();
    this._updateFog();
  }

  _updatePointScale() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const hPx = window.innerHeight * dpr;
    const scale = (hPx * 0.5) / Math.tan((this.fov * 0.5) * DEG);
    this.uniforms.uPointScale.value = scale;
    this.moteUniforms.uPointScale.value = scale;
  }

  _updateFog() {
    const r = this.bounds.radius;
    this.uniforms.uFogNear.value = this.dist - r * 0.9;
    this.uniforms.uFogFar.value = this.dist + r * 0.9;
  }

  /**
   * 每帧更新
   * @param {number} dt 秒
   * @param {number} spread 0~1 绽放度
   */
  update(dt, spread) {
    this.time += dt;
    this.spread = spread;
    this.uniforms.uSpread.value = spread;
    this.uniforms.uTime.value = this.time;
    this.moteUniforms.uTime.value = this.time;

    // 光晕随绽放变大、变亮
    const s = 2.6 + spread * 1.4;
    this.halo.scale.setScalar(s);
    this.halo.material.opacity = 0.10 + spread * 0.20;

    // 方向固定在最佳观赏角度，只保留花蕊浮尘的轻微流动
    this.motes.rotation.y = this.time * 0.02;
  }

  /** 指尖位置（世界坐标）→ 排斥力 */
  setFingertip(worldVec3, power) {
    if (!worldVec3) {
      this.uniforms.uTipPower.value = 0;
      return;
    }
    this._tmpV.copy(worldVec3);
    this.root.updateWorldMatrix(true, true);
    this.tilt.worldToLocal(this._tmpV);
    this.uniforms.uTip.value.copy(this._tmpV);
    this.uniforms.uTipPower.value = power;
  }

  /** 屏幕坐标 → 与相机平行的花平面上的世界坐标 */
  screenToPlane(sx, sy) {
    this._ndc.set((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    this.camera.getWorldDirection(this._tmpV2);
    this._plane.setFromNormalAndCoplanarPoint(this._tmpV2, this._planeOrigin);
    return this._raycaster.ray.intersectPlane(this._plane, this._out) || this._out.set(0, 0, 0);
  }

  /** 世界坐标下 1 像素对应的长度（用于把「手的像素尺寸」换成世界尺寸） */
  worldPerPixel() {
    const tan = Math.tan((this.fov * 0.5) * DEG);
    const halfH = this.dist * tan;
    return (halfH * 2) / window.innerHeight;
  }

  dispose() {
    this.scene.remove(this.root);
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.halo.material.map?.dispose();
    this.halo.material.dispose();
  }
}

export { PALETTE };











