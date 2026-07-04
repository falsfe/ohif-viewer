import React, { useState, useEffect, useCallback } from 'react';
import { ViewportType } from '@cornerstonejs/core/enums';

type Props = { servicesManager: any };
type Phase = '' | 'running' | 'displaying' | 'done' | 'failed';

type Nodule = {
  nodule_id: number;
  volume_mm3: number;
  inscribed_diameter_mm: number;
  circumscribed_diameter_mm: number;
  inscribed_center_x_mm: number;
  inscribed_center_y_mm: number;
  inscribed_center_z_mm: number;
  solid_volume_ratio: number;
};

// segment 编号(与后端 nodule_sphere.py 一致)
const SEG_NODULE = 1;
const SEG_SOLID = 2;
const SEG_INSCRIBED = 3;
const SEG_CIRCUMSCRIBED = 4;

// 颜色:2D labelmap 的 alpha 生效(透明叠加);3D surface 的 alpha 不生效(颜色生效)
const COLOR: Record<number, number[]> = {
  [SEG_NODULE]: [255, 0, 0, 90],       // 结节本体 透明红
  [SEG_SOLID]: [255, 165, 0, 190],     // 实性成分 橙
  [SEG_INSCRIBED]: [0, 191, 255, 255], // 内切球 蓝
  [SEG_CIRCUMSCRIBED]: [180, 0, 255, 255], // 外接球 紫
};

// 3D surface 透明度(Surface 不吃 color alpha,直接 vtk actor setOpacity)
// 内部段(结节/实性/内切)较实保证清晰,外接球较透以便看穿到内部
const OPACITY_3D: Record<number, number> = {
  [SEG_NODULE]: 0.4,
  [SEG_SOLID]: 0.5,
  [SEG_INSCRIBED]: 0.8,
  [SEG_CIRCUMSCRIBED]: 0.18,
};

const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  taskId: null as string | null,
  nodules: [] as Nodule[],
  roiName: 'GTV-1',
  threshold: -160,
  showNodule: true,
  showSolid: true,
  showInscribed: true,
  showCircumscribed: true,
  servicesManager: null as any,
  segId: null as string | null,
  pollTimer: null as ReturnType<typeof setInterval> | null,
};

function stopPolling() {
  if (store.pollTimer) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
}

// 取结果并渲染多 segment labelmap(复用 AlgorithmPanel 的 displayResult 流程)
async function displayResult(taskId: string) {
  store.phase = 'displaying';
  const { segmentationService, viewportGridService, displaySetService } = store.servicesManager.services;

  try {
    const res = await fetch(`/api/algo/result/${taskId}`);
    if (!res.ok) throw new Error('Failed to get result');
    const labels = JSON.parse(res.headers.get('X-Labelmap-Labels') || '{}');
    const compressed = await res.arrayBuffer();

    // 解压 gzip
    const ds2 = new DecompressionStream('gzip');
    const writer = ds2.writable.getWriter();
    writer.write(new Uint8Array(compressed));
    writer.close();
    const reader = ds2.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value!);
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const resultData = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { resultData.set(c, off); off += c.length; }

    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { store.error = 'No active viewport'; store.phase = 'failed'; return; }
    const dsUids = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!dsUids?.length) { store.error = 'No display sets'; store.phase = 'failed'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(dsUids[0]);
    if (!displaySet) { store.error = 'No display set'; store.phase = 'failed'; return; }

    const segments: Record<number, { label: string; active: boolean }> = {};
    for (const [idx, label] of Object.entries(labels)) {
      segments[Number(idx)] = { label: label as string, active: true };
    }
    const segId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
      segments,
      label: 'Nodule Sphere',
    });
    store.segId = segId;

    // 写入 labelmap 数据(volume 或 imageIds)
    const cstSegmentation = await import('@cornerstonejs/tools').then(m => m.segmentation);
    const csSegmentation = cstSegmentation.state.getSegmentation(segId);
    const cs = await import('@cornerstonejs/core');
    if (csSegmentation?.representationData?.Labelmap) {
      const labelmapData = csSegmentation.representationData.Labelmap as any;
      const { cache: csCache } = cs;
      const volumeId = labelmapData.volumeId;
      if (volumeId) {
        const lv = csCache.getVolume(volumeId);
        if (lv?.voxelManager) {
          const scalarData = lv.voxelManager.getScalarData();
          const len = Math.min(scalarData.length, resultData.length);
          for (let i = 0; i < len; i++) if (resultData[i] > 0) scalarData[i] = resultData[i];
          lv.voxelManager.setScalarData(scalarData);
        }
      }
      const imageIds: string[] = labelmapData.imageIds || [];
      if (imageIds.length > 0) {
        const sliceSize = Math.floor(resultData.length / imageIds.length);
        for (let i = 0; i < imageIds.length; i++) {
          const image = csCache.getImage(imageIds[i]);
          if (image) {
            const pixelData = image.getPixelData();
            if (pixelData) {
              const start = i * sliceSize;
              const end = Math.min(start + pixelData.length, resultData.length);
              for (let j = 0; j < end - start; j++) if (resultData[start + j] > 0) pixelData[j] = resultData[start + j];
            }
          }
        }
      }
    }

    const { viewports } = viewportGridService.getState();

    // addSegmentationRepresentation(含 3D,不跳过)
    for (const [vpId] of viewports ?? []) {
      try {
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: segId,
          type: 'Labelmap' as const,
        });
      } catch (e) {
        console.error('[NoduleSphere] addRep failed', vpId, e);
      }
    }

    // 颜色(2D alpha 生效、3D 颜色生效)
    for (const [vpId] of viewports ?? []) {
      for (const segIdx of [SEG_NODULE, SEG_SOLID, SEG_INSCRIBED, SEG_CIRCUMSCRIBED]) {
        try { segmentationService.setSegmentColor(vpId, segId, segIdx, COLOR[segIdx]); } catch {}
      }
    }

    // checkbox 控制的 visibility(4 段)
    for (const [vpId] of viewports ?? []) {
      try {
        segmentationService.setSegmentVisibility(vpId, segId, SEG_NODULE, store.showNodule);
        segmentationService.setSegmentVisibility(vpId, segId, SEG_SOLID, store.showSolid);
        segmentationService.setSegmentVisibility(vpId, segId, SEG_INSCRIBED, store.showInscribed);
        segmentationService.setSegmentVisibility(vpId, segId, SEG_CIRCUMSCRIBED, store.showCircumscribed);
      } catch {}
    }

    // 3D surface 透明度:Surface 表示不吃 color alpha,直接拿 vtk actor setOpacity
    const apply3DOpacity = () => {
      for (const [vpId] of viewports ?? []) {
        try {
          const el = cs.getEnabledElementByViewportId(vpId);
          const vp = el?.viewport;
          if (!vp || vp.type !== ViewportType.VOLUME_3D) continue;
          for (const a of vp.getActors?.() ?? []) {
            const repUID = String(a.representationUID || '');
            if (repUID.startsWith(`${segId}-Surface-`)) {
              const m = repUID.match(/-Surface-(\d+)$/);
              const segIdx = m ? Number(m[1]) : null;
              if (segIdx != null && OPACITY_3D[segIdx] != null) {
                a.actor?.getProperty()?.setOpacity?.(OPACITY_3D[segIdx]);
              }
            }
          }
          vp.render();
        } catch {}
      }
    };
    apply3DOpacity();
    setTimeout(apply3DOpacity, 1500); // surface 从 labelmap 转换需要时间,1.5s 后重试

    viewports?.forEach((v: any) => {
      try { const el = cs.getEnabledElementByViewportId(v.viewportId); if (el?.viewport) el.viewport.render(); } catch {}
    });

    store.phase = 'done';
  } catch (e: any) {
    store.error = e.message;
    store.phase = 'failed';
  }
}

// checkbox 切换 segment visibility(所有视口同步;2D labelmap + 3D surface actor)
function setSegmentVisibilityAll(segIdx: number, visible: boolean) {
  const sm = store.servicesManager;
  if (!sm || !store.segId) return;
  const { segmentationService, viewportGridService, cornerstoneViewportService } = sm.services;
  const { viewports } = viewportGridService.getState();
  const segId = store.segId;
  // 2D labelmap visibility
  for (const [vpId] of viewports ?? []) {
    try { segmentationService.setSegmentVisibility(vpId, segId, segIdx, visible); } catch {}
  }
  // 3D surface actor visibility(setSegmentVisibility 对 surface 表示不生效,直接 vtk actor)
  (async () => {
    try {
      const cs = await import('@cornerstonejs/core');
      const { ViewportType } = await import('@cornerstonejs/core/enums');
      for (const [vpId] of viewports ?? []) {
        try {
          const el = cs.getEnabledElementByViewportId(vpId);
          const vp = el?.viewport;
          if (!vp || vp.type !== ViewportType.VOLUME_3D) continue;
          for (const a of vp.getActors?.() ?? []) {
            const repUID = String(a.representationUID || '');
            if (repUID === `${segId}-Surface-${segIdx}`) {
              a.actor?.setVisibility?.(visible);
            }
          }
          vp.render();
        } catch {}
      }
    } catch {}
  })();
  try { cornerstoneViewportService.getRenderingEngine?.()?.render(); } catch {}
}

function startPolling() {
  stopPolling();
  store.pollTimer = setInterval(() => {
    if (!store.taskId) return;
    fetch(`/api/algo/tasks/${store.taskId}`)
      .then(r => r.json())
      .then(data => {
        store.progress = data.progress;
        if (data.error) { store.error = data.error; store.phase = 'failed'; stopPolling(); return; }
        if (data.status === 'success') {
          stopPolling();
          store.nodules = (data.metadata?.nodules as Nodule[]) || [];
          displayResult(store.taskId!);
        } else if (data.status === 'failed') {
          stopPolling();
          store.phase = 'failed';
        }
      })
      .catch(() => { stopPolling(); store.error = 'Poll failed'; store.phase = 'failed'; });
  }, 2000);
}

export default function NoduleSpherePanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);
  const [nodules, setNodules] = useState<Nodule[]>(store.nodules);
  const [roiName, setRoiName] = useState(store.roiName);
  const [threshold, setThreshold] = useState(store.threshold);
  const [showNodule, setShowNodule] = useState(store.showNodule);
  const [showSolid, setShowSolid] = useState(store.showSolid);
  const [showInscribed, setShowInscribed] = useState(store.showInscribed);
  const [showCircumscribed, setShowCircumscribed] = useState(store.showCircumscribed);

  store.servicesManager = servicesManager;
  useEffect(() => { store.roiName = roiName; }, [roiName]);
  useEffect(() => { store.threshold = threshold; }, [threshold]);
  useEffect(() => { store.showNodule = showNodule; }, [showNodule]);
  useEffect(() => { store.showSolid = showSolid; }, [showSolid]);
  useEffect(() => { store.showInscribed = showInscribed; }, [showInscribed]);
  useEffect(() => { store.showCircumscribed = showCircumscribed; }, [showCircumscribed]);

  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase); setProgress(store.progress); setError(store.error); setNodules(store.nodules);
    }, 500);
    return () => clearInterval(sync);
  }, []);

  const handleRun = useCallback(async () => {
    setError(''); setProgress(0); setPhase('running');
    store.phase = 'running'; store.progress = 0; store.error = ''; store.nodules = [];
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { setError('No active viewport'); store.phase = 'failed'; return; }
    const dsUids = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!dsUids?.length) { setError('No display sets'); store.phase = 'failed'; return; }
    const ds = displaySetService.getDisplaySetByUID(dsUids[0]);
    if (!ds?.StudyInstanceUID) { setError('No study found'); store.phase = 'failed'; return; }
    if (ds.Modality && ds.Modality !== 'CT') { setError('请在 CT 视口上运行(当前视口非 CT)'); store.phase = 'failed'; return; }
    try {
      const res = await fetch('/api/algo/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithmId: 'nodule-sphere',
          studyInstanceUID: ds.StudyInstanceUID,
          seriesInstanceUID: ds.SeriesInstanceUID,
          params: { roi_name: roiName, threshold },  // 后端固定 exact,不传 mode
        }),
      });
      const data = await res.json();
      store.taskId = data.taskId;
      startPolling();
    } catch (e: any) { setError(e.message); store.phase = 'failed'; }
  }, [servicesManager, roiName, threshold]);

  const isBusy = phase === 'running' || phase === 'displaying';
  const statusText = { '': '', running: `Running (${progress}%)`, displaying: 'Loading result...', done: 'Completed', failed: 'Failed' }[phase];
  const statusColor = { '': '#329ce8', running: '#329ce8', displaying: '#ff9800', done: '#4caf50', failed: '#f44336' }[phase];
  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#ccc', display: 'block', marginBottom: 4 };
  const inputStyle: React.CSSProperties = { width: '100%', padding: '4px 6px', borderRadius: 4, background: '#2c2c2c', color: '#fff', border: '1px solid #555', boxSizing: 'border-box' };

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: 14 }}>肺结节球体分析</h3>
      {/* 颜色图例 */}
      <div style={{ marginBottom: 12, fontSize: 11, color: '#ccc', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgb(255,0,0)', marginRight: 6, verticalAlign: 'middle' }} />结节本体</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgb(255,165,0)', marginRight: 6, verticalAlign: 'middle' }} />实性成分</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgb(0,191,255)', marginRight: 6, verticalAlign: 'middle' }} />内切球</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgb(180,0,255)', marginRight: 6, verticalAlign: 'middle' }} />外接球</span>
      </div>

      <label style={labelStyle}>ROI 名称(RTSTRUCT 中的结构名)</label>
      <input style={{ ...inputStyle, marginBottom: 12 }} value={roiName} onChange={e => setRoiName(e.target.value)} disabled={isBusy} />

      <label style={labelStyle}>实性阈值(HU,高于此值算实性成分):<b style={{ color: '#329ce8' }}>{threshold}</b></label>
      <input type="range" min={-1000} max={500} step={10} value={threshold}
        onChange={e => setThreshold(Number(e.target.value))} disabled={isBusy}
        style={{ width: '100%', marginBottom: 12 }} />

      <label style={labelStyle}>显示控制</label>
      <div style={{ marginBottom: 12, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label>
          <input type="checkbox" checked={showNodule}
            onChange={e => { setShowNodule(e.target.checked); setSegmentVisibilityAll(SEG_NODULE, e.target.checked); }} />
          {' '}显示结节本体(红)
        </label>
        <label>
          <input type="checkbox" checked={showSolid}
            onChange={e => { setShowSolid(e.target.checked); setSegmentVisibilityAll(SEG_SOLID, e.target.checked); }} />
          {' '}显示实性成分(橙)
        </label>
        <label>
          <input type="checkbox" checked={showInscribed}
            onChange={e => { setShowInscribed(e.target.checked); setSegmentVisibilityAll(SEG_INSCRIBED, e.target.checked); }} />
          {' '}显示内切球(蓝)
        </label>
        <label>
          <input type="checkbox" checked={showCircumscribed}
            onChange={e => { setShowCircumscribed(e.target.checked); setSegmentVisibilityAll(SEG_CIRCUMSCRIBED, e.target.checked); }} />
          {' '}显示外接球(紫)
        </label>
      </div>

      <button onClick={handleRun} disabled={isBusy}
        style={{ width: '100%', padding: 8, borderRadius: 4, border: 'none', background: isBusy ? '#555' : '#329ce8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 13 }}>
        {isBusy ? 'Processing...' : phase === 'done' ? 'Re-run' : 'Run'}
      </button>

      {phase && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: statusColor, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            {isBusy && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #666', borderTopColor: statusColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
            {statusText}
          </div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${phase === 'done' || phase === 'displaying' ? 100 : progress}%`, height: '100%', background: statusColor, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}

      {phase === 'done' && nodules.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6 }}>共 {nodules.length} 个结节</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#1c1c1c' }}>
                {['#', '体积(mL)', '内切Ø(mm)', '外接Ø(mm)', '实性%', '球心 x/y/z'].map(h => (
                  <th key={h} style={{ padding: '4px 2px', textAlign: 'left', borderBottom: '1px solid #444' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {nodules.map(n => (
                <tr key={n.nodule_id}>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{n.nodule_id}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{(n.volume_mm3 / 1000).toFixed(2)}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{n.inscribed_diameter_mm.toFixed(1)}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{n.circumscribed_diameter_mm.toFixed(1)}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{(n.solid_volume_ratio * 100).toFixed(1)}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a', fontSize: 10 }}>
                    {n.inscribed_center_x_mm.toFixed(0)} / {n.inscribed_center_y_mm.toFixed(0)} / {n.inscribed_center_z_mm.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
