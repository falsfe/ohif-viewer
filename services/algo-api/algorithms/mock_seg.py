import os
import numpy as np
import nibabel as nib
import pydicom
from algorithms import register


def mock_segmentation(input_dir: str, output_path: str, params: dict) -> dict:
    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir)
        if os.path.isfile(os.path.join(input_dir, f))
    ])

    if not dcm_files:
        raise ValueError("No DICOM files found in input directory")

    ds = pydicom.dcmread(dcm_files[0])
    rows = int(ds.Rows)
    cols = int(ds.Columns)
    slices = len(dcm_files)

    labelmap = np.zeros((slices, rows, cols), dtype=np.uint8)

    center_z, center_y, center_x = slices // 2, rows // 2, cols // 2
    radius = min(rows, cols, slices) // 4

    zz, yy, xx = np.ogrid[
        max(0, center_z - radius):min(slices, center_z + radius),
        max(0, center_y - radius):min(rows, center_y + radius),
        max(0, center_x - radius):min(cols, center_x + radius),
    ]
    mask = ((zz - center_z) ** 2 + (yy - center_y) ** 2 + (xx - center_x) ** 2) < radius ** 2
    labelmap[
        max(0, center_z - radius):min(slices, center_z + radius),
        max(0, center_y - radius):min(rows, center_y + radius),
        max(0, center_x - radius):min(cols, center_x + radius),
    ][mask] = 1

    affine = np.eye(4)
    try:
        pixel_spacing = ds.PixelSpacing
        slice_thickness = float(getattr(ds, 'SliceThickness', 1.0))
        affine[0, 0] = float(pixel_spacing[1])
        affine[1, 1] = float(pixel_spacing[0])
        affine[2, 2] = slice_thickness
    except Exception:
        pass

    nii = nib.Nifti1Image(labelmap, affine)
    nib.save(nii, output_path)

    return {
        "labels": {"1": "mock_region"},
        "shape": [slices, rows, cols],
    }


register("mock-seg", "Mock Segmentation", "Threshold-based mock segmentation for testing", mock_segmentation)
