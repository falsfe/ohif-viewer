import React, { useState, useEffect, useCallback } from 'react';

type Props = {
  servicesManager: any;
};

type Phase = '' | 'running' | 'displaying' | 'done' | 'failed';

// 单个结节的测量数据(对应后端 metadata.nodules[i] 的字段)
type Nodule = {
  nodule_id: number;
  voxel_count?: number;
  volume_mm3: number;
  inscribed_diameter_mm: number;
  circumscribed_diameter_mm: number;
  inscribed_center_x_mm: number;
  inscribed_center_y_mm: number;
  inscribed_center_z_mm: number;
  circumscribed_center_x_mm?: number;
  circumscribed_center_y_mm?: number;
  circumscribed_center_z_mm?: number;
  solid_volume_ratio: number;
  solid_threshold_hu?: number;
};

// 模块级 state:面板切换/卸载时保留状态(复用 AlgorithmPanel 模式)
const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  taskId: null as string | null,
  nodules: [] as Nodule[],
  roiName: 'GTV-1',
  threshold: -160,
  mode: 'approx' as 'approx' | 'exact',
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

// 取结果并渲染 labelmap(复用 AlgorithmPanel 的 displayResult 逻辑)
// 算法把内切球(段1)/外接球(段2)画成 labelmap,segmentationService 渲染:
// 2D 每层显示球的截面,3D 显示球面,不随切片消失。
async function displayResult(taskId: string) {
  store.phase = 'displaying';
  const { segmentationService, viewportGridService, displaySetService, toolGroupService } = store.servicesManager.services;

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
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!displaySetUIDs?.length) { store.error = 'No display sets'; store.phase = 'failed'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
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

    const cstSegmentation = await import('@cornerstonejs/tools').then(m => m.segmentation);
    const csSegmentation = cstSegmentation.state.getSegmentation(segId);

    if (csSegmentation?.representationData?.Labelmap) {
      const labelmapData = csSegmentation.representationData.Labelmap as any;
      const { cache: csCache } = await import('@cornerstonejs/core');

      const volumeId = labelmapData.volumeId;
      if (volumeId) {
        const labelmapVolume = csCache.getVolume(volumeId);
        if (labelmapVolume?.voxelManager) {
          const scalarData = labelmapVolume.voxelManager.getScalarData();
          const len = Math.min(scalarData.length, resultData.length);
          for (let i = 0; i < len; i++) {
            if (resultData[i] > 0) scalarData[i] = resultData[i];
          }
          labelmapVolume.voxelManager.setScalarData(scalarData);
        }
      }
      // imageIds-based(stack)labelmap:逐切片写 image pixelData
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
              for (let j = 0; j < end - start; j++) {
                if (resultData[start + j] > 0) pixelData[j] = resultData[start + j];
              }
            }
          }
        }
      }
    }

    const { viewports } = viewportGridService.getState();
    const cs = await import('@cornerstonejs/core');
    for (const [vpId] of viewports ?? []) {
      try {
        // 不跳过 VOLUME_3D:labelmap 融合渲染与 surface 是分开的路径,3D 也能显示
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: segId,
          type: 'Labelmap' as const,
        });
      } catch (e) {
        console.error('[NoduleSphere] addRep failed', vpId, e);
      }
    }

    // 设置 segment 颜色:内切球蓝、外接球红
    const { ViewportType } = await import('@cornerstonejs/core/enums');
    for (const [vpId] of viewports ?? []) {
      try {
        segmentationService.setSegmentColor(vpId, segId, 1, [0, 191, 255, 255]);
        segmentationService.setSegmentColor(vpId, segId, 2, [255, 68, 68, 255]);
        // 3D 视口强制 Surface 渲染,Surface 不支持透明度/线框,外接壳会遮挡内切;
        // 故 3D 只显示内切球(结节核心),外接球在 2D 截面查看(红壳)+ 表格直径
        const el = cs.getEnabledElementByViewportId(vpId);
        if (el?.viewport?.type === ViewportType.VOLUME_3D) {
          segmentationService.setSegmentVisibility(vpId, segId, 2, false);
        }
      } catch (e) {
        console.error('[NoduleSphere] segment style failed', vpId, e);
      }
    }

    viewports?.forEach((v: any) => {
      try {
        const el = cs.getEnabledElementByViewportId(v.viewportId);
        if (el?.viewport) el.viewport.render();
      } catch {}
    });

    store.phase = 'done';
  } catch (e: any) {
    store.error = e.message;
    store.phase = 'failed';
  }
}

// 后台轮询(独立于组件生命周期)。success 时取 labelmap 并渲染。
function startPolling() {
  stopPolling();
  store.pollTimer = setInterval(() => {
    if (!store.taskId) return;
    fetch(`/api/algo/tasks/${store.taskId}`)
      .then(r => r.json())
      .then(data => {
        store.progress = data.progress;
        if (data.error) {
          store.error = data.error;
          store.phase = 'failed';
          stopPolling();
          return;
        }
        if (data.status === 'success') {
          stopPolling();
          store.nodules = (data.metadata?.nodules as Nodule[]) || [];
          displayResult(store.taskId!);
        } else if (data.status === 'failed') {
          stopPolling();
          store.phase = 'failed';
        }
      })
      .catch(() => {
        stopPolling();
        store.error = 'Poll failed';
        store.phase = 'failed';
      });
  }, 2000);
}

export default function NoduleSpherePanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);
  const [nodules, setNodules] = useState<Nodule[]>(store.nodules);
  const [roiName, setRoiName] = useState(store.roiName);
  const [threshold, setThreshold] = useState(store.threshold);
  const [mode, setMode] = useState(store.mode);

  store.servicesManager = servicesManager;

  useEffect(() => { store.roiName = roiName; }, [roiName]);
  useEffect(() => { store.threshold = threshold; }, [threshold]);
  useEffect(() => { store.mode = mode; }, [mode]);

  // store → React state 每 500ms 同步
  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
      setNodules(store.nodules);
    }, 500);
    return () => clearInterval(sync);
  }, []);

  const handleRun = useCallback(async () => {
    setError('');
    setProgress(0);
    setPhase('running');
    store.phase = 'running';
    store.progress = 0;
    store.error = '';
    store.nodules = [];

    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { setError('No active viewport'); store.phase = 'failed'; return; }
    const dsUids = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!dsUids?.length) { setError('No display sets'); store.phase = 'failed'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(dsUids[0]);
    if (!displaySet?.StudyInstanceUID) { setError('No study found'); store.phase = 'failed'; return; }
    if (displaySet.Modality && displaySet.Modality !== 'CT') {
      setError('请在 CT 视口上运行此算法(当前视口非 CT)');
      store.phase = 'failed';
      return;
    }

    try {
      const res = await fetch('/api/algo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithmId: 'nodule-sphere',
          studyInstanceUID: displaySet.StudyInstanceUID,
          seriesInstanceUID: displaySet.SeriesInstanceUID,
          params: { roi_name: roiName, threshold, mode },
        }),
      });
      const data = await res.json();
      store.taskId = data.taskId;
      startPolling();
    } catch (e: any) {
      setError(e.message);
      store.phase = 'failed';
    }
  }, [servicesManager, roiName, threshold, mode]);

  const isBusy = phase === 'running' || phase === 'displaying';

  const statusText = {
    '': '',
    running: `Running (${progress}%)`,
    displaying: 'Loading result...',
    done: 'Completed',
    failed: 'Failed',
  }[phase];

  const statusColor = {
    '': '#329ce8',
    running: '#329ce8',
    displaying: '#ff9800',
    done: '#4caf50',
    failed: '#f44336',
  }[phase];

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '4px 6px', borderRadius: 4,
    background: '#2c2c2c', color: '#fff', border: '1px solid #555', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, color: '#ccc', display: 'block', marginBottom: 4 };

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>肺结节球体分析</h3>
      <p style={{ fontSize: 11, color: '#999', margin: '0 0 12px 0' }}>
        在 CT 视口运行,后端算内切球/外接球并以 labelmap 输出,前端渲染(2D 截面圆 + 3D 球面)。
      </p>

      <label style={labelStyle}>ROI 名称(RTSTRUCT 中的结构名)</label>
      <input style={{ ...inputStyle, marginBottom: 10 }} value={roiName} onChange={e => setRoiName(e.target.value)} disabled={isBusy} />

      <label style={labelStyle}>实性阈值 (HU)</label>
      <input type="number" style={{ ...inputStyle, marginBottom: 10 }} value={threshold} onChange={e => setThreshold(Number(e.target.value))} disabled={isBusy} />

      <label style={labelStyle}>外接球算法</label>
      <div style={{ marginBottom: 12, fontSize: 12 }}>
        <label style={{ marginRight: 12 }}>
          <input type="radio" checked={mode === 'approx'} onChange={() => setMode('approx')} disabled={isBusy} /> approx (快)
        </label>
        <label>
          <input type="radio" checked={mode === 'exact'} onChange={() => setMode('exact')} disabled={isBusy} /> exact (精确,慢)
        </label>
      </div>

      <button onClick={handleRun} disabled={isBusy}
        style={{ width: '100%', padding: 8, borderRadius: 4, border: 'none',
          background: isBusy ? '#555' : '#329ce8', color: '#fff',
          cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 13 }}>
        {isBusy ? 'Processing...' : phase === 'done' ? 'Re-run' : 'Run'}
      </button>

      {phase && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: statusColor, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            {isBusy && (
              <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #666', borderTopColor: statusColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            )}
            {statusText}
          </div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${phase === 'done' || phase === 'displaying' ? 100 : progress}%`, height: '100%', background: statusColor, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}

      {/* 结果表格 */}
      {phase === 'done' && nodules.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6 }}>共 {nodules.length} 个结节</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#1c1c1c' }}>
                {['#', '体积(mL)', '内切Ø(mm)', '外接Ø(mm)', '实性%', '球心 x/y/z (mm)'].map(h => (
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
