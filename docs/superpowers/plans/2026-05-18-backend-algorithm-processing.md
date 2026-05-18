# Backend Algorithm Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend algorithm processing framework where users click a button in OHIF viewer, Python runs an algorithm on DICOM data from Orthanc, and results display as a colored segmentation overlay.

**Architecture:** Python FastAPI service reads DICOM from Orthanc, runs algorithm, returns raw labelmap bytes. Frontend creates a Cornerstone labelmap segmentation and writes the data into it. Webpack proxies `/api/algo` to the Python service.

**Tech Stack:** Python (FastAPI, pydicom, nibabel, numpy), TypeScript/React (OHIF extension), CornerstoneJS SegmentationService

---

## File Structure

```
services/algo-api/                          # NEW - Python algorithm service
├── main.py                                 # FastAPI app, routes, task management
├── algorithms/
│   ├── __init__.py                         # Algorithm registry
│   └── mock_seg.py                         # Mock segmentation algorithm
└── requirements.txt                        # Python dependencies

platform/app/src/routes/Auth/algoApi.ts     # NEW - Frontend API client
platform/app/src/components/                # NEW - Algorithm panel component
  AlgorithmPanel.tsx

platform/app/.webpack/webpack.pwa.js        # MODIFY - Add /api/algo proxy
modes/basic/src/index.tsx                   # MODIFY - Add algorithm button to toolbar
modes/basic/src/toolbarButtons.ts           # MODIFY - Add algorithm toolbar button
```

---

### Task 1: Python algo-api skeleton

**Files:**
- Create: `services/algo-api/main.py`
- Create: `services/algo-api/requirements.txt`
- Create: `services/algo-api/algorithms/__init__.py`
- Create: `services/algo-api/algorithms/mock_seg.py`

- [ ] **Step 1: Create project directory and requirements.txt**

```txt
# services/algo-api/requirements.txt
fastapi==0.115.0
uvicorn==0.30.0
pydicom==2.4.4
nibabel==5.2.0
numpy==1.26.4
requests==2.31.0
```

Run: `mkdir -p services/algo-api/algorithms`

- [ ] **Step 2: Create algorithm registry**

```python
# services/algo-api/algorithms/__init__.py
from typing import Callable, Dict, Any

# Algorithm function signature: (input_dir, output_path, params) -> metadata dict
AlgorithmFn = Callable[[str, str, Dict[str, Any]], Dict[str, Any]]

_registry: Dict[str, Dict[str, Any]] = {}


def register(algorithm_id: str, name: str, description: str, fn: AlgorithmFn):
    _registry[algorithm_id] = {
        "id": algorithm_id,
        "name": name,
        "description": description,
        "fn": fn,
    }


def get(algorithm_id: str):
    return _registry.get(algorithm_id)


def list_all():
    return list(_registry.values())


# Import algorithms to trigger registration
from algorithms import mock_seg  # noqa: E402, F401
```

- [ ] **Step 3: Create mock segmentation algorithm**

```python
# services/algo-api/algorithms/mock_seg.py
import os
import numpy as np
import nibabel as nib
import pydicom
from algorithms import register


def mock_segmentation(input_dir: str, output_path: str, params: dict) -> dict:
    """Mock segmentation: threshold-based to generate a simple labelmap."""
    dcm_files = sorted([
        os.path.join(input_dir, f)
        for f in os.listdir(input_dir) if f.endswith('.dcm') or not '.' in f
    ])

    if not dcm_files:
        raise ValueError("No DICOM files found in input directory")

    # Read first DICOM to get dimensions
    ds = pydicom.dcmread(dcm_files[0])
    rows = int(ds.Rows)
    cols = int(ds.Columns)
    slices = len(dcm_files)

    # Create a simple labelmap with a central region as segment 1
    labelmap = np.zeros((slices, rows, cols), dtype=np.uint8)

    # Create a spherical region in the center as "segment 1"
    center_z, center_y, center_x = slices // 2, rows // 2, cols // 2
    radius = min(rows, cols, slices) // 4

    for z in range(max(0, center_z - radius), min(slices, center_z + radius)):
        for y in range(max(0, center_y - radius), min(rows, center_y + radius)):
            for x in range(max(0, center_x - radius), min(cols, center_x + radius)):
                dist = ((z - center_z) ** 2 + (y - center_y) ** 2 + (x - center_x) ** 2) ** 0.5
                if dist < radius:
                    labelmap[z, y, x] = 1

    # Save as NIfTI
    affine = np.eye(4)
    # Use pixel spacing from DICOM if available
    try:
        pixel_spacing = ds.PixelSpacing
        slice_thickness = float(ds.SliceThickness) if hasattr(ds, 'SliceThickness') else 1.0
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
```

- [ ] **Step 4: Create FastAPI main app**

```python
# services/algo-api/main.py
import os
import uuid
import tempfile
import gzip
import threading
from typing import Dict, Any

import numpy as np
import nibabel as nib
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from algorithms import list_all, get

app = FastAPI(title="Algorithm Processing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://192.168.150.101:8042")

# In-memory task store
tasks: Dict[str, Dict[str, Any]] = {}


class RunRequest(BaseModel):
    algorithmId: str
    studyInstanceUID: str
    seriesInstanceUID: str | None = None


@app.get("/api/algo/algorithms")
def list_algorithms():
    return list_all()


@app.post("/api/algo/run")
def run_algorithm(req: RunRequest):
    algo = get(req.algorithmId)
    if not algo:
        raise HTTPException(status_code=404, detail=f"Algorithm '{req.algorithmId}' not found")

    task_id = str(uuid.uuid4())
    tasks[task_id] = {
        "status": "pending",
        "progress": 0,
        "algorithmId": req.algorithmId,
        "studyInstanceUID": req.studyInstanceUID,
        "seriesInstanceUID": req.seriesInstanceUID,
        "resultPath": None,
        "error": None,
        "metadata": None,
    }

    thread = threading.Thread(
        target=_run_task,
        args=(task_id, algo["fn"], req.studyInstanceUID, req.seriesInstanceUID),
    )
    thread.start()

    return {"taskId": task_id}


@app.get("/api/algo/tasks/{task_id}")
def get_task_status(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    response = {
        "status": task["status"],
        "progress": task["progress"],
    }
    if task["status"] == "success":
        response["metadata"] = task["metadata"]
    if task["status"] == "failed":
        response["error"] = task["error"]
    return response


@app.get("/api/algo/result/{task_id}")
def get_result(task_id: str):
    task = tasks.get(task_id)
    if not task or task["status"] != "success":
        raise HTTPException(status_code=404, detail="Result not available")

    result_path = task["resultPath"]
    if not result_path or not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="Result file not found")

    metadata = task["metadata"] or {}
    shape = metadata.get("shape", [])
    labels = metadata.get("labels", {})

    # Read the NIfTI file and return raw uint8 bytes
    nii = nib.load(result_path)
    data = np.asanyarray(nii.dataobj).astype(np.uint8)
    raw_bytes = gzip.compress(data.tobytes())

    from fastapi.responses import Response
    return Response(
        content=raw_bytes,
        media_type="application/octet-stream",
        headers={
            "X-Labelmap-Shape": str(shape),
            "X-Labelmap-Labels": str(labels).replace("'", '"'),
            "X-Labelmap-Dtype": "uint8",
        },
    )


def _run_task(task_id: str, algo_fn, study_uid: str, series_uid: str | None):
    tmp_dir = None
    try:
        tasks[task_id]["status"] = "running"
        tasks[task_id]["progress"] = 10

        # Step 1: Find series in Orthanc
        series_list = _find_series(study_uid, series_uid)
        if not series_list:
            raise ValueError(f"No series found for study {study_uid}")

        series_id = series_list[0]
        tasks[task_id]["progress"] = 20

        # Step 2: Download DICOM instances
        tmp_dir = tempfile.mkdtemp()
        instances = _get_series_instances(series_id)
        total = len(instances)

        for i, instance_id in enumerate(instances):
            _download_instance(instance_id, tmp_dir, i)
            tasks[task_id]["progress"] = 20 + int(50 * (i + 1) / total)

        tasks[task_id]["progress"] = 75

        # Step 3: Run algorithm
        output_path = os.path.join(tmp_dir, "result.nii.gz")
        metadata = algo_fn(tmp_dir, output_path, {})
        tasks[task_id]["progress"] = 95

        # Store result
        result_dir = tempfile.mkdtemp()
        final_path = os.path.join(result_dir, "result.nii.gz")
        os.rename(output_path, final_path)

        # Clean up input DICOM files to save space
        for f in os.listdir(tmp_dir):
            if f != "result.nii.gz":
                os.remove(os.path.join(tmp_dir, f))

        tasks[task_id]["resultPath"] = final_path
        tasks[task_id]["metadata"] = metadata
        tasks[task_id]["status"] = "success"
        tasks[task_id]["progress"] = 100

    except Exception as e:
        tasks[task_id]["status"] = "failed"
        tasks[task_id]["error"] = str(e)
        if tmp_dir:
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _find_series(study_uid: str, series_uid: str | None) -> list:
    """Find Orthanc series IDs for a study."""
    # Use DICOMweb QIDO to find series
    url = f"{ORTHANC_URL}/dicom-web/series?StudyInstanceUID={study_uid}"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    series_data = resp.json()

    if not series_data:
        return []

    # If specific series requested, filter
    if series_uid:
        for s in series_data:
            if s.get("0020000E", {}).get("Value", [""])[0] == series_uid:
                # Get Orthanc internal ID from the series
                return [_get_orthanc_series_id(study_uid, series_uid)]
        return []

    # Return first series Orthanc ID
    first_series_uid = series_data[0].get("0020000E", {}).get("Value", [""])[0]
    return [_get_orthanc_series_id(study_uid, first_series_uid)]


def _get_orthanc_series_id(study_uid: str, series_uid: str) -> str:
    """Get Orthanc internal series ID using DICOMweb."""
    # Use Orthanc REST API to find by UID
    url = f"{ORTHANC_URL}/tools/find"
    resp = requests.post(url, json={
        "Level": "Series",
        "Query": {
            "StudyInstanceUID": study_uid,
            "SeriesInstanceUID": series_uid,
        }
    }, timeout=30)
    resp.raise_for_status()
    ids = resp.json()
    return ids[0] if ids else ""


def _get_series_instances(series_id: str) -> list:
    """Get list of Orthanc instance IDs for a series."""
    url = f"{ORTHANC_URL}/series/{series_id}/instances"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return [inst["ID"] for inst in resp.json()]


def _download_instance(instance_id: str, output_dir: str, index: int):
    """Download a DICOM instance from Orthanc."""
    url = f"{ORTHANC_URL}/instances/{instance_id}/file"
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    filepath = os.path.join(output_dir, f"{index:06d}.dcm")
    with open(filepath, "wb") as f:
        f.write(resp.content)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

- [ ] **Step 5: Install Python dependencies and test the server starts**

```bash
cd services/algo-api
pip install -r requirements.txt
python main.py
```

Expected: `Uvicorn running on http://0.0.0.0:8000`

- [ ] **Step 6: Test the algorithms endpoint**

Run: `curl http://localhost:8000/api/algo/algorithms`

Expected: `[{"id":"mock-seg","name":"Mock Segmentation","description":"Threshold-based mock segmentation for testing"}]`

- [ ] **Step 7: Commit**

```bash
cd ../../../
git add services/algo-api/
git commit -m "feat(algo-api): add Python algorithm processing service skeleton"
```

---

### Task 2: Webpack proxy for algo-api

**Files:**
- Modify: `platform/app/.webpack/webpack.pwa.js`

- [ ] **Step 1: Add proxy entry**

In `platform/app/.webpack/webpack.pwa.js`, add after the `/api/studies` proxy block (around line 176):

```javascript
        {
          context: ['/api/algo'],
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
```

- [ ] **Step 2: Verify by restarting dev server**

Run dev server, check Network tab that `/api/algo/algorithms` proxies correctly.

- [ ] **Step 3: Commit**

```bash
git add platform/app/.webpack/webpack.pwa.js
git commit -m "feat(proxy): add webpack proxy for algo-api service"
```

---

### Task 3: Frontend algo API client

**Files:**
- Create: `platform/app/src/routes/Auth/algoApi.ts`

- [ ] **Step 1: Create algoApi.ts**

```typescript
// platform/app/src/routes/Auth/algoApi.ts

export interface AlgorithmInfo {
  id: string;
  name: string;
  description: string;
}

export interface TaskStatus {
  status: 'pending' | 'running' | 'success' | 'failed';
  progress: number;
  metadata?: {
    labels: Record<string, string>;
    shape: number[];
  };
  error?: string;
}

export interface LabelmapResult {
  data: Uint8Array;
  shape: number[];
  labels: Record<string, string>;
}

export async function listAlgorithms(): Promise<AlgorithmInfo[]> {
  const response = await fetch('/api/algo/algorithms');
  if (!response.ok) throw new Error('Failed to fetch algorithms');
  return response.json();
}

export async function runAlgorithm(
  algorithmId: string,
  studyInstanceUID: string,
  seriesInstanceUID?: string,
): Promise<string> {
  const response = await fetch('/api/algo/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ algorithmId, studyInstanceUID, seriesInstanceUID }),
  });
  if (!response.ok) throw new Error('Failed to start algorithm');
  const data = await response.json();
  return data.taskId;
}

export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const response = await fetch(`/api/algo/tasks/${taskId}`);
  if (!response.ok) throw new Error('Failed to get task status');
  return response.json();
}

export async function getResult(taskId: string): Promise<LabelmapResult> {
  const response = await fetch(`/api/algo/result/${taskId}`);
  if (!response.ok) throw new Error('Failed to get result');

  const shape = JSON.parse(response.headers.get('X-Labelmap-Shape') || '[]');
  const labels = JSON.parse(response.headers.get('X-Labelmap-Labels') || '{}');

  const compressed = await response.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(compressed));
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const data = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  return { data, shape, labels };
}
```

- [ ] **Step 2: Commit**

```bash
git add platform/app/src/routes/Auth/algoApi.ts
git commit -m "feat(frontend): add algorithm API client"
```

---

### Task 4: Algorithm panel component

**Files:**
- Create: `platform/app/src/components/AlgorithmPanel.tsx`

This panel is displayed as a right sidebar when the user clicks the "Algorithm" toolbar button. It shows the algorithm list, run button, progress bar, and handles result display.

- [ ] **Step 1: Create AlgorithmPanel.tsx**

```tsx
// platform/app/src/components/AlgorithmPanel.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { listAlgorithms, runAlgorithm, getTaskStatus, getResult } from '../routes/Auth/algoApi';
import type { AlgorithmInfo, TaskStatus } from '../routes/Auth/algoApi';

type Props = {
  servicesManager: any;
};

const POLL_INTERVAL = 2000;

export default function AlgorithmPanel({ servicesManager }: Props) {
  const [algorithms, setAlgorithms] = useState<AlgorithmInfo[]>([]);
  const [selectedAlgo, setSelectedAlgo] = useState<string>('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listAlgorithms()
      .then(setAlgorithms)
      .catch(() => setError('Failed to load algorithms'));
  }, []);

  useEffect(() => {
    if (!taskId || taskStatus?.status === 'success' || taskStatus?.status === 'failed') {
      return;
    }
    const timer = setInterval(() => {
      getTaskStatus(taskId)
        .then(status => {
          setTaskStatus(status);
          if (status.status === 'success' || status.status === 'failed') {
            clearInterval(timer);
          }
        })
        .catch(() => {
          clearInterval(timer);
          setError('Failed to poll task status');
        });
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [taskId, taskStatus?.status]);

  const handleRun = useCallback(async () => {
    if (!selectedAlgo) return;

    const { cornerstoneViewportService, segmentationService } = servicesManager.services;
    const viewport = cornerstoneViewportService.getActiveViewport();
    if (!viewport) {
      setError('No active viewport');
      return;
    }

    const displaySet = viewport.getDisplaySet?.() ?? viewport.displaySets?.[0];
    if (!displaySet) {
      setError('No display set found');
      return;
    }

    const studyInstanceUID = displaySet.StudyInstanceUID;
    const seriesInstanceUID = displaySet.SeriesInstanceUID;

    if (!studyInstanceUID) {
      setError('No StudyInstanceUID found');
      return;
    }

    setError(null);
    setTaskStatus(null);
    setLoading(true);

    try {
      const id = await runAlgorithm(selectedAlgo, studyInstanceUID, seriesInstanceUID);
      setTaskId(id);
    } catch (e: any) {
      setError(e.message || 'Failed to start algorithm');
    } finally {
      setLoading(false);
    }
  }, [selectedAlgo, servicesManager]);

  const handleDisplayResult = useCallback(async () => {
    if (!taskId) return;

    const { segmentationService, cornerstoneViewportService } = servicesManager.services;

    try {
      const result = await getResult(taskId);
      const viewport = cornerstoneViewportService.getActiveViewport();
      const displaySet = viewport?.getDisplaySet?.() ?? viewport?.displaySets?.[0];

      if (!displaySet) {
        setError('No display set for result overlay');
        return;
      }

      // Create segments from labels
      const segments: Record<number, { label: string; active: boolean }> = {};
      for (const [idx, label] of Object.entries(result.labels)) {
        segments[Number(idx)] = { label, active: true };
      }

      const segId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segments,
        label: `Algorithm: ${selectedAlgo}`,
      });

      // Write labelmap data into the segmentation volume
      const volume = segmentationService.getLabelmapVolume(segId);
      if (volume) {
        const scalarData = volume.voxelManager.getScalarData();
        const sourceData = result.data;
        const len = Math.min(scalarData.length, sourceData.length);
        for (let i = 0; i < len; i++) {
          if (sourceData[i] > 0) {
            scalarData[i] = sourceData[i];
          }
        }
        volume.voxelManager.setScalarData(scalarData);

        // Trigger re-render
        const viewportIds = segmentationService.getViewportIdsWithSegmentation(segId);
        const cs = await import('@cornerstonejs/core');
        viewportIds.forEach(vpId => {
          const { viewport: vp } = cs.getEnabledElementByViewportId(vpId);
          if (vp) vp.render();
        });
      }
    } catch (e: any) {
      setError(e.message || 'Failed to display result');
    }
  }, [taskId, selectedAlgo, servicesManager]);

  return (
    <div style={{ padding: '16px', color: '#fff', backgroundColor: '#1c1c1c', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600 }}>Algorithm Processing</h3>

      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#ccc' }}>
          Select Algorithm
        </label>
        <select
          value={selectedAlgo}
          onChange={e => setSelectedAlgo(e.target.value)}
          style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', backgroundColor: '#2c2c2c', color: '#fff', border: '1px solid #555' }}
        >
          <option value="">-- Select --</option>
          {algorithms.map(algo => (
            <option key={algo.id} value={algo.id}>{algo.name}</option>
          ))}
        </select>
      </div>

      {selectedAlgo && (
        <p style={{ fontSize: '11px', color: '#999', margin: '0 0 12px 0' }}>
          {algorithms.find(a => a.id === selectedAlgo)?.description}
        </p>
      )}

      <button
        onClick={handleRun}
        disabled={!selectedAlgo || loading || taskStatus?.status === 'running'}
        style={{
          width: '100%', padding: '8px', borderRadius: '4px', border: 'none',
          backgroundColor: selectedAlgo && !loading ? '#329ce8' : '#555',
          color: '#fff', cursor: selectedAlgo && !loading ? 'pointer' : 'not-allowed',
          fontSize: '13px', fontWeight: 500,
        }}
      >
        {loading ? 'Starting...' : taskStatus?.status === 'running' ? 'Processing...' : 'Run'}
      </button>

      {taskStatus && (
        <div style={{ marginTop: '16px' }}>
          <div style={{ fontSize: '12px', color: '#ccc', marginBottom: '6px' }}>
            Status: {taskStatus.status} ({taskStatus.progress}%)
          </div>
          <div style={{ width: '100%', height: '6px', backgroundColor: '#333', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              width: `${taskStatus.progress}%`, height: '100%', backgroundColor:
                taskStatus.status === 'success' ? '#4caf50' :
                taskStatus.status === 'failed' ? '#f44336' : '#329ce8',
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}

      {taskStatus?.status === 'success' && (
        <button
          onClick={handleDisplayResult}
          style={{
            width: '100%', marginTop: '12px', padding: '8px', borderRadius: '4px',
            border: 'none', backgroundColor: '#4caf50', color: '#fff',
            cursor: 'pointer', fontSize: '13px', fontWeight: 500,
          }}
        >
          Display Result
        </button>
      )}

      {taskStatus?.status === 'failed' && (
        <p style={{ fontSize: '12px', color: '#f44336', marginTop: '8px' }}>
          Error: {taskStatus.error}
        </p>
      )}

      {error && (
        <p style={{ fontSize: '12px', color: '#f44336', marginTop: '8px' }}>
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add platform/app/src/components/AlgorithmPanel.tsx
git commit -m "feat(frontend): add algorithm panel component"
```

---

### Task 5: Register algorithm panel in OHIF

**Files:**
- Create: `platform/app/src/getAlgorithmPanelModule.tsx`
- Modify: `platform/app/src/appInit.js` (or the file that registers extensions and panels)

This task registers the AlgorithmPanel as an OHIF panel module and adds a toolbar button that opens it.

- [ ] **Step 1: Create panel module registration**

```tsx
// platform/app/src/getAlgorithmPanelModule.tsx
import React from 'react';
import AlgorithmPanel from './components/AlgorithmPanel';

const getAlgorithmPanelModule = ({ commandsManager, servicesManager, extensionManager }) => {
  const wrappedPanel = props => {
    return (
      <AlgorithmPanel
        servicesManager={servicesManager}
      />
    );
  };

  return [
    {
      name: 'algorithmPanel',
      iconName: 'tab-segmentation',
      iconLabel: 'Algorithm',
      label: 'Algorithm',
      component: wrappedPanel,
    },
  ];
};

export default getAlgorithmPanelModule;
```

- [ ] **Step 2: Register panel in app initialization**

Find the file where OHIF registers extension panel modules and add the algorithm panel. In `platform/app/src/appInit.js`, find where panels are registered (look for `panelService.registerPanels` or `extensionManager.moduleEntries`). Add the algorithm panel registration alongside existing panels.

The exact file and registration point may vary — search for where `panelSegmentation` or other panels are registered in the app initialization flow, and add the algorithm panel in the same pattern.

- [ ] **Step 3: Add toolbar button**

In `modes/basic/src/toolbarButtons.ts`, add a new button:

```typescript
{
  id: 'Algorithm',
  uiType: 'ohif.toolButton',
  props: {
    icon: 'icon-tool-brush',
    label: 'Algorithm',
    tooltip: 'Run algorithm processing',
    commands: {
      commandName: 'openPanel',
      commandOptions: { panelName: 'algorithmPanel' },
    },
  },
},
```

Then in `modes/basic/src/index.tsx`, add `'Algorithm'` to the `MoreTools` section in `toolbarSections`.

- [ ] **Step 4: Test the button appears in viewer**

Start dev server, open a study, click "More Tools" → "Algorithm" should appear. Clicking it should open the right panel.

- [ ] **Step 5: Commit**

```bash
git add platform/app/src/getAlgorithmPanelModule.tsx platform/app/src/appInit.js modes/basic/src/
git commit -m "feat(frontend): register algorithm panel and toolbar button"
```

---

### Task 6: End-to-end integration test

**Files:** No new files — manual testing

- [ ] **Step 1: Start all services**

```bash
# Terminal 1: Orthanc (already running on Ubuntu VM)
# Terminal 2: auth-api
cd services/auth-api && npm run dev

# Terminal 3: algo-api
cd services/algo-api && python main.py

# Terminal 4: OHIF dev server
cd platform/app && yarn dev
```

- [ ] **Step 2: Test full pipeline**

1. Open browser to `http://localhost:3000`
2. Login
3. Open a study (e.g., the lung CT)
4. Click "More Tools" → "Algorithm"
5. Select "Mock Segmentation"
6. Click "Run"
7. Verify progress bar updates
8. Click "Display Result"
9. Verify colored overlay appears on the viewport

- [ ] **Step 3: Verify mock algorithm output**

The mock algorithm creates a spherical region in the center of the volume. Verify:
- A semi-transparent colored overlay appears
- The overlay covers roughly the center portion of the slices
- The overlay can be toggled on/off from the segmentation panel

- [ ] **Step 4: Commit any fixes**

If any issues found during testing, fix and commit.
