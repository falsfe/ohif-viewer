import React, { useState, useEffect } from 'react';

type Phase = '' | 'running' | 'done';

type Props = {
  servicesManager: any;
};

// 模块级 store：面板切换/卸载时保留状态（与 AlgorithmPanel 一致）
const store = {
  phase: '' as Phase,
  progress: 0,
  volumeData: {
    rightMl: 1234.56,
    leftMl: 1456.78,
    totalMl: 2691.34,
  },
  error: '',
  servicesManager: null as any, // 保留供后端 lung-volume 算法接入
  simTimer: null as ReturnType<typeof setInterval> | null,
};

function stopSim() {
  if (store.simTimer) {
    clearInterval(store.simTimer);
    store.simTimer = null;
  }
}

// 前端模拟运行（不调后端、不依赖 Algorithm 面板）：进度 0→100，完成后显示 mock 体积
function startRun() {
  stopSim();
  store.phase = 'running';
  store.progress = 0;
  store.error = '';
  let p = 0;
  store.simTimer = setInterval(() => {
    p += 8 + Math.random() * 12;
    if (p >= 100) {
      stopSim();
      store.progress = 100;
      store.phase = 'done';
    } else {
      store.progress = Math.floor(p);
    }
  }, 350);
}

export default function LungVolumePanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);

  // 保留 servicesManager 引用，供后端 lung-volume 算法接入时使用
  store.servicesManager = servicesManager;

  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
    }, 200);
    return () => clearInterval(sync);
  }, []);

  const isRunning = phase === 'running';
  const { rightMl, leftMl, totalMl } = store.volumeData;

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    fontSize: 13,
  };
  const swatchStyle = (color: string): React.CSSProperties => ({
    display: 'inline-block',
    width: 12,
    height: 12,
    background: color,
    marginRight: 8,
    borderRadius: 2,
    verticalAlign: 'middle',
  });

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 16px 0', fontSize: 14 }}>肺体积计算</h3>

      <button
        onClick={startRun}
        disabled={isRunning}
        style={{
          width: '100%',
          padding: 8,
          borderRadius: 4,
          border: 'none',
          background: isRunning ? '#555' : '#329ce8',
          color: '#fff',
          cursor: isRunning ? 'not-allowed' : 'pointer',
          fontSize: 13,
        }}
      >
        {isRunning ? 'Processing...' : phase === 'done' ? 'Re-run' : 'Run'}
      </button>

      {isRunning && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #666', borderTopColor: '#329ce8', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Running ({progress}%)
          </div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#329ce8', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ marginTop: 16 }}>
          <div style={{ background: '#1c1c1c', borderRadius: 6, padding: 12 }}>
            <div style={rowStyle}>
              <span><span style={swatchStyle('#ff3434')} />右肺 Right Lung</span>
              <span style={{ color: '#ff3434', fontWeight: 600 }}>{rightMl.toFixed(2)} mL</span>
            </div>
            <div style={rowStyle}>
              <span><span style={swatchStyle('#34ff34')} />左肺 Left Lung</span>
              <span style={{ color: '#34ff34', fontWeight: 600 }}>{leftMl.toFixed(2)} mL</span>
            </div>
            <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />
            <div style={rowStyle}>
              <span>总计 Total</span>
              <span style={{ fontWeight: 600 }}>{totalMl.toFixed(2)} mL</span>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
            * 当前为占位数据，后端算法接入后显示真实体积与红绿渲染
          </div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
