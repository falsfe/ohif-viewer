import { sliceSphere, sub, dot, scale, length } from '../noduleSphereGeometry';

describe('noduleSphereGeometry', () => {
  it('球心在切片平面上 → 截面=球心, 半径=球半径', () => {
    // 球心 (0,0,0), 半径 5;平面过 (0,0,0), 法线 z 轴
    const r = sliceSphere([0, 0, 0], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(5, 5);
    expect(r!.center).toEqual([0, 0, 0]);
  });

  it('球心偏离平面但仍在切片范围内 → 截面半径变小', () => {
    // 球心 (0,0,3), 半径 5;平面 z=0, 法线 z 轴 → d=3, r=sqrt(25-9)=4
    const r = sliceSphere([0, 0, 3], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(4, 5);
    expect(r!.center).toEqual([0, 0, 0]); // 投影回平面
  });

  it('球心到平面距离 = 半径(相切) → 返回 null', () => {
    const r = sliceSphere([0, 0, 5], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).toBeNull();
  });

  it('球心到平面距离 > 半径(切不到) → 返回 null', () => {
    const r = sliceSphere([0, 0, 6], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).toBeNull();
  });

  it('球心在平面负法线侧也能正确计算(|d|)', () => {
    // 球心 (0,0,-3), 半径 5 → d=-3, |d|=3, r=4
    const r = sliceSphere([0, 0, -3], 5, [0, 0, 0], [0, 0, 1]);
    expect(r).not.toBeNull();
    expect(r!.radius).toBeCloseTo(4, 5);
  });

  it('向量运算: sub/dot/scale/length', () => {
    expect(sub([1, 2, 3], [4, 5, 6])).toEqual([-3, -3, -3]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
    expect(length([3, 4, 0])).toBeCloseTo(5, 5);
  });
});
