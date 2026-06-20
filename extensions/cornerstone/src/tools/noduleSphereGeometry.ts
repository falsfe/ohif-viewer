// 肺结节球体-切片截面纯几何函数(无副作用、无外部依赖,便于单测)
// 所有坐标为世界坐标(mm),向量为 [x, y, z]。

export type Vec3 = [number, number, number];

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

/**
 * 计算球体被一个无限大平面切出的截面圆。
 *
 * @param sphereCenter  球心(世界坐标 mm)
 * @param sphereRadius  球半径(mm)
 * @param planePoint    切片平面上一点(通常用相机位置)
 * @param planeNormal   切片平面法线(单位向量,通常用 viewPlaneNormal)
 * @returns 截面圆 { center(世界坐标, 在平面上), radius(mm) },或 null(切不到)
 */
export function sliceSphere(
  sphereCenter: Vec3,
  sphereRadius: number,
  planePoint: Vec3,
  planeNormal: Vec3
): { center: Vec3; radius: number } | null {
  // 有符号距离 d = (C - P) · n
  const d = dot(sub(sphereCenter, planePoint), planeNormal);
  const absD = Math.abs(d);

  // 切不到(含相切:截面退化为点,本实现按 null 处理)
  if (absD >= sphereRadius) {
    return null;
  }

  // 截面半径 r = √(R² - d²)
  const radius = Math.sqrt(sphereRadius * sphereRadius - absD * absD);

  // 截面圆心 = 球心投影到平面 = C - d·n
  const center = sub(sphereCenter, scale(planeNormal, d));

  return { center, radius };
}
