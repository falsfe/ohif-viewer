import update from 'immutability-helper';
import { ToolbarService, utils } from '@ohif/core';

import initToolGroups from './initToolGroups';
import toolbarButtons from './toolbarButtons';
import { id } from './id';

const { TOOLBAR_SECTIONS } = ToolbarService;
const { structuredCloneWithFunctions } = utils;

export const NON_IMAGE_MODALITIES = ['SEG', 'RTSTRUCT', 'RTPLAN', 'PR', 'SR'];

export const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  thumbnailList: '@ohif/extension-default.panelModule.seriesList',
  hangingProtocol: '@ohif/extension-cornerstone.hangingProtocolModule.mprAnd3DVolumeViewport',
  wsiSopClassHandler:
    '@ohif/extension-cornerstone.sopClassHandlerModule.DicomMicroscopySopClassHandler',
};

export const cornerstone = {
  measurements: '@ohif/extension-cornerstone.panelModule.panelMeasurement',
  algorithm: '@ohif/extension-cornerstone.panelModule.panelAlgorithm',
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
};

export const extensionDependencies = {
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
};

export const sopClassHandlers = [
  ohif.sopClassHandler,
  ohif.wsiSopClassHandler,
];

export function isValidMode({ modalities }) {
  const modalities_list = modalities.split('\\');

  if (this.modeModalities?.length) {
    for (const modeModality of this.modeModalities) {
      if (Array.isArray(modeModality) && modeModality.every(m => modalities.indexOf(m) !== -1)) {
        return { valid: true, description: `Matches ${modeModality.join(', ')}` };
      } else if (modalities.indexOf(modeModality)) {
        return { valid: true, description: `Matches ${modeModality}` };
      }
    }
    return {
      valid: false,
      description: `None of the mode modalities match: ${JSON.stringify(this.modeModalities)}`,
    };
  }

  return {
    valid: !!modalities_list.find(modality => this.nonModeModalities.indexOf(modality) === -1),
    description: `The mode does not support studies that ONLY include the following modalities: ${this.nonModeModalities.join(', ')}`,
  };
}

export function onModeEnter({
  servicesManager,
  extensionManager,
  commandsManager,
  panelService,
  segmentationService,
}: withAppTypes) {
  const { measurementService, toolbarService, toolGroupService, customizationService } =
    servicesManager.services;

  measurementService.clearMeasurements();

  initToolGroups(extensionManager, toolGroupService, commandsManager);

  toolbarService.register(this.toolbarButtons);

  for (const [key, section] of Object.entries(this.toolbarSections)) {
    toolbarService.updateSection(key, section);
  }

  if (!this.enableSegmentationEdit) {
    customizationService.setCustomizations({
      'panelSegmentation.disableEditing': {
        $set: true,
      },
    });
  }

  if (this.activatePanelTrigger) {
    this._activatePanelTriggersSubscriptions = [
      ...panelService.addActivatePanelTriggers(
        cornerstone.measurements,
        [
          {
            sourcePubSubService: measurementService,
            sourceEvents: [
              measurementService.EVENTS.MEASUREMENT_ADDED,
              measurementService.EVENTS.RAW_MEASUREMENT_ADDED,
            ],
          },
        ],
        true
      ),
      true,
    ];
  }
}

export function onModeExit({ servicesManager }: withAppTypes) {
  const {
    toolGroupService,
    syncGroupService,
    segmentationService,
    cornerstoneViewportService,
    uiDialogService,
    uiModalService,
  } = servicesManager.services;

  this._activatePanelTriggersSubscriptions.forEach(sub => sub.unsubscribe());
  this._activatePanelTriggersSubscriptions.length = 0;

  uiDialogService.hideAll();
  uiModalService.hide();
  toolGroupService.destroy();
  syncGroupService.destroy();
  segmentationService.destroy();
  cornerstoneViewportService.destroy();
}

export const toolbarSections = {
  [TOOLBAR_SECTIONS.primary]: [
    'Length',
    'WindowLevel',
    'Zoom',
    'Pan',
    'TrackballRotate',
    'Crosshairs',
    'Reset',
    'Capture',
  ],

  [TOOLBAR_SECTIONS.viewportActionMenu.topLeft]: ['orientationMenu'],

  [TOOLBAR_SECTIONS.viewportActionMenu.bottomRight]: ['windowLevelMenu'],

  [TOOLBAR_SECTIONS.viewportActionMenu.bottomLeft]: ['dataOverlayMenu'],
};

export const volume3DLayout = {
  id: ohif.layout,
  props: {
    leftPanels: [ohif.thumbnailList],
    leftPanelResizable: true,
    rightPanels: [cornerstone.algorithm, cornerstone.measurements],
    rightPanelClosed: true,
    rightPanelResizable: true,
    viewports: [
      {
        namespace: cornerstone.viewport,
        displaySetsToDisplay: [
          ohif.sopClassHandler,
          ohif.wsiSopClassHandler,
        ],
      },
    ],
  },
};

export function layoutTemplate() {
  return structuredCloneWithFunctions(this.layoutInstance);
}

export const volume3DRoute = {
  path: 'volume-3d',
  layoutTemplate,
  layoutInstance: volume3DLayout,
};

export const modeInstance = {
  id,
  routeName: 'volume-3d',
  hide: false,
  displayName: 'Volume 3D',
  _activatePanelTriggersSubscriptions: [],
  toolbarSections,

  onModeEnter,
  onModeExit,
  validationTags: {
    study: [],
    series: [],
  },

  isValidMode,
  routes: [volume3DRoute],
  extensions: extensionDependencies,
  hangingProtocol: 'mprAnd3DVolumeViewport',
  sopClassHandlers,
  toolbarButtons,
  enableSegmentationEdit: false,
  nonModeModalities: NON_IMAGE_MODALITIES,
};

export function modeFactory({ modeConfiguration }) {
  let modeInstance = this.modeInstance;
  if (modeConfiguration) {
    modeInstance = update(modeInstance, modeConfiguration);
  }
  return modeInstance;
}

export const mode = {
  id,
  modeFactory,
  modeInstance: { ...modeInstance, hide: false },
  extensionDependencies,
};

export default mode;
export { initToolGroups, toolbarButtons };
