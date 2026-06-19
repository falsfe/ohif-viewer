# OHIF 新算法集成指南

本文档说明如何为 OHIF 系统集成一个新算法：**前端加一个工具栏按钮 + 面板**，**后端加一个算法**。以现有的"肺分割"和"肺体积计算"为参考。

---

## 一、系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│ 浏览器 (localhost:3000)                                      │
│                                                              │
│  工具栏按钮 ──点击──▶ 右侧面板组件 (XxxPanel.tsx)            │
│                          │                                   │
│                          ▼                                   │
│              POST /api/algo/run      ──webpack代理──┐        │
│              GET  /api/algo/tasks/:id               │        │
│              GET  /api/algo/result/:id              │        │
└─────────────────────────────────────────────────────┼───────┘
                                                      │
                       proxy: /api/algo → 192.168.150.101:8000
                                                      │
┌─────────────────────────────────────────────────────▼───────┐
│ Ubuntu 虚拟机 (192.168.150.101)                              │
│  Docker 容器 algo-api (FastAPI, port 8000)                   │
│    main.py  ──路由、任务管理、下载DICOM、返回结果             │
│    algorithms/                                               │
│      __init__.py   ──算法注册表 (register/get/list_all)      │
│      mock_seg.py   ──示例算法                                │
│      lung_seg.py   ──肺分割算法                              │
│      your_algo.py  ──★ 你要新增的算法                        │
│    Orthanc (port 8042) ──DICOM存储                           │
└──────────────────────────────────────────────────────────────┘
```

**核心约定**：
- 算法代码在**本地** `Viewers/services/algo-api/`，**运行在**虚拟机的 Docker 容器中
- 改了算法代码后，需 `docker compose up -d --build` 重建容器才生效
- 前端通过 webpack 代理 `/api/algo` 访问后端，无需改前端网络配置

---

## 二、后端：添加算法

### 2.1 算法函数契约（输入/输出）

每个算法是一个 Python 函数，签名固定：

```python
def your_algorithm(input_dir: str, output_path: str, params: dict) -> dict:
    """
    Args:
        input_dir:   已下载好的 DICOM 文件目录（main.py 从 Orthanc 拉取，按 000000.dcm, 000001.dcm... 排序）
        output_path: 你要把分割结果 NIfTI 文件保存到的路径（result.nii.gz）
        params:      算法参数（目前固定传 {}，见 2.5 节扩展）

    Returns:
        dict: 元数据，至少包含:
            - "labels": {段编号: 段名称}  例如 {"1": "lung"} 或 {"1":"Right Lung","2":"Left Lung"}
            - "shape":  labelmap 的形状 [z, y, x]
            - 其他自定义字段会自动透传给前端（如 "volume": {...}）
    """
```

**输入 DICOM 读取要点**：
- 用 `pydicom.dcmread()` 读取每个 `.dcm`
- 转 HU 值：`pixel * RescaleSlope + RescaleIntercept`
- 按文件名排序（000000.dcm 在前）保证切片顺序

**输出 NIfTI 要点**：
- 用 `nibabel` 保存为 `.nii.gz`
- 数据类型 `uint8`（labelmap，0=背景，1/2/...=各段）
- 建议从 DICOM 的 `PixelSpacing` + `SliceThickness` 构造 affine 矩阵（保证空间正确）

### 2.2 注册算法

在 `algorithms/your_algo.py` 末尾调用 `register()`：

```python
from algorithms import register

register(
    "your-algo-id",              # 唯一ID（前端下拉框的value）
    "Your Algorithm Name",       # 显示名称
    "一句话描述",                # 描述
    your_algorithm,              # 函数引用
)
```

### 2.3 在注册表中导入

编辑 `algorithms/__init__.py`，在文件末尾加一行：

```python
from algorithms import mock_seg  # noqa: E402, F401
from algorithms import lung_seg  # noqa: E402, F401
from algorithms import your_algo  # noqa: E402, F401   ★ 新增
```

注册后，该算法会自动出现在 `GET /api/algo/algorithms` 的返回列表里。

### 2.4 完整示例（参考 `lung_seg.py`）

```python
import os
import numpy as np
import nibabel as nib
import pydicom
from algorithms import register


def lung_global_threshold(input_dir: str, output_path: str, params: dict) -> dict:
    threshold = params.get("threshold", -600)

    # 1. 读取 DICOM → 3D volume (HU)
    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, f))
    ])
    ds0 = pydicom.dcmread(dcm_files[0])
    slices = []
    for f in dcm_files:
        ds = pydicom.dcmread(f)
        hu = ds.pixel_array.astype(np.int16) * float(getattr(ds, 'RescaleSlope', 1)) \
             + float(getattr(ds, 'RescaleIntercept', 0))
        slices.append(hu)
    volume = np.stack(slices, axis=0)  # (Z, Y, X)

    # 2. 你的算法逻辑（这里：全局阈值 + 连通域）
    mask = (volume < threshold).astype(np.uint8)
    # ... 后处理 ...

    # 3. 构造 affine（从 DICOM 间距）
    affine = np.eye(4)
    ps = ds0.PixelSpacing
    affine[0, 0] = float(ps[1])
    affine[1, 1] = float(ps[0])
    affine[2, 2] = float(getattr(ds0, 'SliceThickness', 1.0))

    # 4. 保存 NIfTI
    nib.save(nib.Nifti1Image(mask, affine), output_path)

    # 5. 返回元数据
    return {
        "labels": {"1": "lung"},
        "shape": list(mask.shape),
    }


register(
    "lung-global-threshold",
    "Lung Segmentation (Global Threshold)",
    "Global threshold at -600 HU with connected component cleanup",
    lung_global_threshold,
)
```

### 2.5 返回自定义数据（如体积、统计量）

算法返回的 metadata 里**除 `labels`/`shape` 外的任何字段，都会自动透传给前端**（通过 task status 的 metadata）。

main.py 已经这样处理：
- `task["metadata"] = algo_fn(...)` 存全部返回值
- `GET /api/algo/tasks/:id` 在 success 时返回 `metadata`
- `GET /api/algo/result/:id` 把 `labels`/`shape` 放进响应头

所以算体积只需在返回值里加字段：

```python
return {
    "labels": {"1": "Right Lung", "2": "Left Lung"},
    "shape": list(mask.shape),
    "volume": {                          # ★ 自定义字段，前端能拿到
        "right_ml": round(right_voxels * voxel_volume / 1000, 2),
        "left_ml": round(left_voxels * voxel_volume / 1000, 2),
        "total_ml": round(total_voxels * voxel_volume / 1000, 2),
    },
}
```

**体积计算公式**：
```
体素体积(mm³) = PixelSpacing[0] × PixelSpacing[1] × SliceThickness
体积(mL)     = 体素数 × 体素体积 ÷ 1000
```

### 2.6 后端依赖

如果算法用了新库（如 `scipy`、`onnxruntime`），加到 `services/algo-api/requirements.txt`，然后重建容器。

### 2.7 多段分割（不同颜色）

labelmap 用不同整数值表示不同段：
- 0 = 背景
- 1 = 第一段（如右肺）
- 2 = 第二段（如左肺）
- ...

`labels` 字典的 key 必须与这些值对应：`{"1": "Right Lung", "2": "Left Lung"}`。前端会自动为每个段分配颜色（见 3.1）。

---

## 三、前端：添加工具栏按钮 + 面板

### 3.1 步骤1：创建面板组件

在 `extensions/cornerstone/src/components/` 新建 `XxxPanel.tsx`。

**两种模板，按需选择**：

**模板 A：真实运行算法的面板**（参考 `AlgorithmPanel.tsx`）
- 下拉选算法 → Run → 轮询进度 → 渲染分割覆盖层
- 适用于：算法在后端已注册，前端要真实运行并显示分割结果

**模板 B：独立模拟面板**（参考 `LungVolumePanel.tsx`）
- 只有 Run 按钮 → 前端模拟进度 → 显示结果
- 适用于：后端暂未做好，先做前端界面占位

关键架构（两种都要）：
- **模块级 `store` 对象**：面板切换/卸载时保留状态（OHIF 切换工具栏会卸载面板组件）
- **500ms `setInterval` 同步**：把 store 状态同步到 React state
- `servicesManager` 保留在 store 供模块级函数使用

模板 B（最简独立面板）骨架：

```typescript
import React, { useState, useEffect } from 'react';

type Phase = '' | 'running' | 'done';
type Props = { servicesManager: any };

const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  servicesManager: null as any,
  simTimer: null as ReturnType<typeof setInterval> | null,
};

function startRun() {
  store.phase = 'running';
  store.progress = 0;
  let p = 0;
  store.simTimer = setInterval(() => {
    p += 10;
    if (p >= 100) { clearInterval(store.simTimer!); store.progress = 100; store.phase = 'done'; }
    else store.progress = p;
  }, 300);
}

export default function XxxPanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState(store.phase);
  const [progress, setProgress] = useState(store.progress);
  store.servicesManager = servicesManager;

  useEffect(() => {
    const sync = setInterval(() => { setPhase(store.phase); setProgress(store.progress); }, 200);
    return () => clearInterval(sync);
  }, []);

  // ... 渲染 Run 按钮、进度条、结果
}
```

### 3.2 步骤2：注册面板

编辑 `extensions/cornerstone/src/getPanelModule.tsx`：

**(a) 顶部加 import**：
```typescript
import XxxPanel from './components/XxxPanel';
```

**(b) 在 `result` 数组里加一项**（仿照 `panelAlgorithm`）：
```typescript
{
  name: 'panelXxx',
  iconName: 'tab-segmentation',
  iconLabel: 'Xxx',
  label: 'Xxx',
  component: () => <XxxPanel servicesManager={servicesManager} />,
},
```

### 3.3 步骤3：配置工具栏按钮（3 个 mode 文件）

在 `modes/basic/src/index.tsx`、`modes/mpr/src/index.tsx`、`modes/volume-3d/src/index.tsx` 各做两处：

**(a) `cornerstone` 映射表加一行**（在 `algorithm` 那行下面）：
```typescript
xxx: '@ohif/extension-cornerstone.panelModule.panelXxx',
```

**(b) `rightPanels` 数组加入**：
```typescript
rightPanels: [cornerstone.algorithm, cornerstone.xxx, cornerstone.measurements],
```

`rightPanels` 数组的顺序 = 工具栏按钮的顺序。

---

## 四、端到端数据流

以"真实运行算法的面板"为例：

```
1. 用户点 Run
   前端: POST /api/algo/run {algorithmId, studyInstanceUID, seriesInstanceUID}
         ← {taskId}

2. 后端 (main.py _run_task, 后台线程):
   - 从 Orthanc 按 StudyInstanceUID 找到 series
   - 下载该 series 所有 DICOM 实例到临时目录
   - 调用 algo_fn(tmp_dir, output_path, {})   ← 你的算法
   - 算法返回 metadata {labels, shape, ...自定义}
   - 保存 NIfTI，存 metadata

3. 前端轮询 (每 2 秒):
   GET /api/algo/tasks/:taskId
   ← {status: "running"|"success"|"failed", progress, metadata?}
   status === "success" 时 metadata 自动返回（含体积等自定义字段）

4. 前端取结果并渲染:
   GET /api/algo/result/:taskId
   ← gzip 压缩的 labelmap 二进制
     + 响应头 X-Labelmap-Labels / X-Labelmap-Shape
   前端: 解压 → 写入 labelmap volume → addSegmentationRepresentation → 渲染
```

**多段着色**：labelmap 里值 1/2/... 自动按段渲染不同颜色。要自定义颜色，用：
```typescript
segmentationService.setSegmentColor(viewportId, segmentationId, segmentIndex, [r, g, b, a]);
```

---

## 五、部署到虚拟机

后端算法改完后，需把代码同步到虚拟机并重建容器。

```bash
# 1. 同步改动的文件到虚拟机（假设免密登录已配置）
scp Viewers/services/algo-api/algorithms/your_algo.py gin@192.168.150.101:~/algo-api/algorithms/
scp Viewers/services/algo-api/algorithms/__init__.py gin@192.168.150.101:~/algo-api/algorithms/
# 如果改了 requirements.txt:
scp Viewers/services/algo-api/requirements.txt gin@192.168.150.101:~/algo-api/

# 2. 重建并重启容器
ssh gin@192.168.150.101 "cd ~/algo-api && docker compose up -d --build"

# 3. 验证算法已注册
ssh gin@192.168.150.101 "curl -s http://localhost:8000/api/algo/algorithms"
# 应能看到你的算法 ID
```

**注意**：
- `scp` 报错 "No space left on device" → 虚拟机磁盘满，先 `docker system prune -a -f` 清理
- Docker build 报错拉不到镜像 → 检查代理配置 `/etc/systemd/system/docker.service.d/proxy.conf`
- **不要用 `git push origin`**（origin 是 OHIF 官方仓库，无权限），用 `myrepo`

---

## 六、检查清单

集成一个新算法时，逐项核对：

### 后端
- [ ] 在 `algorithms/` 下创建 `your_algo.py`
- [ ] 函数签名 `(input_dir, output_path, params) -> dict`
- [ ] 读取 DICOM 转 HU（RescaleSlope/Intercept）
- [ ] 输出 NIfTI（uint8 labelmap）到 `output_path`
- [ ] 返回 `{"labels": {...}, "shape": [...]}`（+ 自定义字段如 volume）
- [ ] 末尾调用 `register(id, name, desc, fn)`
- [ ] 在 `__init__.py` 加 `from algorithms import your_algo`
- [ ] 新依赖加到 `requirements.txt`
- [ ] 同步到虚拟机 + `docker compose up -d --build`
- [ ] `curl /api/algo/algorithms` 确认已注册

### 前端
- [ ] 在 `extensions/cornerstone/src/components/` 创建 `XxxPanel.tsx`（模块级 store + 同步）
- [ ] 在 `getPanelModule.tsx` 加 import + 注册 `panelXxx`
- [ ] 在 3 个 mode 文件加 `cornerstone.xxx` 映射 + `rightPanels` 数组项
- [ ] dev server (`yarn dev`) 验证按钮出现、面板正常

### Git
- [ ] `git add` 具体文件（不要 `git add .`）
- [ ] 提交信息格式 `feat(范围): 中文描述`
- [ ] `git push myrepo my-customizations`

---

## 七、关键文件速查

| 文件 | 作用 |
|------|------|
| `services/algo-api/algorithms/__init__.py` | 算法注册表 |
| `services/algo-api/algorithms/lung_seg.py` | 算法范例（真实运行） |
| `services/algo-api/main.py` | FastAPI 路由、任务管理、结果返回（一般不改） |
| `services/algo-api/requirements.txt` | Python 依赖 |
| `extensions/cornerstone/src/components/AlgorithmPanel.tsx` | 真实运行面板范例 |
| `extensions/cornerstone/src/components/LungVolumePanel.tsx` | 独立模拟面板范例 |
| `extensions/cornerstone/src/getPanelModule.tsx` | 面板注册入口 |
| `modes/{basic,mpr,volume-3d}/src/index.tsx` | 工具栏按钮配置 |
| `platform/app/.webpack/webpack.pwa.js` | `/api/algo` 代理到 VM:8000 |

## 八、Scope 对照（提交信息用）

| 改动文件 | scope |
|----------|-------|
| `extensions/cornerstone/src/components/XxxPanel.tsx` | algorithm |
| `extensions/cornerstone/src/getPanelModule.tsx` | algorithm |
| `modes/*/src/index.tsx` | algorithm 或 mode |
| `services/algo-api/algorithms/*.py` | （不在 git 仓库内，无需提交） |
