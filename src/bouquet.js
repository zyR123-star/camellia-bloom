import * as THREE from 'three';
import { mulberry32 } from './flowerGeometry.js';

const TAU = Math.PI * 2;
const TIE_POINT = [0, -1.02, 0.22];

const DECOR_BRANCHES = [
  {
    points: [[455, 900], [365, 760], [315, 570], [350, 360], [320, 110]],
    flowers: [
      [365, 760, 17, -0.38, 2],
      [315, 570, 23, 0.18, 5],
      [350, 360, 13, -0.65, 4],
      [320, 110, 16, 0.2, 3],
    ],
  },
  {
    points: [[590, 880], [670, 790], [745, 650], [775, 500], [755, 330]],
    flowers: [
      [670, 790, 14, 0.35, 6],
      [775, 500, 20, -0.18, 3],
      [755, 330, 18, 0.62, 7],
    ],
  },
  {
    points: [[445, 925], [350, 870], [255, 860], [140, 825]],
    flowers: [
      [350, 870, 12, -0.4, 1],
      [140, 825, 18, 0.22, 0],
    ],
  },
];

function polygon(ctx, points, fill) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawMiniFlower(ctx, x, y, r, angle = 0, variant = 0, spread = 1, order = 0) {
  const delay = (variant % 5) * 0.035 + (order % 3) * 0.025;
  const from = 0.16 + delay;
  const to = Math.min(0.94, 0.72 + delay);
  const t = Math.max(0, Math.min(1, (spread - from) / (to - from)));
  const open = t * t * (3 - 2 * t);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = 'rgba(38, 40, 34, 0.42)';
  ctx.lineWidth = 1;
  const petals = variant === 3 ? 6 : 5;
  for (let i = 0; i < petals; i++) {
    const wobble = 1 + 0.18 * Math.sin(variant * 2.3 + i * 2.1);
    const squeeze = 0.86 + 0.2 * Math.sin(variant + i * 1.4);
    const theta = (i * TAU / petals + 0.18 * Math.sin(variant + i * 1.7)) * open;
    const radial = 0.88 + 0.12 * Math.sin(variant * 2.7 + i * 1.9);
    const distance = r * (0.35 + 0.38 * open) * radial;
    const petalX = Math.sin(theta) * distance + r * 0.06 * Math.sin(variant + i) * (0.25 + 0.75 * open);
    const petalY = -Math.cos(theta) * distance;
    ctx.fillStyle = i % 3 ? '#f5f1e5' : '#e8e2d3';
    ctx.beginPath();
    ctx.ellipse(
      petalX,
      petalY,
      r * (0.11 + 0.12 * open) * squeeze,
      r * (0.4 + 0.2 * open) * wobble,
      theta + 0.12 * Math.sin(variant * 1.7 + i) * open,
      0,
      TAU,
    );
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.25 + 0.75 * open;
  ctx.beginPath();
  ctx.arc(r * 0.05, -r * 0.02, r * (0.05 + 0.07 * open), 0, TAU);
  ctx.fillStyle = '#a98745';
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function makePointTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.82)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function paperPoint([x, y]) {
  return new THREE.Vector3(
    (x / 1024 - 0.5) * 2.55 * 1.16,
    -0.34 + (0.5 - y / 1400) * 3.2 * 1.16,
    -0.82,
  );
}

function createBranchParticles(count = 1600) {
  const rand = mulberry32(84021);
  const decorativeCurves = DECOR_BRANCHES.map((branch, index) => {
    const points = [new THREE.Vector3(...TIE_POINT), ...branch.points.map(paperPoint)];
    return {
      points,
      curve: new THREE.CatmullRomCurve3(points, false, 'centripetal'),
      color: index === 0 ? [0.29, 0.17, 0.08] : [0.24, 0.14, 0.07],
      jitter: 0.0045 + index * 0.0005,
    };
  });
  const curves = [
    ...decorativeCurves,
    {
      points: [
        new THREE.Vector3(-0.38, 0.20, 0.29),
        new THREE.Vector3(-0.39, -0.12, 0.25),
        new THREE.Vector3(-0.25, -0.39, 0.22),
        new THREE.Vector3(-0.10, -0.72, 0.19),
        new THREE.Vector3(...TIE_POINT),
      ],
      color: [0.31, 0.27, 0.13],
      jitter: 0.011,
    },
    {
      points: [
        new THREE.Vector3(0.32, -0.20, 0.19),
        new THREE.Vector3(0.29, -0.48, 0.19),
        new THREE.Vector3(0.16, -0.78, 0.19),
        new THREE.Vector3(...TIE_POINT),
      ],
      color: [0.28, 0.25, 0.12],
      jitter: 0.009,
    },
  ];

  const withLength = curves.map((item) => {
    let curve = item.curve;
    if (!curve) {
      curve = new THREE.CurvePath();
      for (let i = 1; i < item.points.length; i++) {
        curve.add(new THREE.LineCurve3(item.points[i - 1], item.points[i]));
      }
    }
    return { ...item, curve, length: curve.getLength() };
  });
  const totalLength = withLength.reduce((sum, item) => sum + item.length, 0);
  const positions = [];
  const colors = [];
  const point = new THREE.Vector3();

  for (const item of withLength) {
    const localCount = Math.max(24, Math.round(count * item.length / totalLength));
    for (let i = 0; i < localCount; i++) {
      const t = (i + rand() * 0.9) / localCount;
      item.curve.getPoint(t, point);
      point.x += (rand() - 0.5) * item.jitter * 2;
      point.y += (rand() - 0.5) * item.jitter * 2;
      point.z += (rand() - 0.5) * item.jitter;
      positions.push(point.x, point.y, point.z);
      const light = 0.72 + rand() * 0.55;
      colors.push(item.color[0] * light, item.color[1] * light, item.color[2] * light);
    }
  }

  const tie = new THREE.Vector3(...TIE_POINT);
  const tieCount = Math.max(24, Math.round(count * 0.06));
  for (let i = 0; i < tieCount; i++) {
    const angle = rand() * TAU;
    const radius = 0.018 * Math.sqrt(rand());
    positions.push(
      tie.x + Math.cos(angle) * radius,
      tie.y + Math.sin(angle) * radius,
      tie.z + (rand() - 0.5) * 0.018,
    );
    const light = 0.7 + rand() * 0.45;
    colors.push(0.24 * light, 0.14 * light, 0.07 * light);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.034,
      map: makePointTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      depthTest: false,
      alphaTest: 0.02,
      sizeAttenuation: true,
      toneMapped: false,
    }),
  );
  points.frustumCulled = false;
  points.renderOrder = 1;
  return points;
}

function drawRibbonTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 640;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.translate(256, 90);
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#171a18';
  ctx.strokeStyle = 'rgba(211, 205, 187, 0.38)';
  ctx.lineWidth = 3;

  polygon(ctx, [[-8, 42], [-98, 500], [-28, 518], [20, 88]], '#171a18');
  polygon(ctx, [[12, 42], [78, 486], [144, 452], [42, 86]], '#111412');

  polygon(ctx, [[-8, 22], [-78, 12], [-54, 58], [-6, 44]], '#1b1f1c');
  polygon(ctx, [[8, 22], [78, 12], [54, 58], [6, 44]], '#151916');
  ctx.beginPath();
  ctx.moveTo(-78, 12);
  ctx.lineTo(-54, 58);
  ctx.moveTo(78, 12);
  ctx.lineTo(54, 58);
  ctx.stroke();

  ctx.fillStyle = '#202420';
  ctx.fillRect(-24, 20, 48, 44);
  ctx.strokeRect(-24, 20, 48, 44);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
  ctx.beginPath();
  ctx.moveTo(-16, 30);
  ctx.lineTo(-16, 53);
  ctx.stroke();
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawPaperTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1400;
  const ctx = canvas.getContext('2d');

  polygon(ctx, [[235, 90], [775, 70], [930, 660], [790, 1250], [500, 1370], [205, 1160], [78, 650]], '#080a09');
  polygon(ctx, [[88, 520], [238, 92], [500, 168], [438, 1210], [202, 1062]], '#151917');
  polygon(ctx, [[350, 146], [653, 112], [626, 1272], [414, 1190]], '#202420');
  polygon(ctx, [[620, 112], [808, 68], [956, 520], [846, 1240], [612, 1210]], '#101311');
  ctx.beginPath();
  ctx.moveTo(235, 90);
  ctx.lineTo(775, 70);
  ctx.lineTo(930, 660);
  ctx.lineTo(790, 1250);
  ctx.lineTo(500, 1370);
  ctx.lineTo(205, 1160);
  ctx.lineTo(78, 650);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(226, 233, 224, 0.09)';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.lineCap = 'round';
  const folds = [
    [[240, 105], [306, 620], [278, 1050]],
    [[416, 128], [380, 650], [430, 1190]],
    [[618, 112], [560, 630], [610, 1210]],
    [[806, 72], [742, 620], [842, 1218]],
  ];
  for (const [a, b, c] of folds) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(b[0], b[1], c[0], c[1]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(280, 170);
  ctx.rotate(-0.045);
  ctx.fillStyle = '#0a0c0b';
  ctx.strokeStyle = '#b69a66';
  ctx.lineWidth = 2;
  ctx.fillRect(-92, -54, 184, 108);
  ctx.strokeRect(-92, -54, 184, 108);
  ctx.fillStyle = '#e9dfc8';
  ctx.textAlign = 'center';
  ctx.font = '600 23px Georgia, serif';
  ctx.fillText('CAMELLIA', 0, 2);
  ctx.fillStyle = '#a98d5f';
  ctx.font = '12px Arial, sans-serif';
  ctx.fillText('HAND BLOOM', 0, 27);
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawFrontPaperTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1400;
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.moveTo(224, 1020);
  ctx.bezierCurveTo(278, 985, 333, 986, 366, 1010);
  ctx.bezierCurveTo(430, 1080, 470, 1090, 520, 1080);
  ctx.bezierCurveTo(590, 1090, 640, 1080, 690, 1030);
  ctx.bezierCurveTo(742, 980, 820, 986, 878, 1020);
  ctx.bezierCurveTo(842, 1160, 770, 1274, 520, 1335);
  ctx.bezierCurveTo(336, 1248, 250, 1146, 224, 1020);
  ctx.closePath();
  ctx.fillStyle = '#131714';
  ctx.fill();

  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(224, 1020);
  ctx.quadraticCurveTo(338, 1060, 310, 1218);
  ctx.moveTo(878, 1020);
  ctx.quadraticCurveTo(770, 1072, 784, 1264);
  ctx.moveTo(520, 1080);
  ctx.quadraticCurveTo(548, 1180, 520, 1335);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createDecorFlowerLayer() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1400;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.55, 3.2),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  mesh.position.set(0, -0.34, -0.83);
  mesh.scale.setScalar(1.16);
  mesh.renderOrder = 1.25;
  mesh.name = 'decor-flowers';

  let lastSpread = -1;
  mesh.userData.setSpread = (value) => {
    const spread = Math.max(0, Math.min(1, Number(value) || 0));
    if (Math.abs(spread - lastSpread) < 0.002) return;
    lastSpread = spread;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let order = 0;
    for (const branch of DECOR_BRANCHES) {
      for (const flower of branch.flowers) drawMiniFlower(ctx, ...flower, spread, order++);
    }
    texture.needsUpdate = true;
  };
  mesh.userData.setSpread(0);
  return mesh;
}

export function createBouquetDecor({ branchCount = 1600 } = {}) {
  const group = new THREE.Group();
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(2.55, 3.2),
    new THREE.MeshBasicMaterial({
      map: drawPaperTexture(),
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  paper.position.set(0, -0.34, -0.85);
  paper.scale.setScalar(1.16);
  paper.renderOrder = 0;
  group.add(paper);

  group.add(createBranchParticles(branchCount));
  const decorFlowers = createDecorFlowerLayer();
  group.add(decorFlowers);

  const frontPaper = new THREE.Mesh(
    new THREE.PlaneGeometry(2.55, 3.2),
    new THREE.MeshBasicMaterial({
      map: drawFrontPaperTexture(),
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  frontPaper.position.set(0, -0.60, -0.84);
  frontPaper.scale.setScalar(1.16);
  frontPaper.renderOrder = 2.5;
  frontPaper.name = 'front-paper';
  group.add(frontPaper);

  const ribbon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.58, 0.98),
    new THREE.MeshBasicMaterial({
      map: drawRibbonTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    }),
  );
  ribbon.position.set(0, -0.96, 0.42);
  ribbon.renderOrder = 3;
  group.add(ribbon);
  return group;
}
