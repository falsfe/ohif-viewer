#!/usr/bin/env python3
"""Nodule Sphere Analyzer — standalone algorithm (zero GUI dependencies).

Drop this single file into your backend and call::

    from nodule_sphere_algorithm import analyze_nodule_spheres

    results, err = analyze_nodule_spheres(
        mask_path="/path/to/mask.nii.gz",     # NIfTI (.nii/.nii.gz) or RTSTRUCT (.dcm)
        ct_path="/path/to/ct",                # DICOM directory or .nii/.nii.gz
        circumscribed_mode="approx",          # "approx" | "exact"
        solid_threshold_hu=-160,
        roi_name="GTV-1",                     # RTSTRUCT ROI name (ignored for NIfTI)
        progress_callback=print,              # optional
    )
    # results is a list of dicts; err is None on success, error string on failure

Supported mask formats:
    - NIfTI:  .nii / .nii.gz  (binary mask, foreground = non-zero voxels)
    - DICOM RTSTRUCT:  .dcm  (contours rasterized to match CT geometry)

Dependencies (add to requirements.txt):
    numpy>=1.24, scipy>=1.10, SimpleITK>=2.3, pydicom>=2.4
"""

from __future__ import annotations

import os
import glob
from dataclasses import dataclass
from collections.abc import Callable

import numpy as np
import SimpleITK as sitk
from scipy import ndimage

# ── types ──────────────────────────────────────────────────────────────────

Point3D = tuple[float, float, float]
ProgressCallback = Callable[[str], None] | None


@dataclass(frozen=True)
class NoduleResult:
    """Per-nodule measurement result (all units in mm / mm^3)."""
    nodule_id: int
    voxel_count: int
    volume_mm3: float
    inscribed_diameter_mm: float
    circumscribed_diameter_mm: float
    inscribed_center_mm: Point3D
    circumscribed_center_mm: Point3D
    solid_voxel_count: int = 0
    solid_volume_mm3: float = 0.0
    solid_volume_ratio: float = 0.0
    solid_threshold_hu: float = -160.0

    def to_dict(self) -> dict:
        return {
            "nodule_id": self.nodule_id,
            "voxel_count": self.voxel_count,
            "volume_mm3": self.volume_mm3,
            "inscribed_diameter_mm": self.inscribed_diameter_mm,
            "circumscribed_diameter_mm": self.circumscribed_diameter_mm,
            "inscribed_center_x_mm": self.inscribed_center_mm[0],
            "inscribed_center_y_mm": self.inscribed_center_mm[1],
            "inscribed_center_z_mm": self.inscribed_center_mm[2],
            "circumscribed_center_x_mm": self.circumscribed_center_mm[0],
            "circumscribed_center_y_mm": self.circumscribed_center_mm[1],
            "circumscribed_center_z_mm": self.circumscribed_center_mm[2],
            "solid_voxel_count": self.solid_voxel_count,
            "solid_volume_mm3": self.solid_volume_mm3,
            "solid_volume_ratio": self.solid_volume_ratio,
            "solid_threshold_hu": self.solid_threshold_hu,
        }


# ── geometry ───────────────────────────────────────────────────────────────

def _minimum_enclosing_sphere(points: np.ndarray) -> tuple[np.ndarray, float]:
    """Welzl-style minimum enclosing sphere in 3D.  *points* shape (n, 3)."""
    points = np.asarray(points, dtype=float)
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError("points must be (n, 3)")
    if len(points) == 0:
        raise ValueError("at least one point required")

    unique = np.unique(points, axis=0)
    order = np.lexsort((unique[:, 2], unique[:, 1], unique[:, 0]))
    shuffled = unique[order]

    center, radius = shuffled[0].copy(), 0.0
    for i, pi in enumerate(shuffled):
        if _inside(pi, center, radius):
            continue
        center, radius = pi.copy(), 0.0
        for j in range(i):
            pj = shuffled[j]
            if _inside(pj, center, radius):
                continue
            center, radius = _sphere_from_2(pi, pj)
            for k in range(j):
                pk = shuffled[k]
                if _inside(pk, center, radius):
                    continue
                center, radius = _sphere_from_3pts(pi, pj, pk)
                for m in range(k):
                    pm = shuffled[m]
                    if _inside(pm, center, radius):
                        continue
                    center, radius = _sphere_from_4pts(pi, pj, pk, pm)
    return center, float(radius)


def _inside(point, center, radius, tol=1e-8):
    return bool(np.linalg.norm(point - center) <= radius + tol)


def _sphere_from_2(p1, p2):
    c = (p1 + p2) / 2.0
    return c, float(np.linalg.norm(p1 - c))


def _sphere_from_3pts(a, b, c):
    normal = np.cross(b - a, c - a)
    if np.linalg.norm(normal) < 1e-10:
        return None
    m = np.vstack([2.0 * (b - a), 2.0 * (c - a), normal])
    rhs = np.array([np.dot(b, b) - np.dot(a, a),
                    np.dot(c, c) - np.dot(a, a),
                    np.dot(normal, a)])
    try:
        center = np.linalg.solve(m, rhs)
    except np.linalg.LinAlgError:
        return None
    return center, float(np.linalg.norm(center - a))


def _sphere_from_4pts(a, b, c, d):
    pts = np.array([a, b, c, d])
    m = 2.0 * (pts[1:] - a)
    rhs = np.array([np.dot(p, p) - np.dot(a, a) for p in pts[1:]])
    try:
        center = np.linalg.solve(m, rhs)
    except np.linalg.LinAlgError:
        return None
    return center, float(np.linalg.norm(center - a))


def _all_inside(points, center, radius, tol=1e-7):
    return bool(np.all(np.linalg.norm(points - center, axis=1) <= radius + tol))


# ── image loading ──────────────────────────────────────────────────────────

_GEOMETRY_TOLERANCE = 1e-5


def _is_nifti(path: str) -> bool:
    name = os.path.basename(path).lower()
    return name.endswith(".nii") or name.endswith(".nii.gz")


def _is_dcm(path: str) -> bool:
    name = os.path.basename(path).lower()
    return name.endswith(".dcm") or name.endswith(".dicom")


def _is_rtstruct(path: str) -> bool:
    """Heuristic: a .dcm file whose parent directory name suggests RTSTRUCT."""
    if not _is_dcm(path):
        return False
    parent = os.path.basename(os.path.dirname(path)).upper()
    return "RTSTRUCT" in parent or "RS" in parent


def _load_ct(path: str) -> sitk.Image:
    """Load CT from DICOM directory or NIfTI file."""
    if os.path.isdir(path):
        return _load_dicom_series(path)
    if not os.path.exists(path):
        raise FileNotFoundError(f"CT path does not exist: {path}")
    if _is_nifti(path):
        return sitk.ReadImage(path)
    raise ValueError(f"CT must be a DICOM directory or NIfTI file, got: {path}")


def _load_dicom_series(directory: str) -> sitk.Image:
    reader = sitk.ImageSeriesReader()
    series_ids = reader.GetGDCMSeriesIDs(directory)
    if not series_ids:
        raise ValueError(f"No DICOM series found in: {directory}")
    files = reader.GetGDCMSeriesFileNames(directory, series_ids[0])
    if not files:
        raise ValueError(f"No DICOM files found in: {directory}")
    reader.SetFileNames(files)
    return reader.Execute()


def _load_mask_from_rtstruct(
    rtstruct_path: str,
    ct_image: sitk.Image,
    ct_path: str | None = None,
    roi_name: str = "GTV-1",
) -> sitk.Image:
    """Rasterize an RTSTRUCT contour into a mask matching CT geometry."""
    try:
        import pydicom
    except ImportError as exc:
        raise ImportError(
            f"pydicom is required to read RTSTRUCT files.\n"
            f"  Run: pip install pydicom\n"
            f"  Detail: {exc}"
        )

    ds = pydicom.dcmread(rtstruct_path)
    if getattr(ds, "Modality", "") != "RTSTRUCT":
        raise ValueError(f"Expected RTSTRUCT modality, got: {getattr(ds, 'Modality', '?')}")

    # find ROI by name
    roi_number = None
    for s in ds.StructureSetROISequence:
        if s.ROIName == roi_name:
            roi_number = s.ROINumber
            break
    if roi_number is None:
        available = [s.ROIName for s in ds.StructureSetROISequence]
        raise ValueError(f"ROI '{roi_name}' not found. Available: {available}")

    # build SOP → slice Z mapping
    sop_to_z: dict[str, float] = {}
    ct_dir = ct_path if (ct_path and os.path.isdir(ct_path)) else None
    if ct_dir:
        for f in glob.glob(os.path.join(ct_dir, "*.dcm")):
            try:
                d = pydicom.dcmread(f, stop_before_pixels=True)
                sop_to_z[d.SOPInstanceUID] = float(d.ImagePositionPatient[2])
            except Exception:
                pass

    ct_array = sitk.GetArrayFromImage(ct_image)
    mask = np.zeros(ct_array.shape, dtype=np.uint8)
    sx, sy, sz = ct_image.GetSpacing()
    ox, oy, oz = ct_image.GetOrigin()

    from matplotlib.path import Path as MplPath

    for roi_contour in ds.ROIContourSequence:
        if roi_contour.ReferencedROINumber != roi_number:
            continue
        for contour in roi_contour.ContourSequence:
            ref_sop = contour.ContourImageSequence[0].ReferencedSOPInstanceUID
            z_phys = sop_to_z.get(ref_sop)
            if z_phys is None:
                continue
            z_idx = int(round((z_phys - oz) / sz))
            if z_idx < 0 or z_idx >= mask.shape[0]:
                continue

            pts_mm = np.array(contour.ContourData).reshape(-1, 3)
            if len(pts_mm) < 3:
                continue

            px = ((pts_mm[:, 0] - ox) / sx).astype(int)
            py = ((pts_mm[:, 1] - oy) / sy).astype(int)
            points_2d = np.column_stack([px, py])

            min_x, max_x = max(0, px.min()), min(mask.shape[2] - 1, px.max())
            min_y, max_y = max(0, py.min()), min(mask.shape[1] - 1, py.max())
            if max_x <= min_x or max_y <= min_y:
                continue

            xx, yy = np.meshgrid(np.arange(min_x, max_x + 1), np.arange(min_y, max_y + 1))
            grid_pts = np.column_stack([xx.ravel(), yy.ravel()])
            inside = MplPath(points_2d).contains_points(grid_pts).reshape(xx.shape)
            mask[z_idx, min_y:max_y + 1, min_x:max_x + 1] |= inside.astype(np.uint8)

    if not np.any(mask):
        raise ValueError(f"RTSTRUCT rasterization produced empty mask for '{roi_name}'")

    mask_image = sitk.GetImageFromArray(mask)
    mask_image.CopyInformation(ct_image)
    return mask_image


def _validate_matching_geometry(ct: sitk.Image, mask: sitk.Image) -> None:
    if ct.GetSize() != mask.GetSize():
        raise ValueError(f"CT/mask size mismatch: {ct.GetSize()} != {mask.GetSize()}")
    for name, left, right in [("spacing", ct.GetSpacing(), mask.GetSpacing()),
                               ("origin", ct.GetOrigin(), mask.GetOrigin()),
                               ("direction", ct.GetDirection(), mask.GetDirection())]:
        if len(left) != len(right):
            raise ValueError(f"CT/mask {name} length mismatch")
        for lv, rv in zip(left, right):
            if abs(float(lv) - float(rv)) > _GEOMETRY_TOLERANCE:
                raise ValueError(f"CT/mask {name} mismatch: {left} != {right}")


# ── main algorithm ─────────────────────────────────────────────────────────

def analyze_nodule_spheres(
    mask_path: str,
    ct_path: str | None = None,
    circumscribed_mode: str = "approx",
    solid_threshold_hu: float = -160.0,
    roi_name: str = "GTV-1",
    progress_callback: ProgressCallback = None,
):
    """Analyze pulmonary nodules from CT + mask.

    Args:
        mask_path: NIfTI (.nii/.nii.gz) or DICOM RTSTRUCT (.dcm).
        ct_path:   DICOM directory or NIfTI (.nii/.nii.gz). Optional.
        circumscribed_mode: "approx" (fast) or "exact" (precise, may be slow).
        solid_threshold_hu: HU threshold for solid component counting.
        roi_name:  RTSTRUCT ROI name to extract (default "GTV-1").
                   Ignored when *mask_path* is NIfTI.
        progress_callback:  Optional callable(str) for progress messages.

    Returns:
        (list[dict], error_message) — if error_message is not None the
        input is invalid and the list is empty.
    """
    if circumscribed_mode not in ("approx", "exact"):
        return [], f"circumscribed_mode must be 'approx' or 'exact', got {circumscribed_mode!r}"

    # ── load CT ─────────────────────────────────────────────
    ct_image = None
    ct_array = None
    if ct_path is not None:
        try:
            ct_image = _load_ct(ct_path)
            ct_array = sitk.GetArrayFromImage(ct_image)
        except Exception as exc:
            return [], f"CT load error: {exc}"

    # ── load mask (NIfTI or RTSTRUCT) ───────────────────────
    if _is_rtstruct(mask_path):
        if ct_image is None:
            return [], "RTSTRUCT mask requires CT for geometry reference"
        try:
            _report(progress_callback, "Rasterizing RTSTRUCT contours")
            mask = _load_mask_from_rtstruct(
                mask_path, ct_image, ct_path=ct_path, roi_name=roi_name)
        except Exception as exc:
            return [], f"RTSTRUCT error: {exc}"
    else:
        try:
            mask = sitk.ReadImage(mask_path)
        except Exception as exc:
            return [], f"Mask load error: {exc}"
        if ct_image is not None:
            try:
                _validate_matching_geometry(ct_image, mask)
            except Exception as exc:
                return [], f"Geometry mismatch: {exc}"

    mask_array = sitk.GetArrayFromImage(mask).astype(bool)
    if not np.any(mask_array):
        return [], "mask contains no non-zero region"

    results = _analyze(
        mask, mask_array, ct_image, ct_array,
        circumscribed_mode, solid_threshold_hu, progress_callback,
    )
    return [r.to_dict() for r in results], None


def _report(cb, msg):
    if cb:
        cb(msg)


def _analyze(mask_image, mask, ct_image, ct_array,
             circumscribed_mode, solid_threshold_hu, progress_callback):
    _report(progress_callback, "Labeling connected components")
    structure = np.ones((3, 3, 3), dtype=bool)
    labels, component_count = ndimage.label(mask, structure=structure)
    if component_count == 0:
        raise ValueError("mask contains no non-zero nodule region")

    spacing_xyz = tuple(float(v) for v in mask_image.GetSpacing())
    voxel_volume = spacing_xyz[0] * spacing_xyz[1] * spacing_xyz[2]
    sampling_zyx = (spacing_xyz[2], spacing_xyz[1], spacing_xyz[0])
    component_slices = ndimage.find_objects(labels)

    results: list[NoduleResult] = []
    _label_info: list[tuple[int, int]] = []

    for label_id in range(1, component_count + 1):
        _report(progress_callback, f"Processing nodule {label_id}/{component_count}")
        comp_slice = component_slices[label_id - 1]
        if comp_slice is None:
            continue

        cropped_labels = labels[comp_slice]
        component_mask = cropped_labels == label_id
        offset_zyx = tuple(item.start for item in comp_slice)

        voxel_count = int(np.count_nonzero(component_mask))
        _label_info.append((label_id, voxel_count))

        solid_voxel_count = 0
        if ct_array is not None:
            cropped_ct = ct_array[comp_slice]
            solid_voxel_count = int(np.count_nonzero(
                cropped_ct[component_mask] >= solid_threshold_hu))

        solid_volume_mm3 = float(solid_voxel_count * voxel_volume)
        total_volume_mm3 = float(voxel_count * voxel_volume)

        _report(progress_callback, f"Computing inscribed sphere {label_id}/{component_count}")
        padded = np.pad(component_mask, 1, constant_values=False)
        distance_map = ndimage.distance_transform_edt(padded, sampling=sampling_zyx)
        max_idx_padded = np.unravel_index(int(np.argmax(distance_map)), distance_map.shape)
        max_idx = tuple(idx - 1 for idx in max_idx_padded)
        full_idx = tuple(off + idx for off, idx in zip(offset_zyx, max_idx))
        inscribed_radius = float(distance_map[max_idx_padded])
        inscribed_center = _index_to_physical(mask_image, full_idx)

        _report(progress_callback, f"Computing circumscribed sphere {label_id}/{component_count}")
        circ_center, circ_radius = _circumscribed_sphere(
            mask_image, component_mask, circumscribed_mode, offset_zyx)

        results.append(NoduleResult(
            nodule_id=label_id,
            voxel_count=voxel_count,
            volume_mm3=total_volume_mm3,
            inscribed_diameter_mm=2.0 * inscribed_radius,
            circumscribed_diameter_mm=2.0 * circ_radius,
            inscribed_center_mm=tuple(float(v) for v in inscribed_center),
            circumscribed_center_mm=tuple(float(v) for v in circ_center),
            solid_voxel_count=solid_voxel_count,
            solid_volume_mm3=solid_volume_mm3,
            solid_volume_ratio=solid_volume_mm3 / total_volume_mm3 if total_volume_mm3 > 0 else 0.0,
            solid_threshold_hu=float(solid_threshold_hu),
        ))

    results.sort(key=lambda r: r.volume_mm3, reverse=True)
    _label_info.sort(key=lambda x: x[1], reverse=True)

    return [
        NoduleResult(
            nodule_id=idx,
            voxel_count=r.voxel_count,
            volume_mm3=r.volume_mm3,
            inscribed_diameter_mm=r.inscribed_diameter_mm,
            circumscribed_diameter_mm=r.circumscribed_diameter_mm,
            inscribed_center_mm=r.inscribed_center_mm,
            circumscribed_center_mm=r.circumscribed_center_mm,
            solid_voxel_count=r.solid_voxel_count,
            solid_volume_mm3=r.solid_volume_mm3,
            solid_volume_ratio=r.solid_volume_ratio,
            solid_threshold_hu=r.solid_threshold_hu,
        )
        for idx, r in enumerate(results, start=1)
    ]


def _circumscribed_sphere(image, component_mask, mode, offset_zyx):
    if mode == "approx":
        return _bounding_box_sphere(image, component_mask, offset_zyx)
    surface_pts = _component_surface_points(component_mask)
    physical_pts = _indices_to_physical(image, surface_pts, offset_zyx)
    return _minimum_enclosing_sphere(physical_pts)


def _bounding_box_sphere(image, component_mask, offset_zyx):
    indices = np.argwhere(component_mask)
    mmin = indices.min(axis=0)
    mmax = indices.max(axis=0)
    corners = np.array([[z, y, x]
                        for z in (mmin[0], mmax[0])
                        for y in (mmin[1], mmax[1])
                        for x in (mmin[2], mmax[2])])
    physical = _indices_to_physical(image, corners, offset_zyx)
    c = (physical.min(axis=0) + physical.max(axis=0)) / 2.0
    r = float(np.linalg.norm(physical.max(axis=0) - physical.min(axis=0)) / 2.0)
    return c, r


def _component_surface_points(component_mask):
    structure = np.ones((3, 3, 3), dtype=bool)
    eroded = ndimage.binary_erosion(component_mask, structure=structure, border_value=0)
    return np.argwhere(component_mask & ~eroded)


def _indices_to_physical(image, indices_zyx, offset_zyx=(0, 0, 0)):
    pts = np.empty((len(indices_zyx), 3), dtype=float)
    for row, (zi, yi, xi) in enumerate(indices_zyx):
        pts[row] = image.TransformIndexToPhysicalPoint(
            (int(xi) + offset_zyx[2], int(yi) + offset_zyx[1], int(zi) + offset_zyx[0]))
    return pts


def _index_to_physical(image, index_zyx):
    zi, yi, xi = index_zyx
    return image.TransformIndexToPhysicalPoint((int(xi), int(yi), int(zi)))


# ── CLI ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys, json

    if len(sys.argv) < 2:
        print("Usage: python nodule_sphere_algorithm.py <mask> [ct] [approx|exact] [-160] [GTV-1]")
        print("  mask: NIfTI (.nii/.nii.gz) or RTSTRUCT (.dcm)")
        print("  ct:   DICOM directory or NIfTI (.nii/.nii.gz)")
        sys.exit(1)

    mask_p = sys.argv[1]
    ct_p = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    mode = sys.argv[3] if len(sys.argv) > 3 else "approx"
    thr = float(sys.argv[4]) if len(sys.argv) > 4 else -160.0
    roi = sys.argv[5] if len(sys.argv) > 5 else "GTV-1"

    results, err = analyze_nodule_spheres(
        mask_p, ct_p, circumscribed_mode=mode, solid_threshold_hu=thr,
        roi_name=roi,
        progress_callback=lambda msg: print(f"[progress] {msg}"),
    )
    if err:
        print(f"ERROR: {err}")
        sys.exit(1)

    print(json.dumps(results, indent=2, ensure_ascii=False))
