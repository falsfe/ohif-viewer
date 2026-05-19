import React, { useState, useEffect, useCallback } from 'react';

type Props = {
  servicesManager: any;
};

type Phase = '' | 'running' | 'displaying' | 'done' | 'failed';

// Module-level state: survives panel unmount/remount (like a mini service)
const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  taskId: null as string | null,
  selectedAlgo: '',
  servicesManager: null as any,
  pollTimer: null as ReturnType<typeof setInterval> | null,
};

function stopPolling() {
  if (store.pollTimer) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
}

// Fetch result and render overlay (works even when panel is unmounted)
async function displayResult(taskId: string, selectedAlgo: string) {
  store.phase = 'displaying';
  const { segmentationService, viewportGridService, displaySetService } = store.servicesManager.services;

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
      label: `Algorithm: ${selectedAlgo}`,
    });

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

    const { viewportGridService: vgs } = store.servicesManager.services;
    const { viewports } = vgs.getState();
    for (const [vpId] of viewports ?? []) {
      try {
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: segId,
          type: 'Labelmap' as const,
        });
      } catch {}
    }

    const cs = await import('@cornerstonejs/core');
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

// Background polling (runs independently of component lifecycle)
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
          displayResult(store.taskId!, store.selectedAlgo);
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

export default function AlgorithmPanel({ servicesManager }: Props) {
  const [algorithms, setAlgorithms] = useState<any[]>([]);
  const [selectedAlgo, setSelectedAlgo] = useState(store.selectedAlgo);
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);

  // Keep servicesManager reference for module-level functions
  store.servicesManager = servicesManager;

  // Sync selectedAlgo to store
  useEffect(() => { store.selectedAlgo = selectedAlgo; }, [selectedAlgo]);

  // Sync store → React state every 500ms (handles remount and background updates)
  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
    }, 500);
    return () => clearInterval(sync);
  }, []);

  useEffect(() => {
    fetch('/api/algo/algorithms')
      .then(r => r.json())
      .then(setAlgorithms)
      .catch(() => setError('Failed to load algorithms'));
  }, []);

  const handleRun = useCallback(async () => {
    if (!selectedAlgo) return;
    setError('');
    setProgress(0);
    setPhase('running');
    store.phase = 'running';
    store.progress = 0;
    store.error = '';

    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { setError('No active viewport'); store.phase = 'failed'; return; }
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!displaySetUIDs?.length) { setError('No display sets'); store.phase = 'failed'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
    if (!displaySet?.StudyInstanceUID) { setError('No study found'); store.phase = 'failed'; return; }

    try {
      const res = await fetch('/api/algo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithmId: selectedAlgo,
          studyInstanceUID: displaySet.StudyInstanceUID,
          seriesInstanceUID: displaySet.SeriesInstanceUID,
        }),
      });
      const data = await res.json();
      store.taskId = data.taskId;
      startPolling();
    } catch (e: any) {
      setError(e.message);
      store.phase = 'failed';
    }
  }, [selectedAlgo, servicesManager]);

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

  const isBusy = phase === 'running' || phase === 'displaying';

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>Algorithm Processing</h3>
      <div style={{ marginBottom: 12 }}>
        <select
          value={selectedAlgo}
          onChange={e => setSelectedAlgo(e.target.value)}
          disabled={isBusy}
          style={{ width: '100%', padding: '6px 8px', borderRadius: 4, background: '#2c2c2c', color: '#fff', border: '1px solid #555' }}
        >
          <option value="">-- Select --</option>
          {algorithms.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <button
        onClick={handleRun}
        disabled={!selectedAlgo || isBusy}
        style={{ width: '100%', padding: 8, borderRadius: 4, border: 'none', background: !selectedAlgo || isBusy ? '#555' : '#329ce8', color: '#fff', cursor: !selectedAlgo || isBusy ? 'not-allowed' : 'pointer', fontSize: 13 }}
      >
        {isBusy ? 'Processing...' : phase === 'done' ? 'Re-run' : 'Run'}
      </button>
      {phase && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            {isBusy && <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #666', borderTopColor: statusColor, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
            {statusText}
          </div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${phase === 'done' ? 100 : phase === 'displaying' ? 100 : progress}%`, height: '100%', background: statusColor, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
