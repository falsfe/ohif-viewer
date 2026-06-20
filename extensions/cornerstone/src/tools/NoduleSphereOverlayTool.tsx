import { AnnotationDisplayTool, drawing } from '@cornerstonejs/tools';
import { sliceSphere, sub, length, Vec3 } from './noduleSphereGeometry';

// 工具配置的数据结构(对应第一阶段 metadata.nodules[i] 的字段)
interface NoduleData {
  nodule_id: number;
  inscribed_center_x_mm: number;
  inscribed_center_y_mm: number;
  inscribed_center_z_mm: number;
  inscribed_diameter_mm: number;
  circumscribed_center_x_mm: number;
  circumscribed_center_y_mm: number;
  circumscribed_center_z_mm: number;
  circumscribed_diameter_mm: number;
}

interface NoduleSphereConfiguration {
  nodules: NoduleData[];
  showInscribed: boolean;
  showCircumscribed: boolean;
}

const INSCRIBED_COLOR = '#00BFFF'; // 蓝
const CIRCUMSCRIBED_COLOR = '#FF4444'; // 红
const STROKE_WIDTH = 2;

/**
 * 在 CT 视口上叠加显示结节的内切球/外接球截面圆。
 * - 继承 AnnotationDisplayTool:renderAnnotation 由 Cornerstone 每帧自动调用,
 *   切片滚动/缩放/平移时圆会自动重算,无需手动监听事件。
 * - 数据通过 configuration.nodules 传入(面板 Run 成功后注入)。
 * - 通过 toolGroup.setToolEnabled / setToolDisabled 显示/隐藏。
 */
class NoduleSphereOverlayTool extends AnnotationDisplayTool {
  static toolName = 'NoduleSphereOverlay';

  constructor(toolProps = {}, defaultToolProps = { supportedInteractionTypes: [] }) {
    super(toolProps, defaultToolProps);
  }

  onSetToolDisabled = (): void => {};

  renderAnnotation = (enabledElement, svgDrawingHelper): void => {
    const { viewport } = enabledElement;
    const cfg = (this.configuration || {}) as Partial<NoduleSphereConfiguration>;
    const nodules = cfg.nodules || [];
    if (!nodules.length) return;

    const camera = viewport.getCamera?.();
    const P = camera?.position as Vec3 | undefined;
    const n = camera?.viewPlaneNormal as Vec3 | undefined;
    if (!P || !n) return;

    // 画布 1 像素 = 多少 mm(canvasToWorld 技巧,ViewportOrientationMarkers 同款)
    const w0 = viewport.canvasToWorld?.([0, 0]) as Vec3;
    const w1 = viewport.canvasToWorld?.([1, 0]) as Vec3;
    if (!w0 || !w1) return;
    const mmPerPixel = length(sub(w0, w1));
    if (!mmPerPixel || !Number.isFinite(mmPerPixel)) return;

    for (const nd of nodules) {
      if (cfg.showInscribed) {
        this._drawSphere(
          viewport,
          svgDrawingHelper,
          [nd.inscribed_center_x_mm, nd.inscribed_center_y_mm, nd.inscribed_center_z_mm],
          nd.inscribed_diameter_mm / 2,
          INSCRIBED_COLOR,
          P,
          n,
          mmPerPixel,
          `nodule-${nd.nodule_id}-inscribed`
        );
      }
      if (cfg.showCircumscribed) {
        this._drawSphere(
          viewport,
          svgDrawingHelper,
          [
            nd.circumscribed_center_x_mm,
            nd.circumscribed_center_y_mm,
            nd.circumscribed_center_z_mm,
          ],
          nd.circumscribed_diameter_mm / 2,
          CIRCUMSCRIBED_COLOR,
          P,
          n,
          mmPerPixel,
          `nodule-${nd.nodule_id}-circumscribed`
        );
      }
    }
  };

  private _drawSphere(
    viewport,
    svgDrawingHelper,
    sphereCenter: Vec3,
    sphereRadius: number,
    color: string,
    planePoint: Vec3,
    planeNormal: Vec3,
    mmPerPixel: number,
    hashId: string
  ): void {
    const slice = sliceSphere(sphereCenter, sphereRadius, planePoint, planeNormal);
    if (!slice) return; // 这层切不到该球

    const canvasXY = viewport.worldToCanvas?.(slice.center);
    if (!canvasXY) return;
    const [cx, cy] = canvasXY;
    const rPixel = slice.radius / mmPerPixel;

    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(rPixel)) return;

    const svgns = 'http://www.w3.org/2000/svg';
    const attributes = {
      'data-id': hashId,
      cx,
      cy,
      r: rPixel,
      fill: 'none',
      stroke: color,
      'stroke-width': STROKE_WIDTH,
    };

    const existing = svgDrawingHelper.getSvgNode(hashId);
    if (existing) {
      drawing.setAttributesIfNecessary(attributes, existing);
      svgDrawingHelper.setNodeTouched(hashId);
    } else {
      const circle = document.createElementNS(svgns, 'circle');
      drawing.setNewAttributesIfValid(attributes, circle);
      svgDrawingHelper.appendNode(circle, hashId);
    }
  }
}

export default NoduleSphereOverlayTool;
