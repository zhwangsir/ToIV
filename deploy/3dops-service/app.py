"""toiv-3dops(:9402)—— 3D 模型材质/渲染调整服务(workstation)。

技术栈:trimesh(读写 GLB / PBR 材质改写)+ pyrender(EGL 离屏渲染,
PYOPENGL_PLATFORM=egl;workstation 真机实证 GPU EGL 可用)。

端点:
- POST /render:GLB(上传 file 或 source_path 本地路径)→ out=glb(默认)把材质预设
  (clay/matte/metal/glossy)烘焙为 GLB 的 PBR 材质,返回新 GLB;out=png 出静态快照
  (可指定方位角),out=mp4 出 360° 旋转视频(turntable)。wireframe/normal 是纯查看
  模式,glb 输出下拒绝(422)。
- POST /material:改 GLB PBR 材质(base_color 染色/金属度/粗糙度)→ 导出新 GLB。
- GET /health:探活。

纪律:单请求串行锁(pyrender OffscreenRenderer 非线程安全);硬超时,超时不留半成品;
所有输入字节先校验 GLB magic(``glTF``),伪造输入直接 422。
"""
from __future__ import annotations

import asyncio
import io
import math
import os
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

# pyrender 必须在 egl 平台下初始化(模块级 import 即绑定平台)
os.environ.setdefault("PYOPENGL_PLATFORM", "egl")
import pyrender  # noqa: E402

app = FastAPI(title="toiv-3dops", version="1.0.0")

_LOCK = asyncio.Lock()
_TIMEOUT_SEC = float(os.environ.get("THREEDOPS_TIMEOUT_SEC", "300"))
_MAX_GLB_BYTES = 200 * 1024 * 1024
_SOURCE_PATH_ROOT = os.environ.get("THREEDOPS_SOURCE_ROOT", "/home/merlin/nas_mount")

# ---------- 材质预设(render 用;不改源 GLB) ----------
# (baseColorFactor, metallic, roughness)
_RENDER_MATERIALS: dict[str, tuple[tuple[float, float, float], float, float]] = {
    "clay": ((0.55, 0.50, 0.46), 0.0, 0.92),     # 黏土(暖灰)
    "matte": ((0.88, 0.88, 0.88), 0.0, 1.0),     # 哑光(近白)
    "metal": ((0.56, 0.57, 0.58), 1.0, 0.28),    # 金属(中性灰)
    "glossy": ((0.94, 0.94, 0.95), 0.0, 0.08),   # 陶瓷(高光白)
}

# ---------- 灯光档位:(ambient, [(方向(单位向量), 强度)]) ----------
_LIGHTING: dict[str, tuple[float, list[tuple[tuple[float, float, float], float]]]] = {
    # 均匀环境光 + 单太阳光,接近室外天光
    "environment": (0.45, [((-0.4, -0.6, 0.7), 0.9)]),
    # 三点布光:主光 45° 高位 / 补光对侧 / 轮廓光背后上方
    "studio": (
        0.12,
        [((-0.5, -0.7, 0.6), 1.4), ((0.8, 0.3, 0.4), 0.5), ((0.3, 0.9, 0.5), 0.9)],
    ),
    # 轮廓光:正面几乎无光,背后强光勾边
    "rim": (0.04, [((0.1, 1.0, 0.35), 2.2), ((-0.3, -0.9, 0.2), 0.25)]),
}


def _read_glb(data: bytes) -> trimesh.Scene:
    if not data or data[:4] != b"glTF":
        raise HTTPException(status_code=422, detail="输入不是 GLB(magic 校验失败)")
    if len(data) > _MAX_GLB_BYTES:
        raise HTTPException(status_code=413, detail="GLB 过大(上限 200MB)")
    try:
        scene = trimesh.load(io.BytesIO(data), file_type="glb", force="scene")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"GLB 解析失败:{e}") from e
    if not isinstance(scene, trimesh.Scene) or not scene.geometry:
        raise HTTPException(status_code=422, detail="GLB 中无可渲染网格")
    return scene


def _look_at(eye: np.ndarray, target: np.ndarray, up=(0.0, 0.0, 1.0)) -> np.ndarray:
    """OpenGL 相机(-Z 朝前)look-at 位姿。"""
    z = np.asarray(eye, dtype=np.float64) - np.asarray(target, dtype=np.float64)
    z /= np.linalg.norm(z)
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    pose = np.eye(4)
    pose[:3, 0] = x
    pose[:3, 1] = y
    pose[:3, 2] = z
    pose[:3, 3] = eye
    return pose


def _make_material(name: str) -> pyrender.Material:
    if name in _RENDER_MATERIALS:
        base, metallic, roughness = _RENDER_MATERIALS[name]
        return pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(*base, 1.0), metallicFactor=metallic, roughnessFactor=roughness
        )
    if name == "wireframe":
        # 线框在 from_trimesh(wireframe=True) 生效(材质对象的 wireframe kwarg 无效)
        return pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(0.7, 0.72, 0.75, 1.0), metallicFactor=0.0, roughnessFactor=0.6,
        )
    if name == "normal":
        # 顶点法线烘焙成顶点色(N*0.5+0.5);from_trimesh 传 material=None 才会带
        # COLOR_0(显式材质会丢弃顶点色),配合纯环境光消除明暗
        return None
    raise HTTPException(status_code=422, detail=f"未知材质预设:{name}")


def _bake_normal_colors(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """返回顶点色=法线可视化的网格副本(仅 normal 预设用)。"""
    m = mesh.copy()
    normals = np.asarray(m.vertex_normals, dtype=np.float64)
    colors = ((normals * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    alpha = np.full((len(colors), 1), 255, dtype=np.uint8)
    m.visual = trimesh.visual.ColorVisuals(mesh=m, vertex_colors=np.hstack([colors, alpha]))
    return m


def _wireframe_mesh(mesh: trimesh.Trimesh) -> pyrender.Mesh:
    """手工 LINES 线框:EGL 离屏上下文 glPolygonMode(GL_LINE) 不生效(实测),
    from_trimesh(wireframe=True) 只改 polygon mode,故改为唯一边 → 线段图元。
    密网格(Hunyuan3D 动辄 20w+ 面)直接画边会糊成实心,先二次简化到 ~4000 面。"""
    from pyrender.constants import GLTF

    m = mesh
    if len(m.faces) > 24000:
        # 目标 2w 面:再低会把大平面区域整体塌掉(实测 4k 面 z 向背板消失),破坏轮廓
        try:
            m = m.simplify_quadric_decimation(face_count=20000)
        except Exception:  # 简化失败兜底:用原网格(最多糊一点,不炸)
            m = mesh
    edges = m.edges_unique
    pos = np.asarray(m.vertices, dtype=np.float32)
    line_pos = np.ascontiguousarray(pos[edges].reshape(-1, 3))
    color = np.tile(np.array([[0.42, 0.44, 0.47, 1.0]], dtype=np.float32), (len(line_pos), 1))
    mat = pyrender.MetallicRoughnessMaterial(
        baseColorFactor=(1.0, 1.0, 1.0, 1.0), metallicFactor=0.0, roughnessFactor=1.0
    )
    prim = pyrender.Primitive(
        positions=line_pos, color_0=color, material=mat, mode=GLTF.LINES
    )
    return pyrender.Mesh(primitives=[prim], is_visible=True)


def _camera_pose(center: np.ndarray, radius: float, azimuth_deg: float) -> np.ndarray:
    """方位角绕竖轴、固定俯仰 ~18°、距离按包围球+视角留 1.5 倍余量。"""
    yfov = math.radians(40.0)
    dist = radius / math.tan(yfov / 2.0) * 1.5
    elev = math.radians(18.0)
    az = math.radians(azimuth_deg)
    eye = center + dist * np.array(
        [math.cos(elev) * math.sin(az), -math.cos(elev) * math.cos(az), math.sin(elev)]
    )
    return _look_at(eye, center)


def _gradient_bg(h: int, w: int) -> np.ndarray:
    """深灰竖向渐变底(上 0.23 → 下 0.07),用于 dark 背景档合成。"""
    col = np.linspace(0.23, 0.07, h, dtype=np.float32)[:, None, None]
    return (np.repeat(col, w, axis=1) * 255.0).repeat(3, axis=2).astype(np.uint8)


def _composite(rgba: np.ndarray, background: str) -> np.ndarray:
    """RGBA 渲染帧按背景档合成;transparent 直接返回 4 通道。"""
    if background == "transparent":
        return rgba
    h, w = rgba.shape[:2]
    if background == "white":
        bg = np.full((h, w, 3), 255, dtype=np.uint8)
    elif background == "dark":
        bg = _gradient_bg(h, w)
    else:
        raise HTTPException(status_code=422, detail=f"未知背景档:{background}")
    alpha = (rgba[:, :, 3:4].astype(np.float32)) / 255.0
    out = rgba[:, :, :3].astype(np.float32) * alpha + bg.astype(np.float32) * (1.0 - alpha)
    return out.clip(0, 255).astype(np.uint8)


def _render_sync(
    glb: bytes,
    material: str,
    lighting: str,
    background: str,
    fmt: str,
    azimuth: float,
    frames: int,
    size: int,
) -> bytes:
    scene_glb = _read_glb(glb)
    if lighting not in _LIGHTING:
        raise HTTPException(status_code=422, detail=f"未知灯光档:{lighting}")
    mat = _make_material(material)

    ambient, dirs = _LIGHTING[lighting]
    if material in ("normal", "wireframe"):
        ambient, dirs = 1.0, []  # 法线/线框要平光(顶点色/线色直接呈现)

    bounds = scene_glb.bounds
    center = bounds.mean(axis=0)
    radius = float(np.linalg.norm(bounds[1] - bounds[0]) / 2.0) or 1.0

    ambient_v = np.array([ambient, ambient, ambient])
    scene = pyrender.Scene(ambient_light=ambient_v, bg_color=np.array([0, 0, 0, 0]))
    for geom in scene_glb.geometry.values():
        if not isinstance(geom, trimesh.Trimesh):
            continue
        if material == "wireframe":
            scene.add(_wireframe_mesh(geom))
            continue
        src = _bake_normal_colors(geom) if material == "normal" else geom
        scene.add(pyrender.Mesh.from_trimesh(
            src, material=mat, smooth=material != "normal",
        ))
    for direction, intensity in dirs:
        light = pyrender.DirectionalLight(color=np.ones(3), intensity=intensity)
        d = np.array(direction, dtype=np.float64)
        d /= np.linalg.norm(d)
        # 方向光沿 -Z 发射:光源放在 direction 反方向、看向原点
        scene.add(light, pose=_look_at(-d * 10.0, np.zeros(3)))
    camera = pyrender.PerspectiveCamera(yfov=math.radians(40.0))
    cam_node = scene.add(camera, pose=np.eye(4))

    renderer = pyrender.OffscreenRenderer(size, size)
    try:
        if fmt == "png":
            scene.set_pose(cam_node, pose=_camera_pose(center, radius, azimuth))
            rgba, _ = renderer.render(scene, flags=pyrender.RenderFlags.RGBA)
            img = _composite(rgba, background)
            buf = io.BytesIO()
            mode = "RGBA" if background == "transparent" else "RGB"
            from PIL import Image

            Image.fromarray(img, mode=mode).save(buf, format="PNG")
            return buf.getvalue()
        if fmt == "mp4":
            import imageio.v2 as imageio

            tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp.close()
            try:
                writer = imageio.get_writer(
                    tmp.name, fps=12, codec="libx264", quality=8,
                    pixelformat="yuv420p", macro_block_size=2,
                )
                for i in range(frames):
                    scene.set_pose(
                        cam_node, pose=_camera_pose(center, radius, 360.0 * i / frames)
                    )
                    rgba, _ = renderer.render(scene, flags=pyrender.RenderFlags.RGBA)
                    frame = _composite(rgba, background)
                    if frame.shape[2] == 4:  # mp4 无透明;透明档合成到白底
                        frame = _composite(rgba, "white")
                    writer.append_data(frame)
                writer.close()
                data = Path(tmp.name).read_bytes()
            finally:
                Path(tmp.name).unlink(missing_ok=True)
            return data
        raise HTTPException(status_code=422, detail=f"未知输出格式:{fmt}")
    finally:
        renderer.delete()


def _material_sync(glb: bytes, base_color: str, metallic: float, roughness: float) -> bytes:
    scene = _read_glb(glb)
    try:
        r = int(base_color[1:3], 16) / 255.0
        g = int(base_color[3:5], 16) / 255.0
        b = int(base_color[5:7], 16) / 255.0
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=422, detail=f"base_color 须为 #RRGGBB:{e}") from e
    mat = trimesh.visual.material.PBRMaterial(
        baseColorFactor=[r, g, b, 1.0],
        metallicFactor=metallic,
        roughnessFactor=roughness,
    )
    for geom in scene.geometry.values():
        if isinstance(geom, trimesh.Trimesh):
            geom.visual.material = mat
    data = scene.export(file_type="glb")
    if not data or data[:4] != b"glTF":
        raise HTTPException(status_code=500, detail="GLB 导出失败")
    return data


def _bake_material_glb(glb: bytes, material: str) -> bytes:
    """out=glb:把材质预设烘焙为 GLB 的 PBR 材质,返回新 GLB。

    wireframe/normal 是纯查看模式(线框图元/顶点法线色,无法表达为 PBR 材质),
    glb 输出下拒绝并说明。
    """
    if material in ("wireframe", "normal"):
        raise HTTPException(
            status_code=422,
            detail=f"{material} 是纯查看模式,无法烘焙为 GLB;请改用 png/mp4 输出,"
                   f"或选 clay/matte/metal/glossy 材质预设",
        )
    if material not in _RENDER_MATERIALS:
        raise HTTPException(status_code=422, detail=f"未知材质预设:{material}")
    scene = _read_glb(glb)
    base, metallic, roughness = _RENDER_MATERIALS[material]
    mat = trimesh.visual.material.PBRMaterial(
        baseColorFactor=[*base, 1.0],
        metallicFactor=metallic,
        roughnessFactor=roughness,
    )
    for geom in scene.geometry.values():
        if isinstance(geom, trimesh.Trimesh):
            geom.visual.material = mat
    data = scene.export(file_type="glb")
    if not data or data[:4] != b"glTF":
        raise HTTPException(status_code=500, detail="GLB 导出失败")
    return data


async def _resolve_input(file: UploadFile | None, source_path: str | None) -> bytes:
    """GLB 输入:上传字节优先;否则读 workstation 本地路径(限 _SOURCE_PATH_ROOT 下 .glb)。"""
    if file is not None:
        return await file.read()
    if source_path:
        p = Path(source_path)
        try:
            resolved = p.resolve()
        except OSError as e:
            raise HTTPException(status_code=422, detail=f"路径非法:{e}") from e
        if resolved.suffix.lower() != ".glb" or not str(resolved).startswith(
            _SOURCE_PATH_ROOT.rstrip("/") + "/"
        ):
            raise HTTPException(
                status_code=403, detail=f"本地路径须在 {_SOURCE_PATH_ROOT} 下且为 .glb"
            )
        try:
            return resolved.read_bytes()
        except OSError as e:
            raise HTTPException(status_code=404, detail=f"本地文件不可读:{e}") from e
    raise HTTPException(status_code=422, detail="缺少输入:file 或 source_path 二选一")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "platform": os.environ.get("PYOPENGL_PLATFORM", "egl")}


@app.post("/render")
async def render(
    file: UploadFile | None = File(default=None),
    source_path: str | None = Form(default=None),
    material: str = Form(default="clay"),
    lighting: str = Form(default="studio"),
    background: str = Form(default="dark"),
    out: str | None = Form(default=None),
    format: str | None = Form(default=None),  # 旧参数:out 缺省时生效(png/mp4)
    azimuth: float = Form(default=30.0),
    frames: int = Form(default=36),
    size: int = Form(default=768),
) -> Response:
    # 输出模式:out 优先,兼容旧 format;默认 glb(材质烘焙回模型本身)
    mode = out or format or "glb"
    if mode not in ("glb", "png", "mp4"):
        raise HTTPException(status_code=422, detail=f"未知输出模式:{mode}(glb/png/mp4)")
    glb = await _resolve_input(file, source_path)
    frames = frames if frames in (24, 36) else 36
    size = max(256, min(int(size), 1080))
    async with _LOCK:
        try:
            if mode == "glb":
                data = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        None, _bake_material_glb, glb, material,
                    ),
                    timeout=_TIMEOUT_SEC,
                )
            else:
                data = await asyncio.wait_for(
                    asyncio.get_running_loop().run_in_executor(
                        None, _render_sync, glb, material, lighting, background,
                        mode, float(azimuth), frames, size,
                    ),
                    timeout=_TIMEOUT_SEC,
                )
        except asyncio.TimeoutError as e:
            raise HTTPException(status_code=504, detail="渲染超时") from e
    media_type = {"glb": "model/gltf-binary", "png": "image/png", "mp4": "video/mp4"}[mode]
    return Response(content=data, media_type=media_type)


@app.post("/material")
async def material(
    file: UploadFile | None = File(default=None),
    source_path: str | None = Form(default=None),
    base_color: str = Form(default="#b87333"),  # 默认青铜色
    metallic: float = Form(default=0.85),
    roughness: float = Form(default=0.35),
) -> Response:
    glb = await _resolve_input(file, source_path)
    metallic = max(0.0, min(float(metallic), 1.0))
    roughness = max(0.0, min(float(roughness), 1.0))
    async with _LOCK:
        try:
            data = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None, _material_sync, glb, base_color, metallic, roughness
                ),
                timeout=_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError as e:
            raise HTTPException(status_code=504, detail="材质改写超时") from e
    return Response(content=data, media_type="model/gltf-binary")
