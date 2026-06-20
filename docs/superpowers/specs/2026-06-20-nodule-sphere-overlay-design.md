# 肺结节球体 SVG 叠加渲染(第二阶段)设计

- 日期:2026-06-20
- 关联:第一阶段 `nodule-sphere` 算法集成(测量数据表格已完成并提交 `ba1f7029b`)
- 关联文档:`集成中转站/nodule-sphere-ohif-integration.md`(原始集成方案,第三章三视图公式)

## 一、背景与目标

第一阶段已让"肺结节球体分析"算法跑通:前端面板 Run 后,后端返回每个结节的**内切球/外接球**(直径、球心 DICOM 世界坐标 mm)、体积、实性占比,面板以**表格**展示。

第二阶段目标:把这些球**以圆形叠加到 CT 视口上**——在每个切面(axial/coronal/sagittal)实时显示内切球(蓝)、外接球(红)的截面圆,跟随切片滚动/缩放实时更新。

## 二、范围(本次)

**做**:
- 三视图(axial/coronal/sagittal)各自画出每个结节的内切球 + 外接球**截面圆**
- 跟随切片滚动、缩放、平移**实时更新**(由 Cornerstone 自动驱动)
- 面板内两个**显示开关**(显示内切球 / 显示外接球)
- 切换 study / 卸载面板时自动清除

**不做**(留待后续):
- 实性阈值滑杆实时高亮(功能复杂度不同量级,单独攻关)

## 三、架构

### 三个改动点

1. **新建 `NoduleSphereOverlayTool`** —— `extensions/cornerstone/src/tools/NoduleSphereOverlayTool.tsx`
   继承 `AnnotationDisplayTool`(来自 `@cornerstonejs/tools`),仿 [ImageOverlayViewerTool.tsx](../../../extensions/cornerstone/src/tools/ImageOverlayViewerTool.tsx)。实现 `renderAnnotation`,在视口 SVG 层画截面圆。

2. **改 `NoduleSpherePanel.tsx`** —— 第一阶段已有
   - Run 成功后,把 `store.nodules` 写入工具 `configuration.nodules`,并 `setToolEnabled` 激活工具
   - 表格上方加两个开关(`显示内切球` / `显示外接球`),改 `configuration.showInscribed/showCircumscribed` 并触发重绘
   - 切换 study / 卸载面板时:`setToolDisabled` + 清空 configuration.nodules

3. **注册工具** —— `extensions/cornerstone/src/initCornerstoneTools.js`
   `addTool(NoduleSphereOverlayTool)`,使工具可被 toolGroup 激活。

### 数据流

```
用户 Run → 后端 metadata.nodules(球心 xyz + 直径)
        → 面板 store.nodules(第一阶段已有)
        → 写入 NoduleSphereOverlayTool.configuration.nodules
        → toolGroup.setToolEnabled('NoduleSphereOverlay')  激活
        → 工具每帧 renderAnnotation:
            读 configuration.nodules + 当前视口 getCamera()(位置 P、法线 n)
            → 对每个结节算内切/外接截面圆
            → worldToCanvas 投到画布 → svgDrawingHelper 画 <circle>
滚动/缩放 → Cornerstone 自动重绘 → 圆自动重算(无需事件监听)
开关切换 → 改 configuration.show* → 触发重绘
切换study/卸载 → setToolDisabled + 清 configuration → 圆消失
```

**关键**:工具 `renderAnnotation` 由 Cornerstone 每帧自动调用,切片/缩放/平移的变化都会自动反映,无需手动监听任何事件。这是选 `AnnotationDisplayTool` 方案的核心收益。

## 四、NoduleSphereOverlayTool 核心算法

### 输入

第一阶段 metadata.nodules[i] 已含全部所需几何:
- `inscribed_center_x/y/z_mm` + `inscribed_diameter_mm`(内切球心 + 直径)
- `circumscribed_center_x/y/z_mm` + `circumscribed_diameter_mm`(外接球心 + 直径)

球心是 DICOM 世界坐标(mm,LPS),与 Cornerstone 世界坐标系一致(SimpleITK 物理坐标 = LPS,Cornerstone 也是 LPS)。

### 几何(集成文档第三章精确版)

```
切片平面:过相机位置 P,法线 n = viewPlaneNormal
球心 C,半径 R

球心到切片平面距离:  d = |(C − P) · n|
  ├─ d ≥ R  → 这层切不到球,不画
  └─ d < R  → 截面半径 r = √(R² − d²)
              截面圆心 C' = C − ((C−P)·n)·n   (球心投影到切片平面)
```

### renderAnnotation 伪代码

> 以下为示意伪代码,`vec3` 运算实际用 `gl-matrix`(项目已用,见 [CornerstoneViewportService.ts](../../../extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts)),具体签名以库为准。

```js
renderAnnotation(enabledElement, svgDrawingHelper) {
  const { viewport } = enabledElement;
  const nodules = this.configuration.nodules || [];
  if (!nodules.length) return;

  const { position: P, viewPlaneNormal: n } = viewport.getCamera();

  // 画布 1 像素 = 多少 mm(canvasToWorld 技巧,ViewportOrientationMarkers 同款)
  const mmPerPixel = dist3(viewport.canvasToWorld([0,0]), viewport.canvasToWorld([1,0]));

  for (const nd of nodules) {
    if (this.configuration.showInscribed)
      this._drawCircle(viewport, svgDrawingHelper, nd.inscribedCenter, nd.inscribedR, '#00BFFF', P, n, mmPerPixel, 'inscribed-'+nd.nodule_id);
    if (this.configuration.showCircumscribed)
      this._drawCircle(viewport, svgDrawingHelper, nd.circumscribedCenter, nd.circumscribedR, '#FF4444', P, n, mmPerPixel, 'circumscribed-'+nd.nodule_id);
  }
}

_drawCircle(viewport, svgDrawingHelper, C, R, color, P, n, mmPerPixel, hashId) {
  const CP = vec3.sub(C, P);
  const d = Math.abs(vec3.dot(CP, n));
  if (d >= R) return;                                  // 这层切不到 → 不画
  const r = Math.sqrt(R*R - d*d);                      // 截面半径(mm)
  const Cproj = vec3.sub(C, vec3.scale(n, vec3.dot(CP, n))); // 投影到切片平面
  const [cx, cy] = viewport.worldToCanvas(Cproj);
  const rPixel = r / mmPerPixel;
  if (Number.isNaN(cx) || Number.isNaN(cy) || Number.isNaN(rPixel)) return;
  // svgDrawingHelper 画 <circle>(仿 ImageOverlayViewerTool:svgNodeHash + getSvgNode/appendNode + drawing.setAttributes)
}
```

### 样式

- 内切球:`#00BFFF`(蓝)
- 外接球:`#FF4444`(红)
- 线宽 2px,**只描边不填充**(`fill: none`,不挡住下面 CT 影像)

### 边界处理

- `nodules` 为空 → 不画
- 当前切片切不到某球(`d ≥ R`)→ 该圆不画,其余仍画
- `worldToCanvas` 返回 NaN(球心不在该视口范围)→ 跳过该圆
- 非 volume 视口(stack 等):依赖 `getCamera()` 返回有效 `viewPlaneNormal`,无则跳过

## 五、UI

开关放在 Nodule Sphere 面板内、结果表格**正上方**:

```
ROI 名称 / 实性阈值 / 外接球算法 / [Re-run] / 进度
☑ 显示内切球(蓝)     ← 新增
☑ 显示外接球(红)     ← 新增
共 N 个结节
[结果表格]
```

默认两个开关都勾选。开关变化即时生效(改 configuration → 触发视口重绘)。

## 六、验证

1. **编译**:`yarn run dev`(platform/app 下)编译通过
2. **单结节可视化**:加载 LUNG1-001,Run,在三视图 CT 上应看到:
   - 蓝色内切球截面圆、红色外接球截面圆,位于结节处
   - 滚动切片靠近结节球心时圆变大、远离时变小、切不到时消失
   - 缩放时圆按比例缩放
3. **开关**:取消勾选 → 对应圆消失;勾回 → 重现
4. **切换 study / 关闭面板**:圆消失,不残留

## 七、风险

- **坐标系统一致性**:SimpleITK 物理坐标(LPS)需与 Cornerstone 世界坐标一致。若圆落点偏移,优先排查 LPS/RAS 转换(实施时用 LUNG1-001 的已知球心 `92.3 / -208.6 / -459.5` 校验:打开到该切片,圆心应在结节上)。
- **mmPerPixel 各向异性**:用 x 方向 `canvasToWorld` 算的比例,在极端各向异性缩放下可能略偏;CT 视口通常各向同性,可接受。若不准,改用 `viewUp`/`viewRight` 方向偏移点算半径。
- **多结节叠加**:多个结节的圆可能重叠(本次范围:全画,不做选择)。

## 八、第二阶段之后(不在本次)

- 实性阈值滑杆实时高亮(前端实时阈值渲染,或后端按阈值重算)
- 表格行点击 → 视口跳转到该结节球心切片
