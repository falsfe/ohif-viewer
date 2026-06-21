import os
import numpy as np
import nibabel as nib
import pydicom
from scipy import ndimage
from algorithms import register


def lung_global_threshold(input_dir: str, output_path: str, params: dict) -> dict:
    """Global threshold segmentation for lung CT (-600 HU)"""
    threshold = params.get("threshold", -600)

    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, f))
    ])
    if not dcm_files:
        raise ValueError("No DICOM files found")

    slices = []
    ds0 = pydicom.dcmread(dcm_files[0])
    rows, cols = int(ds0.Rows), int(ds0.Columns)

    for f in dcm_files:
        ds = pydicom.dcmread(f)
        pixel = ds.pixel_array.astype(np.int16)
        intercept = float(getattr(ds, 'RescaleIntercept', 0))
        slope = float(getattr(ds, 'RescaleSlope', 1))
        hu = pixel * slope + intercept
        slices.append(hu)

    volume = np.stack(slices, axis=0)  # (Z, Y, X)

    # Global threshold
    mask = (volume < threshold).astype(np.uint8)

    # Connected component analysis: keep largest 2 regions (left + right lung)
    cleaned = _keep_largest_regions(mask)

    # Build affine from DICOM spacing
    affine = np.eye(4)
    try:
        ps = ds0.PixelSpacing
        affine[0, 0] = float(ps[1])
        affine[1, 1] = float(ps[0])
        affine[2, 2] = float(getattr(ds0, 'SliceThickness', 1.0))
    except Exception:
        pass

    nii = nib.Nifti1Image(cleaned, affine)
    nib.save(nii, output_path)

    return {
        "labels": {"1": "lung"},
        "shape": list(cleaned.shape),
    }


def _keep_largest_regions(mask_3d: np.ndarray) -> np.ndarray:
    """Keep the 2 largest connected components (left + right lung)"""
    struct = ndimage.generate_binary_structure(3, 1)
    labeled, num = ndimage.label(mask_3d, structure=struct)
    if num == 0:
        return mask_3d

    sizes = ndimage.sum(mask_3d, labeled, range(1, num + 1))
    keep_n = min(2, len(sizes))
    largest_labels = [1 + i for i in np.argsort(sizes)[-keep_n:] if sizes[i] > 500]

    result = np.isin(labeled, largest_labels).astype(np.uint8)

    # Morphological cleanup
    result = ndimage.binary_closing(result, structure=struct, iterations=2)
    result = ndimage.binary_opening(result, structure=struct, iterations=1)

    return result.astype(np.uint8)


register(
    "lung-global-threshold",
    "Lung Segmentation (Global Threshold)",
    "Global threshold at -600 HU with connected component cleanup",
    lung_global_threshold,
)
