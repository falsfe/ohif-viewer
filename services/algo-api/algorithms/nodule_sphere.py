"""Nodule Sphere Analyzer wrapper — 输出 labelmap(内切球/外接球体素)。

包装层:算完每个结节的内切球/外接球后,生成一个和 CT 同尺寸的 labelmap,
把内切球体素标段 1、外接球体素标段 2,保存 NIfTI 到 output_path。
这样前端用现成的 segmentationService 渲染(2D 每层截面圆、3D 立体球面),
坐标对齐由 segmentationService 保证,不随切片消失。

契约同 lung_seg:(input_dir, output_path, params) -> dict,返回 {labels, shape, ...}。
"""
import numpy as np
import nibabel as nib
import SimpleITK as sitk

from algorithms.nodule_sphere_algorithm import analyze_nodule_spheres, _load_ct
from algorithms import register

SEG_INSCRIBED = 1      # 内切球(蓝)
SEG_CIRCUMSCRIBED = 2  # 外接球(红)


def _fill_sphere(labelmap_zyx: np.ndarray, ct_image: sitk.Image,
                 center_mm, radius_mm: float, value: int) -> None:
    """在 labelmap(numpy, ZYX 顺序)里画一个物理空间的实心球。

    用 CT 的 spacing 把体素差换算成物理距离(各向异性正确,轴对齐近似),
    向量化遍历球的 bounding box,物理距离 ≤ 半径的体素标记为 value。
    """
    size = ct_image.GetSize()        # (x, y, z)
    spacing = ct_image.GetSpacing()  # (x, y, z) mm
    cidx = ct_image.TransformPhysicalPointToIndex(center_mm)  # (x, y, z) 体素
    rvox = [int(np.ceil(radius_mm / spacing[i])) + 1 for i in range(3)]

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
    inside = (dx * dx + dy * dy + dz * dz) <= radius_mm * radius_mm
    sub = labelmap_zyx[z0:z1, y0:y1, x0:x1]
    sub[inside & (sub == 0)] = value  # 不覆盖已标记的体素(先画的段保留)


def nodule_sphere_algo(input_dir: str, output_path: str, params: dict) -> dict:
    mask_path = params.get("mask_path")
    if not mask_path:
        raise ValueError("mask_path is required (main.py should have resolved RTSTRUCT)")

    results, err = analyze_nodule_spheres(
        mask_path=mask_path,
        ct_path=input_dir,                              # CT 在 tmp_dir/<index>.dcm
        circumscribed_mode=params.get("mode", "approx"),
        solid_threshold_hu=float(params.get("threshold", -160)),
        roi_name=params.get("roi_name", "GTV-1"),
    )
    if err:
        raise RuntimeError(err)

    # 生成 labelmap:和 CT 同尺寸,世界坐标画内切/外接球
    ct_image = _load_ct(input_dir)
    ct_array = sitk.GetArrayFromImage(ct_image)      # (Z, Y, X)
    labelmap = np.zeros(ct_array.shape, dtype=np.uint8)

    # 先画所有内切球(段1,实心),再画所有外接球(段2)。
    # _fill_sphere 不覆盖已有段,所以外接只填内切之外的区域(球壳),两个段都可见。
    for nd in results:
        _fill_sphere(
            labelmap, ct_image,
            (nd["inscribed_center_x_mm"], nd["inscribed_center_y_mm"], nd["inscribed_center_z_mm"]),
            nd["inscribed_diameter_mm"] / 2.0,
            SEG_INSCRIBED,
        )
    for nd in results:
        _fill_sphere(
            labelmap, ct_image,
            (nd["circumscribed_center_x_mm"], nd["circumscribed_center_y_mm"], nd["circumscribed_center_z_mm"]),
            nd["circumscribed_diameter_mm"] / 2.0,
            SEG_CIRCUMSCRIBED,
        )

    # 保存 NIfTI(result 端点只读 data.tobytes,affine 用 spacing 对角即可)
    affine = np.eye(4)
    sp = ct_image.GetSpacing()
    affine[0, 0], affine[1, 1], affine[2, 2] = sp[0], sp[1], sp[2]
    nib.save(nib.Nifti1Image(labelmap, affine), output_path)

    return {
        "labels": {
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
    "Inscribed/circumscribed sphere + solid component (RTSTRUCT auto, labelmap output)",
    nodule_sphere_algo,
)
