"""Nodule Sphere Analyzer wrapper — 输出多 segment labelmap。

按 nodule-sphere-ohif-display-plan.md 方案,生成和 CT 同尺寸的 uint8 labelmap:
  1 = 结节本体 mask(原始 RTSTRUCT/NIfTI mask)
  2 = 实性成分(mask 内 CT >= 阈值)
  3 = 内切球球壳
  4 = 外接球球壳
保存 NIfTI 到 output_path,前端用 segmentationService 渲染(2D 圆环/区域、3D 球面)。

契约同 lung_seg:(input_dir, output_path, params) -> dict。固定 circumscribed_mode="exact"。
"""
import numpy as np
import nibabel as nib
import SimpleITK as sitk

from algorithms.nodule_sphere_algorithm import (
    analyze_nodule_spheres, _load_ct, _is_rtstruct, _load_mask_from_rtstruct,
)
from algorithms import register

SEG_NODULE = 1          # 结节本体 mask
SEG_SOLID = 2           # 实性成分
SEG_INSCRIBED = 3       # 内切球壳
SEG_CIRCUMSCRIBED = 4   # 外接球壳


def _draw_sphere_shell(labelmap_zyx, ct_image, center_mm, radius_mm, value, shell_thickness_mm):
    """在 labelmap(numpy, ZYX)画球壳:物理距球心 ≈ radius(±thickness/2)的体素。"""
    size = ct_image.GetSize()        # (x, y, z)
    spacing = ct_image.GetSpacing()  # (x, y, z) mm
    cidx = ct_image.TransformPhysicalPointToIndex(center_mm)  # (x, y, z)
    half = shell_thickness_mm / 2.0
    rvox = [int(np.ceil((radius_mm + half) / spacing[i])) + 1 for i in range(3)]

    z0, z1 = max(0, cidx[2] - rvox[2]), min(size[2], cidx[2] + rvox[2] + 1)
    y0, y1 = max(0, cidx[1] - rvox[1]), min(size[1], cidx[1] + rvox[1] + 1)
    x0, x1 = max(0, cidx[0] - rvox[0]), min(size[0], cidx[0] + rvox[0] + 1)
    if z1 <= z0 or y1 <= y0 or x1 <= x0:
        return

    zz, yy, xx = np.meshgrid(
        np.arange(z0, z1), np.arange(y0, y1), np.arange(x0, x1), indexing='ij'
    )
    dx = (xx - cidx[0]) * spacing[0]
    dy = (yy - cidx[1]) * spacing[1]
    dz = (zz - cidx[2]) * spacing[2]
    dist = np.sqrt(dx * dx + dy * dy + dz * dz)
    shell = np.abs(dist - radius_mm) <= half
    labelmap_zyx[z0:z1, y0:y1, x0:x1][shell] = value


def _load_mask_array(mask_path, ct_image, ct_path, roi_name):
    """读取 mask(RTSTRUCT 栅格化 或 NIfTI),返回和 CT 同 geometry 的 bool numpy(ZYX)。"""
    if _is_rtstruct(mask_path):
        mask_sitk = _load_mask_from_rtstruct(mask_path, ct_image, ct_path=ct_path, roi_name=roi_name)
    else:
        mask_sitk = sitk.ReadImage(mask_path)
    return sitk.GetArrayFromImage(mask_sitk).astype(bool)


def nodule_sphere_algo(input_dir: str, output_path: str, params: dict) -> dict:
    mask_path = params.get("mask_path")
    if not mask_path:
        raise ValueError("mask_path is required (main.py should have resolved RTSTRUCT)")

    threshold = float(params.get("threshold", -160))
    roi_name = params.get("roi_name", "GTV-1")

    # 1. 算测量数据(固定 exact)
    results, err = analyze_nodule_spheres(
        mask_path=mask_path,
        ct_path=input_dir,
        circumscribed_mode="exact",
        solid_threshold_hu=threshold,
        roi_name=roi_name,
    )
    if err:
        raise RuntimeError(err)

    # 2. 读 CT + mask
    ct_image = _load_ct(input_dir)
    ct_array = sitk.GetArrayFromImage(ct_image)                          # (Z,Y,X),HU
    mask_array = _load_mask_array(mask_path, ct_image, input_dir, roi_name)  # bool (Z,Y,X)

    # 3. 生成 4 段 labelmap
    labelmap = np.zeros(ct_array.shape, dtype=np.uint8)
    labelmap[mask_array] = SEG_NODULE                                  # 1 结节本体
    labelmap[mask_array & (ct_array >= threshold)] = SEG_SOLID         # 2 实性成分(覆盖1)

    # 球壳厚度:足够厚让 surface mesh 连续光滑(3D 不模糊),2D 圆环稍粗
    spacing = ct_image.GetSpacing()
    shell_thickness = max(min(spacing) * 2.5, 2.5)

    # 写入顺序:外接壳(4)先,内切壳(3)后(内切更关键,最后写优先可见)
    for nd in results:
        _draw_sphere_shell(
            labelmap, ct_image,
            (nd["circumscribed_center_x_mm"], nd["circumscribed_center_y_mm"], nd["circumscribed_center_z_mm"]),
            nd["circumscribed_diameter_mm"] / 2.0,
            SEG_CIRCUMSCRIBED, shell_thickness,
        )
    for nd in results:
        _draw_sphere_shell(
            labelmap, ct_image,
            (nd["inscribed_center_x_mm"], nd["inscribed_center_y_mm"], nd["inscribed_center_z_mm"]),
            nd["inscribed_diameter_mm"] / 2.0,
            SEG_INSCRIBED, shell_thickness,
        )

    # 4. 保存 NIfTI(result 端点只读 data.tobytes,affine 用 spacing 对角即可)
    affine = np.eye(4)
    affine[0, 0], affine[1, 1], affine[2, 2] = spacing[0], spacing[1], spacing[2]
    nib.save(nib.Nifti1Image(labelmap, affine), output_path)

    return {
        "labels": {
            str(SEG_NODULE): "Nodule Mask",
            str(SEG_SOLID): "Solid Component",
            str(SEG_INSCRIBED): "Inscribed Sphere",
            str(SEG_CIRCUMSCRIBED): "Circumscribed Sphere",
        },
        "shape": list(labelmap.shape),
        "nodules": results,
        "nodule_count": len(results),
    }


register(
    "nodule-sphere",
    "Nodule Sphere Analyzer",
    "Nodule/solid/inscribed/circumscribed (RTSTRUCT auto, multi-segment labelmap)",
    nodule_sphere_algo,
)
