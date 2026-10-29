/**
 * 背景（纯 WebGL 全屏渐变）
 * ---------------------------------------------------------------
 * 大画面不再显示摄像头：白花需要干净的深色背景才立得住，
 * 手的实时画面只放在右下角小窗里。
 *
 * 这里的渐变刻意与 CSS 变量 --ink / .stage 的背景一致，
 * 这样 WebGL 挂掉时回退到 CSS 也不会跳色。
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  varying vec2 vUv;

  void main() {
    // 平面 uv（左下原点）→ 屏幕 uv（左上原点）
    vec2 s = vec2(vUv.x, 1.0 - vUv.y);

    // 与 .stage 的 radial-gradient 对齐：中心墨绿 → 边缘近黑
    vec2 c = s - vec2(0.5, 0.42);
    float r = length(c * vec2(1.0, 0.92));

    vec3 near = vec3(0.028, 0.080, 0.060);   // 近黑墨绿
    vec3 mid  = vec3(0.014, 0.042, 0.033);
    vec3 far  = vec3(0.006, 0.018, 0.014);

    vec3 col = mix(near, mid, smoothstep(0.0, 0.55, r));
    col = mix(col, far, smoothstep(0.45, 1.05, r));

    // 花心处的极淡辉光，随呼吸微微起伏（60s 周期）
    float pulse = 0.006 + 0.003 * sin(uTime * 0.105);
    col += vec3(0.9, 1.15, 1.0) * pulse * exp(-r * r * 3.2);

    // 极轻微的有序抖动，避免暗部出现色带
    float dither = fract(sin(dot(s * 1024.0, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dither - 0.5) * 0.0016;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Backdrop {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = { uTime: { value: 0 } };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
  }

  render(renderer) {
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

