"""
肺叶分割算法 - TransUNet + 体积统计

从 DICOM 序列推理 5 个肺叶分割 + 计算各叶体积
类别: 0=背景, 1=左上叶(LL), 2=左下叶(LU), 3=右上叶(RU), 4=右下叶(RL), 5=右中叶(RM)
"""

import os
import sys
import numpy as np
from algorithms import register

# 肺叶名称映射
LOBE_NAMES = {
    1: "左上叶(LL)",
    2: "左下叶(LU)",
    3: "右上叶(RU)",
    4: "右下叶(RL)",
    5: "右中叶(RM)",
}

LEFT_LUNG_CLASSES = [1, 2]
RIGHT_LUNG_CLASSES = [3, 4, 5]
NUM_CLASSES = 6
MODEL_IMAGE_SIZE = (512, 512)

_model = None
_device = None


def _get_device():
    global _device
    if _device is None:
        import torch
        _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return _device


def _load_model():
    """延迟加载 TransUNet 模型（只加载一次）"""
    global _model

    if _model is not None:
        return _model

    import torch

    # 确定模型目录
    model_dir = os.environ.get("LUNG_MODEL_DIR", "/app/logs_Trans")
    model_path = os.path.join(model_dir, "lung_lobe_model_fp16.pth")

    if not os.path.exists(model_path):
        # 尝试 fp32
        model_path = os.path.join(model_dir, "lung_lobe_model.pth")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"模型权重未找到: {model_path}")

    # 添加 MGANet 路径以导入 nets 模块
    nets_dir = os.environ.get("MGANET_DIR", "/app")
    if nets_dir not in sys.path:
        sys.path.insert(0, nets_dir)

    from nets.TransUNet import TransUNet

    device = _get_device()
    print(f"[lung_lobe_seg] 加载模型: {model_path} (device={device})")

    _model = TransUNet(num_class=NUM_CLASSES).eval()
    state_dict = torch.load(model_path, map_location=device)

    # 处理 DataParallel 包装
    new_state_dict = {}
    for k, v in state_dict.items():
        if k.startswith("module."):
            new_state_dict[k[7:]] = v
        else:
            new_state_dict[k] = v

    model_state = _model.state_dict()
    matched_keys = [k for k in new_state_dict
                    if k in model_state and new_state_dict[k].shape == model_state[k].shape]
    filtered_state = {k: new_state_dict[k] for k in matched_keys}
    _model.load_state_dict(filtered_state, strict=False)
    _model = _model.to(device).eval()

    print(f"[lung_lobe_seg] 模型加载完成, {len(matched_keys)} 个参数匹配")
    return _model


def _read_dicom_sequence(input_dir):
    """读取 DICOM 序列，按 InstanceNumber 排序，返回 slices 和 spacing"""
    import pydicom

    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, f))
    ])

    if not dcm_files:
        raise ValueError("输入目录中没有文件")

    # 排序
    slices_info = []
    for fp in dcm_files:
        try:
            ds = pydicom.dcmread(fp, stop_before_pixels=True)
            instance_number = int(getattr(ds, "InstanceNumber", 0) or 0)
            slices_info.append((fp, instance_number))
        except Exception:
            slices_info.append((fp, 0))

    slices_info.sort(key=lambda x: x[1])

    # 提取 spacing
    spacing = {"pixel_x": 1.0, "pixel_y": 1.0, "slice_thickness": 1.0}
    try:
        ds_first = pydicom.dcmread(slices_info[0][0])
        ps = getattr(ds_first, "PixelSpacing", None)
        if ps:
            spacing["pixel_x"] = float(ps[0])
            spacing["pixel_y"] = float(ps[1])
        st = getattr(ds_first, "SliceThickness", None)
        if st:
            spacing["slice_thickness"] = float(st)
    except Exception:
        pass

    # 推断 slice_thickness
    if spacing["slice_thickness"] == 1.0 and len(slices_info) >= 2:
        try:
            ds1 = pydicom.dcmread(slices_info[0][0])
            ds2 = pydicom.dcmread(slices_info[1][0])
            pos1 = float(getattr(ds1, "SliceLocation",
                                 getattr(ds1, "ImagePositionPatient", [0, 0, 0])[2]))
            pos2 = float(getattr(ds2, "SliceLocation",
                                 getattr(ds2, "ImagePositionPatient", [0, 0, 0])[2]))
            spacing["slice_thickness"] = abs(pos2 - pos1)
        except Exception:
            pass

    # 读取像素数据
    sorted_slices = []
    for fp, _ in slices_info:
        ds = pydicom.dcmread(fp)
        arr = ds.pixel_array.astype(np.float32)
        # HU 转换(之前漏了这步:模型拿到的是原始存储值而非 HU,强度整体偏掉 → 分不出肺 → 体积≈0)
        slope = getattr(ds, "RescaleSlope", 1.0)
        intercept = getattr(ds, "RescaleIntercept", 0.0)
        if slope != 1.0 or intercept != 0.0:
            arr = arr * float(slope) + float(intercept)
        sorted_slices.append(arr)

    print(f"[lung_lobe_seg] 读取 {len(sorted_slices)} 张切片, "
          f"spacing: {spacing['pixel_x']:.3f}x{spacing['pixel_y']:.3f}mm, "
          f"层厚 {spacing['slice_thickness']:.3f}mm")

    return sorted_slices, spacing


def _predict_slice(model, dcm_array, device):
    """对单张 DICOM 切片推理，返回 seg_map (512, 512)"""
    import torch
    import torch.nn.functional as F
    from PIL import Image

    # 预处理: +1024 offset
    image = dcm_array + 1024.0

    # Resize 到 512x512
    image_pil = Image.fromarray(image)
    image_pil = image_pil.resize(MODEL_IMAGE_SIZE, Image.BICUBIC)

    # 归一化 /4095, 扩展为 3 通道
    image_np = np.array(image_pil, dtype=np.float32) / 4095.0
    image_np = np.expand_dims(image_np, axis=0)
    image_np = np.repeat(image_np, 3, axis=0)
    image_tensor = torch.from_numpy(image_np).unsqueeze(0).float().to(device)

    # 推理
    with torch.no_grad():
        output = model(image_tensor)
        output = F.interpolate(output, size=MODEL_IMAGE_SIZE, mode="bilinear", align_corners=False)[0]
        output = F.softmax(output.permute(1, 2, 0), dim=-1).cpu().numpy()
        seg_map = output.argmax(axis=-1).astype(np.uint8)

    return seg_map


def _calculate_volumes(seg_maps, dicom_spacing):
    """计算肺叶体积（mm³ 和 mL）"""
    pixel_area_mm2 = dicom_spacing["pixel_x"] * dicom_spacing["pixel_y"]
    slice_thickness_mm = dicom_spacing["slice_thickness"]
    voxel_volume_mm3 = pixel_area_mm2 * slice_thickness_mm

    lobe_volumes = {i: 0.0 for i in range(1, NUM_CLASSES)}
    per_slice_total = []
    per_slice_left = []
    per_slice_right = []
    per_lobe_per_slice = {i: [] for i in range(1, NUM_CLASSES)}

    for seg_map in seg_maps:
        slice_total_px = 0
        slice_left_px = 0
        slice_right_px = 0
        for c in range(1, NUM_CLASSES):
            px_count = int((seg_map == c).sum())
            vol = px_count * voxel_volume_mm3
            per_lobe_per_slice[c].append(round(vol, 2))
            lobe_volumes[c] += vol
            slice_total_px += px_count
            if c in LEFT_LUNG_CLASSES:
                slice_left_px += px_count
            if c in RIGHT_LUNG_CLASSES:
                slice_right_px += px_count
        per_slice_total.append(round(slice_total_px * voxel_volume_mm3, 2))
        per_slice_left.append(round(slice_left_px * voxel_volume_mm3, 2))
        per_slice_right.append(round(slice_right_px * voxel_volume_mm3, 2))

    left_lung_vol = sum(lobe_volumes[c] for c in LEFT_LUNG_CLASSES)
    right_lung_vol = sum(lobe_volumes[c] for c in RIGHT_LUNG_CLASSES)
    total_vol = left_lung_vol + right_lung_vol

    def to_ml(mm3):
        return round(mm3 / 1000.0, 2)

    lobe_detail = {}
    for c in range(1, NUM_CLASSES):
        name = LOBE_NAMES[c]
        lobe_detail[name] = {
            "class_id": c,
            "volume_mm3": round(lobe_volumes[c], 2),
            "volume_ml": to_ml(lobe_volumes[c]),
        }

    return {
        "spacing": {
            "pixel_x_mm": round(dicom_spacing["pixel_x"], 4),
            "pixel_y_mm": round(dicom_spacing["pixel_y"], 4),
            "slice_thickness_mm": round(dicom_spacing["slice_thickness"], 4),
        },
        "lobes": lobe_detail,
        "left_lung_ml": to_ml(left_lung_vol),
        "right_lung_ml": to_ml(right_lung_vol),
        "total_ml": to_ml(total_vol),
        "per_slice_ml": {
            "total": [round(v / 1000.0, 3) for v in per_slice_total],
            "left": [round(v / 1000.0, 3) for v in per_slice_left],
            "right": [round(v / 1000.0, 3) for v in per_slice_right],
        },
        "num_slices": len(seg_maps),
    }


def lung_lobe_segmentation(input_dir: str, output_path: str, params: dict) -> dict:
    """
    肺叶分割 + 体积统计算法

    参数:
        input_dir: 包含 DICOM 文件的目录
        output_path: 输出 NIfTI 文件路径
        params: 额外参数（可选）

    返回:
        dict: 包含 labels, shape, volume_stats
    """
    import nibabel as nib

    # 1. 加载模型
    model = _load_model()
    device = _get_device()

    # 2. 读取 DICOM 序列
    slices, spacing = _read_dicom_sequence(input_dir)
    total = len(slices)

    # 3. 逐片推理
    seg_maps = []
    for i, slc in enumerate(slices):
        seg_map = _predict_slice(model, slc, device)
        seg_maps.append(seg_map)
        if (i + 1) % 50 == 0 or i == total - 1:
            print(f"[lung_lobe_seg] 推理进度: {i + 1}/{total}")

    # 4. 构建 3D labelmap
    # seg_maps 是 512x512，但原始切片可能有不同尺寸
    # 取第一张切片尺寸作为输出尺寸
    orig_shape = slices[0].shape
    labelmap_3d = np.zeros((total, MODEL_IMAGE_SIZE[0], MODEL_IMAGE_SIZE[1]), dtype=np.uint8)
    for i, sm in enumerate(seg_maps):
        labelmap_3d[i] = sm

    # 5. 计算体积
    volume_stats = _calculate_volumes(seg_maps, spacing)
    print(f"[lung_lobe_seg] 左肺: {volume_stats['left_lung_ml']} mL, "
          f"右肺: {volume_stats['right_lung_ml']} mL, "
          f"总计: {volume_stats['total_ml']} mL")

    # 6. 保存 NIfTI
    affine = np.eye(4)
    try:
        import pydicom
        dcm_files = sorted([os.path.join(input_dir, f) for f in os.listdir(input_dir)
                           if os.path.isfile(os.path.join(input_dir, f))])
        if dcm_files:
            ds = pydicom.dcmread(dcm_files[0])
            ps = getattr(ds, "PixelSpacing", None)
            st = getattr(ds, "SliceThickness", None)
            if ps:
                affine[0, 0] = float(ps[1])
                affine[1, 1] = float(ps[0])
            if st:
                affine[2, 2] = float(st)
    except Exception:
        pass

    nii = nib.Nifti1Image(labelmap_3d, affine)
    nib.save(nii, output_path)
    print(f"[lung_lobe_seg] NIfTI 保存到: {output_path}")

    # 7. 返回 metadata
    labels = {str(k): v for k, v in LOBE_NAMES.items()}
    shape = list(labelmap_3d.shape)  # [slices, 512, 512]

    return {
        "labels": labels,
        "shape": shape,
        "volume_stats": volume_stats,
    }


# 注册算法
register(
    "lung-lobe-seg",
    "肺叶分割 TransUNet",
    "基于 TransUNet 的肺叶分割（5 叶）+ 体积统计。"
    "输出：左上叶(LL)、左下叶(LU)、右上叶(RU)、右下叶(RL)、右中叶(RM)",
    lung_lobe_segmentation,
)
