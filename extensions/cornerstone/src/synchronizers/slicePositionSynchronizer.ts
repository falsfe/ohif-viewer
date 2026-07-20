import { SynchronizerManager, Synchronizer } from '@cornerstonejs/tools';
import { EVENTS, getRenderingEngine } from '@cornerstonejs/core';

// 只同步切片位置(camera position)+ 方向(viewPlaneNormal/viewUp),
// 不同步缩放(parallelScale)。这样两个不同大小的 study 各自充满视口、又能同步切同一解剖位置。
const slicePositionSyncCallback = (
  synchronizerInstance: Synchronizer,
  sourceViewport: any,
  targetViewport: any
) => {
  const renderingEngine = getRenderingEngine(targetViewport.renderingEngineId);
  if (!renderingEngine) return;
  const sViewport = renderingEngine.getViewport(sourceViewport.viewportId);
  const tViewport = renderingEngine.getViewport(targetViewport.viewportId);
  if (!sViewport?.getCamera || !tViewport?.getCamera) return;

  const sCamera = sViewport.getCamera();
  const tCamera = tViewport.getCamera();
  if (!sCamera || !tCamera) return;

  // 覆盖 position + focalPoint + 方向(切切片需 position 和 focalPoint 一起沿法线移动),
  // 保留 tCamera 其他(尤其 parallelScale 缩放各自独立 → 各自充满视口)
  tViewport.setCamera({
    ...tCamera,
    position: [...sCamera.position],
    focalPoint: [...(sCamera.focalPoint || tCamera.focalPoint)],
    viewPlaneNormal: sCamera.viewPlaneNormal,
    viewUp: sCamera.viewUp,
  });
  tViewport.render();
};

const createSlicePositionSynchronizer = (synchronizerName: string): Synchronizer =>
  SynchronizerManager.createSynchronizer(
    synchronizerName,
    EVENTS.CAMERA_MODIFIED,
    slicePositionSyncCallback,
  );

export { createSlicePositionSynchronizer };
