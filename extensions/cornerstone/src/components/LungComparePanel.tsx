import React, { useState, useEffect } from 'react';

type Props = {
  servicesManager: any;
};

type Phase = '' | 'running' | 'done' | 'failed';

// 可选算法(术前/术后都用同一个)
const ALGOS = [
  { id: 'lung-parenchyma-seg', name: '左右肺分割(左/右肺)' },
  { id: 'lung-lobe-seg', name: '肺叶分割(5 叶)' },
];

// 布局循环切换列表(点"循环切换"按钮按顺序切方向:轴位→冠状→矢状→3D)
const LAYOUTS = [
  { id: 'lungCompareAxial1x2', name: '轴位对比', orientation: 'axial', viewportType: 'volume' },
  { id: 'lungCompareCoronal1x2', name: '冠状位对比', orientation: 'coronal', viewportType: 'volume' },
  { id: 'lungCompareSagittal1x2', name: '矢状位对比', orientation: 'sagittal', viewportType: 'volume' },
  { id: 'lungCompare3D1x2', name: '3D 对比', orientation: 'coronal', viewportType: 'volume3d' },
];

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
  // 当前选的算法 + 比对的两个视口(按 StudyDate: pre=早/post=晚)
  selectedAlgo: 'lung-parenchyma-seg',
  fastMode: false,
  volStats: { pre: null as any, post: null as any },
  layoutIndex: 0,
  layoutName: LAYOUTS[0].name,
  // 已创建的分割 { segId, displaySetUID }[]：术前/术后各一个。
  // 切布局(setProtocol / setDisplaySetsForViewport)会清掉表示且不会自动恢复,
  // 所以记录下来,在 grid 变化时按 displaySet 重新挂到对应视口。
  segs: [] as { segId: string; displaySetUID: string }[],
};

function stopPolling() {
  if (store.pollTimer) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
}

// --- 切布局后重新挂载分割 -----------------------------------------------------------------------
// 分割表示绑定在具体 viewportId 上。切布局(循环切换方向 / setProtocol / refill 重填 displaySet)
// 会让视口重建或重载数据,表示被清掉且不会自动回来——右侧分割就消失了。这里监听 grid 变化,
// 把记录的每个分割按 displaySet 重新挂到"显示该 displaySet 且非 3D 且还没挂"的视口上。
// 幂等:已有则跳过;3D 视口跳过(与原渲染逻辑一致,避免 surface 转换崩溃)。
let reapplyListenerSetup = false;

async function reapplySegmentations(): Promise<boolean> {
  if (!store.segs.length || !store.servicesManager) return false;
  const { viewportGridService, segmentationService } = store.servicesManager.services;
  const { viewports } = viewportGridService.getState();
  const cs = await import('@cornerstonejs/core');
  const { ViewportType } = await import('@cornerstonejs/core/enums');
  let pending = false;
  for (const [vpId, vp] of viewports ?? []) {
    const ds: string[] = vp?.displaySetInstanceUIDs || [];
    const el = cs.getEnabledElementByViewportId(vpId);
    if (!el?.viewport) { pending = true; continue; } // 视口还没 enable -> 稍后重试
    if (el.viewport.type === ViewportType.VOLUME_3D) continue; // 3D 跳过
    for (const seg of store.segs) {
      if (!ds.includes(seg.displaySetUID)) continue; // 只挂显示该 displaySet 的视口
      try {
        const existing = segmentationService.getSegmentationRepresentations(vpId);
        if (existing?.some((r: any) => r.segmentationId === seg.segId)) continue; // 已有则跳过
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: seg.segId,
          type: 'Labelmap' as const,
        });
        el.viewport.render();
      } catch {}
    }
  }
  return pending;
}

function setupReapplyOnLayoutChange() {
  if (reapplyListenerSetup || !store.servicesManager) return;
  const { viewportGridService } = store.servicesManager.services;
  // 切布局后 refill 要等 ~800ms 才 setDisplaySet,新视口也要时间 enable,所以多重试几次
  // (条件等待,不是写死延时),直到所有目标视口就绪并挂上分割。
  const attempt = (retriesLeft: number) => {
    reapplySegmentations().then(pending => {
      if (pending && retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 200);
    });
  };
  viewportGridService.subscribe(
    viewportGridService.EVENTS.GRID_STATE_CHANGED,
    () => attempt(20)
  );
  reapplyListenerSetup = true;
}

// 识别当前视口及其 displaySet，按 StudyDate 排序（pre=早 在前）
// 多视口显示同一 study 时只取第一个(去重),适配 2×2 等多视口布局
function getViewportsForCompare() {
  const { viewportGridService, displaySetService } = store.servicesManager.services;
  const { viewports } = viewportGridService.getState();
  const result: { viewportId: string; displaySet: any; studyDate: string }[] = [];
  const seenStudy = new Set<string>();
  for (const [vpId] of viewports ?? []) {
    const dsUIDs = viewportGridService.getDisplaySetsUIDsForViewport(vpId);
    if (!dsUIDs?.length) continue;
    const ds = displaySetService.getDisplaySetByUID(dsUIDs[0]);
    if (!ds?.StudyInstanceUID) continue;
    if (seenStudy.has(ds.StudyInstanceUID)) continue; // 同 study 只取第一个视口
    seenStudy.add(ds.StudyInstanceUID);
    result.push({ viewportId: vpId, displaySet: ds, studyDate: ds.StudyDate || '' });
  }
  result.sort((a, b) => (a.studyDate || '').localeCompare(b.studyDate || ''));
  return result;
}

// 切换到 1×2 双 2D 对比布局(专用 hangingProtocol,不受 3D 视口影响)
function switchToCompareLayout() {
  const sm = store.servicesManager;
  if (!sm) return;
  const vps = getViewportsForCompare();  // 记术前/术后
  try {
    sm.services.hangingProtocolService?.setProtocol?.('lungCompareAxial1x2');
    store.layoutIndex = 0;
    store.layoutName = LAYOUTS[0].name;
    refillCompareViewports(vps);  // 自动重填 + 充满
  } catch (e: any) {
    store.error = `切换布局失败：${e?.message || '未知'}`;
  }
}

// 循环切换布局:点一下切到下一个方向(轴位→冠状→矢状→3D→循环)。
// 2D 之间:就地改方向,每个视口的 displaySet 原封不动 —— 避免 setProtocol 重新匹配
//   (它会因为 ds0/ds1 规则相同而把同一序列挂到两个视口)再 refill 重载,造成"等一下再缩放"。
// 3D:需要 CT preset + 专用 toolGroup,只能走完整 setProtocol(接受一次性重载)。
function switchNextLayout() {
  const sm = store.servicesManager;
  if (!sm) return;
  const cur = LAYOUTS[store.layoutIndex];
  store.layoutIndex = (store.layoutIndex + 1) % LAYOUTS.length;
  const next = LAYOUTS[store.layoutIndex];
  store.layoutName = next.name;

  // 只要涉及 3D(从 3D 切走 或 切到 3D)就走完整 setProtocol:
  //  3D 需要 CT-Bone preset + volume3d toolGroup;且 3D 的 viewportOptions(volume3d 工具组、
  //  hideOverlays)绝不能残留到 2D,否则 2D 视口拿错工具组渲染不出图像(Crosshairs 未注册报错)。
  const involves3D = cur.viewportType === 'volume3d' || next.viewportType === 'volume3d';
  if (involves3D) {
    const vps = getViewportsForCompare();
    try {
      sm.services.hangingProtocolService?.setProtocol?.(next.id);
      refillCompareViewports(vps);
    } catch (e: any) {
      store.error = `切换布局失败：${e?.message || '未知'}`;
    }
    return;
  }

  // 2D 之间:就地改方向,保留每个视口当前序列(不重新匹配、不重载、不抖动)
  const { viewportGridService } = sm.services;
  const { viewports } = viewportGridService.getState();
  for (const [vpId, vp] of viewports ?? []) {
    const dsUIDs = viewportGridService.getDisplaySetsUIDsForViewport(vpId) || [];
    if (!dsUIDs.length) continue;
    try {
      viewportGridService.setDisplaySetsForViewport({
        viewportId: vpId,
        displaySetInstanceUIDs: dsUIDs,
        viewportOptions: {
          ...(vp?.viewportOptions || {}),
          orientation: next.orientation,
          viewportType: next.viewportType,
        },
      });
    } catch (e: any) {
      store.error = `切换方向失败：${e?.message || '未知'}`;
    }
  }
}

// 切换布局后自动重填 displaySet(早=左/晚=右),保留用户选的术前/术后序列。
// 不再 resetCamera: 旧 reset 是为"会顺带同步缩放/平移的同步器"打补丁; 现在同步器已改成
// 只同步切片、数学上不动缩放和平移,各视口加载时各自充满即可,reset 反而造成"等一下再缩放"。
function refillCompareViewports(vps: { displaySet: any }[] | null) {
  if (!vps || vps.length < 2) { console.log('[LungCompare] refill: 不足2个视口有数据'); return; }
  const uids = vps.map(v => v.displaySet?.displaySetInstanceUID ?? v.displaySet?.UID);
  console.log('[LungCompare] refill displaySet UIDs:', uids);
  const { viewportGridService } = store.servicesManager.services;
  setTimeout(() => {
    const vpsState: any = viewportGridService.getState().viewports ?? [];
    const vpIds: string[] = [...vpsState].map(([id]: any) => id);
    console.log('[LungCompare] 当前视口 ids:', vpIds);
    try {
      if (vpIds.length >= 2 && uids[0] && uids[1]) {
        // 只在 displaySet 与目标不一致时才重设; 一致就跳过,避免无谓重载引发的"等一下再缩放"
        const setIfDifferent = (vpId: string, uid: string) => {
          const cur = viewportGridService.getDisplaySetsUIDsForViewport(vpId) || [];
          if (cur[0] !== uid) {
            console.log(`[LungCompare] refill 重设 ${vpId}: ${cur[0]} -> ${uid}(会触发重载+重新充满)`);
            viewportGridService.setDisplaySetsForViewport({ viewportId: vpId, displaySetInstanceUIDs: [uid] });
          } else {
            console.log(`[LungCompare] refill 跳过 ${vpId}: 已是 ${uid}(不重载,不抖动)`);
          }
        };
        setIfDifferent(vpIds[0], uids[0]);
        setIfDifferent(vpIds[1], uids[1]);
      } else {
        console.log('[LungCompare] refill 跳过: vpIds 或 uids 不足', vpIds, uids);
      }
    } catch (e) { console.error('[LungCompare] setDisplaySet failed', e); }
  }, 800);
}

// 对两个视口各跑选中的算法
async function runComparison() {
  const vps = getViewportsForCompare();
  if (vps.length < 2) {
    store.error = `需要 2 个视口各显示不同 study，当前 ${vps.length} 个。请先用布局图标布置 2 视口并拖入术前/术后 study。`;
    store.phase = 'failed';
    return;
  }

  stopPolling();
  store.phase = 'running';
  store.progress = 0;
  store.error = '';
  store.tasks = {};
  store.rendered = new Set<string>();
  store.volStats = { pre: null, post: null };
  store.segs = []; // 清掉上一轮的分割记录

  try {
    for (const vp of vps) {
      const res = await fetch('/api/algo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          algorithmId: store.selectedAlgo,
          studyInstanceUID: vp.displaySet.StudyInstanceUID,
          seriesInstanceUID: vp.displaySet.SeriesInstanceUID,
          params: store.fastMode ? { max_slices: 100 } : {},
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

    for (let idx = 0; idx < vps.length; idx++) {
      const vp = vps[idx];
      const taskId = store.tasks[vp.viewportId];
      if (!taskId) continue;
      count++;
      try {
        const r = await fetch(`/api/algo/tasks/${taskId}`);
        const data = await r.json();
        progressSum += data.progress || 0;

        if (data.status === 'success') {
          // 存真实体积统计(pre=idx0, post=idx1)
          const vs = data.metadata?.volume_stats || null;
          if (idx === 0) store.volStats.pre = vs;
          else if (idx === 1) store.volStats.post = vs;

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

// 在指定视口上渲染分割（按 viewportId 限定 scope,复用 AlgorithmPanel 逻辑）
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

    // 记录这个分割,以便切布局后按 displaySet 重新挂到对应视口
    if (!store.segs.some(s => s.segId === segId)) {
      store.segs.push({ segId, displaySetUID: displaySet.displaySetInstanceUID });
    }
    setupReapplyOnLayoutChange();

    const enabledEl = cs.getEnabledElementByViewportId(viewportId);
    if (enabledEl?.viewport) enabledEl.viewport.render();
  } catch (e: any) {
    store.error = `渲染失败：${e?.message || '未知错误'}`;
  }
}

// 体积行(左/右/总),统一用 left_lung_ml/right_lung_ml/total_ml
function VolRows({ stats }: { stats: any }) {
  if (!stats) return <div style={{ color: '#666', fontSize: 11 }}>无数据</div>;
  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '4px 0' };
  return (
    <>
      <div style={row}><span>左肺</span><span>{stats.left_lung_ml?.toFixed?.(2) ?? '-'}</span></div>
      <div style={row}><span>右肺</span><span>{stats.right_lung_ml?.toFixed?.(2) ?? '-'}</span></div>
      <div style={{ ...row, borderTop: '1px solid #333' }}>
        <span>总计</span><span style={{ fontWeight: 600 }}>{stats.total_ml?.toFixed?.(2) ?? '-'}</span>
      </div>
    </>
  );
}

export default function LungComparePanel({ servicesManager }: Props) {
  const [phase, setPhase] = useState<Phase>(store.phase);
  const [progress, setProgress] = useState(store.progress);
  const [error, setError] = useState(store.error);
  const [selectedAlgo, setSelectedAlgo] = useState(store.selectedAlgo);
  const [fastMode, setFastMode] = useState(store.fastMode);
  const [volStats, setVolStats] = useState(store.volStats);
  const [layoutName, setLayoutName] = useState(store.layoutName);

  store.servicesManager = servicesManager;
  useEffect(() => { store.selectedAlgo = selectedAlgo; }, [selectedAlgo]);
  useEffect(() => { store.fastMode = fastMode; }, [fastMode]);

  useEffect(() => {
    const sync = setInterval(() => {
      setPhase(store.phase);
      setProgress(store.progress);
      setError(store.error);
      setVolStats({ pre: store.volStats.pre, post: store.volStats.post });
      setLayoutName(store.layoutName);
    }, 300);
    return () => clearInterval(sync);
  }, []);

  const isBusy = phase === 'running';
  const pre = volStats.pre, post = volStats.post;
  const hasBoth = pre && post && pre.total_ml != null && post.total_ml != null;
  const delta = hasBoth ? post.total_ml - pre.total_ml : 0;
  const leftDelta = hasBoth ? (post.left_lung_ml ?? 0) - (pre.left_lung_ml ?? 0) : 0;
  const rightDelta = hasBoth ? (post.right_lung_ml ?? 0) - (pre.right_lung_ml ?? 0) : 0;

  const colStyle: React.CSSProperties = { flex: 1, background: '#1c1c1c', borderRadius: 6, padding: 10, fontSize: 12 };

  return (
    <div style={{ padding: 16, color: '#fff', height: '100%', overflowY: 'auto' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: 14 }}>肺体积对比</h3>

      {/* 一键切换 1×2 双 2D 对比布局 */}
      <button
        onClick={() => switchToCompareLayout()}
        style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, border: '1px solid #329ce8', background: 'transparent', color: '#329ce8', cursor: 'pointer', fontSize: 12 }}
      >
        ⊕ 切换到 1×2 对比布局(双轴位 2D)
      </button>

      {/* 循环切换布局 */}
      <button
        onClick={() => switchNextLayout()}
        style={{ width: '100%', padding: 6, marginBottom: 12, borderRadius: 4, border: '1px solid #888', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 12 }}
      >
        ⬅️➡️ 切换布局(当前: {layoutName})
      </button>

      {/* 算法选择 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>分割算法</div>
        <select
          value={selectedAlgo}
          onChange={e => setSelectedAlgo(e.target.value)}
          disabled={isBusy}
          style={{ width: '100%', padding: '6px 8px', borderRadius: 4, background: '#2c2c2c', color: '#fff', border: '1px solid #555' }}
        >
          {ALGOS.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {/* 快速模式 */}
      <label style={{ display: 'flex', alignItems: 'center', fontSize: 12, color: '#ccc', marginBottom: 10 }}>
        <input type="checkbox" checked={fastMode} onChange={e => setFastMode(e.target.checked)} disabled={isBusy} style={{ marginRight: 6 }} />
        快速模式(只跑中间100片,约2分钟/侧,体积为估算)
      </label>

      <button
        onClick={() => runComparison()}
        disabled={isBusy}
        style={{ width: '100%', padding: 8, borderRadius: 4, border: 'none', background: isBusy ? '#555' : '#329ce8', color: '#fff', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: 13 }}
      >
        {isBusy ? `对比中 (${progress}%)` : phase === 'done' ? '重新对比' : '运行对比'}
      </button>

      {isBusy && (
        <div style={{ marginTop: 12 }}>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#329ce8', transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#ccc', marginTop: 4 }}>对术前/术后各跑分割中…</div>
        </div>
      )}

      {phase === 'done' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={colStyle}>
              <div style={{ color: '#9ad', marginBottom: 4, fontWeight: 600 }}>术前 Pre</div>
              <VolRows stats={pre} />
            </div>
            <div style={colStyle}>
              <div style={{ color: '#da9', marginBottom: 4, fontWeight: 600 }}>术后 Post</div>
              <VolRows stats={post} />
            </div>
          </div>
          {hasBoth && (() => {
            const rows = [
              { label: '左肺变化', d: leftDelta, base: pre.left_lung_ml },
              { label: '右肺变化', d: rightDelta, base: pre.right_lung_ml },
              { label: '总体积变化', d: delta, base: pre.total_ml, last: true },
            ];
            return (
              <div style={{ background: '#2a2a3a', borderRadius: 6, padding: 10, marginTop: 8, fontSize: 12 }}>
                {rows.map(r => {
                  const pct = r.base ? ((r.d / r.base) * 100).toFixed(1) : '0';
                  return (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: r.last ? '1px solid #444' : 'none', fontWeight: r.last ? 700 : 400 }}>
                      <span>{r.label} Δ</span>
                      <span style={{ color: r.d < 0 ? '#ff6b6b' : '#6bff6b' }}>
                        {r.d > 0 ? '+' : ''}{r.d.toFixed(2)} mL ({pct}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {post?.lobes && (
            <div style={{ fontSize: 10, color: '#999', marginTop: 8 }}>
              <div style={{ marginBottom: 2 }}>术后各叶:</div>
              {Object.entries(post.lobes).map(([k, v]: [string, any]) =>
                <div key={k}>{k}: {(v as any).volume_ml ?? v} mL</div>
              )}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>单位 mL</div>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}

      <div style={{ fontSize: 11, color: '#888', marginTop: 12 }}>
        先用顶部 Layout 图标布置 2 视口（1×2），分别拖入术前/术后 study，再点"运行对比"。
      </div>
    </div>
  );
}
