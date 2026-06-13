# 肺部体积计算面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 OHIF 工具栏新增一个"肺部体积"按钮，点击后在右侧边栏打开面板，显示左右肺体积（mock 数据）并能把当前分割按 X 中点拆成红/绿双色渲染。

**Architecture:** 沿用 OHIF 现有的 `rightPanels` 工具栏按钮机制——在 mode 配置的 `rightPanels` 数组加一项 + 在 `getPanelModule.tsx` 注册一个新面板。新面板 `LungVolumePanel.tsx` 使用模块级 store 持久化状态（与 `AlgorithmPanel.tsx` 一致），"应用到当前影像"按钮读取已加载 labelmap 按 X 中点拆分为左右肺两段并设红/绿颜色。

**Tech Stack:** React + TypeScript, @cornerstonejs/core, @cornerstonejs/tools, OHIF segmentationService

**参考设计**: `docs/superpowers/specs/2026-05-20-lung-volume-panel-design.md`

**测试说明**: OHIF 面板组件运行在复杂的 App 上下文中（依赖 servicesManager、viewport、已加载的影像），无独立单元测试基础设施（现有 `AlgorithmPanel` 也无单测）。本计划采用"实现 + 启动 dev server 手动验证"的方式，每个任务有明确的验证步骤，不伪造无法运行的 TDD。

**Git 提交规范**: remote 用 `myrepo`，提交信息格式 `类型(范围): 中文描述`，git 命令在 `Viewers/` 目录下执行。本次 scope 为 `algorithm`。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `extensions/cornerstone/src/components/LungVolumePanel.tsx` | 新建 | 肺体积面板组件（显示体积 + 应用双色渲染） |
| `extensions/cornerstone/src/getPanelModule.tsx` | 修改 | 注册 `panelLungVolume` 面板 |
| `modes/basic/src/index.tsx` | 修改 | cornerstone 映射表加 lungVolume + rightPanels 加按钮 |
| `modes/mpr/src/index.tsx` | 修改 | 同上 |
| `modes/volume-3d/src/index.tsx` | 修改 | 同上 |

**关键 API（已验证存在于 SegmentationService.ts）**:
- `segmentationService.getSegmentations()` — 获取所有 segmentation（line 155）
- `segmentationService.getSegmentation(id)` — 按 id 获取（line 141）
- `segmentationService.createLabelmapForDisplaySet(displaySet, {segments, label})` — 创建 labelmap segmentation
- `segmentationService.setSegmentColor(viewportId, segmentationId, segmentIndex, [r,g,b,a])` — 设置段颜色（line 1121）
- `csCache.getVolume(volumeId).voxelManager.getScalarData()` — 读取 labelmap 体素数据
- `volume.dimensions` — 体素维度 `[dimX, dimY, dimZ]`
- `segmentationService.addSegmentationRepresentation(viewportId, {segmentationId, type})` — 添加表示

**Cornerstone 体素索引顺序**: scalarData 是一维数组，XYZ 顺序（x 变化最快）。体素 (x,y,z) 的索引 = `x + y*dimX + z*dimX*dimY`。

---

## Task 1: 创建 LungVolumePanel 组件（体积显示 + 应用逻辑）

**Files:**
- Create: `extensions/cornerstone/src/components/LungVolumePanel.tsx`

- [ ] **Step 1: 创建 LungVolumePanel.tsx 完整文件**

写入以下完整内容到 `extensions/cornerstone/src/components/LungVolumePanel.tsx`：

```typescript
import React, { useState, useEffect } from 'react';

type Props = {
  servicesManager: any;
};

// 模块级 store：面板切换/卸载时保留状态（与 AlgorithmPanel 一致）
const store = {
  volumeData: {
    rightMl: 1234.56,
    leftMl: 1456.78,
    totalMl: 2691.34,
  },
  applied: false,
  error: '',
  servicesManager: null as any,
};

// 按图像 X 中点把已加载的 labelmap 拆成左右肺两段，红/绿双色渲染
async function applyDualColor() {
  const { segmentationService, viewportGridService } = store.servicesManager.services;

  try {
    // 1. 找到已存在的 segmentation（由 AlgorithmPanel 运行产生）
    const segmentations = segmentationService.getSegmentations();
    if (!segmentations || segmentations.length === 0) {
      store.error = '请先在 Algorithm 面板运行分割算法';
      return;
    }
    const sourceSeg = segmentations[0];
    const sourceId = sourceSeg.segmentationId;

    // 2. 读取源 labelmap 体素数据与维度
    const cstSegmentation = await import('@cornerstonejs/tools').then(m => m.segmentation);
    const csSeg = cstSegmentation.state.getSegmentation(sourceId);
    const labelmapData = csSeg?.representationData?.Labelmap;
    if (!labelmapData?.volumeId) {
      store.error = '无法读取 labelmap 数据';
      return;
    }

    const { cache: csCache } = await import('@cornerstonejs/core');
    const srcVolume = csCache.getVolume(labelmapData.volumeId);
    if (!srcVolume?.voxelManager) {
      store.error = '无法读取体素数据';
      return;
    }
    const srcScalar = srcVolume.voxelManager.getScalarData();
    const dims = srcVolume.dimensions; // [dimX, dimY, dimZ]
    const [dimX, dimY, dimZ] = dims;
    const midX = Math.floor(dimX / 2);

    // 3. 创建新的双段 labelmap segmentation
    const { displaySetService } = store.servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { store.error = '无活动视口'; return; }
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!displaySetUIDs?.length) { store.error = '无 display set'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
    if (!displaySet) { store.error = '无 display set'; return; }

    const segments = {
      1: { label: 'Right Lung', active: true },
      2: { label: 'Left Lung', active: true },
    };
    const newSegId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
      segments,
      label: 'Lung Volume Analysis',
    });

    // 4. 把拆分后的数据写入新 labelmap volume
    const newCsSeg = cstSegmentation.state.getSegmentation(newSegId);
    const newLabelmapData = newCsSeg?.representationData?.Labelmap;
    if (newLabelmapData?.volumeId) {
      const newVolume = csCache.getVolume(newLabelmapData.volumeId);
      if (newVolume?.voxelManager) {
        const newScalar = newVolume.voxelManager.getScalarData();
        // 按索引遍历：源>0 的体素，x<midX → 1(右肺)，否则 → 2(左肺)
        for (let z = 0; z < dimZ; z++) {
          for (let y = 0; y < dimY; y++) {
            const rowBase = y * dimX + z * dimX * dimY;
            for (let x = 0; x < dimX; x++) {
              const idx = rowBase + x;
              if (srcScalar[idx] > 0) {
                newScalar[idx] = x < midX ? 1 : 2;
              }
            }
          }
        }
        newVolume.voxelManager.setScalarData(newScalar);
      }
    }

    // 5. 设颜色：段1=右肺红，段2=左肺绿；添加表示并渲染
    const { viewports } = viewportGridService.getState();
    for (const [vpId] of viewports ?? []) {
      try {
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: newSegId,
          type: 'Labelmap' as const,
        });
        segmentationService.setSegmentColor(vpId, newSegId, 1, [255, 52, 52, 255]);
        segmentationService.setSegmentColor(vpId, newSegId, 2, [52, 255, 52, 255]);
      } catch {}
    }

    const cs = await import('@cornerstonejs/core');
    viewports?.forEach((v: any) => {
      try {
        const el = cs.getEnabledElementByViewportId(v.viewportId);
        if (el?.viewport) el.viewport.render();
      } catch {}
    });

    store.applied = true;
    store.error = '';
  } catch (e: any) {
    store.error = e.message || '应用失败';
  }
}

export default function LungVolumePanel({ servicesManager }: Props) {
  const [applied, setApplied] = useState(store.applied);
  const [error, setError] = useState(store.error);

  // 保持 servicesManager 引用供模块级函数使用
  store.servicesManager = servicesManager;

  // 同步 store → React 状态（处理重新挂载）
  useEffect(() => {
    const sync = setInterval(() => {
      setApplied(store.applied);
      setError(store.error);
    }, 500);
    return () => clearInterval(sync);
  }, []);

  const { rightMl, leftMl, totalMl } = store.volumeData;

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    fontSize: 13,
  };
  const swatchStyle = (color: string): React.CSSProperties => ({
    display: 'inline-block',
    width: 12,
    height: 12,
    background: color,
    marginRight: 8,
    borderRadius: 2,
    verticalAlign: 'middle',
  });

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>肺体积计算</h3>

      <div style={{ background: '#1c1c1c', borderRadius: 6, padding: 12, marginBottom: 12 }}>
        <div style={rowStyle}>
          <span><span style={swatchStyle('#ff3434')} />右肺 Right Lung</span>
          <span style={{ color: '#ff3434', fontWeight: 600 }}>{rightMl.toFixed(2)} mL</span>
        </div>
        <div style={rowStyle}>
          <span><span style={swatchStyle('#34ff34')} />左肺 Left Lung</span>
          <span style={{ color: '#34ff34', fontWeight: 600 }}>{leftMl.toFixed(2)} mL</span>
        </div>
        <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />
        <div style={rowStyle}>
          <span>总计 Total</span>
          <span style={{ fontWeight: 600 }}>{totalMl.toFixed(2)} mL</span>
        </div>
      </div>

      <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
        * 当前为占位数据，后端算法接入后显示真实体积
      </div>

      <button
        onClick={() => applyDualColor()}
        style={{
          width: '100%',
          padding: 8,
          borderRadius: 4,
          border: 'none',
          background: applied ? '#2e7d32' : '#329ce8',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        {applied ? '已应用（重新应用）' : '应用到当前影像'}
      </button>

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: 启动 dev server 检查编译无错误**

Run（如已在运行则跳过，HMR 会自动重载）:
```bash
cd /c/Users/gin/Desktop/ohif/Viewers/platform/app && yarn dev
```
Expected: 控制台无 TypeScript 编译错误（组件暂未注册，不会渲染，但需确保文件本身无语法/类型错误）

- [ ] **Step 3: Commit**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git add extensions/cornerstone/src/components/LungVolumePanel.tsx
git commit -m "feat(algorithm): 新增肺体积计算面板组件

- 显示左右肺/总体积（mock占位数据，2位小数mL）
- 应用按钮按X中点拆分当前labelmap为左右肺红绿双色
- 模块级store持久化状态

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 在 getPanelModule.tsx 注册面板

**Files:**
- Modify: `extensions/cornerstone/src/getPanelModule.tsx`

- [ ] **Step 1: 添加 import**

在 `getPanelModule.tsx` 第 7 行 `import AlgorithmPanel from './components/AlgorithmPanel';` 之后添加：

```typescript
import LungVolumePanel from './components/LungVolumePanel';
```

- [ ] **Step 2: 在 result 数组中注册 panelLungVolume**

在第 134 行（`panelAlgorithm` 对象的结束 `},`）之后、第 135 行的 `];` 之前，插入：

```typescript
    {
      name: 'panelLungVolume',
      iconName: 'tab-segmentation',
      iconLabel: 'Lung Volume',
      label: 'Lung Volume',
      component: () => {
        return <LungVolumePanel servicesManager={servicesManager} />;
      },
    },
```

修改后该段应为：
```typescript
    {
      name: 'panelAlgorithm',
      iconName: 'tab-segmentation',
      iconLabel: 'Algorithm',
      label: 'Algorithm',
      component: () => {
        console.log('[panelAlgorithm] rendering');
        return <AlgorithmPanel servicesManager={servicesManager} />;
      },
    },
    {
      name: 'panelLungVolume',
      iconName: 'tab-segmentation',
      iconLabel: 'Lung Volume',
      label: 'Lung Volume',
      component: () => {
        return <LungVolumePanel servicesManager={servicesManager} />;
      },
    },
  ];
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git add extensions/cornerstone/src/getPanelModule.tsx
git commit -m "feat(algorithm): 注册肺体积面板panelLungVolume

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 在 basic mode 配置中添加工具栏按钮

**Files:**
- Modify: `modes/basic/src/index.tsx`

- [ ] **Step 1: cornerstone 映射表添加 lungVolume**

在第 31 行 `algorithm: '@ohif/extension-cornerstone.panelModule.panelAlgorithm',` 之后添加一行：

```typescript
  lungVolume: '@ohif/extension-cornerstone.panelModule.panelLungVolume',
```

- [ ] **Step 2: rightPanels 数组添加 lungVolume**

修改第 290 行：
```typescript
// 原内容
rightPanels: [cornerstone.segmentation, cornerstone.algorithm, cornerstone.measurements],
// 改为
rightPanels: [cornerstone.segmentation, cornerstone.algorithm, cornerstone.lungVolume, cornerstone.measurements],
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git add modes/basic/src/index.tsx
git commit -m "feat(algorithm): basic模式工具栏添加肺体积按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 在 mpr mode 配置中添加工具栏按钮

**Files:**
- Modify: `modes/mpr/src/index.tsx`

- [ ] **Step 1: cornerstone 映射表添加 lungVolume**

在第 31 行 `algorithm: '@ohif/extension-cornerstone.panelModule.panelAlgorithm',` 之后添加：

```typescript
  lungVolume: '@ohif/extension-cornerstone.panelModule.panelLungVolume',
```

- [ ] **Step 2: rightPanels 数组添加 lungVolume**

修改第 171 行：
```typescript
// 原内容
rightPanels: [cornerstone.algorithm, cornerstone.measurements],
// 改为
rightPanels: [cornerstone.algorithm, cornerstone.lungVolume, cornerstone.measurements],
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git add modes/mpr/src/index.tsx
git commit -m "feat(algorithm): mpr模式工具栏添加肺体积按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 在 volume-3d mode 配置中添加工具栏按钮

**Files:**
- Modify: `modes/volume-3d/src/index.tsx`

- [ ] **Step 1: cornerstone 映射表添加 lungVolume**

在第 24 行 `algorithm: '@ohif/extension-cornerstone.panelModule.panelAlgorithm',` 之后添加：

```typescript
  lungVolume: '@ohif/extension-cornerstone.panelModule.panelLungVolume',
```

- [ ] **Step 2: rightPanels 数组添加 lungVolume**

修改第 154 行：
```typescript
// 原内容
rightPanels: [cornerstone.algorithm, cornerstone.measurements],
// 改为
rightPanels: [cornerstone.algorithm, cornerstone.lungVolume, cornerstone.measurements],
```

- [ ] **Step 3: Commit**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git add modes/volume-3d/src/index.tsx
git commit -m "feat(algorithm): volume-3d模式工具栏添加肺体积按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 端到端手动验证 + 推送

**Files:** 无（验证）

- [ ] **Step 1: 启动 dev server（如未运行）**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers/platform/app && yarn dev
```
Expected: 在 `http://localhost:3000` 启动成功

- [ ] **Step 2: 验证按钮出现**

打开浏览器 → 加载一个 CT study → 进入查看器（basic 或 mpr mode）→ 检查右侧工具栏
Expected: 出现 3 个按钮（算法 + 肺部体积 Lung Volume + 测量），肺部体积按钮可见

- [ ] **Step 3: 验证体积显示**

点击"肺部体积"按钮
Expected: 右侧边栏打开面板，显示"肺体积计算"标题 + 右肺 1234.56 mL / 左肺 1456.78 mL / 总计 2691.34 mL

- [ ] **Step 4: 验证双色渲染**

先在 Algorithm 面板运行分割算法（生成覆盖层）→ 切到肺体积面板 → 点"应用到当前影像"
Expected: 影像覆盖层变为左半绿、右半红双色；按钮变为"已应用"

- [ ] **Step 5: 验证状态持久化**

点击其他工具栏按钮切走 → 再点回肺部体积按钮
Expected: 面板状态保留（已应用标记、体积数字仍在）

- [ ] **Step 6: 推送到 myrepo**

```bash
cd /c/Users/gin/Desktop/ohif/Viewers
git push myrepo my-customizations
```
Expected: 推送成功（若提示 no upstream 则用 `git push --set-upstream myrepo my-customizations`）

---

## Self-Review 已完成

- ✅ **Spec 覆盖**: 工具栏按钮（Task 2-5）、体积显示（Task 1）、双色渲染（Task 1 applyDualColor）、mock 数据（Task 1 store）、状态持久化（Task 1 模块级 store）均有对应任务
- ✅ **无占位符**: 所有代码块完整，无 TODO/TBD
- ✅ **类型一致**: `panelLungVolume` 在 getPanelModule 与三个 mode 的 `panelModule.panelLungVolume` 引用一致；`applyDualColor` 函数名全程一致
- ✅ **API 已验证**: SegmentationService 的 getSegmentations/createLabelmapForDisplaySet/setSegmentColor/addSegmentationRepresentation 均确认存在于 SegmentationService.ts
