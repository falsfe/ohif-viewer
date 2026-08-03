import { Types } from '@ohif/core';
import { VOI_SYNC_GROUP } from './mpr';

// 专门给"肺分割对比"用的 1×2 布局:两个视口各放一个 study(术前/术后),
// 按方向生成 4 个 protocol(轴位/冠状/矢状/3D),用户循环切换看不同方向的对比。
const ctMatching = [
  { weight: 1, attribute: 'isReconstructable', constraint: { equals: true }, required: true },
  { attribute: 'Modality', constraint: { equals: { value: 'CT' } }, required: true },
];

// 切片/视角同步:只同步切片位置、不同步缩放(自定义 sliceposition 同步器),
// 这样两个不同大小的 study 各自充满视口、又能同步切同一解剖位置。
const SLICE_SYNC_GROUP = {
  type: 'sliceposition',
  id: 'lungCompareSlice',
  source: true,
  target: true,
};

// 3D 相机同步:复制完整相机(旋转/视角/缩放),让左右两个 3D 体绘制一起转、一起晃。
// 2D 不能用这个(会把缩放也同步过去、破坏各自充满),所以只在 3D 协议用。
const CAMERA_3D_SYNC_GROUP = {
  type: 'cameraposition',
  id: 'lungCompare3DCamera',
  source: true,
  target: true,
};

// 3D 体绘制 preset(CT-Bone transfer function),没有它 volume3d 视口会退化成 2D
const CT_PRESET = { CT: 'CT-Bone', MR: 'MR-Default', default: 'CT-Bone' };

function makeCompareProtocol(
  id: string,
  name: string,
  orientation: string,
  viewportType: string,
  toolGroupId: string,
  is3D = false,
): Types.HangingProtocol.Protocol {
  const dsOptions = is3D ? { options: { displayPreset: CT_PRESET } } : {};
  // 2D 同步切片位置(各自充满);3D 同步相机(一起转)。3D 不能用 sliceposition——
  // 它会监听 CAMERA_MODIFIED 把目标沿法线推拉,旋转时反而造成两边乱动。
  const syncGroups = is3D
    ? [VOI_SYNC_GROUP, CAMERA_3D_SYNC_GROUP]
    : [VOI_SYNC_GROUP, SLICE_SYNC_GROUP];
  return {
    id,
    locked: true,
    name,
    createdDate: '2025-07-11T00:00:00.000Z',
    modifiedDate: '2025-07-11T00:00:00.000Z',
    availableTo: {},
    editableBy: {},
    protocolMatchingRules: [],
    imageLoadStrategy: 'interleaveCenter',
    displaySetSelectors: {
      ds0: { seriesMatchingRules: ctMatching },
      ds1: { seriesMatchingRules: ctMatching },
    },
    stages: [
      {
        id: 'compareStage',
        name,
        viewportStructure: {
          layoutType: 'grid',
          properties: { rows: 1, columns: 2 },
        },
        viewports: [
          {
            viewportOptions: {
              viewportId: 'compare-left',
              toolGroupId,
              viewportType,
              orientation,
              initialImageOptions: { preset: 'middle' },
              syncGroups,
              ...(is3D ? { customViewportProps: { hideOverlays: true } } : {}),
            },
            displaySets: [{ id: 'ds0', ...dsOptions }],
          },
          {
            viewportOptions: {
              viewportId: 'compare-right',
              toolGroupId,
              viewportType,
              orientation,
              initialImageOptions: { preset: 'middle' },
              syncGroups,
              ...(is3D ? { customViewportProps: { hideOverlays: true } } : {}),
            },
            displaySets: [{ id: 'ds1', ...dsOptions }],
          },
        ],
      },
    ],
  };
}

export const lungCompareAxial1x2 = makeCompareProtocol('lungCompareAxial1x2', '肺对比-轴位1×2', 'axial', 'volume', 'mpr');
export const lungCompareCoronal1x2 = makeCompareProtocol('lungCompareCoronal1x2', '肺对比-冠状位1×2', 'coronal', 'volume', 'mpr');
export const lungCompareSagittal1x2 = makeCompareProtocol('lungCompareSagittal1x2', '肺对比-矢状位1×2', 'sagittal', 'volume', 'mpr');
export const lungCompare3D1x2 = makeCompareProtocol('lungCompare3D1x2', '肺对比-3D1×2', 'coronal', 'volume3d', 'volume3d', true);
