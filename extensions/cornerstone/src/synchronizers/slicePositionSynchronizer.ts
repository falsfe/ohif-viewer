import { SynchronizerManager, Synchronizer } from '@cornerstonejs/tools';
import { EVENTS, getRenderingEngine } from '@cornerstonejs/core';

// 只同步切片位置: 把目标相机沿法线平移到源的切片深度,
// 不同步缩放(parallelScale)、也不同步平移(pan, 法线外的 focalPoint 分量)。
// 这样两个不同大小/不同原点的 study 各自充满、平移各自独立,又能同步切同一解剖位置。
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

  // 只同步"切片": 把目标相机沿法线方向平移,使其在法线上的投影深度 = 源的切片深度。
  // 不整块复制源的 position/focalPoint —— 那会顺带把源的平移(pan)带过去,让目标视口偏移、
  // 看起来"大小不对/没充满"。缩放(parallelScale)和法线外分量(pan)都保留目标自己的。
  // (前提: 两视口同方向、共享患者坐标系,如同一病人术前/术后。lungCompare 布局保证同方向。)
  const normal = sCamera.viewPlaneNormal as [number, number, number];
  if (!sCamera.focalPoint || !tCamera.focalPoint || !normal) return;
  const nLen = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sFP = sCamera.focalPoint as [number, number, number];
  const tFP = tCamera.focalPoint as [number, number, number];
  const tPos = tCamera.position as [number, number, number];
  const delta = dot(sFP, n) - dot(tFP, n); // 沿法线需要平移的世界坐标距离
  tViewport.setCamera({
    ...tCamera,
    position: [tPos[0] + delta * n[0], tPos[1] + delta * n[1], tPos[2] + delta * n[2]],
    focalPoint: [tFP[0] + delta * n[0], tFP[1] + delta * n[1], tFP[2] + delta * n[2]],
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
