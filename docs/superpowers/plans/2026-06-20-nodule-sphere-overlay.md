# 肺结节球体 SVG 叠加渲染(第二阶段)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把第一阶段的结节内切球/外接球以圆形叠加到 CT 三视图视口,跟随切片滚动实时更新,面板开关控制可见性。

**Architecture:** 新建 `NoduleSphereOverlayTool`(继承 `AnnotationDisplayTool`),`renderAnnotation` 每帧由 Cornerstone 自动调用,读工具 `configuration.nodules` + 当前视口 `getCamera()`,用纯几何函数算球-切片截面,`worldToCanvas` 投到画布,`svgDrawingHelper` 画 `<circle>`。面板 Run 成功后 `setToolConfiguration` 注入 nodules 并 `setToolEnabled` 激活;开关改 `showInscribed/showCircumscribed`;切换 study/卸载时 `setToolDisabled` + 清空。

**Tech Stack:** TypeScript、React、@cornerstonejs/core、@cornerstonejs/tools(AnnotationDisplayTool + drawing + svgDrawingHelper)、jest(几何纯函数单测)。

**关联设计:** [docs/superpowers/specs/2026-06-20-nodule-sphere-overlay-design.md](../specs/2026-06-20-nodule-sphere-overlay-design.md)

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `extensions/cornerstone/src/tools/noduleSphereGeometry.ts` | 球-切片截面纯几何(无副作用,可单测) | 新建 |
| `extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts` | 几何函数单测 | 新建 |
| `extensions/cornerstone/src/tools/NoduleSphereOverlayTool.tsx` | 工具:renderAnnotation 画圆 | 新建 |
| `extensions/cornerstone/src/initCornerstoneTools.js` | addTool 注册工具 | 修改 |
| `extensions/cornerstone/src/components/NoduleSpherePanel.tsx` | Run 后激活/配置、开关 UI、清除 | 修改 |

**设计原则**:几何逻辑提取成纯函数(`noduleSphereGeometry.ts`),工具和面板只做"调几何 + 调 Cornerstone API + UI"。几何被单测覆盖,UI 用可视化验证。

---

## Task 1: 球-切片截面纯几何函数(TDD)

**Files:**
- Create: `extensions/cornerstone/src/tools/noduleSphereGeometry.ts`
- Test: `extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts`

- [ ] **Step 1: 写失败测试**

Create `extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts`:

```typescript
import { sliceSphere, sub, dot, scale, length } from '../noduleSphereGeometry';

describe('noduleSphereGeometry', () => {
  it('球心在切片平面上 → 截面=球心, 半径=球半径', () => {
    // 球心 (0,0,0), 半径 5;平面过 (0,0,0), 法线 z 轴
    const r = sliceSphere([0, 0, 0], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(5, 5);
    expect(r!.center).toEqual([0, 0, 0]);
  });

  it('球心偏离平面但仍在切片范围内 → 截面半径变小', () => {
    // 球心 (0,0,3), 半径 5;平面 z=0, 法线 z 轴 → d=3, r=sqrt(25-9)=4
    const r = sliceSphere([0, 0, 3], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(4, 5);
    expect(r!.center).toEqual([0, 0, 0]); // 投影回平面
  });

  it('球心到平面距离 = 半径(相切) → 返回 null', () => {
    const r = sliceSphere([0, 0, 5], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).toBeNull();
  });

  it('球心到平面距离 > 半径(切不到) → 返回 null', () => {
    const r = sliceSphere([0, 0, 6], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).toBeNull();
  });

  it('球心在平面负法线侧也能正确计算(|d|)', () => {
    // 球心 (0,0,-3), 半径 5 → d=-3, |d|=3, r=4
    const r = sliceSphere([0, 0, -3], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(4, 5);
  });

  it('向量运算: sub/dot/scale/length', () => {
    expect(sub([1, 2, 3], [4, 5, 6])).toEqual([-3, -3, -3]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
    expect(length([3, 4, 0])).toBeCloseTo(5, 5);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `yarn jest extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts --no-coverage`
Expected: FAIL —— "Cannot find module '../noduleSphereGeometry'"

- [ ] **Step 3: 实现几何函数**

Create `extensions/cornerstone/src/tools/noduleSphereGeometry.ts`:

```typescript
// 肺结节球体-切片截面纯几何函数(无副作用、无外部依赖,便于单测)
// 所有坐标为世界坐标(mm),向量为 [x, y, z]。

export type Vec3 = [number, number, number];

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/**
 * 计算球体被一个无限大平面切出的截面圆。
 *
 * @param sphereCenter  球心(世界坐标 mm)
 * @param sphereRadius  球半径(mm)
 * @param planePoint    切片平面上一点(通常用相机位置)
 * @param planeNormal   切片平面法线(单位向量,通常用 viewPlaneNormal)
 * @returns 截面圆 { center(世界坐标, 在平面上), radius(mm) },或 null(切不到)
 */
export function sliceSphere(
  sphereCenter: Vec3,
  sphereRadius: number,
  planePoint: Vec3,
  planeNormal: Vec3
): { center: Vec3; radius: number } | null {
  // 有符号距离 d = (C - P) · n
  const d = dot(sub(sphereCenter, planePoint), planeNormal);
  const absD = Math.abs(d);

  // 切不到(含相切:截面退化为点,本实现按 null 处理)
  if (absD >= sphereRadius) {
    return null;
  }

  // 截面半径 r = √(R² - d²)
  const radius = Math.sqrt(sphereRadius * sphereRadius - absD * absD);

  // 截面圆心 = 球心投影到平面 = C - d·n
  const center = sub(sphereCenter, scale(planeNormal, d));

  return { center, radius };
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `yarn jest extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts --no-coverage`
Expected: PASS(6 个测试全过)

- [ ] **Step 5: 提交**

```bash
git add extensions/cornerstone/src/tools/noduleSphereGeometry.ts extensions/cornerstone/src/tools/__tests__/noduleSphereGeometry.test.ts
git commit -m "feat(algorithm): 新增结节球体-切片截面纯几何函数及单测

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: NoduleSphereOverlayTool 工具 + 注册

**Files:**
- Create: `extensions/cornerstone/src/tools/NoduleSphereOverlayTool.tsx`
- Modify: `extensions/cornerstone/src/initCornerstoneTools.js`

- [ ] **Step 1: 写工具类**

Create `extensions/cornerstone/src/tools/NoduleSphereOverlayTool.tsx`:

```typescript
import { AnnotationDisplayTool, drawing } from '@cornerstonejs/tools';
import { sliceSphere, sub, length, Vec3 } from './noduleSphereGeometry';

// 工具配置的数据结构(对应第一阶段 metadata.nodules[i] 的字段)
interface NoduleData {
  nodule_id: number;
  inscribed_center_x_mm: number;
  inscribed_center_y_mm: number;
  inscribed_center_z_mm: number;
  inscribed_diameter_mm: number;
  circumscribed_center_x_mm: number;
  circumscribed_center_y_mm: number;
  circumscribed_center_z_mm: number;
  circumscribed_diameter_mm: number;
}

interface NoduleSphereConfiguration {
  nodules: NoduleData[];
  showInscribed: boolean;
  showCircumscribed: boolean;
}

const INSCRIBED_COLOR = '#00BFFF'; // 蓝
const CIRCUMSCRIBED_COLOR = '#FF4444'; // 红
const STROKE_WIDTH = 2;

/**
 * 在 CT 视口上叠加显示结节的内切球/外接球截面圆。
 * - 继承 AnnotationDisplayTool:renderAnnotation 由 Cornerstone 每帧自动调用,
 *   切片滚动/缩放/平移时圆会自动重算,无需手动监听事件。
 * - 数据通过 configuration.nodules 传入(面板 Run 成功后注入)。
 * - 通过 toolGroup.setToolEnabled / setToolDisabled 显示/隐藏。
 */
class NoduleSphereOverlayTool extends AnnotationDisplayTool {
  static toolName = 'NoduleSphereOverlay';

  constructor(toolProps = {}, defaultToolProps = { supportedInteractionTypes: [] }) {
    super(toolProps, defaultToolProps);
  }

  onSetToolDisabled = (): void => {};

  renderAnnotation = (enabledElement, svgDrawingHelper): void => {
    const { viewport } = enabledElement;
    const cfg = (this.configuration || {}) as Partial<NoduleSphereConfiguration>;
    const nodules = cfg.nodules || [];
    if (!nodules.length) return;

    const camera = viewport.getCamera?.();
    const P = camera?.position as Vec3 | undefined;
    const n = camera?.viewPlaneNormal as Vec3 | undefined;
    if (!P || !n) return;

    // 画布 1 像素 = 多少 mm(canvasToWorld 技巧,ViewportOrientationMarkers 同款)
    const w0 = viewport.canvasToWorld?.([0, 0]) as Vec3;
    const w1 = viewport.canvasToWorld?.([1, 0]) as Vec3;
    if (!w0 || !w1) return;
    const mmPerPixel = length(sub(w0, w1));
    if (!mmPerPixel || !Number.isFinite(mmPerPixel)) return;

    for (const nd of nodules) {
      if (cfg.showInscribed) {
        this._drawSphere(
          viewport,
          svgDrawingHelper,
          [nd.inscribed_center_x_mm, nd.inscribed_center_y_mm, nd.inscribed_center_z_mm],
          nd.inscribed_diameter_mm / 2,
          INSCRIBED_COLOR,
          P,
          n,
          mmPerPixel,
          `nodule-${nd.nodule_id}-inscribed`
        );
      }
      if (cfg.showCircumscribed) {
        this._drawSphere(
          viewport,
          svgDrawingHelper,
          [
            nd.circumscribed_center_x_mm,
            nd.circumscribed_center_y_mm,
            nd.circumscribed_center_z_mm,
          ],
          nd.circumscribed_diameter_mm / 2,
          CIRCUMSCRIBED_COLOR,
          P,
          n,
          mmPerPixel,
          `nodule-${nd.nodule_id}-circumscribed`
        );
      }
    }
  };

  private _drawSphere(
    viewport,
    svgDrawingHelper,
    sphereCenter: Vec3,
    sphereRadius: number,
    color: string,
    planePoint: Vec3,
    planeNormal: Vec3,
    mmPerPixel: number,
    hashId: string
  ): void {
    const slice = sliceSphere(sphereCenter, sphereRadius, planePoint, planeNormal);
    if (!slice) return; // 这层切不到该球

    const canvasXY = viewport.worldToCanvas?.(slice.center);
    if (!canvasXY) return;
    const [cx, cy] = canvasXY;
    const rPixel = slice.radius / mmPerPixel;

    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(rPixel)) return;

    const svgns = 'http://www.w3.org/2000/svg';
    const attributes = {
      'data-id': hashId,
      cx,
      cy,
      r: rPixel,
      fill: 'none',
      stroke: color,
      'stroke-width': STROKE_WIDTH,
    };

    const existing = svgDrawingHelper.getSvgNode(hashId);
    if (existing) {
      drawing.setAttributesIfNecessary(attributes, existing);
      svgDrawingHelper.setNodeTouched(hashId);
    } else {
      const circle = document.createElementNS(svgns, 'circle');
      drawing.setNewAttributesIfValid(attributes, circle);
      svgDrawingHelper.appendNode(circle, hashId);
    }
  }
}

export default NoduleSphereOverlayTool;
```

- [ ] **Step 2: 在 initCornerstoneTools.js 注册工具**

Modify `extensions/cornerstone/src/initCornerstoneTools.js`:

在文件顶部已有的工具 import 区(参考 `import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';` 那一行附近)追加:

```javascript
import NoduleSphereOverlayTool from './tools/NoduleSphereOverlayTool';
```

在 `addTool(...)` 调用区(参考 `addTool(ImageOverlayViewerTool);` 那一行附近)追加:

```javascript
addTool(NoduleSphereOverlayTool);
```

- [ ] **Step 3: 编译验证(无类型/语法错误)**

Run: `cd platform/app && yarn run dev`(后台启动;首次会用缓存,几十秒内出 "compiled" 或错误)
Expected: 控制台出现 `webpack ... compiled ... in Nms`,无 TypeScript 报错。看到后可 Ctrl+C 停掉(后续 Task 4 还要用)。

> 若报错,常见原因:`AnnotationDisplayTool` / `drawing` 未从 `@cornerstonejs/tools` 正确导出 → 对照 [ImageOverlayViewerTool.tsx:3](../../../extensions/cornerstone/src/tools/ImageOverlayViewerTool.tsx#L3) 的 import。

- [ ] **Step 4: 提交**

```bash
git add extensions/cornerstone/src/tools/NoduleSphereOverlayTool.tsx extensions/cornerstone/src/initCornerstoneTools.js
git commit -m "feat(algorithm): 新增 NoduleSphereOverlayTool 并注册

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 面板集成(激活工具、开关 UI、清除)

**Files:**
- Modify: `extensions/cornerstone/src/components/NoduleSpherePanel.tsx`

本任务在第一阶段已有的 NoduleSpherePanel 上扩展。核心:Run 成功后把 nodules 注入工具并激活;加两个开关;面板卸载/切换 study 时关闭工具并清空。

- [ ] **Step 1: 在 store 增加开关状态**

Modify `extensions/cornerstone/src/components/NoduleSpherePanel.tsx` —— 找到第一阶段定义的 `const store = {...}`,在 `mode` 字段后追加两个字段:

```typescript
  showInscribed: true,
  showCircumscribed: true,
```

- [ ] **Step 2: 新增"把 nodules 推给工具并激活"的模块级函数**

在 `NoduleSpherePanel.tsx` 顶部(紧邻 `startPolling`/`stopPolling` 定义处)新增:

```typescript
const NODULE_SPHERE_TOOL_NAME = 'NoduleSphereOverlay';

// 把 nodules 写入工具 configuration 并激活工具,让球截面圆显示在所有 CT 视口
function applyNodulesToTool(nodules: Nodule[], showInscribed: boolean, showCircumscribed: boolean) {
  const sm = store.servicesManager;
  if (!sm) return;
  const { toolGroupService, cornerstoneViewportService, viewportGridService } = sm.services;
  const renderingEngine = cornerstoneViewportService.getRenderingEngine?.();
  if (!renderingEngine) return;

  // 对每个视口的 toolGroup 注入配置并激活(三视图通常同一 toolGroup,遍历以保险)
  const { viewports } = viewportGridService.getState();
  const handledGroups = new Set<string>();
  for (const [vpId] of viewports ?? []) {
    const toolGroup = toolGroupService.getToolGroupForViewport?.(vpId);
    if (!toolGroup || handledGroups.has(toolGroup.id)) continue;
    handledGroups.add(toolGroup.id);
    try {
      toolGroup.setToolConfiguration(NODULE_SPHERE_TOOL_NAME, {
        nodules,
        showInscribed,
        showCircumscribed,
      });
      toolGroup.setToolEnabled(NODULE_SPHERE_TOOL_NAME);
    } catch {}
  }
  renderingEngine.render();
}

// 关闭工具并清空(切换 study / 卸载面板时调用)
function clearNodulesFromTool() {
  const sm = store.servicesManager;
  if (!sm) return;
  const { toolGroupService, cornerstoneViewportService, viewportGridService } = sm.services;
  const renderingEngine = cornerstoneViewportService.getRenderingEngine?.();
  const { viewports } = viewportGridService.getState();
  const handledGroups = new Set<string>();
  for (const [vpId] of viewports ?? []) {
    const toolGroup = toolGroupService.getToolGroupForViewport?.(vpId);
    if (!toolGroup || handledGroups.has(toolGroup.id)) continue;
    handledGroups.add(toolGroup.id);
    try {
      toolGroup.setToolConfiguration(NODULE_SPHERE_TOOL_NAME, { nodules: [] });
      toolGroup.setToolDisabled(NODULE_SPHERE_TOOL_NAME);
    } catch {}
  }
  renderingEngine?.render?.();
}
```

- [ ] **Step 3: 轮询 success 时调用 applyNodulesToTool**

在 `startPolling` 函数里,找到 `if (data.status === 'success')` 分支(第一阶段那里设置了 `store.nodules`),改为同时推给工具:

```typescript
        if (data.status === 'success') {
          stopPolling();
          store.nodules = (data.metadata?.nodules as Nodule[]) || [];
          store.phase = 'done';
          applyNodulesToTool(store.nodules, store.showInscribed, store.showCircumscribed);
        } else if (data.status === 'failed') {
```

- [ ] **Step 4: 开关 UI + 同步 store + 实时生效**

在组件函数体内(已有 `roiName/threshold/mode` 等 useState 旁边)新增两个 state:

```typescript
  const [showInscribed, setShowInscribed] = useState(store.showInscribed);
  const [showCircumscribed, setShowCircumscribed] = useState(store.showCircumscribed);
```

新增两个 effect(同步到 store + 实时推给工具):

```typescript
  useEffect(() => { store.showInscribed = showInscribed; }, [showInscribed]);
  useEffect(() => { store.showCircumscribed = showCircumscribed; }, [showCircumscribed]);
```

开关变化时若已有 nodules,实时更新工具 configuration 并重绘。在组件内新增:

```typescript
  // 开关变化:若已有结节结果,实时更新工具显示
  const toggleShow = (kind: 'showInscribed' | 'showCircumscribed', val: boolean) => {
    if (kind === 'showInscribed') setShowInscribed(val);
    else setShowCircumscribed(val);
    if (store.nodules.length) {
      applyNodulesToTool(
        store.nodules,
        kind === 'showInscribed' ? val : store.showInscribed,
        kind === 'showCircumscribed' ? val : store.showCircumscribed
      );
    }
  };
```

- [ ] **Step 5: 在表格上方插入开关 JSX**

在 NoduleSpherePanel 的 return 里,找到结果表格区块(`{phase === 'done' && nodules.length > 0 && (` 之前),插入开关:

```tsx
      {/* 显示开关 */}
      <div style={{ marginTop: 12, marginBottom: 8, fontSize: 12, color: '#ccc', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label>
          <input
            type="checkbox"
            checked={showInscribed}
            onChange={e => toggleShow('showInscribed', e.target.checked)}
          />{' '}
          显示内切球(蓝)
        </label>
        <label>
          <input
            type="checkbox"
            checked={showCircumscribed}
            onChange={e => toggleShow('showCircumscribed', e.target.checked)}
          />{' '}
          显示外接球(红)
        </label>
      </div>
```

- [ ] **Step 6: 卸载时清除工具**

在组件内新增一个 effect,组件卸载时关闭工具:

```typescript
  useEffect(() => {
    return () => {
      // 面板卸载:关闭工具,避免球残留在视口
      clearNodulesFromTool();
    };
  }, []);
```

> 说明:面板切换/卸载会触发此 cleanup。切换 study 时旧 study 的球会残留到新 study 视口——这需要监听 study 变化,本任务作为已知限制记录,可在后续优化(见风险)。

- [ ] **Step 7: 编译验证**

Run: `cd platform/app && yarn run dev`(后台)
Expected: `webpack ... compiled`,无报错。看到后 Ctrl+C。

- [ ] **Step 8: 提交**

```bash
git add extensions/cornerstone/src/components/NoduleSpherePanel.tsx
git commit -m "feat(algorithm): NoduleSpherePanel 集成球体叠加工具(激活/开关/清除)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 端到端可视化验证

**Files:** 无改动(纯验证)

> 前提:VM 上 algo-api 已部署 nodule-sphere(第一阶段已完成);Orthanc 里有 LUNG1-001(用户已通过前端上传,含 CT + RTSTRUCT)。

- [ ] **Step 1: 启动前端 dev server**

Run(在 platform/app,避开根目录 yarn dev 的 bun 坑): `cd /c/Users/gin/Desktop/ohif/Viewers/platform/app && yarn run dev`
Expected: 控制台出现代理创建(`/api/algo → 192.168.150.101:8000` 等)+ `webpack ... compiled`。浏览器打开 http://localhost:3000 能进系统。

- [ ] **Step 2: 加载 LUNG1-001 并 Run**

操作:浏览器 → 打开 LUNG1-001 study → 进入 CT 视口 → 右侧 Nodule Sphere 面板 → ROI `GTV-1` → Run。
Expected: 进度跑完后,表格显示 1 个结节(内切Ø≈42.6mm、外接Ø≈141.9mm/或 exact 97.3mm)。

- [ ] **Step 3: 验证球截面圆显示**

操作:Run 完成后观察三视图 CT 视口。
Expected:
- 结节位置出现**蓝色内切球截面圆**和**红色外接球截面圆**(默认两个都显示)
- 圆心约在结节球心 `92 / -209 / -460` 附近(需滚动到对应切片才看得最清楚)
- 只描边、不填充,不挡住 CT

- [ ] **Step 4: 验证跟随切片滚动**

操作:在任一视口滚动鼠标滚轮翻片。
Expected:靠近结节球心的切片,圆变大;远离时圆变小;切不到该球时圆消失。无需手动刷新。

- [ ] **Step 5: 验证开关**

操作:取消勾选"显示内切球" → 蓝圆消失;勾回 → 重现。同理外接球。
Expected:开关即时生效。

- [ ] **Step 6: 验证缩放跟随**

操作:按住右键/滚轮缩放视口。
Expected:圆按 CT 同步缩放(半径像素随 mmPerPixel 变化)。

- [ ] **Step 7: 记录坐标校验**

校验点(设计文档风险1):打开到结节球心切片(球心 z≈-460 对应的轴位片),蓝圆/红圆圆心应落在结节解剖位置上。若整体偏移,排查 LPS/RAS 坐标系(可能需在世界坐标某轴取反)。

- [ ] **Step 8: 若全部通过,推送**

```bash
git push myrepo my-customizations
```

---

## 已知限制 / 后续

- **切换 study 时旧球残留**:面板未卸载、仅切换 study 时,旧结节的球可能残留在新视口(需监听 study 变化主动 clearNodulesFromTool)。本次未实现,留作优化。
- **实性阈值滑杆实时高亮**:第三功能,不在本次范围(见设计文档第八节)。
- **多结节圆重叠**:多个结节的圆可能重叠,本次全画、不做选择。

---

## 自审

**1. Spec 覆盖**:
- 三视图截面圆 → Task 2 工具 + Task 4 Step 3 验证 ✓
- 跟随滚动/缩放实时更新 → Task 2(AnnotationDisplayTool 自动)+ Task 4 Step 4/6 验证 ✓
- 显示开关 → Task 3 Step 4/5 + Task 4 Step 5 ✓
- 切换 study/卸载清除 → Task 3 Step 6(卸载清除)+ 已知限制(study 切换)✓
- 几何公式(设计第四章)→ Task 1 sliceSphere + 单测 ✓
- 样式(蓝/红/2px/不填充)→ Task 2 常量 ✓
- 不含阈值滑杆 → 范围明确排除 ✓

**2. Placeholder 扫描**:无 TBD/TODO;每步含完整代码或确切命令。

**3. 类型一致性**:`NODULE_SPHERE_TOOL_NAME = 'NoduleSphereOverlay'` 与工具 `static toolName = 'NoduleSphereOverlay'` 一致;`sliceSphere` 签名(Task 1)与工具调用(Task 2)一致;`Nodule[]`/`showInscribed/showCircumscribed` 跨 Task 3 一致。

自审通过。
