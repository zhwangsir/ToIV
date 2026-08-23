"""SCoPE 参数化相机轨迹生成器 —— 产出 [81,3,4] float32 OpenCV c2w .npy。

约定(与 examples/poses 一致):OpenCV camera-to-world,相对首帧(首帧 = 单位阵),
相机看向 +Z,X 右、Y 下。平移量级对标 examples 合成轨迹(dolly_in 全程 ~0.45)。
"""
from __future__ import annotations

import numpy as np

NUM_FRAMES = 81


def _smooth(t: np.ndarray) -> np.ndarray:
    """smoothstep 缓动:首尾速度为 0,运镜更自然。"""
    return t * t * (3.0 - 2.0 * t)


def _rot_y(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _rot_x(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _look_at(eye: np.ndarray, center: np.ndarray) -> np.ndarray:
    """OpenCV 约定 look-at:返回 3x3 旋转(列 = 相机 X右/Y下/Z前 的世界方向)。"""
    f = center - eye
    f = f / (np.linalg.norm(f) + 1e-12)
    up = np.array([0.0, -1.0, 0.0])  # Y 下 ⇒ 世界上方是 -Y
    r = np.cross(f, up)
    r = r / (np.linalg.norm(r) + 1e-12)
    d = np.cross(f, r)
    return np.stack([r, d, f], axis=1)


def _timeline() -> np.ndarray:
    return _smooth(np.linspace(0.0, 1.0, NUM_FRAMES, dtype=np.float64))


def _pose(R: np.ndarray, t: np.ndarray) -> np.ndarray:
    m = np.zeros((3, 4), dtype=np.float64)
    m[:, :3] = R
    m[:, 3] = t
    return m


def _identity_path() -> np.ndarray:
    return np.repeat(np.eye(3, 4)[None], NUM_FRAMES, axis=0)


def make_orbit(angle_deg: float = 25.0, depth: float = 2.0) -> np.ndarray:
    """环绕:相机在首帧前方 depth 处环绕场景中心扫过 ±angle_deg(正值 = 向左环绕)。"""
    center = np.array([0.0, 0.0, depth])
    p0 = np.zeros(3)
    out = []
    for s in _timeline():
        a = np.radians(angle_deg) * s
        eye = center + _rot_y(a) @ (p0 - center)
        out.append(_pose(_look_at(eye, center), eye))
    return np.stack(out)


def make_dolly(distance: float = 0.45) -> np.ndarray:
    """推拉:沿视线方向平移(正 = 推近)。"""
    out = []
    for s in _timeline():
        out.append(_pose(np.eye(3), np.array([0.0, 0.0, distance * s])))
    return np.stack(out)


def make_pan(angle_deg: float = 15.0) -> np.ndarray:
    """水平摇镜:纯偏航(正 = 向右看)。"""
    out = []
    for s in _timeline():
        out.append(_pose(_rot_y(np.radians(angle_deg) * s), np.zeros(3)))
    return np.stack(out)


def make_tilt(angle_deg: float = 10.0) -> np.ndarray:
    """俯仰:纯俯仰(正 = 向下看)。"""
    out = []
    for s in _timeline():
        out.append(_pose(_rot_x(np.radians(angle_deg) * s), np.zeros(3)))
    return np.stack(out)


def make_truck(distance: float = 0.3) -> np.ndarray:
    """平移:沿 X 轴(正 = 向右)。"""
    out = []
    for s in _timeline():
        out.append(_pose(np.eye(3), np.array([distance * s, 0.0, 0.0])))
    return np.stack(out)


def make_crane(distance: float = 0.3) -> np.ndarray:
    """升降:沿 Y 轴(正 = 向下,Y 下约定;升用负值)。"""
    out = []
    for s in _timeline():
        out.append(_pose(np.eye(3), np.array([0.0, distance * s, 0.0])))
    return np.stack(out)


# 全部生成式预设:name → 构造函数(角度/量级对齐 examples 合成轨迹的经验值)
GENERATED_PRESETS: dict[str, object] = {
    "orbit_left": lambda: make_orbit(+25.0),
    "orbit_right": lambda: make_orbit(-25.0),
    "dolly_in": lambda: make_dolly(+0.45),
    "dolly_out": lambda: make_dolly(-0.30),
    "pan_left": lambda: make_pan(-15.0),
    "pan_right": lambda: make_pan(+15.0),
    "tilt_up": lambda: make_tilt(-10.0),
    "tilt_down": lambda: make_tilt(+10.0),
    "truck_left": lambda: make_truck(-0.30),
    "truck_right": lambda: make_truck(+0.30),
    "crane_up": lambda: make_crane(-0.30),
    "crane_down": lambda: make_crane(+0.30),
}


def write_generated_presets(out_dir) -> list:
    """把全部生成式预设写盘(幂等,已存在跳过),返回写出的路径列表。"""
    from pathlib import Path

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, fn in GENERATED_PRESETS.items():
        path = out_dir / f"{name}.npy"
        if not path.exists():
            pose = fn().astype(np.float32)
            assert pose.shape == (NUM_FRAMES, 3, 4) and np.isfinite(pose).all()
            np.save(path, pose)
            written.append(path)
    return written
