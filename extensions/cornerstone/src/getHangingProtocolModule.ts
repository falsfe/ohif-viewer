import { fourUp } from './hps/fourUp';
import { main3D } from './hps/main3D';
import { mpr } from './hps/mpr';
import { mprAnd3DVolumeViewport } from './hps/mprAnd3DVolumeViewport';
import { only3D } from './hps/only3D';
import { primary3D } from './hps/primary3D';
import { primaryAxial } from './hps/primaryAxial';
import { frameView } from './hps/frameView';
import { lungCompareAxial1x2, lungCompareCoronal1x2, lungCompareSagittal1x2, lungCompare3D1x2 } from './hps/lungCompare1x2';

function getHangingProtocolModule() {
  return [
    {
      name: mpr.id,
      protocol: mpr,
    },
    {
      name: mprAnd3DVolumeViewport.id,
      protocol: mprAnd3DVolumeViewport,
    },
    {
      name: fourUp.id,
      protocol: fourUp,
    },
    {
      name: main3D.id,
      protocol: main3D,
    },
    {
      name: primaryAxial.id,
      protocol: primaryAxial,
    },
    {
      name: only3D.id,
      protocol: only3D,
    },
    {
      name: primary3D.id,
      protocol: primary3D,
    },
    {
      name: frameView.id,
      protocol: frameView,
    },
    {
      name: lungCompareAxial1x2.id,
      protocol: lungCompareAxial1x2,
    },
    {
      name: lungCompareCoronal1x2.id,
      protocol: lungCompareCoronal1x2,
    },
    {
      name: lungCompareSagittal1x2.id,
      protocol: lungCompareSagittal1x2,
    },
    {
      name: lungCompare3D1x2.id,
      protocol: lungCompare3D1x2,
    },
  ];
}

export default getHangingProtocolModule;
