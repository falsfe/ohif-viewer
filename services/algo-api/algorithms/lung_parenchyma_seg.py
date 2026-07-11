"""
肺实质分割算法 - TransUNet (二分类: 左肺/右肺)

类别: 0=背景, 1=左肺, 2=右肺
基于肺实质/MGANet/logs/ 训练权重
"""

import os
import sys
import numpy as np
from algorithms import register

NUM_CLASSES = 3  # 0: background, 1: left lung, 2: right lung
MODEL_IMAGE_SIZE = (512, 512)

CLASS_NAMES = {1: "Left Lung", 2: "Right Lung"}
VIS_COLORS = [
    [0, 0, 0],        # 0: background
    [255, 0, 0],      # 1: left lung
    [0, 0, 255],      # 2: right lung
]

_model = None
_device = None


def _get_device():
    global _device
    if _device is None:
        import torch
        _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return _device


def _load_model():
    """延迟加载模型（只加载一次）"""
    global _model

    if _model is not None:
        return _model

    import torch

    model_dir = os.environ.get("PARENCHYMA_MODEL_DIR", "/app/logs_parenchyma")
    model_path = os.path.join(model_dir, "parenchyma_fp16.pth")
    if not os.path.exists(model_path):
        model_path = os.path.join(model_dir, "parenchyma_model.pth")
    if not os.path.exists(model_path):
        # Try full pth file
        import glob
        pths = glob.glob(os.path.join(model_dir, "*.pth"))
        if pths:
            model_path = pths[0]
        else:
            raise FileNotFoundError(f"Model not found in {model_dir}")

    nets_dir = os.environ.get("MGANET_DIR", "/app")
    if nets_dir not in sys.path:
        sys.path.insert(0, nets_dir)

    from nets.TransUNet import TransUNet

    device = _get_device()
    print(f"[parenchyma] Loading model: {model_path} (device={device})")

    _model = TransUNet(num_class=NUM_CLASSES).eval()
    state_dict = torch.load(model_path, map_location=device)

    # Handle DataParallel
    new_state_dict = {}
    for k, v in state_dict.items():
        if k.startswith("module."):
            new_state_dict[k[7:]] = v
        else:
            new_state_dict[k] = v

    # Convert fp16 back to fp32 for inference if needed
    model_state = _model.state_dict()
    matched_keys = []
    filtered_state = {}
    for k in new_state_dict:
        if k in model_state:
            if new_state_dict[k].shape == model_state[k].shape:
                filtered_state[k] = new_state_dict[k].float()
                matched_keys.append(k)

    _model.load_state_dict(filtered_state, strict=False)
    _model = _model.to(device).eval()

    print(f"[parenchyma] Model loaded, {len(matched_keys)} params matched")
    return _model


def _read_dicom_sequence(input_dir):
    """读取 DICOM 序列，按 InstanceNumber 排序"""
    import pydicom

    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, f))
    ])

    if not dcm_files:
        raise ValueError("No DICOM files found")

    slices_info = []
    for fp in dcm_files:
        try:
            ds = pydicom.dcmread(fp, stop_before_pixels=True)
            inum = int(getattr(ds, "InstanceNumber", 0) or 0)
            slices_info.append((fp, inum))
        except Exception:
            slices_info.append((fp, 0))

    slices_info.sort(key=lambda x: x[1])

    # Extract spacing
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

    # Cross-check with first two slices
    if len(slices_info) >= 2:
        try:
            ds_a = pydicom.dcmread(slices_info[0][0])
            ds_b = pydicom.dcmread(slices_info[1][0])
            za = float(getattr(ds_a, "ImagePositionPatient", [0, 0, 0])[2])
            zb = float(getattr(ds_b, "ImagePositionPatient", [0, 0, 0])[2])
            actual = abs(zb - za)
            if 0.1 < actual < 20:
                spacing["slice_thickness"] = actual
        except Exception:
            pass

    # Read pixel data
    sorted_slices = []
    for fp, _ in slices_info:
        ds = pydicom.dcmread(fp)
        arr = ds.pixel_array.astype(np.float32)
        # HU conversion
        slope = getattr(ds, "RescaleSlope", 1.0)
        intercept = getattr(ds, "RescaleIntercept", 0.0)
        if slope != 1.0 or intercept != 0.0:
            arr = arr * float(slope) + float(intercept)
        sorted_slices.append(arr)

    print(f"[parenchyma] Read {len(sorted_slices)} slices, "
          f"spacing: {spacing['pixel_x']:.3f}x{spacing['pixel_y']:.3f}mm, "
          f"thick: {spacing['slice_thickness']:.3f}mm")

    return sorted_slices, spacing


def _predict_slice(model, dcm_array, device):
    """单张切片推理"""
    import torch
    import torch.nn.functional as F
    from PIL import Image

    image = dcm_array + 1024.0
    image_pil = Image.fromarray(image)
    image_pil = image_pil.resize(MODEL_IMAGE_SIZE, Image.BICUBIC)
    image_np = np.array(image_pil, dtype=np.float32) / 4095.0
    image_np = np.expand_dims(image_np, axis=0)
    image_np = np.repeat(image_np, 3, axis=0)
    image_tensor = torch.from_numpy(image_np).unsqueeze(0).float().to(device)

    with torch.no_grad():
        output = model(image_tensor)
        output = F.interpolate(output, size=MODEL_IMAGE_SIZE, mode="bilinear", align_corners=False)[0]
        output = F.softmax(output.permute(1, 2, 0), dim=-1).cpu().numpy()
        seg_map = output.argmax(axis=-1).astype(np.uint8)

    return seg_map


def _calculate_volumes(seg_maps, dicom_spacing):
    """计算左/右肺体积"""
    pixel_area_mm2 = dicom_spacing["pixel_x"] * dicom_spacing["pixel_y"]
    slice_thickness_mm = dicom_spacing["slice_thickness"]
    voxel_volume_mm3 = pixel_area_mm2 * slice_thickness_mm

    left_vol = 0.0
    right_vol = 0.0
    per_slice = []

    for seg_map in seg_maps:
        left_px = int((seg_map == 1).sum())
        right_px = int((seg_map == 2).sum())
        left_vol += left_px * voxel_volume_mm3
        right_vol += right_px * voxel_volume_mm3
        per_slice.append(round((left_px + right_px) * voxel_volume_mm3 / 1000.0, 3))

    def to_ml(mm3):
        return round(mm3 / 1000.0, 2)

    return {
        "spacing": {
            "pixel_x_mm": round(dicom_spacing["pixel_x"], 4),
            "pixel_y_mm": round(dicom_spacing["pixel_y"], 4),
            "slice_thickness_mm": round(dicom_spacing["slice_thickness"], 4),
        },
        "left_lung_ml": to_ml(left_vol),
        "right_lung_ml": to_ml(right_vol),
        "total_ml": to_ml(left_vol + right_vol),
        "per_slice_ml": per_slice,
        "num_slices": len(seg_maps),
    }


def lung_parenchyma_segmentation(input_dir: str, output_path: str, params: dict = None) -> dict:
    """肺实质分割（左肺/右肺二分类）"""
    import nibabel as nib
    import time as _time

    params = params or {}
    progress_cb = params.get("progress_callback", lambda pct, msg: None)

    # 1. Load model
    progress_cb(1, "Loading parenchyma model...")
    model = _load_model()
    progress_cb(5, "Model loaded")
    device = _get_device()

    # 2. Read DICOM
    progress_cb(6, "Reading DICOM...")
    slices, spacing = _read_dicom_sequence(input_dir)
    total = len(slices)
    progress_cb(8, f"Read {total} slices")

    # 3. Inference
    seg_maps = []
    start_time = _time.time()
    for i, slc in enumerate(slices):
        if i > 0:
            elapsed = _time.time() - start_time
            avg = elapsed / i
            eta = avg * (total - i)
            pct = 8 + int((i / total) * 87)
            progress_cb(pct, f"{i}/{total} | avg {avg:.1f}s | eta {eta:.0f}s")

        seg_map = _predict_slice(model, slc, device)
        seg_maps.append(seg_map)

        if (i + 1) % 50 == 0 or i == total - 1:
            elapsed = _time.time() - start_time
            progress_cb(8 + int((i + 1) / total * 87),
                        f"{i + 1}/{total} done | {elapsed:.0f}s")

    # 4. Build 3D labelmap
    labelmap_3d = np.zeros((total, MODEL_IMAGE_SIZE[0], MODEL_IMAGE_SIZE[1]), dtype=np.uint8)
    for i, sm in enumerate(seg_maps):
        labelmap_3d[i] = sm

    # 5. Volume
    progress_cb(95, "Calculating volumes...")
    volume_stats = _calculate_volumes(seg_maps, spacing)
    print(f"[parenchyma] Left: {volume_stats['left_lung_ml']} mL, "
          f"Right: {volume_stats['right_lung_ml']} mL, "
          f"Total: {volume_stats['total_ml']} mL")

    # 6. Save NIfTI
    progress_cb(97, "Saving...")
    affine = np.eye(4)
    try:
        import pydicom
        dcms = sorted([os.path.join(input_dir, f) for f in os.listdir(input_dir)
                      if os.path.isfile(os.path.join(input_dir, f))])
        if dcms:
            ds = pydicom.dcmread(dcms[0])
            ps = getattr(ds, "PixelSpacing", None)
            if ps:
                affine[0, 0] = float(ps[1])
                affine[1, 1] = float(ps[0])
            st = getattr(ds, "SliceThickness", None)
            if st:
                affine[2, 2] = float(st)
    except Exception:
        pass

    nii = nib.Nifti1Image(labelmap_3d, affine)
    nib.save(nii, output_path)

    return {
        "labels": CLASS_NAMES,
        "shape": list(labelmap_3d.shape),
        "volume_stats": volume_stats,
    }


# Register
register(
    "lung-parenchyma-seg",
    "肺实质分割",
    "基于 TransUNet 的肺实质分割（左肺/右肺二分类）+ 体积统计",
    lung_parenchyma_segmentation,
)
