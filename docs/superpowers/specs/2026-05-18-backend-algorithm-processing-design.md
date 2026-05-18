# Backend Algorithm Processing for OHIF Viewer

## Goal

Add a general-purpose algorithm processing framework: user clicks a button in OHIF viewer, backend Python service runs an algorithm on the DICOM data (e.g., segmentation), and results are displayed as a colored overlay on the original images.

## Architecture

```
Browser (localhost:3000)
  │
  ├─ OHIF Viewer
  │    ├─ Toolbar "Algorithm" button → opens algorithm panel (right sidebar)
  │    ├─ Panel: select algorithm → run → progress → display result
  │    └─ SegmentationService: renders NIfTI labelmap as colored overlay
  │
  ├─ POST /api/algo/run { algorithmId, studyInstanceUID }
  │    → Python reads DICOM from Orthanc → runs algorithm → returns NIfTI
  │
  ├─ auth-api (Node.js, :4001) — existing, unchanged
  ├─ algo-api (Python FastAPI, :8000) — new
  └─ Orthanc (:8042) — existing, DICOM storage
```

## Python Algorithm Service (algo-api)

**Stack**: FastAPI, uvicorn, pydicom, nibabel, numpy

**API endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/algo/algorithms | List available algorithms |
| POST | /api/algo/run | Run an algorithm (async) |
| GET | /api/algo/tasks/:taskId | Poll task status/progress |
| GET | /api/algo/result/:taskId | Download NIfTI result |

**POST /api/algo/run**:
- Request: `{ algorithmId: string, studyInstanceUID: string, seriesInstanceUID?: string }`
- Response: `{ taskId: string }`

**GET /api/algo/tasks/:taskId**:
- Response: `{ status: "pending"|"running"|"success"|"failed", progress?: number, resultUrl?: string }`

**Internal flow**:
1. Receive run request → create async task (background thread)
2. Query Orthanc REST API for series/instances in the study
3. Download DICOM instances to temp directory
4. Call registered algorithm function: `(input_dir, output_path, params) → metadata`
5. Return NIfTI labelmap file on result request

**Algorithm registration interface**:
```python
def algorithm_fn(input_dir: str, output_path: str, params: dict) -> dict:
    """
    input_dir: directory containing DICOM files
    output_path: path to write NIfTI labelmap (.nii.gz)
    params: algorithm-specific parameters
    returns: metadata dict, e.g. { "labels": {"1": "lung_left", "2": "lung_right"} }
    """
    pass
```

**Project structure**:
```
services/algo-api/
├── main.py              FastAPI app, routes
├── algorithms/
│   ├── __init__.py      registry: { id → algorithm_fn }
│   └── mock_seg.py      mock segmentation for testing
└── requirements.txt
```

**Mock algorithm**: generates a simple labelmap (e.g., threshold-based or random regions) to validate the full pipeline without real AI models.

## Frontend Integration

**Components**:
1. Toolbar button "Algorithm" in viewer
2. Right sidebar panel with algorithm list, run button, progress bar
3. Result loader: download NIfTI → load via cornerstoneTools → display via SegmentationService

**Flow**:
1. User clicks "Algorithm" toolbar button → panel opens
2. Panel fetches GET /api/algo/algorithms → shows dropdown
3. User selects algorithm, clicks "Run"
4. Frontend sends POST /api/algo/run with current StudyInstanceUID
5. Poll GET /api/algo/tasks/:taskId every 2s, show progress
6. On success: GET /api/algo/result/:taskId → download NIfTI bytes
7. Parse NIfTI with cornerstoneTools (nifti volume loader) → create labelmap segmentation
8. SegmentationService renders colored overlay on viewport

**Webpack proxy**: add `/api/algo` → `http://localhost:8000` in webpack.pwa.js

**Auth**: algorithm requests carry JWT Bearer token. Initial version skips Python-side verification; can be added later.

## Scope

- In scope: framework, mock algorithm, full pipeline, overlay display
- Out of scope: real AI models, user auth on algo-api, DICOM SEG output, multiple result formats
