# 交接文档 / HANDOFF

> 给接手的开发者或 AI：读完这一页就能继续改，不用重新摸索。
> 最后更新：2026-10-30，完成花束组合与桌面/移动端验证之后。

## 一、这是什么

**白山茶花束 · 手控绽放** —— 用摄像头识别手势，控制一束由 1.6 万粒子组成的白山茶开合：

- 握拳 → 花束收拢待放；张开手掌 → 两朵主花一层层散开
- 炭黑包装纸、细枝小白花、金色卡片与黑色缎带组成完整花束
- 花朵跟随手的位移，指尖靠近会拨开花瓣
- 右下角有实时「手部捕捉」小窗（镜像画面 + 21 点骨架 + 张开度）

| 项目 | 地址 |
|---|---|
| 在线演示（HTTPS，摄像头可用） | https://zyr123-star.github.io/camellia-bloom/ |
| 源码 | https://github.com/zyr123-star/camellia-bloom |
| 技术栈 | 原生 ES Module + Three.js r169（CDN）+ MediaPipe Hands + GLSL，无构建 |

## 二、当前状态

**能跑、已部署、自检全绿**：

```bash
node tools/check.mjs     # 40 项通过，0 失败
node serve.mjs           # → http://localhost:5173
```

**2026-10-30 浏览器验收结果**：

- Edge 无头浏览器使用 SwiftShader 建起 WebGL 2，着色器编译通过，双主花共 16000 粒子正常绘制
- Three.js 与 MediaPipe CDN 均成功加载；假摄像头触发真实推理并拿到结果帧
- 阻断 MediaPipe CDN 后已验证：停止摄像头、隐藏手部小窗、切到演示模式，按住可正常开花
- 1440×900 与 390×844 两种视口均无横向溢出；移动端自动降至 9000 粒子
- 尚未验证：真人摄像头画面、真实手机设备、长时间运行稳定性

离线软件渲染器（`tools/preview.mjs`）仍用于单朵粒子花的造型与曝光回归；
花束包装、双花构图和缎带由真实浏览器截图验证。

## 三、代码地图

```
index.html            importmap 映射 three.js；DOM 结构（开场页 / HUD / 手部小窗 / 帮助）
styles.css            全套界面样式（墨绿夜色 / 玉白 / 一点金）
serve.mjs             零依赖静态服务器（camera 需要 localhost 或 https）
src/
  main.js             主控：状态机、tension→spread、跟随、HUD、错误降级、键盘/指针
  bouquet.js          程序绘制包装纸、粒子花枝、细枝小花、卡片与缎带
  flowerGeometry.js   ★ 纯数学，不依赖 three：花瓣曲面、双姿态、法向、颜色
  flower.js           three.js 层：Points + ShaderMaterial + 光晕 Sprite + 浮尘
  handTracker.js      MediaPipe 封装 + tension 公式 + 模型预热探测
  backdrop.js         背景：全屏墨绿渐变（WebGL）
  handPreview.js      右下角手部捕捉小窗（2D canvas）
  skeleton.js         骨架绘制（小窗用）
tools/
  check.mjs           40 项自检（tension 回归 / 阈值 / 几何 / 着色器属性 / DOM 契约）
  preview.mjs         离线软件光栅器：不装浏览器也能把粒子渲成 PNG
  sweep.mjs           参数扫描，出 2×2 对比拼图
```

数据流：

```
摄像头帧 → MediaPipe(21点) → tension(0~1) → smoothstep(0.32,0.66) → targetSpread
        → spread 缓动 → 顶点着色器 mix(aBud, aBloom, spread) → 加色粒子
```

**设计上的关键决定**（改之前先读，避免踩回去）：

1. **花瓣只存两套静态顶点**（花苞 / 盛放），中间态全部在顶点着色器里 `mix`。
   CPU 每帧只更新 3 个 uniform。不要改成 CPU 每帧算位置。
2. **画布必须不透明**。透明画布会被浏览器按 premultiplied alpha 合成，加色粒子会出现黑边。
   所以背景是一层 WebGL 全屏渐变（`backdrop.js`），不是 CSS。
3. **大画面不显示摄像头**。白花需要干净深背景；手只看右下角小窗。
   因此跟随不需要像素级对齐，只把手的归一化位置映射成画面中的有限位移（±30% / ±24%）。
4. **用 legacy `@mediapipe/hands` 而不是 tasks-vision**：前者 wasm + 模型都在同一个 npm 包里，
   一个 CDN 源就能跑通；后者还要从 storage.googleapis.com 拉模型。
5. **错误必须降级不白屏**：模型加载失败 → 演示模式（呼吸 + 按住模拟张开）。
6. **花束有明确渲染层级**：后层包装纸 0 → 粒子花枝 1 → 粒子花 2 →
   前层包装纸 2.5 → 缎带 3。前层纸负责遮住枝干汇合处并包住花冠底部，
   必须使用低弧形双托口，只覆盖花苞下缘或花瓣底部，不能盖住花冠主体。
   两朵主花的方向固定，不要恢复拖拽旋转或随时间自转。
   两朵 `Camellia` 共享手势状态；不要为了局部样式拆成大量 DOM 节点。
7. **细枝小花必须保持自然不对称**：左右枝长、花朵数量、尺寸和朝向都要有差异，
   花瓣数和边缘也要有差异；小花必须清楚可辨，不要缩成背景噪点，也不要恢复成等距五瓣花模板。
   小白花使用独立透明图层并按 `spread` 错峰开合，不要重新烘焙成静态纸张纹理。
   装饰枝使用不同的不规则控制点与 centripetal 曲线，不要简化成对称放射线或等距波浪线。
8. **所有花枝也使用粒子**：主枝和装饰细枝使用折线路径采样并加入半径抖动，
   数量约为花朵粒子的 16%（桌面 2560 / 移动端 1440），
   不要改回实心 TubeGeometry。
   所有枝干必须共享同一个 `TIE_POINT` 并汇入缎带束口；主枝另一端进入花苞内部，
   装饰枝端点必须有可见小花，不能留下悬浮枝或空枝。

## 四、核心公式

**张开度 tension**（`handTracker.js`）：

```
reach_f     = |指尖 - 手腕| / |指根 - 手腕|          // 握拳 ~1.1，张开 ~2.2
reachScore  = clamp((reach_f - 1.18) / 0.87, 0, 1)
straight    = clamp((θ_pip/π - 0.33) / 0.33, 0, 1)   // 指节伸直度，抗透视压缩
ext_f       = 0.62·reachScore + 0.38·straight
tension     = Σ(w_f·ext_f)/Σw_f                     // 拇指 .70，其余 .85~1.00
```

**绽放映射**（`main.js`）：

```js
const targetSpread = smoothstep(0.32, 0.66, tension);
const k = 1 - Math.pow(1 - 0.1, dt * 60);   // 60fps 时 k === 0.1
spread += (targetSpread - spread) * k;      // 高刷屏不会加速
```

**花瓣轮廓**（`flowerGeometry.js`）：

```
W(t) = Wmax · t^0.55 · (1 − t⁴)^0.5
```

这个形状是"像不像山茶"的关键：到 t≈0.75 才收顶、t=0.95 仍有约一半宽度 → 宽圆瓣顶。
换成 `sin` 那类尖端收敛到 0 的曲线，粒子云的瓣尖会变成尖角，看起来像百合或碎冰。

## 五、调参入口

| 位置 | 参数 | 作用 |
|---|---|---|
| `main.js` `CFG` | `CLOSED_AT` / `OPEN_AT` | 阈值 0.32 / 0.66 |
| | `SPREAD_EASE` | 绽放缓动，0.1 |
| | `TENSION_TAU_OPEN/CLOSE` | 手部平滑 0.085 / 0.055 s |
| `flowerGeometry.js` `WHORLS` | `petals/beta/L/W/rBase/cup/curl/twist` | 每轮花瓣姿态（花苞与盛放各一套） |
| `flowerGeometry.js` `PALETTE` | 花瓣白 / 花药金 / 背景 | 三色平涂 |
| `flower.js` uniforms | `uGain`(0.8) | 全局亮度 |
| | `uSizeMul`(1.5) | 粒子大小 |
| | `pitch`(0.80 ≈ 46°) | 相机俯角，也可用 `?pitch=` |
| `backdrop.js` | `near/mid/far` 三个颜色 | 背景墨绿深度 |

URL 调试参数：`?spread=0.5`（锁定绽放度并跳过开场页）、`?demo=1`、`?particles=20000`、`?pitch=0.42`。

## 六、未完成 / 待确认

1. **视觉是否达标等待确认**。当前已改为 9/8/6 = 23 片重瓣，并收窄盛开态花瓣、加深花心遮蔽。
   浏览器与离线成片中金蕊已经形成独立色块，但仍需真人最终确认审美效果。
2. **移动端未真机测试**。390px 视口已通过浏览器检查，但尚未跑真实手机摄像头。
3. **无完全离线兜底**。MediaPipe CDN 失败已能降级；three.js 仍从 jsDelivr 加载。
   要完全离线，需本地化 three.js，并把 `@mediapipe/hands@0.4.1675469240` 整包镜像后改 `MP_BASE`。
4. **手部识别精度未用真人数据校准**。tension 的系数（1.18 / 0.87 / 0.62 / 0.38）
   是基于合成手型推的，真人可能偏灵敏或偏迟钝，需要现场微调。

## 七、验证手段（没有浏览器时也能用）

```bash
node tools/check.mjs                    # 40 项断言
node tools/preview.mjs                  # 渲出 preview-out/*.png
PARTICLES=14000 node tools/preview.mjs  # 换粒子数

# 离线渲染器的环境变量
PREVIEW_W=1200 PREVIEW_H=820 PREVIEW_PITCH=0.80 \
GAIN=0.8 SIZE_MUL=1.5 TONE=clamp EXPOSURE=1.0 \
STATES="0,0.3,0.55,0.8,1" STRIP=1 \
node tools/preview.mjs
```

`preview.mjs` 用与着色器**同构**的投影、假光照、软核叠加把粒子光栅化，
所以造型可以完全脱离浏览器迭代——这是这个项目能在一台没有浏览器的机器上做完的原因。

## 八、这台机器的坑（写给人看）

- **没装 git**。推送是走 GitHub Git Data API 完成的（blob → tree → commit → ref）。
  空仓库不能建 blob（409），要先做一次引导提交。
- **PowerShell 双引号里 `$(...)` 会被当子表达式展开**。用字符串替换改 JS 代码时，
  含 `$('id')` 或模板字符串的内容会被吃掉。要么用单引号 / here-string，要么直接用编辑工具。
- **headless Chrome / Edge 起不来**（进程挂死），所以没法截图验证。
- 沙箱 shell **不能直连外网**（jsDelivr 等 TLS 失败），但 `gh` 可以。

## 九、许可

MIT。花朵几何与着色器为原创实现。
