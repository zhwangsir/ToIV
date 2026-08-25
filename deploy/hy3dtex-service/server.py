"""toiv-hy3dtex :9404 —— Hunyuan3D 2.1 纹理服务(hy3dpaint 原生管线)。

core 的 POST /api/3d/texture 把白模 GLB(+可选参考图/风格文本) multipart 发到
这里,本服务执行多视图扩散 + RealESRGAN 增强 + PBR 烘焙,回传带贴图的新 GLB。

契约(与 apps/api/app/routes/threed_texture.py 对齐):
  POST /texture  multipart: file=GLB(必传) / image=参考图(可选)
                 form: texture_size(1024-4096,默认 2048) / prompt(风格文本,可选)
  200 → GLB 字节(model/gltf-binary);4xx 输入非法;5xx 管线失败
  GET  /healthz → {ok, loaded, texture_size}

设计要点:
- 管线懒加载单例(首请求载入,GPU0);全程单并发(asyncio.Lock),串行保显存。
- 权重全本地:NAS hunyuan3d-2.1(多视图扩散)+ ckpt/dinov2-giant + ckpt/RealESRGAN。
- 参考图缺省时纯白图兜底,风格完全由 prompt 文本引导(管线已打 text_prompt 补丁)。
- texture_size 是管线初始化期烘焙进 MeshRender 的,运行期不可变;请求值与配置
  不一致时记警告并按配置值执行(HY3D_TEX_SIZE 环境变量,默认 2048)。
- 临时工作目录用 /var/tmp(/tmp 是 tmpfs,易错点 P-4)。
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import shutil
import sys
import tempfile
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "hy3dpaint"))  # 管线内部按顶层包导入 utils/ DifferentiableRenderer/
os.chdir(ROOT)  # 管线相对路径 hy3dpaint/cfgs/... 以 ROOT 为基准

WEIGHTS_NAS = os.environ.get("HY3D_WEIGHTS_DIR", "/home/merlin/nas_mount/toiv/hunyuan3d-2.1")
CKPT_DIR = ROOT / "ckpt"
TEXTURE_SIZE = int(os.environ.get("HY3D_TEX_SIZE", "2048"))
MAX_GLB_BYTES = 200 * 1024 * 1024  # 输入白模上限(与 core _MAX_GLB_BYTES 对齐)
TMP_ROOT = "/var/tmp"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("hy3dtex")

app = FastAPI(title="toiv-hy3dtex", docs_url=None, redoc_url=None, openapi_url=None)

_pipeline = None
_load_lock = threading.Lock()
_run_lock = asyncio.Lock()


def _load_pipeline():
    """懒加载纹理管线(线程锁防并发重复载入)。"""
    global _pipeline
    with _load_lock:
        if _pipeline is not None:
            return _pipeline
        if not Path(WEIGHTS_NAS, "hunyuan3d-paintpbr-v2-1", "model_index.json").is_file():
            raise RuntimeError(f"NAS 权重不可达:{WEIGHTS_NAS}(mountpoint 核实)")
        from hy3dpaint.textureGenPipeline import (
            Hunyuan3DPaintConfig,
            Hunyuan3DPaintPipeline,
        )

        cfg = Hunyuan3DPaintConfig(max_num_view=6, resolution=512)
        cfg.multiview_pretrained_path = WEIGHTS_NAS  # 本地目录直用(管线已打补丁)
        cfg.dino_ckpt_path = str(CKPT_DIR / "dinov2-giant")
        cfg.realesrgan_ckpt_path = str(CKPT_DIR / "RealESRGAN_x4plus.pth")
        cfg.texture_size = TEXTURE_SIZE
        cfg.render_size = min(2048, TEXTURE_SIZE)
        _pipeline = Hunyuan3DPaintPipeline(cfg)
        logger.info("hy3dpaint 管线加载完成(texture_size=%d)", TEXTURE_SIZE)
        return _pipeline


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "loaded": _pipeline is not None, "texture_size": TEXTURE_SIZE}


def _combine_mr(base: Path) -> Image.Image:
    """metallic/roughness 灰度图合并为 GLTF 规范的 metallicRoughness 贴图
    (R=AO 白、G=roughness、B=metallic)。"""
    metallic_p = base.parent / f"{base.name}_metallic.jpg"
    roughness_p = base.parent / f"{base.name}_roughness.jpg"
    metallic = Image.open(metallic_p).convert("L")
    roughness = Image.open(roughness_p).convert("L")
    if metallic.size != roughness.size:
        roughness = roughness.resize(metallic.size)
    import numpy as np

    m = np.array(metallic)
    r = np.array(roughness)
    combined = np.stack([np.full_like(m, 255), r, m], axis=-1).astype("uint8")
    return Image.fromarray(combined)


def _obj_to_glb_pbr(obj_path: Path) -> Path:
    """OBJ+贴图 → GLB(PBR)。替代官方 Blender(bpy) 转换(服务环境无 Blender):
    trimesh 载 OBJ 几何/UV,PBRMaterial 挂 albedo + metallicRoughness 后导出。"""
    import trimesh
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    base = obj_path.with_suffix("")  # textured
    albedo_p = base.parent / f"{base.name}.jpg"
    if not albedo_p.is_file():
        raise RuntimeError("管线未产出 albedo 贴图")
    loaded = trimesh.load(str(obj_path), process=False)
    mesh = loaded.to_geometry() if isinstance(loaded, trimesh.Scene) else loaded
    uv = mesh.visual.uv.copy() if hasattr(mesh.visual, "uv") else None
    mat = PBRMaterial(
        baseColorTexture=Image.open(albedo_p).convert("RGB"),
        metallicRoughnessTexture=_combine_mr(base),
        metallicFactor=1.0,
        roughnessFactor=1.0,
    )
    mesh.visual = TextureVisuals(uv=uv, material=mat)
    glb_path = obj_path.with_suffix(".glb")
    mesh.export(str(glb_path))
    return glb_path


def _run_texture(glb: bytes, ref: bytes | None, prompt: str, tex_size: int) -> bytes:
    """同步执行纹理生成(在 worker 线程里跑,调用方持 _run_lock)。"""
    pipe = _load_pipeline()
    if tex_size != TEXTURE_SIZE:
        logger.warning("请求 texture_size=%d 与配置 %d 不一致,按配置值执行", tex_size, TEXTURE_SIZE)
    work = Path(tempfile.mkdtemp(prefix=f"hy3dtex-{uuid.uuid4().hex[:8]}-", dir=TMP_ROOT))
    try:
        mesh_path = work / "input.glb"
        mesh_path.write_bytes(glb)
        if ref:
            image: Image.Image = Image.open(io.BytesIO(ref)).convert("RGB")
        else:
            image = Image.new("RGB", (512, 512), (255, 255, 255))
        out_obj = work / "textured.obj"
        pipe.config.text_prompt = prompt or None  # 风格文本引导(管线 ToIV 补丁)
        try:
            pipe(
                mesh_path=str(mesh_path),
                image_path=image,
                output_mesh_path=str(out_obj),
                save_glb=False,  # 官方 GLB 转换依赖 Blender,改走 _obj_to_glb_pbr(trimesh)
            )
        finally:
            pipe.config.text_prompt = None
        if not out_obj.is_file():
            raise RuntimeError("管线未产出 OBJ")
        out_glb = _obj_to_glb_pbr(out_obj)
        content = out_glb.read_bytes()
        if content[:4] != b"glTF":
            raise RuntimeError("管线产物 magic 校验失败")
        return content
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.post("/texture")
async def texture(
    file: UploadFile = File(...),
    image: UploadFile | None = File(default=None),
    prompt: str = Form(default=""),
    texture_size: int = Form(default=2048),
) -> Response:
    glb = await file.read()
    if glb[:4] != b"glTF":
        raise HTTPException(status_code=422, detail="file 不是 GLB(magic 校验失败)")
    if len(glb) > MAX_GLB_BYTES:
        raise HTTPException(status_code=413, detail="GLB 过大(上限 200MB)")
    ref: bytes | None = None
    if image is not None and image.filename:
        ref = await image.read()
        if len(ref) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="参考图过大(上限 50MB)")
    prompt = (prompt or "").strip()[:500]

    async with _run_lock:
        try:
            content = await asyncio.to_thread(_run_texture, glb, ref, prompt, texture_size)
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("纹理生成失败")
            raise HTTPException(status_code=500, detail=f"纹理生成失败:{e}") from e
    return Response(content=content, media_type="model/gltf-binary")
