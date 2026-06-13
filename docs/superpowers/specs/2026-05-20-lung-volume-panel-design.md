# 肺部体积计算面板设计

## 背景

当前 OHIF 系统已有 Algorithm 面板（工具栏按钮触发），可运行分割算法并在影像上显示覆盖层。用户希望新增一个**肺部体积计算**功能：

1. 计算肺体积并在页面上以文字形式展示（左肺、右肺、总体积）
2. 计算后在肺的图像上用**不同颜色**展示左肺和右肺
3. 通过新增一个**工具栏按钮**触发，与现有 Algorithm 按钮并列

本次只做**前端**，后端算法暂不实现，体积数字使用 mock 占位数据。

## 需求确认

| 项目 | 决定 |
|------|------|
| 颜色方案 | 左肺/右肺不同颜色（右肺红、左肺绿） |
| 体积单位 | mL |
| 小数精度 | 2 位小数 |
| 触发方式 | 新增工具栏按钮（不是面板内 toggle） |
| 体积数据 | mock 占位数字（后端做好后接入真实数据） |
| 后端 | 本次不做 |

## 架构

OHIF 工具栏按钮的机制：每个 mode 配置文件中的 `rightPanels` 数组，每一项对应一个右侧工具栏按钮。点击按钮在右侧边栏打开对应面板。现有 `algorithm` 按钮就是通过 `rightPanels: [..., cornerstone.algorithm, ...]` 注册的。

新增"肺部体积"功能沿用完全相同的机制：

```
工具栏（顶部）
  ├── 分割按钮（segmentation）     ← 现有
  ├── 算法按钮（algorithm）        ← 现有
  ├── 肺部体积按钮（lungVolume）   ← ★ 新增
  └── 测量按钮（measurements）     ← 现有

点击"肺部体积按钮" → 右侧边栏打开 LungVolumePanel
```

## 实现步骤

### Step 1: 新增 `LungVolumePanel.tsx` 组件

**文件**: `extensions/cornerstone/src/components/LungVolumePanel.tsx`

结构与现有 `AlgorithmPanel.tsx` 一致（模块级 store 持久化状态），内容：

- 顶部标题："肺体积计算"
- 体积结果区域（mock 数据）：
  ```
  🟥 右肺：1234.56 mL
  🟩 左肺：1456.78 mL
  ─────────────────
  总计：2691.34 mL
  ```
- "应用到当前影像"按钮：把当前已加载的分割按 X 轴中点拆成左右两半，分别用红色（右肺）、绿色（左肺）渲染

**左右肺着色逻辑**（前端临时方案）：
1. 通过 `segmentationService` 获取当前已加载的 labelmap segmentation
2. 读取其 voxelManager 的 scalarData
3. 按 X 轴中点拆分：X < width/2 的体素 → 右肺（值=1）；X >= width/2 → 左肺（值=2）
4. 重新写回 scalarData
5. 创建 2 个 segment（label "Right Lung"/"Left Lung"），通过 segmentationService 设置颜色（右肺红、左肺绿）
6. force render 所有 viewport

**模块级 store**（持久化，与 AlgorithmPanel 一致）：
```typescript
const store = {
  volumeData: { rightMl: 1234.56, leftMl: 1456.78, totalMl: 2691.34 },
  applied: false,
  servicesManager: null,
};
```

体积数字先用 mock 常量。后端做好后改为从轮询接口的 `metadata.volume` 读取（后端算法返回 `volume: {right_ml, left_ml, total_ml}`，main.py 已自动通过 task status 的 metadata 字段传递，无需改 main.py）。

### Step 2: 注册面板

**文件**: `extensions/cornerstone/src/getPanelModule.tsx`

参照现有 `panelAlgorithm` 注册，新增：
```typescript
import LungVolumePanel from './components/LungVolumePanel';

// 在 result 数组中新增
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

### Step 3: 在 mode 配置中注册按钮

三个 mode 文件各加两处：
- `modes/basic/src/index.tsx`
- `modes/mpr/src/index.tsx`
- `modes/volume-3d/src/index.tsx`

(a) cornerstone 映射表加一项：
```typescript
export const cornerstone = {
  // ...现有项
  lungVolume: '@ohif/extension-cornerstone.panelModule.panelLungVolume',
};
```

(b) basicLayout 的 rightPanels 数组加入新项：
```typescript
rightPanels: [cornerstone.segmentation, cornerstone.algorithm, cornerstone.lungVolume, cornerstone.measurements],
```

## 数据流

```
[当前阶段 - mock]
点击"肺部体积"按钮 → 打开 LungVolumePanel
  → 显示 mock 体积数字（右肺 1234.56 / 左肺 1456.78 / 总 2691.34 mL）
点击"应用到当前影像"
  → 读取当前 labelmap → X 中点拆分 → 红绿双色渲染

[后端做好后 - 真实数据]
运行 lung-volume 算法 → 轮询 task status（metadata 含 volume）
  → 体积数字从 metadata.volume 读取
  → 后端直接输出左右肺两段，前端无需 X 中点拆分
```

## 不在本次范围

- 后端 `lung-volume` 算法（真实左右肺连通域分割 + 物理体积计算）
- main.py 改动（已确认无需修改）
- 真实左右肺分段（当前用 X 中点拆分作为前端临时方案）

## 验证

1. 打开 OHIF，加载一个 CT study
2. 顶部工具栏应出现新的"肺部体积"按钮
3. 先在 Algorithm 面板运行分割算法，生成覆盖层
4. 点击"肺部体积"按钮 → 面板显示 mock 体积数字（右/左/总，2 位小数 mL）
5. 点击"应用到当前影像" → 覆盖层变为左绿右红双色
6. 切换其他工具栏按钮再切回 → 体积面板状态保留（模块级 store）
