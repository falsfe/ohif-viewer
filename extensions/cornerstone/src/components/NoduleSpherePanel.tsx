import React, { useState, useEffect, useCallback } from 'react';

type Props = {
  servicesManager: any;
};

type Phase = '' | 'running' | 'done' | 'failed';

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

// 模块级 state:面板切换/卸载时保留状态(复用 AlgorithmPanel 模式,像迷你 service)
const store = {
  phase: '' as Phase,
  progress: 0,
  error: '',
  taskId: null as string | null,
  nodules: [] as Nodule[],
  roiName: 'GTV-1',
  threshold: -160,
  mode: 'approx' as 'approx' | 'exact',
  pollTimer: null as ReturnType<typeof setInterval> | null,
};

function stopPolling() {
  if (store.pollTimer) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
}

// 后台轮询(独立于组件生命周期)。第一阶段关键差异:success 时直接读
// metadata.nodules,不调 /api/algo/result(本算法无 labelmap 二进制输出)
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
          store.phase = 'done';
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

  // store → React state 每 500ms 同步(复用 AlgorithmPanel:191-198)
  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
      setNodules(store.nodules);
    }, 500);
    return () => clearInterval(sync);
  }, []);

  // 控件值 → store
  useEffect(() => { store.roiName = roiName; }, [roiName]);
  useEffect(() => { store.threshold = threshold; }, [threshold]);
  useEffect(() => { store.mode = mode; }, [mode]);

  const handleRun = useCallback(async () => {
    setError('');
    setProgress(0);
    setPhase('running');
    store.phase = 'running';
    store.progress = 0;
    store.error = '';
    store.nodules = [];

    // 取活动视口的 displaySet(复用 AlgorithmPanel:216-222)
    const { viewportGridService, displaySetService } = servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { setError('No active viewport'); store.phase = 'failed'; return; }
    const dsUids = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!dsUids?.length) { setError('No display sets'); store.phase = 'failed'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(dsUids[0]);
    if (!displaySet?.StudyInstanceUID) { setError('No study found'); store.phase = 'failed'; return; }
    // 必须在 CT 视口上运行(后端把该 series 当 CT 下载,并把 RTSTRUCT 作为 mask)
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
          params: {
            roi_name: roiName,
            threshold,
            mode,
          },
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

  const isBusy = phase === 'running';

  const statusText = {
    '': '',
    running: `Running (${progress}%)`,
    done: 'Completed',
    failed: 'Failed',
  }[phase];

  const statusColor = {
    '': '#329ce8',
    running: '#329ce8',
    done: '#4caf50',
    failed: '#f44336',
  }[phase];

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    borderRadius: 4,
    background: '#2c2c2c',
    color: '#fff',
    border: '1px solid #555',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: '#ccc',
    display: 'block',
    marginBottom: 4,
  };

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>肺结节球体分析</h3>
      <p style={{ fontSize: 11, color: '#999', margin: '0 0 12px 0' }}>
        在 CT 视口上运行,后端自动从同一 study 找 RTSTRUCT 作为掩膜,计算每个结节的内切球/外接球与实性成分。
      </p>

      {/* 控件区 */}
      <label style={labelStyle}>ROI 名称(RTSTRUCT 中的结构名)</label>
      <input
        style={{ ...inputStyle, marginBottom: 10 }}
        value={roiName}
        onChange={e => setRoiName(e.target.value)}
        disabled={isBusy}
      />

      <label style={labelStyle}>实性阈值 (HU,高于此值算实性成分)</label>
      <input
        type="number"
        style={{ ...inputStyle, marginBottom: 10 }}
        value={threshold}
        onChange={e => setThreshold(Number(e.target.value))}
        disabled={isBusy}
      />

      <label style={labelStyle}>外接球算法</label>
      <div style={{ marginBottom: 12, fontSize: 12 }}>
        <label style={{ marginRight: 12 }}>
          <input
            type="radio"
            checked={mode === 'approx'}
            onChange={() => setMode('approx')}
            disabled={isBusy}
          />{' '}
          approx (快)
        </label>
        <label>
          <input
            type="radio"
            checked={mode === 'exact'}
            onChange={() => setMode('exact')}
            disabled={isBusy}
          />{' '}
          exact (精确,慢)
        </label>
      </div>

      <button
        onClick={handleRun}
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
        {isBusy ? 'Processing...' : phase === 'done' ? 'Re-run' : 'Run'}
      </button>

      {/* 进度(复用 AlgorithmPanel 视觉) */}
      {phase && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 12,
              color: statusColor,
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {isBusy && (
              <span
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  border: '2px solid #666',
                  borderTopColor: statusColor,
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
            )}
            {statusText}
          </div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${phase === 'done' ? 100 : progress}%`,
                height: '100%',
                background: statusColor,
                transition: 'width 0.3s',
              }}
            />
          </div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}

      {/* 结果表格:第一阶段核心产出 */}
      {phase === 'done' && nodules.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6 }}>共 {nodules.length} 个结节</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: '#1c1c1c' }}>
                {['#', '体积(mL)', '内切Ø(mm)', '外接Ø(mm)', '实性%', '球心 x/y/z (mm)'].map(h => (
                  <th
                    key={h}
                    style={{ padding: '4px 2px', textAlign: 'left', borderBottom: '1px solid #444' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {nodules.map(n => (
                <tr key={n.nodule_id}>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>{n.nodule_id}</td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>
                    {(n.volume_mm3 / 1000).toFixed(2)}
                  </td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>
                    {n.inscribed_diameter_mm.toFixed(1)}
                  </td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>
                    {n.circumscribed_diameter_mm.toFixed(1)}
                  </td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a' }}>
                    {(n.solid_volume_ratio * 100).toFixed(1)}
                  </td>
                  <td style={{ padding: '4px 2px', borderBottom: '1px solid #2a2a2a', fontSize: 10 }}>
                    {n.inscribed_center_x_mm.toFixed(0)} / {n.inscribed_center_y_mm.toFixed(0)} /{' '}
                    {n.inscribed_center_z_mm.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {phase === 'done' && nodules.length === 0 && (
        <p style={{ fontSize: 12, color: '#ff9800', marginTop: 8 }}>未检测到结节(mask 为空或 ROI 不匹配)。</p>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
