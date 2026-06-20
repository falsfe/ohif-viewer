import os
import uuid
import tempfile
import gzip
import shutil
import threading
from typing import Dict, Any

import numpy as np
import nibabel as nib
import requests as http_requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from algorithms import list_all, get

app = FastAPI(title="Algorithm Processing API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://localhost:8042")

tasks: Dict[str, Dict[str, Any]] = {}


class RunRequest(BaseModel):
    algorithmId: str
    studyInstanceUID: str
    seriesInstanceUID: str | None = None
    params: Dict[str, Any] = {}


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
        args=(task_id, algo["fn"], req.studyInstanceUID, req.seriesInstanceUID, req.params),
        daemon=True,
    )
    thread.start()

    return {"taskId": task_id}


@app.get("/api/algo/tasks/{task_id}")
def get_task_status(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    resp = {"status": task["status"], "progress": task["progress"]}
    if task["status"] == "success" and task["metadata"]:
        resp["metadata"] = task["metadata"]
    if task["status"] == "failed":
        resp["error"] = task["error"]
    return resp


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

    nii = nib.load(result_path)
    data = np.asanyarray(nii.dataobj).astype(np.uint8)
    raw_bytes = gzip.compress(data.tobytes())

    return Response(
        content=raw_bytes,
        media_type="application/octet-stream",
        headers={
            "X-Labelmap-Shape": str(shape),
            "X-Labelmap-Labels": str(labels).replace("'", '"'),
            "X-Labelmap-Dtype": "uint8",
        },
    )


def _run_task(task_id: str, algo_fn, study_uid: str, series_uid: str | None, params: Dict[str, Any]):
    tmp_dir = None
    result_dir = None
    try:
        tasks[task_id]["status"] = "running"
        tasks[task_id]["progress"] = 10

        # 前端必须传 CT 的 seriesInstanceUID(否则 _find_series 会拿到 study 第一个 series)
        if not series_uid:
            raise ValueError("seriesInstanceUID is required (must be the CT series)")
        series_id = _find_series(study_uid, series_uid)
        if not series_id:
            raise ValueError(f"No CT series found for study {study_uid}")

        tasks[task_id]["progress"] = 20

        tmp_dir = tempfile.mkdtemp()
        instances = _get_series_instances(series_id)
        total = len(instances)

        for i, instance_id in enumerate(instances):
            _download_instance(instance_id, tmp_dir, i)
            tasks[task_id]["progress"] = 20 + int(40 * (i + 1) / total)

        # nodule-sphere 专属:自动从同 study 找 RTSTRUCT,注入 params["mask_path"]
        algo_id = tasks[task_id]["algorithmId"]
        if algo_id == "nodule-sphere" and not params.get("mask_path"):
            tasks[task_id]["progress"] = 62
            rtstruct_path = _find_and_download_rtstruct(study_uid, tmp_dir)
            if not rtstruct_path:
                raise ValueError(
                    f"No RTSTRUCT series found in study {study_uid}. "
                    "Upload an RTSTRUCT to the same study or set params.mask_path."
                )
            params = {**params, "mask_path": rtstruct_path}
        tasks[task_id]["progress"] = 70

        output_path = os.path.join(tmp_dir, "result.nii.gz")
        metadata = algo_fn(tmp_dir, output_path, params)
        tasks[task_id]["progress"] = 95

        # 兼容无 labelmap 输出(本算法返回 _no_labelmap=True;lung_seg/mock_seg 仍走 else)
        no_labelmap = bool((metadata or {}).get("_no_labelmap") or not os.path.exists(output_path))
        if no_labelmap:
            tasks[task_id]["resultPath"] = None
            if os.path.exists(output_path):
                os.remove(output_path)
        else:
            result_dir = tempfile.mkdtemp()
            final_path = os.path.join(result_dir, "result.nii.gz")
            shutil.move(output_path, final_path)
            tasks[task_id]["resultPath"] = final_path

        tasks[task_id]["metadata"] = metadata
        tasks[task_id]["status"] = "success"
        tasks[task_id]["progress"] = 100

    except Exception as e:
        tasks[task_id]["status"] = "failed"
        tasks[task_id]["error"] = str(e)
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if result_dir:
            shutil.rmtree(result_dir, ignore_errors=True)


def _find_series(study_uid: str, series_uid: str | None) -> str:
    url = f"{ORTHANC_URL}/tools/find"
    query = {"Level": "Study", "Query": {"StudyInstanceUID": study_uid}}
    resp = http_requests.post(url, json=query, timeout=30)
    resp.raise_for_status()
    study_ids = resp.json()
    if not study_ids:
        raise ValueError(f"Study not found: {study_uid}")

    study_id = study_ids[0]

    url = f"{ORTHANC_URL}/studies/{study_id}/series"
    resp = http_requests.get(url, timeout=30)
    resp.raise_for_status()
    series_list = resp.json()

    if not series_list:
        raise ValueError(f"No series in study {study_uid}")

    if series_uid:
        for s in series_list:
            meta = http_requests.get(f"{ORTHANC_URL}/series/{s['ID']}", timeout=30).json()
            if meta.get("MainDicomTags", {}).get("SeriesInstanceUID") == series_uid:
                return s["ID"]
        raise ValueError(f"Series {series_uid} not found in study {study_uid}")

    return series_list[0]["ID"]


def _get_series_instances(series_id: str) -> list:
    url = f"{ORTHANC_URL}/series/{series_id}/instances"
    resp = http_requests.get(url, timeout=30)
    resp.raise_for_status()
    return [inst["ID"] for inst in resp.json()]


def _download_instance(instance_id: str, output_dir: str, index: int):
    url = f"{ORTHANC_URL}/instances/{instance_id}/file"
    resp = http_requests.get(url, timeout=30)
    resp.raise_for_status()
    filepath = os.path.join(output_dir, f"{index:06d}.dcm")
    with open(filepath, "wb") as f:
        f.write(resp.content)


def _find_and_download_rtstruct(study_uid: str, parent_tmp_dir: str) -> str | None:
    """在同 study 下找 Modality=RTSTRUCT 的 series,下载其 instance 到
    parent_tmp_dir/RTSTRUCT/<index>.dcm,返回该 .dcm 路径。

    多个 RTSTRUCT 取第一个;无则返回 None。
    RTSTRUCT 放独立子目录,是为满足算法 _is_rtstruct 的"父目录名含 RTSTRUCT"判定。
    """
    resp = http_requests.post(
        f"{ORTHANC_URL}/tools/find",
        json={"Level": "Study", "Query": {"StudyInstanceUID": study_uid}},
        timeout=30,
    )
    resp.raise_for_status()
    study_ids = resp.json()
    if not study_ids:
        return None
    study_id = study_ids[0]

    resp = http_requests.get(f"{ORTHANC_URL}/studies/{study_id}/series", timeout=30)
    resp.raise_for_status()

    rtstruct_series = None
    for s in resp.json():
        try:
            meta = http_requests.get(f"{ORTHANC_URL}/series/{s['ID']}", timeout=30).json()
            if meta.get("MainDicomTags", {}).get("Modality") == "RTSTRUCT":
                rtstruct_series = s["ID"]  # 多个时取第一个
                break
        except Exception:
            continue
    if not rtstruct_series:
        return None

    rtstruct_dir = os.path.join(parent_tmp_dir, "RTSTRUCT")  # 满足算法 _is_rtstruct 判定
    os.makedirs(rtstruct_dir, exist_ok=True)
    for i, inst_id in enumerate(_get_series_instances(rtstruct_series)):
        _download_instance(inst_id, rtstruct_dir, i)
    dcm_files = sorted(f for f in os.listdir(rtstruct_dir) if f.endswith(".dcm"))
    return os.path.join(rtstruct_dir, dcm_files[0]) if dcm_files else None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
