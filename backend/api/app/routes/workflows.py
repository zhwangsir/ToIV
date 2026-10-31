"""工作流模板管理:列出、部署到 ComfyUI worker。

部署机制:
- 内置工作流 JSON 放在 app/workflows/ 下
- 点击"在 ComfyUI 中打开"时,后端把 JSON POST 到 worker 的 userdata API:
  /api/userdata/workflows%2Ftoiv_{id}.json
- 前端把 iframe src 切到: COMFYUI_URL/?workflow=toiv_{id}.json&_r={ts}
- ComfyUI 前端会自动加载该 workflow
"""
import json
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.deps import get_current_admin, get_current_user
from app.models import User

router = APIRouter(prefix="/workflows", tags=["workflows"])

WORKFLOW_DIR = Path(__file__).parent.parent / "workflows"
DEPLOYED_PREFIX = "toiv_"

# 模板 id 白名单:只含字母数字/下划线/连字符且 ≤64 字符,
# 防 template_id 含 ".." 等片段拼出 WORKFLOW_DIR 外的路径(路径穿越)
_TEMPLATE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _check_template_id(template_id: str) -> str:
    """白名单校验模板 id(三个端点共用);不合法直接 400,绝不触文件系统。"""
    if not _TEMPLATE_ID_RE.fullmatch(template_id):
        raise HTTPException(status_code=400, detail="非法的模板 id")
    return template_id


def _list_templates() -> list[dict]:
    """扫描内置工作流文件,返回元数据列表。"""
    templates = []
    for fp in sorted(WORKFLOW_DIR.glob("*.json")):
        if fp.name.startswith("_"):
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        nid = fp.stem
        # 从节点中推断主要节点类型作为标签
        node_types = {n.get("type") for n in data.get("nodes", [])}
        tags = []
        if "CheckpointLoaderSimple" in node_types or "UNETLoader" in node_types:
            tags.append("基础模型")
        if "LoadImage" in node_types:
            tags.append("图生图")
        if "EmptyLTXVLatentVideo" in node_types or "LTXVImgToVideo" in node_types:
            tags.append("视频")
        if "VHS_VideoCombine" in node_types:
            tags.append("VHS")
        templates.append({
            "id": nid,
            "name": _human_name(nid),
            "description": _description(nid),
            "tags": tags,
            "node_count": len(data.get("nodes", [])),
            "filename": fp.name,
        })
    return templates


def _human_name(nid: str) -> str:
    mapping = {
        "txt2img_basic": "文生图基础工作流",
        "img2img_basic": "图生图基础工作流",
        "ltx_txt2video": "LTX 文生视频(NSFW)",
        "ltx_img2video": "LTX 图生视频(NSFW)",
        "ltx_lipsync": "LTX 口型同步(NSFW)",
    }
    return mapping.get(nid, nid.replace("_", " ").title())


def _description(nid: str) -> str:
    mapping = {
        "txt2img_basic": "Checkpoint + CLIP 正负提示词 + KSampler + 保存图片。适合快速验证模型/提示词。",
        "img2img_basic": "加载图片 + VAEEncode + KSampler(denoise 0.75) 重绘。适合风格迁移/局部重绘。",
        "ltx_txt2video": "10eros_v14 + Gemma 3 12B + ltx_vae,768×384@97帧。NSFW 视频生成专用。",
        "ltx_img2video": "首帧引导 + 10eros_v14 + Gemma 3 12B,图生视频(NSFW)。",
        "ltx_lipsync": "图生视频 + 参考音频驱动,10eros_v14 + mmaudio 音频 VAE(NSFW)。",
    }
    return mapping.get(nid, "")


@router.get("/templates")
async def list_templates(user: User = Depends(get_current_user)):
    return {"templates": _list_templates()}


class DeployResponse(BaseModel):
    worker_url: str
    workflow_name: str
    load_url: str
    template_id: str


@router.post("/{template_id}/deploy")
async def deploy_template(
    template_id: str,
    admin: User = Depends(get_current_admin),  # 会往 worker 写文件,属管理操作
) -> DeployResponse:
    _check_template_id(template_id)
    fp = WORKFLOW_DIR / f"{template_id}.json"
    if not fp.exists() or fp.name.startswith("_"):
        raise HTTPException(status_code=404, detail="工作流模板不存在")

    settings = get_settings()
    workers = settings.worker_urls
    if not workers:
        raise HTTPException(status_code=503, detail="未配置 ComfyUI worker")
    worker_url = workers[0].rstrip("/")

    workflow_name = f"{DEPLOYED_PREFIX}{template_id}.json"
    encoded_path = f"workflows%2F{workflow_name}"
    upload_url = f"{worker_url}/api/userdata/{encoded_path}"

    try:
        payload = json.loads(fp.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取工作流失败: {exc}") from exc

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(upload_url, json=payload)
            if resp.status_code not in (200, 201):
                raise HTTPException(
                    status_code=502,
                    detail=f"上传到 ComfyUI 失败: HTTP {resp.status_code} - {resp.text[:200]}",
                )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"连接 ComfyUI worker 失败: {exc}") from exc

    # ComfyUI 前端通过 ?workflow=filename 加载
    load_url = f"{worker_url}/?workflow={workflow_name}"
    return DeployResponse(
        worker_url=worker_url,
        workflow_name=workflow_name,
        load_url=load_url,
        template_id=template_id,
    )


@router.get("/{template_id}/download")
async def download_template(
    template_id: str,
    user: User = Depends(get_current_user),
):
    """直接下载工作流 JSON(手动导入用)。"""
    _check_template_id(template_id)
    fp = WORKFLOW_DIR / f"{template_id}.json"
    if not fp.exists() or fp.name.startswith("_"):
        raise HTTPException(status_code=404, detail="工作流模板不存在")
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取工作流失败: {exc}") from exc
    return data
