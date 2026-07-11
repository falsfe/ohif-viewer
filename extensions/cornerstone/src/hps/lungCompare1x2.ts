import { Types } from '@ohif/core';

// 专门给"肺分割对比"用的 1×2 双 2D 布局:两个轴位 volume(切片)视口,
// 用户把术前/术后 study 分别拖到左右,鼠标滚轮切切片看左右肺分割。
// 不含 3D 视口,避免滚轮变旋转;两视口独立(不 sync)便于对比两个不同 study。
const ctMatching = [
  { weight: 1, attribute: 'isReconstructable', constraint: { equals: true }, required: true },
  { attribute: 'Modality', constraint: { equals: { value: 'CT' } }, required: true },
];

export const lungCompare1x2: Types.HangingProtocol.Protocol = {
  id: 'lungCompare1x2',
  locked: true,
  name: '肺对比 1×2',
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
      name: '1x2 axial',
      viewportStructure: {
        layoutType: 'grid',
        properties: { rows: 1, columns: 2 },
      },
      viewports: [
        {
          viewportOptions: {
            viewportId: 'compare-left',
            toolGroupId: 'mpr',
            viewportType: 'volume',
            orientation: 'axial',
            initialImageOptions: { preset: 'middle' },
          },
          displaySets: [{ id: 'ds0' }],
        },
        {
          viewportOptions: {
            viewportId: 'compare-right',
            toolGroupId: 'mpr',
            viewportType: 'volume',
            orientation: 'axial',
            initialImageOptions: { preset: 'middle' },
          },
          displaySets: [{ id: 'ds1' }],
        },
      ],
    },
  ],
};
