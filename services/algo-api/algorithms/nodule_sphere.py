"""Nodule Sphere Analyzer wrapper — measurement metadata only (phase 1).

包装层:把单文件算法 `analyze_nodule_spheres` 接入 OHIF algo-api 的
`(input_dir, output_path, params) -> dict` 契约。

- mask 由 main.py 从同 study 自动下载 RTSTRUCT 后注入 params["mask_path"]
- CT 即 input_dir(main.py 下载好的 DICOM 目录)
- 只产出测量数据走 metadata,不写 labelmap(返回 _no_labelmap=True,
  main.py 据此跳过 shutil.move / nib.load 流程)
"""
from algorithms.nodule_sphere_algorithm import analyze_nodule_spheres
from algorithms import register


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

    return {
        "labels": {str(i + 1): f"Nodule {i + 1}" for i in range(len(results))},
        "shape": [0, 0, 0],                            # 无 labelmap,占位
        "nodules": results,
        "nodule_count": len(results),
        "_no_labelmap": True,                          # 触发 main.py 跳过 shutil.move
    }


register(
    "nodule-sphere",
    "Nodule Sphere Analyzer",
    "Inscribed/circumscribed sphere + solid component (RTSTRUCT auto)",
    nodule_sphere_algo,
)
