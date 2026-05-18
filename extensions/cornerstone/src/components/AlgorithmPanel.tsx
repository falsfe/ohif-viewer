import React, { useState, useEffect, useCallback } from 'react';

type Props = {
  servicesManager: any;
};

export default function AlgorithmPanel({ servicesManager }: Props) {
  const [algorithms, setAlgorithms] = useState<any[]>([]);
  const [selectedAlgo, setSelectedAlgo] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/algo/algorithms')
      .then(r => r.json())
      .then(setAlgorithms)
      .catch(() => setError('Failed to load algorithms'));
  }, []);

  useEffect(() => {
    if (!taskId || status === 'success' || status === 'failed') return;
    const timer = setInterval(() => {
      fetch(`/api/algo/tasks/${taskId}`)
        .then(r => r.json())
        .then(data => {
          setStatus(data.status);
          setProgress(data.progress);
          if (data.error) setError(data.error);
          if (data.status === 'success' || data.status === 'failed') clearInterval(timer);
        })
        .catch(() => { clearInterval(timer); setError('Poll failed'); });
    }, 2000);
    return () => clearInterval(timer);
  }, [taskId, status]);

  const handleRun = useCallback(async () => {
    if (!selectedAlgo) return;
    setError('');
    setStatus('');
    setProgress(0);

    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { setError('No active viewport'); return; }
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!displaySetUIDs?.length) { setError('No display sets'); return; }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
    if (!displaySet?.StudyInstanceUID) { setError('No study found'); return; }

    try {
      const res = await fetch('/api/algo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithmId: selectedAlgo, studyInstanceUID: displaySet.StudyInstanceUID, seriesInstanceUID: displaySet.SeriesInstanceUID }),
      });
      const data = await res.json();
      setTaskId(data.taskId);
      setStatus('running');
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedAlgo, servicesManager]);

  const handleDisplay = useCallback(async () => {
    if (!taskId) return;
    const { segmentationService, viewportGridService, displaySetService } = servicesManager.services;

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
      if (!activeViewportId) { setError('No active viewport'); return; }
      const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
      if (!displaySetUIDs?.length) { setError('No display sets'); return; }
      const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
      if (!displaySet) { setError('No display set'); return; }

      const segments: Record<number, { label: string; active: boolean }> = {};
      for (const [idx, label] of Object.entries(labels)) {
        segments[Number(idx)] = { label: label as string, active: true };
      }

      console.log('[AlgoPanel] resultData length:', resultData.length, 'non-zero:', resultData.filter(v => v > 0).length);
      console.log('[AlgoPanel] labels:', labels, 'segments:', segments);
      console.log('[AlgoPanel] displaySet:', displaySet.StudyInstanceUID, displaySet.SeriesInstanceUID);

      const segId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segments,
        label: `Algorithm: ${selectedAlgo}`,
      });
      console.log('[AlgoPanel] segId:', segId);

      // Write labelmap data using Cornerstone Tools segmentation API
      const cstSegmentation = await import('@cornerstonejs/tools').then(m => m.segmentation);
      const csSegmentation = cstSegmentation.state.getSegmentation(segId);
      console.log('[AlgoPanel] csSegmentation:', csSegmentation?.representationData ? 'has data' : 'no data');

      if (csSegmentation?.representationData?.Labelmap) {
        const labelmapData = csSegmentation.representationData.Labelmap as any;
        const { cache: csCache } = await import('@cornerstonejs/core');

        // Try volume-based approach first
        const volumeId = labelmapData.volumeId;
        if (volumeId) {
          const labelmapVolume = csCache.getVolume(volumeId);
          if (labelmapVolume?.voxelManager) {
            const scalarData = labelmapVolume.voxelManager.getScalarData();
            const len = Math.min(scalarData.length, resultData.length);
            let written = 0;
            for (let i = 0; i < len; i++) {
              if (resultData[i] > 0) { scalarData[i] = resultData[i]; written++; }
            }
            labelmapVolume.voxelManager.setScalarData(scalarData);
            console.log('[AlgoPanel] volume written:', written);
          }
        }

        // Try image-based approach
        const imageIds: string[] = labelmapData.imageIds || [];
        if (imageIds.length > 0) {
          const sliceSize = Math.floor(resultData.length / imageIds.length);
          let written = 0;
          let imagesFound = 0;
          for (let i = 0; i < imageIds.length; i++) {
            const image = csCache.getImage(imageIds[i]);
            if (image) {
              imagesFound++;
              const pixelData = image.getPixelData();
              if (pixelData) {
                const start = i * sliceSize;
                const end = Math.min(start + pixelData.length, resultData.length);
                for (let j = 0; j < end - start; j++) {
                  if (resultData[start + j] > 0) { pixelData[j] = resultData[start + j]; written++; }
                }
                // Mark image as modified so Cornerstone picks up changes
                if (typeof (image as any).setPixelData === 'function') {
                  (image as any).setPixelData(pixelData);
                }
              }
            }
          }
          console.log('[AlgoPanel] image-based written:', written, 'imagesFound:', imagesFound, '/', imageIds.length, 'sliceSize:', sliceSize);
        }

        // Force render all viewports
        const cs = await import('@cornerstonejs/core');
        const { viewportGridService: vgs } = servicesManager.services;
        const { viewports } = vgs.getState();
        console.log('[AlgoPanel] rendering viewports:', viewports?.length);
        viewports?.forEach((v: any) => {
          try {
            const el = cs.getEnabledElementByViewportId(v.viewportId);
            if (el?.viewport) {
              console.log('[AlgoPanel] rendering viewport:', v.viewportId);
              el.viewport.render();
            }
          } catch {}
        });
      } else {
        console.log('[AlgoPanel] No LABELMAP representation data found');
        setError('Segmentation data not ready');
        return;
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [taskId, selectedAlgo, servicesManager]);

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>Algorithm Processing</h3>
      <div style={{ marginBottom: 12 }}>
        <select
          value={selectedAlgo}
          onChange={e => setSelectedAlgo(e.target.value)}
          style={{ width: '100%', padding: '6px 8px', borderRadius: 4, background: '#2c2c2c', color: '#fff', border: '1px solid #555' }}
        >
          <option value="">-- Select --</option>
          {algorithms.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <button
        onClick={handleRun}
        disabled={!selectedAlgo || status === 'running'}
        style={{ width: '100%', padding: 8, borderRadius: 4, border: 'none', background: selectedAlgo ? '#329ce8' : '#555', color: '#fff', cursor: 'pointer', fontSize: 13 }}
      >
        {status === 'running' ? 'Processing...' : 'Run'}
      </button>
      {status && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6 }}>{status} ({progress}%)</div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: status === 'success' ? '#4caf50' : status === 'failed' ? '#f44336' : '#329ce8', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
      {status === 'success' && (
        <button onClick={handleDisplay} style={{ width: '100%', marginTop: 12, padding: 8, borderRadius: 4, border: 'none', background: '#4caf50', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
          Display Result
        </button>
      )}
      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}
    </div>
  );
}
