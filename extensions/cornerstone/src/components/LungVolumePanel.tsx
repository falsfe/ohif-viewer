import React, { useState, useEffect } from 'react';

type Props = {
  servicesManager: any;
};

// 模块级 store：面板切换/卸载时保留状态（与 AlgorithmPanel 一致）
const store = {
  volumeData: {
    rightMl: 1234.56,
    leftMl: 1456.78,
    totalMl: 2691.34,
  },
  applied: false,
  error: '',
  servicesManager: null as any,
};

// 按图像 X 中点把已加载的 labelmap 拆成左右肺两段，红/绿双色渲染
async function applyDualColor() {
  const { segmentationService, viewportGridService } = store.servicesManager.services;

  try {
    // 1. 找到已存在的 segmentation（由 AlgorithmPanel 运行产生）
    const segmentations = segmentationService.getSegmentations();
    if (!segmentations || segmentations.length === 0) {
      store.error = '请先在 Algorithm 面板运行分割算法';
      return;
    }
    const sourceSeg = segmentations[0];
    const sourceId = sourceSeg.segmentationId;

    // 2. 读取源 labelmap 体素数据与维度
    const cstSegmentation = await import('@cornerstonejs/tools').then(m => m.segmentation);
    const csSeg = cstSegmentation.state.getSegmentation(sourceId);
    const labelmapData = csSeg?.representationData?.Labelmap;
    if (!labelmapData?.volumeId) {
      store.error = '无法读取 labelmap 数据';
      return;
    }

    const { cache: csCache } = await import('@cornerstonejs/core');
    const srcVolume = csCache.getVolume(labelmapData.volumeId);
    if (!srcVolume?.voxelManager) {
      store.error = '无法读取体素数据';
      return;
    }
    const srcScalar = srcVolume.voxelManager.getScalarData();
    const dims = srcVolume.dimensions; // [dimX, dimY, dimZ]
    const [dimX, dimY, dimZ] = dims;
    const midX = Math.floor(dimX / 2);

    // 3. 创建新的双段 labelmap segmentation
    const { displaySetService } = store.servicesManager.services;
    const { activeViewportId } = viewportGridService.getState();
    if (!activeViewportId) { store.error = '无活动视口'; return; }
    const displaySetUIDs = viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);
    if (!displaySetUIDs?.length) { store.error = '无 display set'; return; }
    const displaySet = displaySetService.getDisplaySetByUID(displaySetUIDs[0]);
    if (!displaySet) { store.error = '无 display set'; return; }

    const segments = {
      1: { label: 'Right Lung', active: true },
      2: { label: 'Left Lung', active: true },
    };
    const newSegId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
      segments,
      label: 'Lung Volume Analysis',
    });

    // 4. 把拆分后的数据写入新 labelmap volume
    const newCsSeg = cstSegmentation.state.getSegmentation(newSegId);
    const newLabelmapData = newCsSeg?.representationData?.Labelmap;
    if (newLabelmapData?.volumeId) {
      const newVolume = csCache.getVolume(newLabelmapData.volumeId);
      if (newVolume?.voxelManager) {
        const newScalar = newVolume.voxelManager.getScalarData();
        // 按索引遍历：源>0 的体素，x<midX → 1(右肺)，否则 → 2(左肺)
        for (let z = 0; z < dimZ; z++) {
          for (let y = 0; y < dimY; y++) {
            const rowBase = y * dimX + z * dimX * dimY;
            for (let x = 0; x < dimX; x++) {
              const idx = rowBase + x;
              if (srcScalar[idx] > 0) {
                newScalar[idx] = x < midX ? 1 : 2;
              }
            }
          }
        }
        newVolume.voxelManager.setScalarData(newScalar);
      }
    }

    // 5. 设颜色：段1=右肺红，段2=左肺绿；添加表示并渲染
    const { viewports } = viewportGridService.getState();
    for (const [vpId] of viewports ?? []) {
      try {
        await segmentationService.addSegmentationRepresentation(vpId, {
          segmentationId: newSegId,
          type: 'Labelmap' as const,
        });
        segmentationService.setSegmentColor(vpId, newSegId, 1, [255, 52, 52, 255]);
        segmentationService.setSegmentColor(vpId, newSegId, 2, [52, 255, 52, 255]);
      } catch {}
    }

    const cs = await import('@cornerstonejs/core');
    viewports?.forEach((v: any) => {
      try {
        const el = cs.getEnabledElementByViewportId(v.viewportId);
        if (el?.viewport) el.viewport.render();
      } catch {}
    });

    store.applied = true;
    store.error = '';
  } catch (e: any) {
    store.error = e.message || '应用失败';
  }
}

export default function LungVolumePanel({ servicesManager }: Props) {
  const [applied, setApplied] = useState(store.applied);
  const [error, setError] = useState(store.error);

  // 保持 servicesManager 引用供模块级函数使用
  store.servicesManager = servicesManager;

  // 同步 store → React 状态（处理重新挂载）
  useEffect(() => {
    const sync = setInterval(() => {
      setApplied(store.applied);
      setError(store.error);
    }, 500);
    return () => clearInterval(sync);
  }, []);

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

      <div style={{ background: '#1c1c1c', borderRadius: 6, padding: 12, marginBottom: 12 }}>
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

      <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
        * 当前为占位数据，后端算法接入后显示真实体积
      </div>

      <button
        onClick={() => applyDualColor()}
        style={{
          width: '100%',
          padding: 8,
          borderRadius: 4,
          border: 'none',
          background: applied ? '#2e7d32' : '#329ce8',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        {applied ? '已应用（重新应用）' : '应用到当前影像'}
      </button>

      {error && <p style={{ fontSize: 12, color: '#f44336', marginTop: 8 }}>{error}</p>}
    </div>
  );
}
