"""模型百科服务(WIKI-2026-08-18)—— 「这是什么模型/怎么用」的一站式答案层。

三层语料合成一张卡:
  1. curated(workflows/model_wiki.card_for):平台在用模型的确定性中文卡片
  2. civitai 富化(ModelCard 表):按文件名搜 civitai,缓存描述/触发词/基模/许可
  3. 本地事实:文件名 + 类目 + NSFW 过滤状态

RAG 问答(ask):卡片文本化 → Qwen3-Embedding(:9302,复用 agent/rag._embed)→
内存余弦 top-k(卡片量级 ~数百,无需 pgvector)→ LLM L2 中文作答并引用模型名。
embedding 失败时降级为纯关键词检索(文件名/标签/描述包含),链路永不 503。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime

import httpx
from sqlmodel import Session

from app.agent import rag
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.harness.ctx import get_ctx
from app.models import ModelCard
from app.workflows.model_wiki import card_for

logger = logging.getLogger(__name__)

# worker 枚举类目(与 /models/local 一致;diffusion_models 走 UNETLoader 次世代)
_WIKI_SPECS = [
    ("checkpoints", "CheckpointLoaderSimple", "ckpt_name"),
    ("loras", "LoraLoader", "lora_name"),
    ("vae", "VAELoader", "vae_name"),
    ("controlnet", "ControlNetLoader", "control_net_name"),
    ("upscale", "UpscaleModelLoader", "model_name"),
    ("diffusion_models", "UNETLoader", "unet_name"),
]

# civitai 富化限速:批量逐个查询,间隔避免限流
_ENRICH_INTERVAL = 1.2

_CIVITAI = None  # 惰性取 env(与 marketplace 同源)


def _civitai_base() -> str:
    import os

    return os.environ.get("TOIV_CIVITAI_API_BASE", "https://civitai.red/api/v1/models")


def _civitai_key() -> str:
    import os

    return os.environ.get("TOIV_CIVITAI_API_KEY", "")


def _card_id(filename: str, model_type: str) -> str:
    return hashlib.sha1(f"{filename}|{model_type}".encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# 本地枚举聚合
# ---------------------------------------------------------------------------

async def _enum(client, node: str, field: str) -> list[str]:
    info = await client.object_info(node)
    opts = info.get(node, {}).get("input", {}).get("required", {}).get(field, [[]])
    if opts and isinstance(opts[0], list):
        return [str(o) for o in opts[0]]
    return []


async def local_inventory(pool: WorkerPool) -> dict[str, list[str]]:
    """聚合首台可用 worker 的模型清单(类目 → 文件名列表);全失败返回空结构。"""
    out: dict[str, list[str]] = {t: [] for t, _, _ in _WIKI_SPECS}
    for client in pool.clients:
        try:
            for key, node, field in _WIKI_SPECS:
                try:
                    out[key] = await _enum(client, node, field)
                except ComfyUIError:
                    out[key] = out.get(key, [])
            if any(out.values()):
                return out
        except ComfyUIError:
            continue
    return out


# ---------------------------------------------------------------------------
# 卡片合成(curated ∪ civitai 富化)
# ---------------------------------------------------------------------------

def _merge(filename: str, model_type: str, enriched: ModelCard | None) -> dict:
    card = card_for(filename, model_type) or {}
    merged = {
        "id": _card_id(filename, model_type),
        "filename": filename,
        "model_type": model_type,
        "label": card.get("label") or (enriched.label if enriched else "") or filename,
        "base_model": card.get("base_model") or (enriched.base_model if enriched else "") or "",
        "description": card.get("description") or (enriched.description if enriched else "") or "",
        "usage": card.get("usage", ""),
        "prompt_dialect": card.get("prompt_dialect", ""),
        "trigger_words": card.get("trigger_words") or (
            json.loads(enriched.trigger_words) if enriched and enriched.trigger_words.startswith("[") else []
        ),
        "negative_hint": card.get("negative_hint") or (enriched.negative_hint if enriched else "") or "",
        "tags": card.get("tags", []),
        "creator": (enriched.creator if enriched else "") or "",
        "license": card.get("license") or (enriched.license if enriched else "") or "",
        "civitai_url": card.get("civitai_url") or (enriched.civitai_url if enriched else "") or "",
        "downloads": enriched.downloads if enriched else 0,
        "nsfw": card.get("nsfw", False) or (enriched.nsfw if enriched else False),
        "sources": ([card["source"]] if card else [])
        + (["civitai"] if enriched else []),
        "enriched": bool(enriched),
        "has_detail": bool(card) or bool(enriched and enriched.description),
    }
    return merged


def build_cards(inventory: dict[str, list[str]], session: Session) -> list[dict]:
    """本地清单 + curated + 富化缓存 → 卡片列表(按类目/文件名排序)。"""
    cards: list[dict] = []
    for model_type, names in inventory.items():
        for filename in names:
            enriched = session.get(ModelCard, _card_id(filename, model_type))
            cards.append(_merge(filename, model_type, enriched))
    cards.sort(key=lambda c: (c["model_type"], c["filename"].lower()))
    return cards


# ---------------------------------------------------------------------------
# Civitai 富化
# ---------------------------------------------------------------------------

_CLEAN_RE = re.compile(
    r"(\.safetensors|\.ckpt|\.pt|\.bin)$"
    r"|[-_ ]?(fp8|fp16|bf16|pruned|ema[-_]?all|openvino|scaled)"
    r"|[-_ ]?v\d+(\.\d+)*"
    r"|[-_ ]?\d+[bB](?![a-zA-Z])"
    r"|(noobai|illustrious|pony|sdxl|xl)(?=[-_ ]|$)",
    re.IGNORECASE,
)


def clean_model_name(filename: str) -> str:
    """文件名 → civitai 搜索词:去版本/量化/基模噪音词,保留可读主名。"""
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    name = _CLEAN_RE.sub("", name)
    name = re.sub(r"[-_]+", " ", name).strip()
    return name[:60] or filename[:60]


def _pick_version(model: dict) -> dict:
    versions = model.get("modelVersions") or [{}]
    return versions[0] if isinstance(versions, list) and versions else {}


async def _search_civitai(query: str, model_type: str) -> dict | None:
    """按名搜 civitai 取 top1 原始 model 节点;无 key/网络失败/无结果 → None。"""
    params = {"limit": 4, "query": query, "nsfw": "true"}  # 富化要完整信息,NSFW 由卡片展示层过滤
    if model_type == "loras":
        params["types"] = "LORA"
    elif model_type in ("checkpoints", "diffusion_models"):
        params["types"] = "Checkpoint"
    headers = {"Authorization": f"Bearer {_civitai_key()}"} if _civitai_key() else None
    try:
        async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "ToIV/0.1"}) as client:
            resp = await client.get(_civitai_base(), params=params, headers=headers)
            resp.raise_for_status()
            items = resp.json().get("items") or []
    except (httpx.HTTPError, ValueError):
        return None
    if not items:
        return None
    # 名字相似度粗排:完全包含查询词者优先
    q = query.lower()
    items.sort(key=lambda it: (q not in str(it.get("name", "")).lower(),))
    return items[0]


def _card_from_civitai(filename: str, model_type: str, model: dict) -> ModelCard:
    version = _pick_version(model)
    triggers = [t for t in (version.get("trainedWords") or []) if isinstance(t, str)][:8]
    base = str(version.get("baseModel") or "")
    desc = str(model.get("description") or "").strip()
    # civitai 描述常带 HTML,粗暴去标签(展示层纯文本)
    desc = re.sub(r"<[^>]+>", " ", desc)
    desc = re.sub(r"\s+", " ", desc).strip()[:1500]
    return ModelCard(
        id=_card_id(filename, model_type),
        filename=filename,
        model_type=model_type,
        source="civitai",
        label=str(model.get("name") or ""),
        base_model=base,
        description=desc,
        trigger_words=json.dumps(triggers, ensure_ascii=False),
        creator=(model.get("creator") or {}).get("username") or "",
        license=(version.get("licenses") or [""])[0] if version.get("licenses") else str(
            model.get("allowNoCredit") and "允许不署名" or ""
        ),
        civitai_id=str(model.get("id") or ""),
        civitai_url=f"{_civitai_base().rsplit('/api', 1)[0]}/models/{model.get('id')}",
        downloads=int((model.get("stats") or {}).get("downloadCount") or 0),
        nsfw=bool(model.get("nsfw")),
        enriched_at=datetime.now(),
    )


async def enrich_models(
    filenames: list[tuple[str, str]],
    session: Session,
    *,
    force: bool = False,
    max_count: int = 40,
) -> dict:
    """批量 civitai 富化并落库。filenames = [(filename, model_type), ...]。

    默认跳过已有富化(force=False 且 ModelCard 存在);限速逐个查询。
    返回 {enriched, skipped, failed}。管理端点调用(admin 鉴权在路由层)。
    """
    enriched = skipped = failed = 0
    for i, (filename, model_type) in enumerate(filenames[:max_count]):
        cid = _card_id(filename, model_type)
        if not force and session.get(ModelCard, cid):
            skipped += 1
            continue
        model = await _search_civitai(clean_model_name(filename), model_type)
        if model is None:
            failed += 1
        else:
            card = _card_from_civitai(filename, model_type, model)
            session.merge(card)
            session.commit()
            enriched += 1
        if i < min(len(filenames), max_count) - 1:
            await asyncio.sleep(_ENRICH_INTERVAL)
    return {"enriched": enriched, "skipped": skipped, "failed": failed}


# ---------------------------------------------------------------------------
# RAG 问答
# ---------------------------------------------------------------------------

def card_to_text(card: dict) -> str:
    """卡片 → 检索文本(中文为主,文件名/触发词保留原文利于双语命中)。"""
    parts = [
        f"模型:{card['filename']}(类目:{card['model_type']})",
        f"名称:{card['label']}",
    ]
    if card.get("base_model"):
        parts.append(f"基模:{card['base_model']}")
    if card.get("description"):
        parts.append(f"用途:{card['description']}")
    if card.get("usage"):
        parts.append(f"用法:{card['usage']}")
    if card.get("prompt_dialect"):
        parts.append(f"提示词方言:{card['prompt_dialect']}")
    if card.get("trigger_words"):
        parts.append(f"触发词:{', '.join(card['trigger_words'])}")
    if card.get("tags"):
        parts.append(f"标签:{', '.join(card['tags'])}")
    return " | ".join(parts)


def _keyword_hits(question: str, cards: list[dict]) -> list[dict]:
    """关键词兜底:问题分词后命中 文件名/名称/标签/描述 的卡片。"""
    tokens = [t for t in re.split(r"[\s,，。?？!！/]+", question.lower()) if len(t) >= 2]
    scored: list[tuple[int, dict]] = []
    for c in cards:
        hay = " ".join(
            [c["filename"], c["label"], " ".join(c.get("tags", [])), c.get("description", "")]
        ).lower()
        score = sum(1 for t in tokens if t in hay)
        if score:
            scored.append((score, c))
    scored.sort(key=lambda s: -s[0])
    return [c for _, c in scored[:6]]


# embed 索引进程内缓存(fingerprint = 卡片文本集合哈希;卡片/富化变化自动失效)
_vec_cache: dict = {"fp": "", "vectors": [], "cards": []}


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


async def _topk_by_embed(question: str, cards: list[dict], k: int = 6) -> list[dict]:
    texts = [card_to_text(c) for c in cards]
    fp = hashlib.sha1("|".join(texts).encode("utf-8")).hexdigest()[:16]
    if _vec_cache["fp"] != fp:
        embeddings = await rag._embed(texts)
        if embeddings is None or len(embeddings) != len(texts):
            return []  # embedding 不可用 → 调用方降级关键词
        _vec_cache["fp"] = fp
        _vec_cache["vectors"] = [rag._normalize(e) for e in embeddings]
        _vec_cache["cards"] = cards
    elif _vec_cache["cards"] is not cards:
        _vec_cache["cards"] = cards  # 同指纹复用向量,换列表对象引用
    qe = await rag._embed([question])
    if not qe:
        return []
    q = rag._normalize(qe[0])
    scored = sorted(
        ((_cosine(q, v), c) for v, c in zip(_vec_cache["vectors"], cards)),
        key=lambda s: -s[0],
    )
    return [c for s, c in scored[:k] if s >= 0.25]


_SYSTEM = (
    "你是 ToIV 平台的模型百科助手。根据下方候选模型卡片,用中文回答用户关于模型的问题:"
    "这个模型是什么、适合做什么、怎么用(采样参数/提示词写法/平台入口)、来源与许可。"
    "规则:① 只依据卡片内容回答,卡片没有的信息明确说「暂无资料,可点来源页查看」;"
    "② 推荐具体模型时给出完整文件名;③ 涉及 R18 模型时注明需开启 R18;"
    "④ 简明分点,不超过 200 字。"
)


async def ask_model_wiki(question: str, cards: list[dict]) -> dict:
    """自然语言问模型。返回 {answer, matched: [卡片]}。embedding 失败自动降级关键词。"""
    matched = await _topk_by_embed(question, cards)
    if not matched:
        matched = _keyword_hits(question, cards)
    if not matched:
        return {
            "answer": "本地模型库中没有匹配到相关模型。可在「模型库 → 市场」从 Civitai 搜索安装,或先让管理员运行一次富化补全介绍。",
            "matched": [],
        }
    context = "\n\n".join(f"[卡片 {i+1}]\n{card_to_text(c)}" for i, c in enumerate(matched))
    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": f"候选卡片:\n{context}\n\n用户问题:{question}"},
            ],
            layer="L2",
        )
        answer = (msg.get("content") or "").strip() or "生成回答失败,请直接查看下方匹配的模型卡片。"
    except Exception as e:  # LLM 不可用:卡片直出,不让问答 503
        logger.warning("模型问答 LLM 失败,降级卡片直出: %s", e)
        answer = "AI 暂不可用,以下是最相关的模型卡片:\n" + "\n".join(
            f"· {c['label']}({c['filename']})—— {c['description'][:80]}" for c in matched[:3]
        )
    return {"answer": answer, "matched": matched[:4]}
