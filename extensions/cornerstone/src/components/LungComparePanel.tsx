import React, { useState, useEffect } from 'react';

type Props = {
  servicesManager: any;
};

type Phase = '' | 'running' | 'done' | 'failed';

// 模块级 store：面板切换/卸载时保留状态
const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  servicesManager: null as any,
  pollTimer: null as ReturnType<typeof setInterval> | null,
  // viewportId -> taskId
  tasks: {} as Record<string, string>,
  // 已渲染的 viewportId
  rendered: new Set<string>(),
};

// mock 体积（术前/术后）
const MOCK = {
  pre: { leftMl: 1456.78, rightMl: 1234.56, totalMl: 2691.34 },
  post: { leftMl: 1320.45, rightMl: 1100.22, totalMl: 2420.67 },
};

function stopPolling() {
  if (store.pollTimer) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
}

// 识别当前视口及其 displaySet，按 StudyDate 排序（pre=早 在前）
function getViewportsForCompare() {
  const { viewportGridService, displaySetService } = store.servicesManager.services;
  const { viewports } = viewportGridService.getState();
  const result: { viewportId: string; displaySet: any; studyDate: string }[] = [];
  for (const [vpId] of viewports ?? []) {
    const dsUIDs = viewportGridService.getDisplaySetsUIDsForViewport(vpId);
    if (!dsUIDs?.length) continue;
    const ds = displaySetService.getDisplaySetByUID(dsUIDs[0]);
    if (!ds?.StudyInstanceUID) continue;
    result.push({ viewportId: vpId, displaySet: ds, studyDate: ds.StudyDate || '' });
  }
  result.sort((a, b) => (a.studyDate || '').localeCompare(b.studyDate || ''));
  return result;
}

// 对两个视口各跑 mock-seg
async function runComparison() {
  const vps = getViewportsForCompare();
  if (vps.length < 2) {
    store.error = `需要 2 个视口各显示不同 study，当前 ${vps.length} 个。请先用布局图标布置 2 视口并拖入两个 study。`;
    store.phase = 'failed';
    return;
  }

  stopPolling();
  store.phase = 'running';
  store.progress = 0;
  store.error = '';
  store.tasks = {};
  store.rendered = new Set<string>();

  try {
    for (const vp of vps) {
      const res = await fetch('/api/algo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithmId: 'mock-seg',
          studyInstanceUID: vp.displaySet.StudyInstanceUID,
          seriesInstanceUID: vp.displaySet.SeriesInstanceUID,
        }),
      });
      const data = await res.json();
      store.tasks[vp.viewportId] = data.taskId;
    }
    startPolling(vps);
  } catch (e: any) {
    store.error = `启动失败：${e?.message || '未知错误'}`;
    store.phase = 'failed';
  }
}

function startPolling(vps: { viewportId: string }[]) {
  store.pollTimer = setInterval(async () => {
    let allDone = true;
    let progressSum = 0;
    let count = 0;

    for (const vp of vps) {
      const taskId = store.tasks[vp.viewportId];
      if (!taskId) continue;
      count++;
      try {
        const r = await fetch(`/api/algo/tasks/${taskId}`);
        const data = await r.json();
        progressSum += data.progress || 0;

        if (data.status === 'success') {
          if (!store.rendered.has(vp.viewportId)) {
            store.rendered.add(vp.viewportId);
            displayResultForViewport(taskId, vp.viewportId);
          }
        } else if (data.status === 'failed') {
          store.error = data.error || '任务失败';
          store.phase = 'failed';
          stopPolling();
          return;
        } else {
          allDone = false;
        }
      } catch {
        allDone = false;
      }
    }

    store.progress = count > 0 ? Math.floor(progressSum / count) : 0;

    if (allDone) {
      stopPolling();
      store.phase = 'done';
    }
  }, 2000);
}

// 在指定视口上渲染分割（按 viewportId 限定 scope，复用 AlgorithmPanel 逻辑）
async function displayResultForViewport(taskId: string, viewportId: string) {
  const { segmentationService, displaySetService } = store.servicesManager.services;

  try {
    const res = await fetch(`/api/algo/result/${taskId}`);
    if (!res.ok) throw new Error('Failed to get result');

    const labels = JSON.parse(res.headers.get('X-Labelmap-Labels') || '{}');
    const compressed = await res.arrayBuffer();

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

    // 用该视口的 displaySet 创建 labelmap
    const { viewportGridService } = store.servicesManager.services;
    const dsUIDs = viewportGridService.getDisplaySetsUIDsForViewport(viewportId);
    if (!dsUIDs?.length) return;
    const displaySet = displaySetService.getDisplaySetByUID(dsUIDs[0]);
    if (!displaySet) return;

    const segments: Record<number, { label: string; active: boolean }> = {};
    for (const [idx, label] of Object.entries(labels)) {
      segments[Number(idx)] = { label: label as string, active: true };
    }

    const segId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
      segments,
      label: `Compare: ${displaySet.StudyInstanceUID?.slice(-8) || viewportId}`,
    });

    // 写入 labelmap 数据
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

    // 只给该视口加表示（跳过 VOLUME_3D，避免 surface 崩溃；3D 仍走 labelmap 融合）
    const cs = await import('@cornerstonejs/core');
    const { ViewportType } = await import('@cornerstonejs/core/enums');
    const el = cs.getEnabledElementByViewportId(viewportId);
    if (el?.viewport?.type === ViewportType.VOLUME_3D) return;

    try {
      await segmentationService.addSegmentationRepresentation(viewportId, {
        segmentationId: segId,
        type: 'Labelmap' as const,
      });
    } catch {}

    const enabledEl = cs.getEnabledElementByViewportId(viewportId);
    if (enabledEl?.viewport) enabledEl.viewport.render();
  } catch (e: any) {
    store.error = `渲染失败：${e?.message || '未知错误'}`;
  }
}

export default function LungComparePanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);

  // 保留 servicesManager 引用供模块级函数使用
  store.servicesManager = servicesManager;

  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
    }, 300);
    return () => clearInterval(sync);
  }, []);

  const isBusy = phase === 'running';
  const delta = MOCK.post.totalMl - MOCK.pre.totalMl;
  const deltaPct = ((delta / MOCK.pre.totalMl) * 100).toFixed(1);

  const colStyle: React.CSSProperties = {
    flex: 1,
    background: '#1c1c1c',
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
  };

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: 14 }}>肺体积对比</h3>

      <button
        onClick={() => runComparison()}
        disabled={isBusy}
        style={{
          width: '100%',
          padding: 8,
          borderRadius: 4,
          border: 'none',
          background: isBusy ? '#555' : '#329ce8',
          color: '#fff',
          cursor: isBusy ? 'not-allowed' : 'pointer',
          fontSize: 13,
        }}
      >
        {isBusy ? `对比中 (${progress}%)` : phase === 'done' ? '重新对比' : '运行对比'}
      </button>

      {isBusy && (
        <div style={{ marginTop: 12 }}>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#329ce8', transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#ccc', marginTop: 4 }}>对两个 study 各跑分割中...</div>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={colStyle}>
              <div style={{ color: '#9ad', marginBottom: 4, fontWeight: 600 }}>术前 Pre</div>
              <div style={rowStyle}><span>左肺</span><span>{MOCK.pre.leftMl.toFixed(2)}</span></div>
              <div style={rowStyle}><span>右肺</span><span>{MOCK.pre.rightMl.toFixed(2)}</span></div>
              <div style={{ ...rowStyle, borderTop: '1px solid #333' }}><span>总计</span><span style={{ fontWeight: 600 }}>{MOCK.pre.totalMl.toFixed(2)}</span></div>
            </div>
            <div style={colStyle}>
              <div style={{ color: '#da9', marginBottom: 4, fontWeight: 600 }}>术后 Post</div>
              <div style={rowStyle}><span>左肺</span><span>{MOCK.post.leftMl.toFixed(2)}</span></div>
              <div style={rowStyle}><span>右肺</span><span>{MOCK.post.rightMl.toFixed(2)}</span></div>
              <div style={{ ...rowStyle, borderTop: '1px solid #333' }}><span>总计</span><span style={{ fontWeight: 600 }}>{MOCK.post.totalMl.toFixed(2)}</span></div>
            </div>
          </div>
          <div style={{ background: '#2a2a3a', borderRadius: 6, padding: 10, marginTop: 8, fontSize: 13 }}>
            <span>总体积变化 Δ </span>
            <span style={{ color: delta < 0 ? '#ff6b6b' : '#6bff6b', fontWeight: 700 }}>
              {delta > 0 ? '+' : ''}{delta.toFixed(2)} mL ({deltaPct}%)
            </span>
          </div>
          <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>单位 mL，体积为占位数据</div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}

      <div style={{ fontSize: 11, color: '#888', marginTop: 12 }}>
        先用顶部 Layout 图标布置 2 视口（1×2），分别拖入术前/术后 study，再点"运行对比"。
      </div>
    </div>
  );
}
