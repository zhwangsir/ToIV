"""角色设定卡实现核(拆包后的生成/重试主路径)。"""
from __future__ import annotations

import asyncio
import colorsys
import contextvars
import hashlib
import json
import logging
import math
import os
import re
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

import app.services.studio.character_sheet.constants as _constants
globals().update({k: v for k, v in vars(_constants).items() if not k.startswith('__')})
import app.services.studio.character_sheet.templates as _templates
globals().update({k: v for k, v in vars(_templates).items() if not k.startswith('__')})
import app.services.studio.character_sheet.gates as _gates
globals().update({k: v for k, v in vars(_gates).items() if not k.startswith('__')})
import app.services.studio.character_sheet.layout as _layout
globals().update({k: v for k, v in vars(_layout).items() if not k.startswith('__')})
import app.services.studio.character_sheet.retry as _retry
globals().update({k: v for k, v in vars(_retry).items() if not k.startswith('__')})

async def classify_ancient_accessory_qa(image_bytes: bytes, *, meta: SheetMeta, worker_url: str | None, seed: int=42) -> dict:
    """调 Comfy Qwen-VL 判古风饰品两问;返回 {q1,q2,raw,model,reasons}。无适用问题 → {skipped:True}。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError
    global _VLM_STICKY_BACKEND
    prompt = build_ancient_accessory_qa_prompt(meta)
    if not prompt:
        return {'skipped': True, 'reasons': []}
    if not worker_url:
        raise CharacterSheetError('饰品问答缺少 worker_url', status_code=502)
    url = str(worker_url).rstrip('/')
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(image_bytes, f'sheet_acc_qa_{uuid.uuid4().hex[:10]}.png')
    default_backends = (('Qwen2_VQA', 'Qwen3-VL-4B-Instruct'), ('Qwen2_VQA', 'Qwen2-VL-7B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct-FP8'))
    sticky = _VLM_STICKY_BACKEND
    backends = (sticky,) + tuple((b for b in default_backends if b != sticky)) if sticky else default_backends
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(fname, prompt=prompt, model=model, seed=seed, backend=backend)
            prompt_id = await client.queue_prompt(graph, client_id=f'sheet_accqa_{uuid.uuid4().hex[:8]}')
            waited = 0.0
            raw_text = ''
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get('status') or {}
                if entry.get('outputs'):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get('status_str') == 'error':
                    raise CharacterSheetError('饰品问答执行失败', status_code=502)
                await asyncio.sleep(1.5)
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(f'饰品问答超时无文本 {backend}/{model}', status_code=504)
            parsed = _parse_expr_qa_json(raw_text)
            parsed['model'] = f'{backend}:{model}'
            parsed['reasons'] = ancient_accessory_qa_verdict(parsed, meta)
            _VLM_STICKY_BACKEND = (backend, model)
            return parsed
        except (CharacterSheetError, ComfyUIError) as e:
            last_err = e
            logger.warning('classify_ancient_accessory_qa %s/%s fail: %s', backend, model, e)
            continue
        except Exception as e:
            last_err = e
            logger.warning('classify_ancient_accessory_qa exc %s/%s: %s', backend, model, e)
            continue
    raise CharacterSheetError(f'饰品问答全部后端失败: {last_err}', status_code=502) from last_err

def style_similarity_score(candidate: bytes, reference: bytes, *, size: int=128) -> dict[str, float]:
    """相对参考正视头部的画风相似度:平滑直方图 + 均色 + 像素相关。

    返回 dict: hist (0~1), pixel (0~1), mean (0~1), score (加权)。无外部 CLIP 时用此门禁。
    """
    import math

    def _prep(data: bytes) -> Image.Image:
        im = Image.open(BytesIO(data)).convert('RGB')
        return im.resize((size, size), Image.Resampling.BILINEAR)
    a = _prep(candidate)
    b = _prep(reference)

    def _smooth_hist(im: Image.Image) -> list[float]:
        out: list[float] = []
        full = im.histogram()
        for ch in range(3):
            hx = full[ch * 256:(ch + 1) * 256]
            bins = [sum(hx[i * 16:(i + 1) * 16]) for i in range(16)]
            sm = [0.0] * 16
            for i, v in enumerate(bins):
                sm[i] += v * 0.5
                if i:
                    sm[i - 1] += v * 0.25
                if i + 1 < 16:
                    sm[i + 1] += v * 0.25
            out.extend(sm)
        return out

    def _cos(u: list[float], v: list[float]) -> float:
        dot = sum((a * b for a, b in zip(u, v)))
        nu = math.sqrt(sum((a * a for a in u))) or 1.0
        nv = math.sqrt(sum((b * b for b in v))) or 1.0
        return max(0.0, min(1.0, dot / (nu * nv)))
    ha, hb = (_smooth_hist(a), _smooth_hist(b))
    hist = _cos(ha, hb)
    pa = list(a.getdata())
    pb = list(b.getdata())
    ma = [sum((p[i] for p in pa)) / len(pa) for i in range(3)]
    mb = [sum((p[i] for p in pb)) / len(pb) for i in range(3)]
    mean_dist = math.sqrt(sum(((ma[i] - mb[i]) ** 2 for i in range(3)))) / 441.67
    mean = max(0.0, min(1.0, 1.0 - mean_dist))
    num = dx = dy = 0.0
    for p, q in zip(pa, pb):
        for i in range(3):
            a0 = p[i] - ma[i]
            b0 = q[i] - mb[i]
            num += a0 * b0
            dx += a0 * a0
            dy += b0 * b0
    if dx < 1e-06 or dy < 1e-06:
        pixel = mean
    else:
        pixel = max(0.0, min(1.0, (num / math.sqrt(dx * dy) + 1.0) / 2.0))
    score = 0.45 * hist + 0.35 * mean + 0.2 * pixel
    return {'hist': float(hist), 'pixel': float(pixel), 'mean': float(mean), 'score': float(score)}

def style_ok_for_face(candidate: bytes, reference: bytes, *, min_score: float=0.72) -> tuple[bool, dict[str, float]]:
    """画风门禁:与卡内正视头部相似度低于阈值则不入卡。"""
    meta = style_similarity_score(candidate, reference)
    return (bool(meta['score'] >= float(min_score)), meta)

async def _emblem_cleanup(*, make_plain, is_emblem):
    """徽标去标:按 denoise 升级序列重绘,清掉即回;全败返回 None(绝不矩形铺色)。"""
    for denoise in _DELOGO_DENOISE_SCHEDULE:
        cleaned = await make_plain(denoise)
        if not is_emblem(cleaned):
            return cleaned
    return None

def _hair_center_x(img: Image.Image, *, y0_frac: float, y1_frac: float) -> float:
    """顶带内暗色发丝/轮廓的水平重心，作硬裁中心。"""
    w, h = img.size
    y0 = max(0, int(h * y0_frac))
    y1 = min(h, max(y0 + 1, int(h * y1_frac)))
    px = img.load()
    sx = sw = 0.0
    for y in range(y0, y1):
        for x in range(w):
            r, g, b = px[x, y]
            lum = (r + g + b) / 3.0
            if lum < 55 and max(r, g, b) - min(r, g, b) < 40:
                sx += float(x)
                sw += 1.0
            elif lum < 120 and abs(r - g) < 18 and (abs(g - b) < 18) and (b <= r + 12):
                sx += float(x) * 0.35
                sw += 0.35
    if sw < 8:
        return w * 0.5
    return sx / sw

def _densify_three_quarter_head_crop(img: Image.Image, *, size: int=768, max_up: float=2.0) -> bytes | None:
    """00:59：按头高（发顶→下巴+颈）取框再 Lanczos；禁止眼部特写级密裁。"""
    box = _native_three_quarter_crop_box(img, max_up=max_up, prefer_tight=False)
    if box is None:
        return None
    left, top, side = box
    crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
    crop = _lanczos_to_square(crop, size)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def _native_three_quarter_crop_box(img: Image.Image, *, max_up: float | None=2.0, prefer_tight: bool=False) -> tuple[float, float, float] | None:
    """00:59：在母版原分辨率上按头高取¾侧头框 (left, top, side)。

    发顶 → 下巴再加脖子；禁止按画高固定比例紧裁成眼部特写。
    prefer_tight 保留兼容但默认 False，且不再把 side 压到 0.22*h。
    """
    w, h = img.size
    if w < 32 or h < 32:
        return None
    px = img.load()
    y_top = None
    for y in range(0, int(h * 0.55), max(1, h // 220)):
        dark = 0
        for x in range(0, w, max(1, w // 64)):
            r, g, b = px[x, y][:3]
            if r < 220 or g < 220 or b < 220:
                dark += 1
        if dark >= 3:
            y_top = y
            break
    if y_top is None:
        y_top = int(h * 0.02)
    face_bb = None
    try:
        buf = BytesIO()
        img.save(buf, format='PNG')
        face_bb = _detect_face_bbox_xyxy(buf.getvalue())
    except Exception:
        face_bb = None
    if face_bb is None:
        try:
            face_bb = _heuristic_skin_face_bbox(img)
        except Exception:
            face_bb = None
    if face_bb is not None:
        fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
        face_h = max(8.0, fy2 - fy1)
        face_w = max(8.0, fx2 - fx1)
        y_top_f = min(float(y_top), fy1 - face_h * 0.12)
        y_top_f = max(0.0, y_top_f)
        y_bot = min(float(h), fy2 + face_h * 0.28)
        head_h = max(face_h * 1.35, y_bot - y_top_f)
        target_side = face_h / 0.38
        side = max(head_h, face_w * 1.25, target_side)
        cx = (fx1 + fx2) / 2.0
    else:
        band = 0.3 if prefer_tight else 0.34
        y_top_f = float(y_top)
        side = float(h) * band
        xs: list[int] = []
        y1 = min(h, int(y_top_f) + max(16, int(side)))
        for y in range(int(y_top_f), y1, max(1, max(1, y1 - int(y_top_f)) // 16)):
            for x in range(w):
                r, g, b = px[x, y][:3]
                if r < 220 or g < 220 or b < 220:
                    xs.append(x)
        if len(xs) >= 8:
            xs.sort()
            cx = float(xs[len(xs) // 2])
        else:
            cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.4, band + 0.08))
    if max_up is not None and max_up > 1e-06:
        side = max(side, float(min(w, h)) / float(max_up))
    side = min(side, float(w), float(h))
    left = max(0.0, min(float(w) - side, cx - side / 2.0))
    top = max(0.0, min(float(h) - side, float(y_top_f) - side * 0.04))
    return (left, top, side)

def _lanczos_to_square(crop: Image.Image, size: int) -> Image.Image:
    """00:31：Lanczos 到方格。native≥size 时为缩小；native<size 时不可避免放大（应走高分侧母版）。"""
    if crop.size == (size, size):
        return crop
    return crop.resize((size, size), Image.Resampling.LANCZOS)

def side_crop_upscale_factor(native_side: float, size: int=768) -> float:
    """格尺寸 / 母版原裁边长；>1 表示需要放大（糊风险）。"""
    ns = max(1.0, float(native_side))
    return float(size) / ns

def side_face_slot_readable(data: bytes, *, native_side: float | None=None, size: int=768, max_upscale: float=1.08, min_sharp: float=8.0, min_face_frac: float=0.22) -> bool:
    """00:31：侧面格是否可读。需放大过多 / 边缘能量过低 / 无人脸 → 不可读，应重出高分侧母版。"""
    up = side_crop_upscale_factor(native_side, size) if native_side is not None else 1.0
    if up > float(max_upscale):
        return False
    frac = measure_face_height_frac(data)
    if frac is None or frac + 1e-12 < float(min_face_frac):
        area = measure_face_area_frac(data)
        if area is None or area + 1e-12 < 0.04:
            return False
    if up > 1.0 + 1e-06:
        sharp = _edge_sharpness_score(data)
        if sharp + 1e-12 < float(min_sharp):
            return False
    return True

def crop_face_slot_from_master(data: bytes, *, slot: str, size: int=768) -> bytes:
    """00:31 / 22:02：母版固定比例硬裁头像。

    face_front ← 主立绘顶部到下巴下（约画高 0–20%）
    face_three_quarter ← 侧母版原分辨率裁头 → Lanczos 到格尺寸（禁止改脸超分；默认无 Qwen 清线）
    face_side ← 背母版后脑勺顶部约 0–25%（≤2×；继续背母版硬裁）
    水平以头发轮廓中心为准。
    """
    out, _meta = crop_face_slot_from_master_with_meta(data, slot=slot, size=size)
    return out

def crop_face_slot_from_master_with_meta(data: bytes, *, slot: str, size: int=768) -> tuple[bytes, dict]:
    """同 crop_face_slot_from_master，额外返回 meta（native_side / upscale / readable）。"""
    if not data:
        raise CharacterSheetError(f'faces crop: empty master for {slot}', status_code=422)
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    meta: dict = {'slot': slot, 'master_size': (w, h), 'target': int(size)}
    if slot == 'face_front':
        band = 0.2
        max_up = 2.5
        side = float(band) * float(h)
        min_side = float(min(w, h)) / float(max_up)
        side = max(side, min_side)
        side = min(side, float(w), float(h))
        cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.35, band + 0.08))
        left = cx - side / 2.0
        top = 0.0
        if left < 0:
            left = 0.0
        if left + side > w:
            left = max(0.0, float(w) - side)
        if top + side > h:
            top = max(0.0, float(h) - side)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format='PNG')
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        if frac is not None and frac + 1e-12 < 0.35:
            target = 0.42
            shrink = max(0.55, min(0.92, float(frac) / target))
            floor = float(min(w, h)) / float(max_up)
            new_side = max(floor, side * shrink)
            new_side = min(new_side, float(w), float(h), side)
            left2 = cx - new_side / 2.0
            if left2 < 0:
                left2 = 0.0
            if left2 + new_side > w:
                left2 = max(0.0, float(w) - new_side)
            crop = img.crop((int(left2), int(0.0), int(left2 + new_side), int(new_side)))
            out_im = _lanczos_to_square(crop, size)
            buf = BytesIO()
            out_im.save(buf, format='PNG')
            out = buf.getvalue()
            side = new_side
            frac = measure_face_height_frac(out)
        meta.update({'native_side': float(side), 'upscale': side_crop_upscale_factor(side, size), 'face_frac': frac})
        if frac is None:
            vspan = panel_vertical_span(out)
            if vspan + 1e-12 < 0.35:
                raise CharacterSheetError(f'faces {slot} hard-crop head/content frac {vspan:.3f} < 0.35', status_code=422)
        elif frac + 1e-12 < 0.35:
            # F5: face_front 近失(如 0.324)与 face_side soft-ok 对齐；<0.30 仍硬拒
            if float(frac) + 1e-12 >= 0.30:
                logger.warning('faces %s hard-crop frac=%.3f <0.35 — soft ok near-miss (>=0.30)', slot, frac)
            else:
                raise CharacterSheetError(f'faces {slot} hard-crop face height frac {frac:.3f} < 0.35', status_code=422)
        meta['readable'] = True
        return (out, meta)
    if slot == 'face_three_quarter':
        box = _native_three_quarter_crop_box(img, max_up=2.0, prefer_tight=False)
        if box is None:
            raise CharacterSheetError('faces face_three_quarter: cannot locate head box', status_code=422)
        left, top, side = box
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format='PNG')
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        if frac is not None and frac - 1e-12 > 0.5:
            grow = min(2.2, float(frac) / 0.38)
            new_side = min(float(w), float(h), side * grow)
            cx = left + side / 2.0
            left2 = max(0.0, min(float(w) - new_side, cx - new_side / 2.0))
            top2 = max(0.0, min(float(h) - new_side, top - (new_side - side) * 0.35))
            crop = img.crop((int(left2), int(top2), int(left2 + new_side), int(top2 + new_side)))
            out_im = _lanczos_to_square(crop, size)
            buf = BytesIO()
            out_im.save(buf, format='PNG')
            out = buf.getvalue()
            side = new_side
            left, top = (left2, top2)
            frac = measure_face_height_frac(out)
            logger.info('faces %s expand overcrop frac→%s native_side=%.1f', slot, frac, side)
        elif frac is None or frac + 1e-12 < 0.28:
            denser = _densify_three_quarter_head_crop(img, size=size, max_up=2.0)
            tightened = None
            if frac is not None and float(frac) + 1e-12 < 0.28:
                try:
                    tightened = tighten_side_square_to_face_frac(out, target=0.3, min_frac=0.28, max_frac=0.35, size=size)
                except Exception:
                    tightened = None
            chosen = None
            chosen_frac = frac
            for cand in (tightened, denser):
                if not cand:
                    continue
                dfrac = measure_face_height_frac(cand)
                if dfrac is None:
                    continue
                if float(dfrac) <= 0.5 + 1e-09 and (chosen_frac is None or float(dfrac) > float(chosen_frac) + 0.01):
                    chosen, chosen_frac = (cand, dfrac)
            if chosen is not None:
                out = chosen
                frac = chosen_frac
                logger.info('faces %s tighten/densify head frac→%s native_side=%.1f', slot, frac, side)
        up = side_crop_upscale_factor(side, size)
        readable = side_face_slot_readable(out, native_side=side, size=size, max_upscale=1.08)
        framing_ok = frac is not None and 0.25 - 1e-09 <= float(frac) <= 0.5 + 1e-09
        meta.update({'native_side': float(side), 'upscale': float(up), 'face_frac': frac, 'framing_ok': bool(framing_ok), 'readable': bool(readable) and bool(framing_ok if frac is not None else readable), 'route': '00:59_head_height_lanczos'})
        if frac is None:
            logger.warning('faces %s hard-crop no face frac upscale=%.2f — soft ok (00:59)', slot, up)
        elif not framing_ok:
            logger.warning('faces %s hard-crop frac=%.3f outside 0.25–0.50 upscale=%.2f', slot, frac, up)
        return (out, meta)
    if slot == 'face_side':
        band = 0.25
        max_up = 2.0
        side = float(band) * float(h)
        min_side = float(min(w, h)) / float(max_up)
        side = max(side, min_side)
        side = min(side, float(w), float(h))
        cx = _hair_center_x(img, y0_frac=0.0, y1_frac=min(0.35, band + 0.08))
        left = cx - side / 2.0
        top = 0.0
        if left < 0:
            left = 0.0
        if left + side > w:
            left = max(0.0, float(w) - side)
        if top + side > h:
            top = max(0.0, float(h) - side)
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = _lanczos_to_square(crop, size)
        buf = BytesIO()
        out_im.save(buf, format='PNG')
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        meta.update({'native_side': float(side), 'upscale': side_crop_upscale_factor(side, size), 'face_frac': frac, 'readable': True})
        if frac is None:
            logger.warning('faces %s hard-crop no face frac — soft ok (23:17/00:31 no deblur)', slot)
        elif frac + 1e-12 < 0.35:
            logger.warning('faces %s hard-crop frac=%.3f <0.35 — soft ok (23:17/00:31 no deblur)', slot, frac)
        return (out, meta)
    raise CharacterSheetError(f'faces crop: unknown slot {slot}', status_code=422)

def prepare_hires_side_head_init(side_master: bytes, *, out_size: int=1280) -> bytes:
    """从侧母版原分辨率裁头肩，再 Lanczos 到 out_size，作高分侧母版 img2img 初值。

    注意：此处放大仅作生成初值，真正清晰度靠模型重出，不是改脸超分。
    """
    img = Image.open(BytesIO(side_master)).convert('RGB')
    box = _native_three_quarter_crop_box(img, max_up=None, prefer_tight=False)
    if box is None:
        w, h = img.size
        side = min(float(w), float(h) * 0.35, float(h))
        box = (max(0.0, (w - side) / 2.0), 0.0, side)
    left, top, side = box
    side2 = min(float(img.size[0]), float(img.size[1]), side * 1.15)
    left = max(0.0, min(float(img.size[0]) - side2, left - (side2 - side) / 2.0))
    top = max(0.0, min(float(img.size[1]) - side2, top))
    crop = img.crop((int(left), int(top), int(left + side2), int(top + side2)))
    out = _lanczos_to_square(crop, int(out_size))
    buf = BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()

def build_faces_tri_from_masters(*, portrait: bytes | None, front: bytes | None, side: bytes | None, back: bytes | None=None, size: int=768) -> dict[str, bytes]:
    """22:02 映射：正←portrait/front；侧/¾←侧母版；背头←背母版。

    三格源文件 md5 必须互异，否则 compose 前 422（禁止侧脸重复占第三格）。
    """
    import hashlib as _hl
    src_front = portrait or front
    if not src_front:
        raise CharacterSheetError('faces crop: need portrait or front master', status_code=422)
    if not side:
        raise CharacterSheetError('faces crop: need side master', status_code=422)
    if not back:
        raise CharacterSheetError('faces crop: need back master for back-of-head slot', status_code=422)
    md_f = _hl.md5(src_front).hexdigest()
    md_s = _hl.md5(side).hexdigest()
    md_b = _hl.md5(back).hexdigest()
    if len({md_f, md_s, md_b}) < 3:
        raise CharacterSheetError(f'faces crop: source masters not distinct (front={md_f[:12]} side={md_s[:12]} back={md_b[:12]})', status_code=422)
    return {'face_front': crop_face_slot_from_master(src_front, slot='face_front', size=size), 'face_three_quarter': crop_face_slot_from_master(side, slot='face_three_quarter', size=size), 'face_side': crop_face_slot_from_master(back, slot='face_side', size=size)}

def _hair_extent_below_face(data: bytes) -> dict[str, float]:
    """脸侧发带下探（不含脸下中央，避免雨衣深色当头发）。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        x1, y1, x2, y2 = (w * 0.25, h * 0.08, w * 0.75, h * 0.38)
    else:
        x1, y1, x2, y2 = [float(v) for v in bb]
        if (y2 - y1) / float(h) > 0.45:
            y2 = y1 + 0.38 * h
            x1, x2 = (w * 0.3, w * 0.7)
    fh = max(8.0, y2 - y1)
    fw = max(8.0, x2 - x1)
    chin_y = y2
    shoulder_y = min(h - 1.0, y2 + 0.7 * fh)
    side_pad = max(6, int(0.42 * fw))
    bands = [(max(0, int(x1) - side_pad), max(0, int(x1) + 2), int(y1), h), (min(w, int(x2) - 2), min(w, int(x2) + side_pad), int(y1), h)]
    dark_chin = 0
    dark_shoulder = 0
    max_y_dark = chin_y
    px = img.load()
    for xa, xb, ya, yb in bands:
        xa, xb = (max(0, min(xa, xb)), max(0, max(xa, xb)))
        xa, xb = (min(xa, w), min(xb, w))
        ya, yb = (max(0, ya), min(h, yb))
        for y in range(ya, yb):
            row_dark = 0
            for x in range(xa, xb):
                r, g, b = px[x, y]
                lum = (r + g + b) / 3.0
                if lum < 42 and max(r, g, b) - min(r, g, b) < 28 and (b <= r + 8):
                    row_dark += 1
                    if y >= chin_y:
                        if y <= shoulder_y:
                            dark_chin += 1
                        else:
                            dark_shoulder += 1
                        if y > max_y_dark:
                            max_y_dark = float(y)
            if y > chin_y and row_dark == 0 and (max_y_dark > chin_y + 2):
                pass
    tip_frac = (max_y_dark - chin_y) / float(max(1, h))
    return {'tip_frac': float(max(0.0, tip_frac)), 'dark_below_chin': float(dark_chin), 'dark_below_shoulder': float(dark_shoulder), 'chin_y': float(chin_y), 'shoulder_y': float(shoulder_y), 'h': float(h)}

def expression_hair_too_long(data: bytes, *, ref: bytes | None=None, chin_only: bool=False, relative_only: bool=False) -> bool:
    """18:23 / 16:18 / 19:15 发长门禁：只与同格表情底同裁同尺度比 delta。

    relative_only=True（遮罩外已贴回底图）：只比相对 delta，不做绝对过肩拒。
    禁止拿表情近景去比主立绘全身比例。
    非温柔：肩下侧发带相对加长才拒；温柔：下巴下 + 肩下。
    """
    cur = _hair_extent_below_face(data)
    base = _hair_extent_below_face(ref) if ref else None
    if relative_only:
        if base is None:
            return False
        if chin_only:
            return bool(cur['dark_below_shoulder'] >= base['dark_below_shoulder'] + 80 or cur['tip_frac'] >= base['tip_frac'] + 0.12)
        return bool(cur['dark_below_shoulder'] >= base['dark_below_shoulder'] + 90 or cur['tip_frac'] >= base['tip_frac'] + 0.14)
    if chin_only:
        abs_hit = cur['dark_below_shoulder'] >= 80 or (cur['tip_frac'] > 0.16 and cur['dark_below_chin'] + cur['dark_below_shoulder'] >= 80)
        if base is None:
            return bool(abs_hit)
        worse = cur['dark_below_shoulder'] >= base['dark_below_shoulder'] + 50 or cur['tip_frac'] >= base['tip_frac'] + 0.08
        return bool(abs_hit and worse)
    abs_hit = cur['dark_below_shoulder'] >= 100
    if base is None:
        return bool(abs_hit)
    worse = cur['dark_below_shoulder'] >= base['dark_below_shoulder'] + 60
    return bool(abs_hit and worse)

def _facial_feature_roi(im: Image.Image) -> Image.Image:
    """眉眼嘴区域：上半脸到嘴下（约 12%–72% 高，20%–80% 宽）。"""
    w, h = im.size
    return im.crop((int(w * 0.2), int(h * 0.12), int(w * 0.8), int(h * 0.72)))

def build_face_feature_mask(size: int=768) -> Image.Image:
    """眉/眼/嘴局部遮罩（白=可编辑），供表情局部合成。

    19:15：眼带收紧，并挖掉左右瞳孔中心，避免重画瞳孔高光/心形瞳。
    """
    s = int(size)
    mask = Image.new('L', (s, s), 0)
    from PIL import ImageDraw as _ID
    d = _ID.Draw(mask)
    d.ellipse((int(s * 0.22), int(s * 0.14), int(s * 0.78), int(s * 0.36)), fill=255)
    d.ellipse((int(s * 0.22), int(s * 0.3), int(s * 0.78), int(s * 0.48)), fill=255)
    d.ellipse((int(s * 0.3), int(s * 0.52), int(s * 0.7), int(s * 0.74)), fill=255)
    pr = max(4, int(s * 0.035))
    for cx in (int(s * 0.38), int(s * 0.62)):
        cy = int(s * 0.38)
        d.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=0)
    try:
        from PIL import ImageFilter
        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(4, s // 64)))
    except Exception:
        pass
    return mask

def blend_face_local_edit(original: bytes, edited: bytes, *, strength: float=0.7, size: int=768) -> bytes:
    """把编辑结果仅合成到眉眼嘴遮罩内；strength≈0.6–0.75 等效局部 inpaint 强度。

    须在 enforce_head_shoulders_square 之前调用，且 original 与 edited 同构图参考，
    否则重框后会对不齐 → 叠影。
    """
    strength = max(0.6, min(0.75, float(strength)))
    o = Image.open(BytesIO(original)).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    e = Image.open(BytesIO(edited)).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    try:
        pa = list(o.resize((64, 64)).getdata())
        pb = list(e.resize((64, 64)).getdata())
        mae = sum(((abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])) / 3.0 for a, b in zip(pa, pb))) / float(len(pa))
        if mae > 45.0:
            buf = BytesIO()
            e.save(buf, format='PNG')
            return buf.getvalue()
    except Exception:
        pass
    m = build_face_feature_mask(size)
    m = m.point(lambda v: 255 if v >= 96 else 0)
    try:
        from PIL import ImageFilter
        m = m.filter(ImageFilter.GaussianBlur(radius=max(6, size // 64)))
    except Exception:
        pass
    m_s = m.point(lambda v: int(v * strength))
    out = Image.composite(e, o, m_s)
    buf = BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()

def build_face_paste_mask(size: int=768, *, face_bbox: tuple[float, float, float, float] | None=None) -> Image.Image:
    """00:30：眉眼口鼻区羽化遮罩，下边界不超过下巴。

    用于 Qwen-Edit 结果贴回 approved_portrait：遮罩外（胸口/衣服）强制原图像素，
    消除新徽标/字样。相对脸框比例；无人脸时回退头肩经验比例。
    """
    s = int(size)
    mask = Image.new('L', (s, s), 0)
    from PIL import ImageDraw as _ID
    d = _ID.Draw(mask)
    if face_bbox is not None:
        x1, y1, x2, y2 = [float(v) for v in face_bbox]
        fw = max(8.0, x2 - x1)
        fh = max(8.0, y2 - y1)
        d.ellipse((int(x1 + 0.05 * fw), int(y1 + 0.02 * fh), int(x2 - 0.05 * fw), int(y1 + 0.38 * fh)), fill=255)
        d.ellipse((int(x1 + 0.06 * fw), int(y1 + 0.22 * fh), int(x2 - 0.06 * fw), int(y1 + 0.52 * fh)), fill=255)
        d.ellipse((int(x1 + 0.32 * fw), int(y1 + 0.4 * fh), int(x2 - 0.32 * fw), int(y1 + 0.68 * fh)), fill=255)
        mouth_bottom = min(float(y2), y1 + 0.92 * fh)
        d.ellipse((int(x1 + 0.18 * fw), int(y1 + 0.58 * fh), int(x2 - 0.18 * fw), int(mouth_bottom)), fill=255)
        if int(y2) < s - 1:
            d.rectangle((0, int(y2) + 1, s, s), fill=0)
    else:
        d.ellipse((int(s * 0.22), int(s * 0.12), int(s * 0.78), int(s * 0.36)), fill=255)
        d.ellipse((int(s * 0.22), int(s * 0.28), int(s * 0.78), int(s * 0.48)), fill=255)
        d.ellipse((int(s * 0.38), int(s * 0.4), int(s * 0.62), int(s * 0.62)), fill=255)
        d.ellipse((int(s * 0.3), int(s * 0.52), int(s * 0.7), int(s * 0.7)), fill=255)
        d.rectangle((0, int(s * 0.72), s, s), fill=0)
    try:
        from PIL import ImageFilter
        mask = mask.filter(ImageFilter.GaussianBlur(radius=max(6, s // 48)))
    except Exception:
        pass
    return mask

def paste_qedit_face_onto_portrait(original: bytes, edited: bytes, *, size: int=768) -> bytes:
    """00:30：Qwen-Edit 结果只取眉眼口鼻贴回 approved_portrait；胸口衣服保留原像素。"""
    o = Image.open(BytesIO(original)).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    e = Image.open(BytesIO(edited)).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    bb = _detect_face_bbox_xyxy(original)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(o)
        except Exception:
            bb = None
    m = build_face_paste_mask(size, face_bbox=bb)
    m_hard = m.point(lambda v: 255 if v >= 64 else 0)
    try:
        from PIL import ImageFilter
        m_soft = m_hard.filter(ImageFilter.GaussianBlur(radius=max(6, size // 48)))
    except Exception:
        m_soft = m
    out = Image.composite(e, o, m_soft)
    out = Image.composite(out, o, m_hard)
    buf = BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()

def _expr_frame_bbox(data: bytes) -> tuple[float, float, float, float] | None:
    """表情格构图测量用脸框：与 crop_expr_head_closeup 同一检测链（insightface→动漫级联→启发式）。"""
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(Image.open(BytesIO(data)).convert('RGB'))
        except Exception:
            bb = None
    if bb is None:
        return None
    return tuple((float(v) for v in bb))

def measure_expr_frame(data: bytes) -> dict | None:
    """04:30：测表情格构图 {face_frac, face_top_frac, face_cx_frac}（相对画面边长）。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    w, h = im.size
    bb = _expr_frame_bbox(data)
    if bb is None:
        return None
    x1, y1, x2, y2 = bb
    if y2 - y1 < 8 or x2 - x1 < 8:
        return None
    return {'face_frac': (y2 - y1) / float(h), 'face_top_frac': y1 / float(h), 'face_cx_frac': (x1 + x2) / 2.0 / float(w)}

def locked_expr_frame(cells: list[bytes]) -> dict | None:
    """04:30：已锁表情格构图中位数；可测格 <2 返回 None（回退默认头特写规则）。"""
    ms = [m for m in (measure_expr_frame(c) for c in cells if c) if m]
    if len(ms) < 2:
        return None
    import statistics as _st
    out = {k: float(_st.median([m[k] for m in ms])) for k in ('face_frac', 'face_top_frac', 'face_cx_frac')}
    out['n'] = len(ms)
    return out

def _crop_expr_to_frame(im0: Image.Image, bb: tuple[float, float, float, float], frame: dict, *, size: int=768) -> bytes:
    """04:30：按锁定格比例裁（同检测器），越界只允许小幅平移；不够则抛 HeadcropSourceShort。"""
    w0, h0 = im0.size
    fx1, fy1, fx2, fy2 = bb
    fh = max(8.0, fy2 - fy1)
    ff = max(0.2, min(0.85, float(frame['face_frac'])))
    side = fh / ff
    top = fy1 - float(frame['face_top_frac']) * side
    left = (fx1 + fx2) / 2.0 - float(frame['face_cx_frac']) * side
    mn = float(min(w0, h0))
    if side > mn * 1.03:
        raise HeadcropSourceShort(f'头特写源图不足: 需 side={side:.0f}px > 源 {w0}x{h0}（禁止灰垫，需更宽源/outpaint）')
    side = min(side, mn)
    over_b = top + side - h0
    if over_b > 0.04 * side:
        raise HeadcropSourceShort(f'头特写源图下方不足: 缺 {over_b:.0f}px（{over_b / side:.2f}×side，禁止灰垫，需更宽源/outpaint）')
    if -top > 0.06 * side:
        raise HeadcropSourceShort(f'头特写源图上方不足: 缺 {-top:.0f}px（禁止灰垫）')
    over_l = max(0.0, -left)
    over_r = max(0.0, left + side - w0)
    if over_l + over_r > 0.15 * side:
        raise HeadcropSourceShort(f'头特写源图侧边不足: 左缺 {over_l:.0f}px 右缺 {over_r:.0f}px（禁止灰垫）')
    s_i = int(round(side))
    top_i = int(round(max(0.0, min(h0 - side, top))))
    left_i = int(round(max(0.0, min(w0 - side, left))))
    crop = im0.crop((left_i, top_i, left_i + s_i, top_i + s_i)).resize((int(size), int(size)), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def crop_expr_head_closeup(data: bytes, *, size: int=768, chin_margin_face_frac: float=0.4, hair_above_face_frac: float=0.6, target_face_height_frac: float=0.45, top_margin_frac: float=0.1, frame: dict | None=None) -> bytes:
    """02:42：表情格头部特写裁剪。

    04:30：**禁止任何色块/灰垫填充**。源图下方/侧边不够时抛
    ``HeadcropSourceShort``（调用方换更宽的源再裁），不再用角点色垫边。
    ``frame``（来自已锁表情格的 face_frac/face_top_frac/face_cx_frac 中位数）给定时，
    按同一检测器同比例裁，保证与锁定格头顶留白、肩线一致。

    - 脸框上沿以上至少 ``hair_above_face_frac``(默认 0.6) 倍脸高，盖住整个发顶；
    - 成品脸高约占画面 ``target_face_height_frac``(≈0.45)；
    - 头顶留白约 ``top_margin_frac``(8–12%，默认 0.10)；
    - 下沿到锁骨附近（``chin_margin_face_frac``≈0.40 脸高）；
    - 源图发顶空间不足时 **禁止** 灰底垫高；贴顶实裁，由发顶平切门禁拒灰底平切；上游可换全身/立绘或让 Qwen 补发顶。
    """
    im0 = Image.open(BytesIO(data)).convert('RGB')
    w0, h0 = im0.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im0)
        except Exception:
            bb = None
    if bb is None:
        side = min(w0, h0)
        left = (w0 - side) // 2
        top = max(0, int(h0 * 0.02))
        if top + side > h0:
            top = max(0, h0 - side)
        crop = im0.crop((left, top, left + side, top + side)).resize((int(size), int(size)), Image.Resampling.LANCZOS)
        buf = BytesIO()
        crop.save(buf, format='PNG')
        return buf.getvalue()
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    fcx = (fx1 + fx2) / 2.0
    if frame:
        return _crop_expr_to_frame(im0, (fx1, fy1, fx2, fy2), frame, size=int(size))
    hair_pad = max(0.5, float(hair_above_face_frac)) * fh
    hair_top = fy1 - hair_pad
    chin_bottom = fy2 + float(chin_margin_face_frac) * fh
    tgt_face = max(0.38, min(0.55, float(target_face_height_frac)))
    top_m = max(0.08, min(0.12, float(top_margin_frac)))
    side_f = fh / tgt_face
    side_f = max(side_f, fw * 1.35)
    span_need = hair_pad + fh + float(chin_margin_face_frac) * fh + top_m * side_f
    side_f = max(side_f, span_need)
    side = int(math.ceil(side_f))
    top_f = hair_top - top_m * side
    left_f = fcx - side / 2.0
    short_headroom = False
    if hair_top < 0.0:
        short_headroom = True
        hair_top = 0.0
        top_f = hair_top - top_m * side
    if top_f < 0.0:
        short_headroom = True
        top_f = 0.0
    img = im0
    over_l = max(0.0, -left_f)
    over_r = max(0.0, left_f + side - w0)
    over_b = max(0.0, top_f + side - h0)
    if side > min(w0, h0) * 1.03:
        raise HeadcropSourceShort(f'头特写源图不足: 需 side={side}px > 源 {w0}x{h0}（禁止灰垫，需更宽源/outpaint）')
    if over_b > 0.04 * side:
        raise HeadcropSourceShort(f'头特写源图下方不足: 缺 {over_b:.0f}px（{over_b / side:.2f}×side，禁止灰垫，需更宽源/outpaint）')
    if over_l + over_r > 0.15 * side:
        raise HeadcropSourceShort(f'头特写源图侧边不足: 左缺 {over_l:.0f}px 右缺 {over_r:.0f}px（禁止灰垫）')
    w, h = img.size
    side = int(min(max(side, 64), w, h))
    left = int(round(left_f))
    top = int(round(top_f))
    if chin_bottom - top > side * 0.98:
        top = int(round(chin_bottom - side * 0.96))
    left = max(0, min(w - side, left))
    top = max(0, min(h - side, top))
    face_top_in_crop = fy1 - top
    if not short_headroom and face_top_in_crop + 1e-06 < 0.55 * fh:
        want_top = fy1 - 0.6 * fh - top_m * side
        top = max(0, int(round(want_top)))
        face_top_in_crop = fy1 - top
    crop = img.crop((left, top, left + side, top + side)).resize((int(size), int(size)), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    out = buf.getvalue()
    bb2 = _detect_face_bbox_xyxy(out)
    if bb2 is not None:
        _x1, _y1, _x2, _y2 = [float(v) for v in bb2]
        face_frac = (_y2 - _y1) / float(size)
        top_blank = _y1 / float(size)
        if face_frac > 0.55 or face_frac < 0.36 or top_blank > 0.18:
            fh2 = max(8.0, _y2 - _y1)
            hair2 = _y1 - 0.6 * fh2
            chin2 = _y2 + float(chin_margin_face_frac) * fh2
            side2 = int(max(64, fh2 / 0.45, (_x2 - _x1) * 1.3, chin2 - hair2 + 0.1 * (fh2 / 0.45)))
            im2 = Image.open(BytesIO(out)).convert('RGB')
            if side2 <= size and hair2 >= -1.0:
                cx2 = (_x1 + _x2) / 2.0
                top2 = int(round(hair2 - 0.1 * side2))
                left2 = int(round(cx2 - side2 / 2.0))
                left2 = max(0, min(size - side2, left2))
                top2 = max(0, min(size - side2, top2))
                c2 = im2.crop((left2, top2, left2 + side2, top2 + side2)).resize((int(size), int(size)), Image.Resampling.LANCZOS)
                buf2 = BytesIO()
                c2.save(buf2, format='PNG')
                out = buf2.getvalue()
    return out

def measure_hard_seam_contour(data: bytes, *, size: int=768, stage: str='raw') -> dict:
    """01:50：检测椭圆/矩形硬边接缝（边缘梯度沿闭合轮廓突变）。

    主信号：沿脸部羽化贴回遮罩边界的颜色跳变（专拦 0104 碎脸贴回伪影）；
    辅信号：轴对齐长边围成的矩形框；强闭合椭圆突变。

    stage:
      - raw：完整 Qwen 输出，mask_p75 阈值按 0104 碎脸校准
      - crop：头部特写裁剪后，mask 边界易与发际线重合 → 提高阈值，主靠 rect/ell
    """
    import cv2
    im0 = Image.open(BytesIO(data)).convert('RGB')
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im0)
        except Exception:
            bb = None
    im = im0.resize((size, size), Image.Resampling.LANCZOS)
    if bb is not None:
        sx = size / float(max(1, im0.width))
        sy = size / float(max(1, im0.height))
        bb_s = (bb[0] * sx, bb[1] * sy, bb[2] * sx, bb[3] * sy)
    else:
        bb_s = None
    import numpy as np
    arr = np.asarray(im, dtype=np.float32)
    gray = arr.mean(axis=2).astype(np.float32)
    m = build_face_paste_mask(size, face_bbox=bb_s)
    marr = np.asarray(m, dtype=np.float32)
    try:
        from PIL import ImageFilter as _IF
        soft = np.asarray(m.filter(_IF.GaussianBlur(radius=max(2, size // 256))), dtype=np.float32)
    except Exception:
        soft = marr
    ring = np.abs(marr - soft) > 6
    mk = np.ones((5, 5), np.uint8)
    dil = cv2.dilate(marr, mk)
    ero = cv2.erode(marr, mk)
    ring = ring | (dil - ero > 15)
    gy, gx = np.gradient(marr)
    ys, xs = np.where(ring)
    jumps: list[float] = []
    if len(xs) > 30:
        idx = np.linspace(0, len(xs) - 1, min(400, len(xs))).astype(int)
        for i in idx:
            x, y = (int(xs[i]), int(ys[i]))
            gxv, gyv = (float(gx[y, x]), float(gy[y, x]))
            nrm = (gxv * gxv + gyv * gyv) ** 0.5 + 1e-06
            gxv /= nrm
            gyv /= nrm
            xin = int(round(x - 5 * gxv))
            yin = int(round(y - 5 * gyv))
            xout = int(round(x + 5 * gxv))
            yout = int(round(y + 5 * gyv))
            if 0 <= xin < size and 0 <= yin < size and (0 <= xout < size) and (0 <= yout < size):
                jumps.append(float(np.abs(arr[yin, xin] - arr[yout, xout]).mean()))
    if jumps:
        ja = np.asarray(jumps, dtype=np.float32)
        mask_p75 = float(np.percentile(ja, 75))
        mask_mean = float(ja.mean())
        mask_strong = float((ja > 32).mean())
    else:
        mask_p75 = mask_mean = mask_strong = 0.0
    edges = cv2.Canny(np.clip(gray, 0, 255).astype(np.uint8), 60, 160)
    margin = int(size * 0.12)
    roi = edges[margin:size - margin, margin:size - margin]
    lines = cv2.HoughLinesP(roi, 1, np.pi / 180, threshold=40, minLineLength=int(size * 0.18), maxLineGap=8)
    h_seg = v_seg = 0
    if lines is not None:
        for ln in lines:
            pts = ln[0] if getattr(ln, 'ndim', 1) > 1 or len(ln) == 1 else ln
            try:
                x1, y1, x2, y2 = [int(v) for v in (pts if len(pts) == 4 else ln.reshape(-1)[:4])]
            except Exception:
                continue
            dx, dy = (abs(x2 - x1), abs(y2 - y1))
            if dy <= 3 and dx >= int(size * 0.18):
                h_seg += 1
            if dx <= 3 and dy >= int(size * 0.18):
                v_seg += 1
    rectish = bool(h_seg >= 2 and v_seg >= 2)
    top_band = edges[int(size * 0.04):int(size * 0.18), int(size * 0.15):int(size * 0.85)]
    top_row_frac = float((top_band > 0).mean(axis=1).max()) if top_band.size else 0.0
    top_hard_cut = bool(top_row_frac >= 0.55)
    mag = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    if bb_s is not None:
        cx = int((bb_s[0] + bb_s[2]) / 2)
        cy = int((bb_s[1] + bb_s[3]) / 2)
    else:
        cx, cy = (size // 2, int(size * 0.4))
    best_ell = 0.0
    best_frac = 0.0
    for ry in range(int(size * 0.12), int(size * 0.28), 4):
        for rx in range(int(size * 0.1), int(size * 0.26), 4):
            n = 48
            strong = 0
            js: list[float] = []
            for i in range(n):
                a = 2 * math.pi * i / n
                x = int(round(cx + rx * math.cos(a)))
                y = int(round(cy + ry * math.sin(a)))
                if not (6 <= x < size - 6 and 6 <= y < size - 6):
                    continue
                nx, ny = (math.cos(a), math.sin(a))
                xin = int(round(x - 4 * nx))
                yin = int(round(y - 4 * ny))
                xout = int(round(x + 4 * nx))
                yout = int(round(y + 4 * ny))
                j = float(np.abs(arr[yin, xin] - arr[yout, xout]).mean())
                m0 = float(mag[y, x])
                ms = 0.5 * (float(mag[yin, xin]) + float(mag[yout, xout]))
                thin = m0 / max(ms, 1.0)
                js.append(j)
                if j > 32 and thin > 1.7:
                    strong += 1
            if len(js) < 30:
                continue
            frac = strong / float(n)
            score = float(sum(js) / len(js)) * frac * 2.0
            if score > best_ell:
                best_ell = score
                best_frac = frac
    st = (stage or 'raw').strip().lower()
    if st == 'crop':
        mask_hit = mask_p75 >= 40.0 and mask_strong >= 0.27
        ell_hit = best_ell >= 80.0 and best_frac >= 0.38
        extra = top_hard_cut
    else:
        mask_hit = mask_p75 >= 26.0 and mask_strong >= 0.2
        ell_hit = best_ell >= 70.0 and best_frac >= 0.35
        extra = False
    reject = bool(mask_hit or rectish or ell_hit or extra)
    return {'mask_p75': mask_p75, 'mask_mean': mask_mean, 'mask_strong': mask_strong, 'rectish': rectish, 'h_seg': h_seg, 'v_seg': v_seg, 'ell_score': best_ell, 'ell_frac': best_frac, 'top_hard_cut': top_hard_cut, 'stage': st, 'reject': reject}

def measure_flat_hairline_cut(data: bytes, *, min_run_px: int=40, bg_tol: float=18.0, min_flat_y_frac: float=0.05) -> dict:
    """02:42：发顶平切检测——顶部发际轮廓出现 ≥min_run_px 水平直线且其上为均匀灰底即拒。

    用每列最上方前景 y 构成发际轮廓；连续同 y（容差 0）的水平段长度即平切 run。
    发顶紧贴画布上沿（无灰底垫高）不判为平切，避免误杀自然顶裁。
    """
    import numpy as np
    im = np.asarray(Image.open(BytesIO(data)).convert('RGB'), dtype=np.float32)
    h, w, _ = im.shape
    corners = np.concatenate([im[:12, :12].reshape(-1, 3), im[:12, -12:].reshape(-1, 3)], axis=0)
    bg = np.median(corners, axis=0)
    dist = np.linalg.norm(im - bg[None, None, :], axis=2)
    gray = im.mean(axis=2)
    fg = (dist > float(bg_tol)) & (gray < float(bg.mean()) - 6.0)
    top_y = np.full(w, -1, dtype=np.int32)
    for x in range(w):
        ys = np.where(fg[:, x])[0]
        if len(ys):
            top_y[x] = int(ys[0])
    best = 0
    best_y = -1
    best_x0 = -1
    cur = 0
    cur_y = -1
    cur_x0 = -1
    for x in range(w):
        y = int(top_y[x])
        if y < 0:
            cur = 0
            cur_y = -1
            continue
        if cur > 0 and y == cur_y:
            cur += 1
            if cur > best:
                best = cur
                best_y = cur_y
                best_x0 = cur_x0
        else:
            cur = 1
            cur_y = y
            cur_x0 = x
            if cur > best:
                best = cur
                best_y = y
                best_x0 = x
    gray_above = False
    y_floor = int(float(min_flat_y_frac) * h)
    if best_y >= y_floor:
        band = im[max(0, best_y - min(best_y, 24)):best_y]
        if band.size:
            d = np.linalg.norm(band - bg[None, None, :], axis=2)
            gray_above = float(np.median(d)) < float(bg_tol) and float(d.std()) < 12.0
    reject = bool(best >= int(min_run_px) and best_y >= y_floor and gray_above)
    return {'max_flat_run': int(best), 'flat_y': int(best_y), 'flat_x0': int(best_x0), 'flat_y_frac': float(best_y) / float(h) if best_y >= 0 else None, 'gray_above': bool(gray_above), 'min_run_px': int(min_run_px), 'reject': reject}

def _parse_yes_no_token(raw) -> bool | None:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ('true', 'yes', 'y', '1', '是', '对', '有'):
            return True
        if s in ('false', 'no', 'n', '0', '否', '不', '没有', '无'):
            return False
    return None

def crop_mouth_zoom(data: bytes, *, out_w: int=512) -> bytes:
    """05:30：按脸框裁嘴部（脸框 0.40→1.15 高、中间 70% 宽，容检测框偏差）并放大，供 VLM 复判是否闭嘴。"""
    bb = _detect_face_bbox_xyxy(data)
    im = Image.open(BytesIO(data)).convert('RGB')
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(im)
        except Exception:
            bb = None
    if bb is None:
        raise CharacterSheetError('嘴部放大: 测不到脸', status_code=422)
    w, h = im.size
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    x1 = int(max(0, round(fx1 + 0.15 * fw)))
    x2 = int(min(w, round(fx2 - 0.15 * fw)))
    y1 = int(max(0, round(fy1 + 0.4 * fh)))
    y2 = int(min(h, round(fy2 + 0.15 * fh)))
    if x2 - x1 < 16 or y2 - y1 < 12:
        raise CharacterSheetError(f'嘴部放大: 裁区过小 {x2 - x1}x{y2 - y1}', status_code=422)
    crop = im.crop((x1, y1, x2, y2))
    oh = max(1, int(round(out_w * crop.height / float(crop.width))))
    crop = crop.resize((int(out_w), oh), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def _iris_hue_in_band(im: Image.Image, band: tuple[int, int, int, int]) -> tuple[float, int] | None:
    """01:45：眼带主色相（饱和像素圆均值）；饱和像素不足返回 None。"""
    import numpy as np
    ex0, ey0, ex1, ey1 = [int(v) for v in band]
    if ex1 - ex0 < 8 or ey1 - ey0 < 8:
        return None
    eye = np.asarray(im.convert('RGB'), dtype=np.float32)[ey0:ey1, ex0:ex1] / 255.0
    mx = np.max(eye, axis=2)
    mn = np.min(eye, axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-06), 0.0)
    m = (sat > 0.45) & (mx > 0.35)
    if int(m.sum()) < 30:
        return None
    px = eye[m]
    step = max(1, len(px) // 2000)
    sin_sum = 0.0
    cos_sum = 0.0
    n = 0
    for p in px[::step]:
        hh, _ss, _vv = colorsys.rgb_to_hsv(float(p[0]), float(p[1]), float(p[2]))
        ang = hh * 360.0
        sin_sum += math.sin(math.radians(ang))
        cos_sum += math.cos(math.radians(ang))
        n += 1
    if n == 0:
        return None
    return (math.degrees(math.atan2(sin_sum / n, cos_sum / n)) % 360.0, n)

def measure_iris_hue(data: bytes) -> tuple[float, int] | None:
    """01:45：表情格眼带（脸框 28%-52% 高、cx±35%fh）主色相。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    bb = _expr_face_bbox_of(im)
    if bb is None:
        return None
    x1, y1, x2, y2 = bb
    fh = max(8.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    band = (int(cx - 0.35 * fh), int(y1 + 0.28 * fh), int(cx + 0.35 * fh), int(y1 + 0.52 * fh))
    return _iris_hue_in_band(im, band)

def _parse_expr_qa_json(raw: str) -> dict:
    """解析专项问答 JSON：须含 q1/q2 布尔。"""
    import ast
    text = (raw or '').strip()
    if not text:
        raise CharacterSheetError('专项问答返回空文本', status_code=502)
    if text.startswith('['):
        try:
            lit = ast.literal_eval(text)
            if isinstance(lit, list) and lit:
                first = lit[0]
                text = first if isinstance(first, str) else json.dumps(first, ensure_ascii=False)
        except (SyntaxError, ValueError):
            pass
    fence = re.search('```(?:json)?\\s*([\\s\\S]*?)```', text)
    if fence:
        text = fence.group(1).strip()
    m = re.search('\\{[\\s\\S]*\\}', text)
    if not m:
        raise CharacterSheetError(f'专项问答无 JSON: {raw[:200]}', status_code=502)
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise CharacterSheetError(f'专项问答 JSON 解析失败: {e}; raw={raw[:240]}', status_code=502) from e
    if not isinstance(obj, dict):
        raise CharacterSheetError('专项问答 JSON 非对象', status_code=502)
    q1 = _parse_yes_no_token(obj.get('q1', obj.get('Q1')))
    q2 = _parse_yes_no_token(obj.get('q2', obj.get('Q2')))
    if q1 is None or q2 is None:
        raise CharacterSheetError(f'专项问答缺 q1/q2 布尔: {obj!r}', status_code=502)
    return {'q1': q1, 'q2': q2, 'raw': raw, 'obj': obj}

def pick_best_expression_candidate(cands: list[bytes], *, neutral_ref: bytes | None, portrait_ref: bytes | None, expr_key: str, min_clip: float=0.72) -> bytes:
    """4 候选：选与中性脸差异最大、且与主立绘 CLIP 相对比对仍通过的那张。"""
    if not cands:
        raise CharacterSheetError(f'{expr_key}无表情候选', status_code=422)
    scored: list[tuple[float, bytes]] = []
    for c in cands:
        diff = expression_roi_pixel_diff(c, neutral_ref) if neutral_ref else expression_roi_pixel_diff(c, cands[0])
        if portrait_ref is not None:
            sim = clip_image_cosine_sim(c, portrait_ref)
            if sim is not None and sim + 1e-12 < float(min_clip):
                continue
        scored.append((diff, c))
    if not scored:
        scored = [(expression_roi_pixel_diff(c, neutral_ref) if neutral_ref else 0.0, c) for c in cands]
    scored.sort(key=lambda t: t[0], reverse=True)
    return scored[0][1]

def expression_roi_pixel_diff(a: bytes, b: bytes) -> float:
    """两图眉眼嘴 ROI 的平均绝对像素差（0–255）。"""
    ia = _facial_feature_roi(Image.open(BytesIO(a)).convert('RGB').resize((256, 256), Image.Resampling.BILINEAR))
    ib = _facial_feature_roi(Image.open(BytesIO(b)).convert('RGB').resize((256, 256), Image.Resampling.BILINEAR))
    pa = list(ia.getdata())
    pb = list(ib.getdata())
    if not pa or len(pa) != len(pb):
        return 0.0
    acc = 0.0
    for (r1, g1, b1), (r2, g2, b2) in zip(pa, pb):
        acc += (abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)) / 3.0
    return acc / float(len(pa))

def mouth_dark_ratio(data: bytes) -> float:
    """嘴区深色占比（张嘴口腔）；供语义门禁复用。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    w, h = im.size
    box = (int(w * 0.32), int(h * 0.55), int(w * 0.68), int(h * 0.78))
    crop = im.crop(box)
    px = list(crop.getdata())
    if not px:
        return 0.0
    dark = sum((1 for r, g, b in px if (r + g + b) / 3.0 < 70))
    return dark / float(len(px))

def mouth_appears_open(data: bytes) -> bool:
    """惊恐门禁：下半脸中央出现明显深色张嘴区域。"""
    return mouth_dark_ratio(data) >= 0.08

def mouth_appears_wide_open(data: bytes) -> bool:
    """大张嘴（惊恐级）；温柔轻露上齿不应触发（1915 误杀根因：0.09≈露齿）。"""
    return mouth_dark_ratio(data) >= 0.16

def _mouth_corner_lift(data: bytes) -> float:
    """嘴角相对嘴中的上扬：正=微笑（角高于中），≈0=平，负=下垂。

    只看唇线深色行质心几何，不用肤色亮度（anime 平嘴易被亮度误判）。
    """
    im = Image.open(BytesIO(data)).convert('RGB')
    w, h = im.size
    y0, y1 = (int(h * 0.56), int(h * 0.74))
    bands = {'mid': (int(w * 0.44), y0, int(w * 0.56), y1), 'left': (int(w * 0.3), y0, int(w * 0.4), y1), 'right': (int(w * 0.6), y0, int(w * 0.7), y1)}

    def _lip_y_frac(box: tuple[int, int, int, int]) -> float:
        crop = im.crop(box)
        cw, ch = crop.size
        if ch < 2:
            return 0.5
        px = crop.load()
        best_y, best_n = (ch // 2, -1)
        for y in range(ch):
            n = 0
            for x in range(cw):
                r, g, b = px[x, y]
                lum = (r + g + b) / 3.0
                if 40 <= lum <= 165 and r >= g - 5 and (r >= b - 5) and (max(r, g, b) - min(r, g, b) >= 12):
                    n += 1
                elif lum < 95 and max(r, g, b) - min(r, g, b) < 28:
                    n += 1
            if n > best_n:
                best_n, best_y = (n, y)
        return best_y / float(max(1, ch - 1))
    y_mid = _lip_y_frac(bands['mid'])
    y_side = (_lip_y_frac(bands['left']) + _lip_y_frac(bands['right'])) / 2.0
    return float(y_mid - y_side)

def _brow_press_delta(data: bytes, neutral: bytes | None) -> float | None:
    """相对中性脸：眉带深色质心下移为正（压眉）；上移为负（舒展/挑眉）。"""
    if not neutral:
        return None
    im = Image.open(BytesIO(data)).convert('RGB')
    neu = Image.open(BytesIO(neutral)).convert('RGB').resize(im.size, Image.Resampling.LANCZOS)
    w, h = im.size
    box = (int(w * 0.22), int(h * 0.16), int(w * 0.78), int(h * 0.36))

    def _centroid(img: Image.Image) -> float:
        crop = img.crop(box)
        cw, ch = crop.size
        px = list(crop.getdata())
        weights = []
        for y in range(ch):
            row = px[y * cw:(y + 1) * cw]
            dark = sum((1 for r, g, b in row if (r + g + b) / 3.0 < 90 and max(r, g, b) - min(r, g, b) < 40))
            weights.append(dark)
        tot = sum(weights) or 1
        return sum((i * ww for i, ww in enumerate(weights))) / float(tot * max(1, ch - 1))
    return float(_centroid(im) - _centroid(neu))

def _crop_expr_face_same_scale(data: bytes, *, size: int=768, target_face_height_frac: float=0.6, min_face_height_frac: float=0.55, max_face_height_frac: float=0.65) -> bytes:
    """表情格同尺度裁剪：脸高约占格高 0.55–0.65，保留嘴与少许下颌，禁贴眼特写。

    源图已贴脸过近时先垫棚灰再拉远，保证能落到目标窗。
    """
    img = Image.open(BytesIO(data)).convert('RGB')
    w0, h0 = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(img)
        except Exception:
            bb = None
    if bb is None:
        return enforce_head_shoulders_square(data, size=int(size), max_upscale=2.2, check_coverage=False, face_closeup_gate=False)
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    fw = max(8.0, fx2 - fx1)
    fh = max(8.0, fy2 - fy1)
    fcx = (fx1 + fx2) / 2.0
    fcy = (fy1 + fy2) / 2.0
    tgt = max(0.52, min(0.68, float(target_face_height_frac)))
    need = int(max(fh / tgt, fw * 1.7, 64))
    pad = 0
    if need > min(w0, h0) - 2:
        pad = int(math.ceil((need - min(w0, h0)) / 2.0)) + 16
    if pad > 0:
        canvas = Image.new('RGB', (w0 + 2 * pad, h0 + 2 * pad), (220, 220, 224))
        canvas.paste(img, (pad, pad))
        img = canvas
        fx1 += pad
        fy1 += pad
        fx2 += pad
        fy2 += pad
        fcx += pad
        fcy += pad
    w, h = img.size
    mouth_y = fy1 + 0.72 * fh
    chin_y = fy2 + 0.1 * fh
    side = int(max(fh / tgt, fw * 1.7, 64))
    out = data
    for _round in range(12):
        side = max(64, min(side, w, h))
        top = int(round(fy1 - 0.12 * side))
        left = int(round(fcx - side / 2.0))
        for _ in range(5):
            left = max(0, min(w - side, left))
            top = max(0, min(h - side, top))
            if mouth_y - top <= side * 0.9 and chin_y - top <= side * 0.95:
                break
            side = int(min(max(w, h), max(side + 8, int(side * 1.08))))
            side = min(side, w, h)
            top = int(round(fy1 - 0.12 * side))
            left = int(round(fcx - side / 2.0))
        left = max(0, min(w - side, left))
        top = max(0, min(h - side, top))
        crop = img.crop((left, top, left + side, top + side))
        crop = crop.resize((int(size), int(size)), Image.Resampling.LANCZOS)
        buf = BytesIO()
        crop.save(buf, format='PNG')
        out = buf.getvalue()
        frac = measure_face_height_frac(out)
        if frac is None:
            break
        lo = float(min_face_height_frac)
        hi = float(max_face_height_frac)
        mid = 0.5 * (lo + hi)
        if lo - 1e-06 <= frac <= hi + 1e-06:
            try:
                assert_mouth_in_frame(out)
                return out
            except CharacterSheetError:
                side = int(min(max(w, h), side * 1.1))
                continue
        if frac > hi:
            side = int(max(side + 4, side * (frac / max(mid, 0.58))))
            if side > min(w, h):
                extra = int(math.ceil((side - min(w, h)) / 2.0)) + 8
                canvas = Image.new('RGB', (w + 2 * extra, h + 2 * extra), (220, 220, 224))
                canvas.paste(img, (extra, extra))
                img = canvas
                fx1 += extra
                fy1 += extra
                fx2 += extra
                fy2 += extra
                fcx += extra
                fcy += extra
                mouth_y += extra
                chin_y += extra
                w, h = img.size
        else:
            side = int(max(64, side * (frac / max(mid, 0.58))))
    return out

def _parse_vlm_expression_json(raw: str, labels: tuple[str, ...]=_EXPR_LABELS) -> dict:
    """从 VLM 原始文本解析 label + scores；失败抛 CharacterSheetError。"""
    import ast
    text = (raw or '').strip()
    if not text:
        raise CharacterSheetError('VLM 表情判官返回空文本', status_code=502)
    if text.startswith('['):
        try:
            lit = ast.literal_eval(text)
            if isinstance(lit, list) and lit:
                first = lit[0]
                text = first if isinstance(first, str) else json.dumps(first, ensure_ascii=False)
            elif isinstance(lit, str):
                text = lit
        except (SyntaxError, ValueError):
            pass
    fence = re.search('```(?:json)?\\s*([\\s\\S]*?)```', text)
    if fence:
        text = fence.group(1).strip()
    text = text.strip().lstrip('\ufeff')
    m = re.search('\\{[\\s\\S]*\\}', text)
    if not m:
        raise CharacterSheetError(f'VLM 表情判官无 JSON: {raw[:200]}', status_code=502)
    blob = m.group(0)
    try:
        obj = json.loads(blob)
    except json.JSONDecodeError as e:
        raise CharacterSheetError(f'VLM 表情判官 JSON 解析失败: {e}; raw={raw[:240]}', status_code=502) from e
    if not isinstance(obj, dict):
        raise CharacterSheetError('VLM 表情判官 JSON 非对象', status_code=502)
    label = str(obj.get('label') or obj.get('expression') or '').strip()
    aliases = {'stern': '威严', 'majestic': '威严', 'cold': '冷酷', 'aloof': '冷酷', 'thoughtful': '沉思', 'contemplative': '沉思', 'gentle': '温柔', 'tender': '温柔', 'warm': '温柔', 'terrified': '惊恐', 'fear': '惊恐', 'shocked': '惊恐', 'determined': '果断', 'resolute': '果断'}
    if label not in labels:
        low = label.lower()
        label = aliases.get(low, label)
    scores_in = obj.get('scores') or obj.get('probs') or obj.get('probabilities') or {}
    scores: dict[str, float] = {}
    if isinstance(scores_in, dict):
        for lab in labels:
            v = scores_in.get(lab)
            if v is None:
                for en, zh in aliases.items():
                    if zh == lab and en in scores_in:
                        v = scores_in[en]
                        break
            try:
                scores[lab] = float(v) if v is not None else 0.0
            except (TypeError, ValueError):
                scores[lab] = 0.0
    else:
        scores = {lab: 0.0 for lab in labels}
    if label not in labels:
        if any(scores.values()):
            label = max(scores.items(), key=lambda kv: kv[1])[0]
        else:
            raise CharacterSheetError(f"VLM 表情判官 label 非法: {obj.get('label')!r}", status_code=502)
    if not any(scores.values()):
        scores = {lab: 1.0 if lab == label else 0.0 for lab in labels}
    ssum = sum((max(0.0, float(v)) for v in scores.values())) or 1.0
    scores = {lab: max(0.0, float(scores.get(lab, 0.0))) / ssum for lab in labels}
    smiling_raw = obj.get('smiling', obj.get('is_smiling', obj.get('smile')))
    smiling: bool | None = None
    if isinstance(smiling_raw, bool):
        smiling = smiling_raw
    elif isinstance(smiling_raw, (int, float)):
        smiling = bool(smiling_raw)
    elif isinstance(smiling_raw, str):
        s = smiling_raw.strip().lower()
        if s in ('true', 'yes', 'y', '1', '是', '微笑', 'smile', 'smiling'):
            smiling = True
        elif s in ('false', 'no', 'n', '0', '否', '不', 'not smiling'):
            smiling = False
    return {'label': label, 'scores': scores, 'raw': raw, 'smiling': smiling}

def build_expression_vlm_graph(image_name: str, *, prompt: str=_EXPR_VLM_PROMPT, model: str='Qwen3-VL-4B-Instruct-FP8', seed: int=42, backend: str='Qwen2_VQA') -> dict:
    """构建 Comfy 表情六类分类图：LoadImage → Qwen2_VQA/AILab_QwenVL → PreviewAny。"""
    if backend == 'AILab_QwenVL':
        return {'1': {'class_type': 'LoadImage', 'inputs': {'image': image_name}}, '2': {'class_type': 'AILab_QwenVL', 'inputs': {'model_name': model if model.startswith('Qwen') else 'Qwen3-VL-4B-Instruct-FP8', 'quantization': 'None (FP16)', 'attention_mode': 'sdpa', 'preset_prompt': '🖼️ Detailed Description', 'custom_prompt': prompt, 'max_tokens': 512, 'keep_model_loaded': True, 'seed': max(1, int(seed)), 'image': ['1', 0]}}, '3': {'class_type': 'PreviewAny', 'inputs': {'source': ['2', 0]}}}
    return {'1': {'class_type': 'LoadImage', 'inputs': {'image': image_name}}, '2': {'class_type': 'Qwen2_VQA', 'inputs': {'text': prompt, 'model': model, 'quantization': 'none', 'keep_model_loaded': True, 'temperature': 0.2, 'max_new_tokens': 512, 'min_pixels': 200704, 'max_pixels': 1003520, 'seed': int(seed), 'attention': 'sdpa', 'image': ['1', 0]}}, '3': {'class_type': 'PreviewAny', 'inputs': {'source': ['2', 0]}}}

def _extract_history_text(entry: dict) -> str:
    """从 Comfy history entry 抽 STRING/text。"""
    outputs = (entry or {}).get('outputs') or {}
    chunks: list[str] = []
    for node_out in outputs.values():
        if not isinstance(node_out, dict):
            continue
        for key in ('text', 'STRING', 'string', 'response', 'RESPONSE', 'result'):
            val = node_out.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        chunks.append(item)
                    elif isinstance(item, dict):
                        for kk in ('text', 'string', 'content'):
                            if isinstance(item.get(kk), str) and item[kk].strip():
                                chunks.append(item[kk])
            elif isinstance(val, str) and val.strip():
                chunks.append(val)
        for val in node_out.values():
            if isinstance(val, str) and val.strip() and (val not in chunks):
                if len(val) < 4000:
                    chunks.append(val)
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip() and (item not in chunks):
                        chunks.append(item)
    return '\n'.join(chunks).strip()

def vlm_sticky_evidence() -> dict[str, Any]:
    """供 gate_summary / 进展记录：VLM 常驻与粘性命中证据。"""
    return {**dict(_VLM_STICKY_EVIDENCE), 'sticky_backend': list(_VLM_STICKY_BACKEND) if _VLM_STICKY_BACKEND else None, 'graph_keep_model_loaded': True}

async def classify_expression_vlm(image_bytes: bytes, *, worker_url: str | None, labels: tuple[str, ...]=_EXPR_LABELS, seed: int=42) -> dict:
    """调 Comfy Qwen VL 对表情做 6 选 1；返回 {label, scores, raw, model}。

    失败抛 CharacterSheetError（不许静默跳过判官伪过检）。
    图节点 keep_model_loaded=True；同进程粘性后端避免每表情重试多模型。
    """
    from app.comfy.client import ComfyUIClient, ComfyUIError
    global _VLM_STICKY_BACKEND
    if not worker_url:
        raise CharacterSheetError('VLM 判官缺少 worker_url', status_code=502)
    url = str(worker_url).rstrip('/')
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(image_bytes, f'sheet_expr_vlm_{uuid.uuid4().hex[:10]}.png')
    default_backends = (('Qwen2_VQA', 'Qwen3-VL-4B-Instruct'), ('Qwen2_VQA', 'Qwen2-VL-7B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct'), ('Qwen2_VQA', 'Qwen3-VL-8B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct-FP8'), ('Qwen2_VQA', 'Qwen3-VL-4B-Instruct-FP8'))
    if _VLM_STICKY_BACKEND is not None:
        sticky = _VLM_STICKY_BACKEND
        backends = (sticky,) + tuple((b for b in default_backends if b != sticky))
        _VLM_STICKY_EVIDENCE['sticky_hits'] = int(_VLM_STICKY_EVIDENCE.get('sticky_hits') or 0) + 1
    else:
        backends = default_backends
        _VLM_STICKY_EVIDENCE['sticky_misses'] = int(_VLM_STICKY_EVIDENCE.get('sticky_misses') or 0) + 1
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(fname, prompt=_EXPR_VLM_PROMPT, model=model, seed=seed, backend=backend)
            prompt_id = await client.queue_prompt(graph, client_id=f'sheet_vlm_{uuid.uuid4().hex[:8]}')
            waited = 0.0
            raw_text = ''
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get('status') or {}
                if entry.get('outputs'):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get('status_str') == 'error' or (st.get('completed') is False and any((isinstance(m, list) and m and (m[0] == 'execution_error') for m in st.get('messages') or []))):
                    msg = 'execution_error'
                    for m in st.get('messages') or []:
                        if isinstance(m, list) and m and (m[0] == 'execution_error'):
                            detail = m[1] if len(m) > 1 else {}
                            msg = str((detail or {}).get('exception_message') or (detail or {}).get('exception_type') or msg)
                            break
                    raise CharacterSheetError(f'VLM 判官执行失败:{msg}', status_code=502)
                await asyncio.sleep(1.5)
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(f'VLM 判官超时无文本 backend={backend} model={model}', status_code=504)
            parsed = _parse_vlm_expression_json(raw_text, labels=labels)
            parsed['model'] = f'{backend}:{model}'
            parsed['worker'] = url
            _VLM_STICKY_BACKEND = (backend, model)
            _VLM_STICKY_EVIDENCE['last_backend'] = backend
            _VLM_STICKY_EVIDENCE['last_model'] = model
            _VLM_STICKY_EVIDENCE['keep_model_loaded'] = True
            parsed['vlm_sticky'] = True
            parsed['keep_model_loaded'] = True
            return parsed
        except CharacterSheetError as e:
            last_err = e
            logger.warning('classify_expression_vlm %s/%s fail: %s', backend, model, e)
            continue
        except ComfyUIError as e:
            last_err = CharacterSheetError(f'VLM Comfy 错误:{e}', status_code=502)
            logger.warning('classify_expression_vlm comfy %s/%s: %s', backend, model, e)
            continue
        except Exception as e:
            last_err = CharacterSheetError(f'VLM 判官异常:{e}', status_code=502)
            logger.warning('classify_expression_vlm exc %s/%s: %s', backend, model, e)
            continue
    raise CharacterSheetError(f'VLM 表情判官全部后端失败: {last_err}', status_code=502) from last_err

async def classify_expression_qa(image_bytes: bytes, *, expr_key: str, worker_url: str | None, seed: int=42) -> dict:
    """00:30：沉思/温柔专项两问（非六分类）。返回 {q1,q2,raw,model,...}。"""
    from app.comfy.client import ComfyUIClient, ComfyUIError
    global _VLM_STICKY_BACKEND
    if expr_key not in _EXPR_QA_PROMPTS:
        raise CharacterSheetError(f'专项问答无 prompt: {expr_key}', status_code=422)
    if not worker_url:
        raise CharacterSheetError('专项问答缺少 worker_url', status_code=502)
    url = str(worker_url).rstrip('/')
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    fname = await client.upload_image(image_bytes, f'sheet_expr_qa_{uuid.uuid4().hex[:10]}.png')
    prompt = _EXPR_QA_PROMPTS[expr_key]
    default_backends = (('Qwen2_VQA', 'Qwen3-VL-4B-Instruct'), ('Qwen2_VQA', 'Qwen2-VL-7B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct'), ('Qwen2_VQA', 'Qwen3-VL-8B-Instruct'), ('AILab_QwenVL', 'Qwen3-VL-4B-Instruct-FP8'), ('Qwen2_VQA', 'Qwen3-VL-4B-Instruct-FP8'))
    if _VLM_STICKY_BACKEND is not None:
        sticky = _VLM_STICKY_BACKEND
        backends = (sticky,) + tuple((b for b in default_backends if b != sticky))
        _VLM_STICKY_EVIDENCE['sticky_hits'] = int(_VLM_STICKY_EVIDENCE.get('sticky_hits') or 0) + 1
    else:
        backends = default_backends
        _VLM_STICKY_EVIDENCE['sticky_misses'] = int(_VLM_STICKY_EVIDENCE.get('sticky_misses') or 0) + 1
    last_err: Exception | None = None
    for backend, model in backends:
        try:
            graph = build_expression_vlm_graph(fname, prompt=prompt, model=model, seed=seed, backend=backend)
            prompt_id = await client.queue_prompt(graph, client_id=f'sheet_qa_{uuid.uuid4().hex[:8]}')
            waited = 0.0
            _qa_queue_wait = 0.0
            raw_text = ''
            while waited < 180.0:
                hist = await client.get_history(prompt_id)
                entry = (hist or {}).get(prompt_id) or {}
                st = entry.get('status') or {}
                if entry.get('outputs'):
                    raw_text = _extract_history_text(entry)
                    if raw_text:
                        break
                if st.get('status_str') == 'error' or (st.get('completed') is False and any((isinstance(m, list) and m and (m[0] == 'execution_error') for m in st.get('messages') or []))):
                    msg = 'execution_error'
                    for m in st.get('messages') or []:
                        if isinstance(m, list) and m and (m[0] == 'execution_error'):
                            detail = m[1] if len(m) > 1 else {}
                            msg = str((detail or {}).get('exception_message') or (detail or {}).get('exception_type') or msg)
                            break
                    raise CharacterSheetError(f'专项问答执行失败:{msg}', status_code=502)
                _qs = await _comfy_prompt_state(client, prompt_id)
                await asyncio.sleep(1.5)
                if _qs == 'pending':
                    _qa_queue_wait += 1.5
                    if _qa_queue_wait >= _QUEUE_WAIT_MAX:
                        try:
                            await client.delete_from_queue([prompt_id])
                        except Exception:
                            pass
                        raise CharacterSheetQueueWait(f'专项问答排队超时 queue_wait={_qa_queue_wait:.0f}s(不计失败)', queue_wait=_qa_queue_wait, prompt_id=prompt_id)
                    continue
                waited += 1.5
            if not raw_text:
                raise CharacterSheetError(f'专项问答超时无文本 backend={backend} model={model}', status_code=504)
            parsed = _parse_expr_qa_json(raw_text)
            parsed['model'] = f'{backend}:{model}'
            parsed['worker'] = url
            parsed['expr_key'] = expr_key
            _VLM_STICKY_BACKEND = (backend, model)
            _VLM_STICKY_EVIDENCE['last_backend'] = backend
            _VLM_STICKY_EVIDENCE['last_model'] = model
            _VLM_STICKY_EVIDENCE['keep_model_loaded'] = True
            parsed['vlm_sticky'] = True
            parsed['keep_model_loaded'] = True
            return parsed
        except CharacterSheetQueueWait:
            raise
        except CharacterSheetError as e:
            last_err = e
            logger.warning('classify_expression_qa %s/%s fail: %s', backend, model, e)
            continue
        except ComfyUIError as e:
            last_err = CharacterSheetError(f'专项问答 Comfy 错误:{e}', status_code=502)
            logger.warning('classify_expression_qa comfy %s/%s: %s', backend, model, e)
            continue
        except Exception as e:
            last_err = CharacterSheetError(f'专项问答异常:{e}', status_code=502)
            logger.warning('classify_expression_qa exc %s/%s: %s', backend, model, e)
            continue
    raise CharacterSheetError(f'专项问答全部后端失败: {last_err}', status_code=502) from last_err

def clip_image_cosine_sim(a: bytes, b: bytes) -> float | None:
    """可选 open_clip 图相似度；不可用则 None。"""
    try:
        from app.services.studio.candidate_pick import _cosine, _openclip_image_embedder
    except Exception:
        return None
    enc = _openclip_image_embedder()
    if enc is None:
        return None
    try:
        ia = Image.open(BytesIO(a)).convert('RGB')
        ib = Image.open(BytesIO(b)).convert('RGB')
        ea = enc(ia)
        eb = enc(ib)
        if ea is None or eb is None:
            return None
        return float(_cosine(ea, eb))
    except Exception:
        return None

def _edge_sharpness_score(data: bytes, size: int=256) -> float:
    """边缘能量：侧面融化/糊图偏低，清线成功后应升高。"""
    try:
        from PIL import ImageFilter, ImageStat
        im = Image.open(BytesIO(data)).convert('L').resize((size, size))
        e = im.filter(ImageFilter.FIND_EDGES)
        return float(ImageStat.Stat(e).mean[0])
    except Exception:
        return 0.0

def side_face_cleanup_accept(cleaned: bytes, original_crop: bytes, *, master_side: bytes | None=None, min_clip: float=0.82, identity_ref: bytes | None=None) -> bool:
    """20:23/23:05：清线须像侧面；母版融化时放宽 MAE/CLIP，要求更清晰且有脸。

    禁止脸罩叠影；整图 Qwen 清线结果用本门禁取舍。
    """
    src_frac = measure_face_height_frac(original_crop)
    src_soft = src_frac is None or src_frac + 1e-12 < 0.35
    mae_max = 78.0 if src_soft else 28.0
    clip_min = 0.64 if src_soft else float(min_clip)
    try:
        ia = Image.open(BytesIO(cleaned)).convert('RGB').resize((128, 128))
        ib = Image.open(BytesIO(original_crop)).convert('RGB').resize((128, 128))
        pa, pb = (list(ia.getdata()), list(ib.getdata()))
        mae = sum(((abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)) / 3.0 for (r1, g1, b1), (r2, g2, b2) in zip(pa, pb))) / float(len(pa))
        if mae > mae_max:
            return False
    except Exception:
        return False
    out_frac = measure_face_height_frac(cleaned)
    if src_soft:
        if out_frac is None or out_frac + 1e-12 < 0.22:
            return False
        if _edge_sharpness_score(cleaned) + 1.5 < _edge_sharpness_score(original_crop):
            return False
    ref = master_side or original_crop
    sim = clip_image_cosine_sim(cleaned, ref)
    if sim is None:
        return True
    if sim + 1e-12 >= clip_min:
        return True
    if src_soft and identity_ref is not None:
        sim_id = clip_image_cosine_sim(cleaned, identity_ref)
        if sim_id is not None and sim_id + 1e-12 >= 0.58:
            return True
    return False

def pick_best_side_deblur_candidate(candidates: list[bytes], original_crop: bytes, *, master_side: bytes | None=None, identity_ref: bytes | None=None) -> bytes | None:
    """多候选清线：先过 accept，再按清晰度+脸占比择优；全拒返回 None。"""
    accepted: list[tuple[float, bytes]] = []
    for c in candidates:
        if not c:
            continue
        if not side_face_cleanup_accept(c, original_crop, master_side=master_side, identity_ref=identity_ref):
            continue
        frac = measure_face_height_frac(c) or 0.0
        sharp = _edge_sharpness_score(c)
        accepted.append((sharp + 40.0 * float(frac), c))
    if not accepted:
        return None
    accepted.sort(key=lambda t: t[0], reverse=True)
    return accepted[0][1]

def _expr_reject_cause(err: Exception | str) -> str:
    msg = str(err)
    if '接缝' in msg or '硬边' in msg or 'seam' in msg.lower():
        return 'seam'
    if '徽标' in msg or '字样' in msg or 'emblem' in msg.lower():
        return 'emblem'
    if '发长' in msg or '齐下巴' in msg or 'hair' in msg.lower():
        return 'hair'
    if '专项问答' in msg or 'qa' in msg.lower():
        return 'qa'
    if 'CLIP' in msg or 'clip' in msg.lower():
        return 'clip'
    if '张嘴' in msg or '表情差过弱' in msg or '过于相似' in msg or ('diversity' in msg.lower()):
        return 'expr_weak'
    if 'face' in msg.lower() or '近景' in msg or 'closeup' in msg.lower():
        return 'face'
    return 'other'

def crop_raincoat_detail_from_figure(data: bytes, *, size: int=768) -> bytes:
    """从主立绘/正面裁雨衣躯干局部，供服饰首格空白兜底。"""
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    box = (int(w * 0.18), int(h * 0.28), int(w * 0.82), int(h * 0.62))
    crop = img.crop(box)
    side = max(crop.width, crop.height, 8)
    canvas = Image.new('RGB', (side, side), (240, 240, 244))
    canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
    canvas = canvas.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

def enforce_head_shoulders_square(data: bytes, size: int=768, *, skip_reframe: bool=False, max_upscale: float=1.5, check_coverage: bool=True, face_closeup_gate: bool=False) -> bytes:
    """头肩正方形裁切(fix16):以**检测到的人脸框**为中心 cover 铺满。

    - 优先 insightface 人脸框;否则肤色/五官启发式(禁整前景,避免宽袖/汉服拉偏)。
    - 裁切轴=脸中心;上边含完整发顶/发髻(脸顶再留约 12–16% 格高);下边到锁骨下(≈脸高×2.0–2.2)。
    - 放大上限 max_upscale(默认 1.5):源脸过小则外扩取景;仍不足则 cover 填满(禁深色垫边缩水)。
    - skip_reframe=True:锁定格走同一 cover 填满(头顶方裁→铺满),禁止小图贴大空白。
    - check_coverage:输出前 assert_panel_coverage(>=0.90)；全身格用。
    - face_closeup_gate:16:45 近景脸格用「有人脸+脸高占格高 25%–70%」替代 coverage。
    """
    import math
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    if skip_reframe:
        side = min(w, h)
        left = max(0, (w - side) // 2)
        top = max(0, (h - side) // 2)
        if h > w * 1.15:
            top = max(0, min(h - side, int(h * 0.02)))
        face_bb = _detect_face_bbox_xyxy(data)
        if face_bb is None:
            face_bb = _heuristic_skin_face_bbox(img)
        if face_bb is not None:
            fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
            fw = max(8.0, fx2 - fx1)
            fh = max(8.0, fy2 - fy1)
            fcx = (fx1 + fx2) / 2.0
            span_h = fh * 2.1
            span_w = max(fw * 1.55, span_h * 0.95)
            side2 = int(max(span_w, span_h, 64))
            side2 = min(side2, w, h)
            left = max(0, min(w - side2, int(round(fcx - side2 / 2.0))))
            top = max(0, min(h - side2, int(round(fy1 - 0.14 * side2))))
            if top + side2 > h:
                top = max(0, h - side2)
            side = side2
        crop = img.crop((left, top, left + side, top + side))
        crop = crop.resize((size, size), Image.Resampling.LANCZOS)
        buf = BytesIO()
        crop.save(buf, format='PNG')
        out = buf.getvalue()
        if face_closeup_gate:
            assert_face_closeup_framing(out)
        elif check_coverage:
            assert_panel_coverage(out, min_ratio=0.9)
            assert_face_visible(out, min_face_area=0.04)
        return out
    face_bb = _detect_face_bbox_xyxy(data)
    if face_bb is None:
        face_bb = _heuristic_skin_face_bbox(img)
    if face_bb is not None:
        fx1, fy1, fx2, fy2 = [float(v) for v in face_bb]
        fw = max(8.0, fx2 - fx1)
        fh = max(8.0, fy2 - fy1)
        fcx = (fx1 + fx2) / 2.0
        span_h = fh * 2.1
        span_w = max(fw * 1.55, span_h * 0.95)
        side = int(max(span_w, span_h))
        side = max(side, 64)
        min_side = int(math.ceil(float(size) / float(max_upscale)))
        if side < min_side:
            side = min(min_side, w, h)
        side = min(side, w, h)
        left = int(round(fcx - side / 2.0))
        top = int(round(fy1 - 0.14 * side))
        left = max(0, min(w - side, left))
        top = max(0, min(h - side, top))
        if top + side > h:
            top = max(0, h - side)
        if not left + side * 0.12 <= fcx <= left + side * 0.88:
            left = max(0, min(w - side, int(round(fcx - side / 2.0))))
        if not top + side * 0.04 <= fy1 <= top + side * 0.4:
            top = max(0, min(h - side, int(round(fy1 - 0.14 * side))))
    else:
        cx, cy = (w // 2, int(h * 0.28))
        side = min(w, h, max(int(h * 0.52), int(w * 0.58)))
        min_side = int(math.ceil(float(size) / float(max_upscale)))
        if side < min_side:
            side = min(min_side, w, h)
        left = max(0, min(w - side, cx - side // 2))
        top = max(0, min(h - side, cy - side // 2))
    if top + side > h:
        top = max(0, h - side)
    crop = img.crop((left, top, left + side, top + side))
    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
    buf = BytesIO()
    crop.save(buf, format='PNG')
    out = buf.getvalue()
    if face_closeup_gate:
        assert_face_closeup_framing(out)
    elif check_coverage:
        assert_panel_coverage(out, min_ratio=0.9)
        assert_face_visible(out, min_face_area=0.04)
    return out

def sample_iris_hsv_mean(data: bytes) -> tuple[float, float, float] | None:
    """从近景头像估计虹膜平均 HSV（H∈[0,360)）。取脸上半高 chroma 非肤色像素。"""
    try:
        img = Image.open(BytesIO(data)).convert('RGB')
    except Exception:
        return None
    w, h = img.size
    if w < 16 or h < 16:
        return None
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        try:
            bb = _heuristic_skin_face_bbox(img)
        except Exception:
            bb = None
    if bb is None:
        x1, y1, x2, y2 = (int(w * 0.25), int(h * 0.18), int(w * 0.75), int(h * 0.55))
    else:
        fx1, fy1, fx2, fy2 = [float(v) for v in bb]
        fh = max(8.0, fy2 - fy1)
        fw = max(8.0, fx2 - fx1)
        x1 = int(fx1 + fw * 0.12)
        x2 = int(fx2 - fw * 0.12)
        y1 = int(fy1 + fh * 0.18)
        y2 = int(fy1 + fh * 0.48)
    x1, x2 = (max(0, min(x1, x2)), min(w, max(x1, x2)))
    y1, y2 = (max(0, min(y1, y2)), min(h, max(y1, y2)))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    px = img.load()
    hs: list[float] = []
    ss: list[float] = []
    vs: list[float] = []
    for y in range(y1, y2, max(1, (y2 - y1) // 48)):
        for x in range(x1, x2, max(1, (x2 - x1) // 48)):
            r, g, b = px[x, y][:3]
            mx, mn = (max(r, g, b), min(r, g, b))
            if mx < 40 or mn > 230:
                continue
            rf, gf, bf = (r / 255.0, g / 255.0, b / 255.0)
            hh, ss_, vv = colorsys.rgb_to_hsv(rf, gf, bf)
            if ss_ < 0.22 or vv < 0.18:
                continue
            hue = hh * 360.0
            if 10 <= hue <= 50 and ss_ < 0.45 and (vv > 0.45):
                continue
            hs.append(hue)
            ss.append(ss_)
            vs.append(vv)
    if len(hs) < 6:
        return None
    hs.sort()
    ss.sort()
    vs.sort()
    mid = len(hs) // 2
    return (float(hs[mid]), float(ss[mid]), float(vs[mid]))

def iris_hsv_consistent(a: bytes, b: bytes, *, max_hue_deg: float=48.0, min_sat: float=0.18) -> bool:
    """00:59：侧面头与正面头瞳色 HSV 一致（主要比 Hue 环距）。缺样本时不拦。"""
    ha = sample_iris_hsv_mean(a)
    hb = sample_iris_hsv_mean(b)
    if ha is None or hb is None:
        return True
    if ha[1] < min_sat and hb[1] < min_sat:
        return True
    d = abs(ha[0] - hb[0])
    d = min(d, 360.0 - d)
    return d <= float(max_hue_deg)

def side_three_quarter_accept(data: bytes, *, front_face: bytes | None=None, min_frac: float=0.25, max_frac: float=0.5) -> tuple[bool, dict]:
    """00:59：侧面头格硬门禁——脸高 25%–50%；有正面时瞳色 HSV 一致。"""
    info: dict = {}
    frac = measure_face_height_frac(data)
    info['face_frac'] = frac
    if frac is None:
        info['reason'] = 'no_face'
        return (False, info)
    if float(frac) + 1e-12 < float(min_frac) or float(frac) - 1e-12 > float(max_frac):
        info['reason'] = f'face_frac={frac:.3f} not in [{min_frac},{max_frac}]'
        return (False, info)
    if front_face is not None:
        ok = iris_hsv_consistent(data, front_face)
        info['iris_ok'] = bool(ok)
        ha = sample_iris_hsv_mean(data)
        hb = sample_iris_hsv_mean(front_face)
        info['iris_side'] = ha
        info['iris_front'] = hb
        if not ok:
            info['reason'] = 'iris_hsv_mismatch'
            return (False, info)
    info['reason'] = 'ok'
    return (True, info)

def side_three_quarter_accept_in_panel_cell(data: bytes, *, front_face: bytes | None=None, panel_size: tuple[int, int] | None=None, min_frac: float=0.25, max_frac: float=0.5) -> tuple[bool, dict]:
    """16:18：模拟 faces 高格 cover 后的 face_frac（与 runner 裁 cell 同口径）。"""
    ok0, info0 = side_three_quarter_accept(data, front_face=front_face, min_frac=min_frac, max_frac=max_frac)
    info = dict(info0)
    info['square_ok'] = bool(ok0)
    try:
        fw, fh = panel_size or (LAYOUT['faces'][2], LAYOUT['faces'][3])
        cell_w = max(8, int(fw) // 3)
        tri = {'face_front': data, 'face_three_quarter': data, 'face_side': data}
        panel = compose_faces_triptych(tri, style='anime', size=(int(fw), int(fh)), master_crop=True)
        pim = Image.open(BytesIO(panel)).convert('RGB')
        cell = pim.crop((cell_w, 0, cell_w * 2, int(fh)))
        buf = BytesIO()
        cell.save(buf, format='PNG')
        cell_b = buf.getvalue()
        ok1, info1 = side_three_quarter_accept(cell_b, front_face=front_face, min_frac=min_frac, max_frac=max_frac)
        info['cell_face_frac'] = info1.get('face_frac')
        info['cell_ok'] = bool(ok1)
        info['cell_reason'] = info1.get('reason')
        if not ok1:
            info['reason'] = f"panel_cell:{info1.get('reason')}"
            return (False, info)
        if not ok0:
            info['reason'] = f"square:{info0.get('reason')}"
            return (False, info)
        info['reason'] = 'ok'
        return (True, info)
    except Exception as e:
        info['cell_error'] = str(e)
        return (ok0, info)

def _channel_cdf_lut(src_vals: list[int], ref_vals: list[int]) -> list[int]:
    """256-entry LUT: match src channel CDF to ref channel CDF."""
    hist_s = [0] * 256
    hist_r = [0] * 256
    for v in src_vals:
        hist_s[max(0, min(255, int(v)))] += 1
    for v in ref_vals:
        hist_r[max(0, min(255, int(v)))] += 1
    ns = max(1, len(src_vals))
    nr = max(1, len(ref_vals))
    cdf_s = [0.0] * 256
    cdf_r = [0.0] * 256
    acc = 0.0
    for i in range(256):
        acc += hist_s[i] / ns
        cdf_s[i] = acc
    acc = 0.0
    for i in range(256):
        acc += hist_r[i] / nr
        cdf_r[i] = acc
    lut = [0] * 256
    j = 0
    for i in range(256):
        while j < 255 and cdf_r[j] < cdf_s[i]:
            j += 1
        lut[i] = j
    return lut

def _hair_coat_region_masks(im: Image.Image) -> tuple[list[bool], list[bool]]:
    """头肩方图：头发（上半偏暗）与外套（下半非肤色服装，含偏蓝/偏亮雨衣）布尔掩码。"""
    w, h = im.size
    px = list(im.convert('RGB').getdata())
    hair = [False] * len(px)
    coat = [False] * len(px)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            r, g, b = px[i]
            yf = y / float(max(1, h - 1))
            lum = (r + g + b) / 3.0
            chroma = max(abs(r - g), abs(g - b), abs(r - b))
            skin = r > 180 and g > 140 and (b > 110) and (r >= g >= b - 25)
            near_white = r > 230 and g > 230 and (b > 230)
            if yf < 0.6 and (not skin) and (not near_white) and (lum < 130):
                if chroma < 90 or lum < 70:
                    hair[i] = True
            if yf > 0.4 and (not skin) and (not near_white) and (25 < lum < 210):
                coat[i] = True
    return (hair, coat)

def side_hist_match_enabled() -> bool:
    """18:02：侧头直方图匹配默认关（恢复 1618 干净 Lanczos/母版裁）；仅 TOIV_SHEET_SIDE_HIST_MATCH=1 才启用。"""
    return os.environ.get('TOIV_SHEET_SIDE_HIST_MATCH', '').strip().lower() in ('1', 'true', 'yes')

def match_side_head_coat_hair_to_front(side: bytes, front: bytes) -> bytes:
    """15:52 / 16:18：侧头外套+头发直方图匹配；排除脸区、羽化边界、半透明混合，避免接缝与 face_frac 膨胀。

    18:02：默认跳过（见 side_hist_match_enabled）；anime 整卡走 1618 干净路径，消除 1738 彩噪。
    """
    if not side or not front:
        return side
    if not side_hist_match_enabled():
        return side
    try:
        s_im = Image.open(BytesIO(side)).convert('RGB')
        f_im = Image.open(BytesIO(front)).convert('RGB')
    except Exception:
        return side
    if f_im.size != s_im.size:
        f_im = f_im.resize(s_im.size, Image.Resampling.LANCZOS)
    w, h = s_im.size
    s_hair, s_coat = _hair_coat_region_masks(s_im)
    f_hair, f_coat = _hair_coat_region_masks(f_im)
    face_mask = [False] * (w * h)
    try:
        bb = _detect_face_bbox_xyxy(side)
        if bb is None:
            bb = _heuristic_skin_face_bbox(s_im)
        if bb is not None:
            x1, y1, x2, y2 = [float(v) for v in bb]
            pad_x = max(4.0, (x2 - x1) * 0.12)
            pad_y = max(4.0, (y2 - y1) * 0.1)
            xa = max(0, int(x1 - pad_x))
            xb = min(w, int(x2 + pad_x))
            ya = max(0, int(y1 - pad_y))
            yb = min(h, int(y2 + pad_y * 1.15))
            for y in range(ya, yb):
                for x in range(xa, xb):
                    face_mask[y * w + x] = True
    except Exception:
        pass
    sp = list(s_im.getdata())
    fp = list(f_im.getdata())
    out_px = list(sp)

    def _apply_region(mask_s: list[bool], mask_f: list[bool], *, blend: float=0.55) -> None:
        src_ch = [[], [], []]
        ref_ch = [[], [], []]
        idxs: list[int] = []
        for i, m in enumerate(mask_s):
            if not m or face_mask[i]:
                continue
            r, g, b = sp[i]
            src_ch[0].append(r)
            src_ch[1].append(g)
            src_ch[2].append(b)
            idxs.append(i)
        for i, m in enumerate(mask_f):
            if not m:
                continue
            r, g, b = fp[i]
            ref_ch[0].append(r)
            ref_ch[1].append(g)
            ref_ch[2].append(b)
        if len(src_ch[0]) < 32 or len(ref_ch[0]) < 32:
            return
        luts = [_channel_cdf_lut(src_ch[c], ref_ch[c]) for c in range(3)]
        a = max(0.0, min(1.0, float(blend)))
        for i in idxs:
            r, g, b = sp[i]
            mr, mg, mb = (luts[0][r], luts[1][g], luts[2][b])
            out_px[i] = (int(r * (1.0 - a) + mr * a + 0.5), int(g * (1.0 - a) + mg * a + 0.5), int(b * (1.0 - a) + mb * a + 0.5))
    _apply_region(s_hair, f_hair, blend=0.5)
    _apply_region(s_coat, f_coat, blend=0.55)
    out = Image.new('RGB', s_im.size)
    out.putdata(out_px)
    try:
        from PIL import ImageFilter
        soft = out.filter(ImageFilter.GaussianBlur(radius=0.6))
        spx = list(out.getdata())
        soft_px = list(soft.getdata())
        for i, (mh, mc) in enumerate(zip(s_hair, s_coat)):
            if face_mask[i] or not (mh or mc):
                continue
            y, x = divmod(i, w) if False else (i // w, i % w)
            border = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    xx, yy = (x + dx, y + dy)
                    if xx < 0 or yy < 0 or xx >= w or (yy >= h):
                        continue
                    j = yy * w + xx
                    if face_mask[j] or not (s_hair[j] or s_coat[j]):
                        border = True
                        break
                if border:
                    break
            if border:
                r, g, b = spx[i]
                sr, sg, sb = soft_px[i]
                spx[i] = ((r * 2 + sr) // 3, (g * 2 + sg) // 3, (b * 2 + sb) // 3)
        out.putdata(spx)
    except Exception:
        pass
    buf = BytesIO()
    out.save(buf, format='PNG')
    matched = buf.getvalue()
    try:
        frac_m = measure_face_height_frac(matched)
        frac_s = measure_face_height_frac(side)

        def _in(f):
            return f is not None and 0.25 - 1e-09 <= float(f) <= 0.5 + 1e-09
        if not _in(frac_m) and _in(frac_s):
            return side
    except Exception:
        pass
    return matched

def score_expression_grid_candidate(grid: bytes, *, bases: dict[str, bytes] | None=None, portrait_ref: bytes | None=None, skip_chest_emblem: bool=False) -> tuple[float, str | None]:
    """15:52 / 16:18：宫格候选打分；发长相对表情底测 delta；遮罩外贴回后不因绝对发长拒。"""
    try:
        cells = _split_expression_grid(grid)
    except Exception as e:
        return (-1.0, f'split:{e}')
    score = 0.0
    for ek, cell_b in cells.items():
        try:
            cell_b = enforce_head_shoulders_square(cell_b, size=768, face_closeup_gate=True)
            href = None
            if bases and bases.get(ek):
                href = bases[ek]
            assert_expression_identity_gates(cell_b, portrait_ref=portrait_ref, expr_key=ek, skip_chest_emblem=skip_chest_emblem, hair_ref=href, relative_hair_only=bool(skip_chest_emblem) or href is not None)
            cells[ek] = cell_b
        except CharacterSheetError as ge:
            return (-1.0, str(ge))
        except Exception as e:
            return (-1.0, f'{ek}:{e}')
    neutral = None
    if portrait_ref:
        try:
            neutral = crop_face_ref(portrait_ref, size=768)
        except Exception:
            neutral = None
    for ek, cell_b in cells.items():
        try:
            others = {o: cells[o] for o in _EXPR_KEYS if o != ek}
            assert_expression_diversity(cell_b, expr_key=ek, neutral_ref=neutral, other_exprs=others)
            score += 1.0
            if neutral is not None:
                score += min(40.0, expression_roi_pixel_diff(cell_b, neutral)) / 40.0
        except CharacterSheetError as ge:
            return (-1.0, str(ge))
    return (score, None)

def expression_mask_exterior_unchanged(original: bytes, edited: bytes, mask: Image.Image | None=None, *, size: int | None=None, max_diff: int=0, grid_cell: int | None=None) -> bool:
    """遮罩外像素与原图逐像素一致（00:59：局部重绘后跳过胸口徽标检）。

    mask 白=可编辑；None 时：
      - grid_cell 给定或宽高比≈3:2 → 2×3 宫格眉眼嘴硬遮罩
      - 否则单格 build_face_feature_mask
    """
    try:
        o = Image.open(BytesIO(original)).convert('RGB')
        e = Image.open(BytesIO(edited)).convert('RGB')
    except Exception:
        return False
    if size is not None:
        o = o.resize((size, size), Image.Resampling.LANCZOS)
        e = e.resize((size, size), Image.Resampling.LANCZOS)
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        w, h = o.size
        if grid_cell is not None or (w >= h * 1.3 and w % 3 == 0 and (h % 2 == 0)):
            cols, rows = (3, 2)
            cw, ch = (max(1, w // cols), max(1, h // rows))
            mask = Image.new('L', (w, h), 0)
            for i in range(6):
                row, col = divmod(i, cols)
                cm = build_face_feature_mask(max(cw, ch)).point(lambda v: 255 if v >= 96 else 0)
                cm = cm.resize((cw, ch), Image.Resampling.NEAREST)
                mask.paste(cm, (col * cw, row * ch))
        else:
            side = min(w, h)
            mask = build_face_feature_mask(side).point(lambda v: 255 if v >= 96 else 0)
            if mask.size != o.size:
                mask = mask.resize(o.size, Image.Resampling.NEAREST)
    elif mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    op = o.load()
    ep = e.load()
    mp = mask.load()
    w, h = o.size
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] >= 96:
                continue
            a = op[x, y]
            b = ep[x, y]
            if abs(int(a[0]) - int(b[0])) > max_diff or abs(int(a[1]) - int(b[1])) > max_diff or abs(int(a[2]) - int(b[2])) > max_diff:
                return False
    return True

def expression_mask_exterior_mae(original: bytes, edited: bytes, mask: Image.Image | None=None, *, size: int | None=None) -> float:
    """遮罩外（mp<96）平均绝对像素差；真 inpaint 应近 0，位移贴回会明显偏大。"""
    try:
        o = Image.open(BytesIO(original)).convert('RGB')
        e = Image.open(BytesIO(edited)).convert('RGB')
    except Exception:
        return 999.0
    if size is not None:
        o = o.resize((size, size), Image.Resampling.LANCZOS)
        e = e.resize((size, size), Image.Resampling.LANCZOS)
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        side = min(o.size)
        mask = build_face_feature_mask(side).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    op = o.load()
    ep = e.load()
    mp = mask.load()
    w, h = o.size
    total = 0.0
    n = 0
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] >= 96:
                continue
            a = op[x, y]
            b = ep[x, y]
            total += (abs(int(a[0]) - int(b[0])) + abs(int(a[1]) - int(b[1])) + abs(int(a[2]) - int(b[2]))) / 3.0
            n += 1
    return total / float(max(1, n))

def _face_region_var_sat(data: bytes, mask: Image.Image | None=None, *, size: int | None=None) -> tuple[float, float]:
    """眉眼嘴遮罩内局部亮度方差 + 平均饱和度（HSV S）。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    if size is not None:
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(im.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load()
    mp = mask.load()
    w, h = im.size
    lumas: list[float] = []
    sats: list[float] = []
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            lumas.append((int(r) + int(g) + int(b)) / 3.0)
            mx = max(r, g, b)
            mn = min(r, g, b)
            sats.append(0.0 if mx <= 0 else (mx - mn) / float(mx))
    if not lumas:
        return (0.0, 0.0)
    mean = sum(lumas) / len(lumas)
    var = sum(((v - mean) ** 2 for v in lumas)) / len(lumas)
    sat = sum(sats) / len(sats)
    return (float(var), float(sat))

def _face_region_mean_rgb(data: bytes, mask: Image.Image | None=None, *, size: int | None=None) -> tuple[float, float, float]:
    """遮罩内平均 RGB（用于距 0.5 灰均值差）。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    if size is not None:
        im = im.resize((size, size), Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(im.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load()
    mp = mask.load()
    w, h = im.size
    sr = sg = sb = 0.0
    n = 0
    step = 1 if w * h <= 768 * 768 else 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            sr += float(r)
            sg += float(g)
            sb += float(b)
            n += 1
    if n <= 0:
        return (128.0, 128.0, 128.0)
    return (sr / n, sg / n, sb / n)

def _insightface_face_kps_xy(data: bytes) -> list[tuple[float, float]] | None:
    """insightface 五官关键：le, re, nose, lm, rm；不可用则 None。"""
    try:
        import numpy as np
        import cv2
        from insightface.app import FaceAnalysis
        import os
        arr = np.frombuffer(data, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            return None
        global _YAW_FACE_APP
        app = _YAW_FACE_APP
        if app is None:
            root = os.environ.get('INSIGHTFACE_HOME') or os.path.expanduser('~/.insightface')
            app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'], root=root)
            app.prepare(ctx_id=-1, det_size=(640, 640))
            _YAW_FACE_APP = app
        faces = app.get(bgr)
        if not faces:
            return None
        f = sorted(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]), reverse=True)[0]
        kps = getattr(f, 'kps', None)
        if kps is None or len(kps) < 5:
            return None
        return [(float(kps[i][0]), float(kps[i][1])) for i in range(5)]
    except Exception:
        return None

def _heuristic_eyes_mouth_in_mask(data: bytes, mask: Image.Image) -> tuple[bool, bool, dict[str, float]]:
    """无 landmark 时：遮罩内上半(眼带)与下半(嘴带)须有足够暗色/对比结构。"""
    im = Image.open(BytesIO(data)).convert('RGB')
    if mask.size != im.size:
        mask = mask.resize(im.size, Image.Resampling.NEAREST)
    px = im.load()
    mp = mask.load()
    w, h = im.size
    eye_dark = eye_n = mouth_dark = mouth_n = 0
    eye_lumas: list[float] = []
    mouth_lumas: list[float] = []
    for y in range(h):
        for x in range(w):
            if mp[x, y] < 96:
                continue
            r, g, b = px[x, y]
            lum = (r + g + b) / 3.0
            yf = y / float(max(1, h - 1))
            if 0.18 <= yf <= 0.52:
                eye_n += 1
                eye_lumas.append(lum)
                if lum < 90:
                    eye_dark += 1
            if 0.52 <= yf <= 0.78:
                mouth_n += 1
                mouth_lumas.append(lum)
                if lum < 110:
                    mouth_dark += 1
    eye_ratio = eye_dark / float(max(1, eye_n))
    mouth_ratio = mouth_dark / float(max(1, mouth_n))
    eye_var = 0.0
    if eye_lumas:
        m = sum(eye_lumas) / len(eye_lumas)
        eye_var = sum(((v - m) ** 2 for v in eye_lumas)) / len(eye_lumas)
    mouth_var = 0.0
    if mouth_lumas:
        m = sum(mouth_lumas) / len(mouth_lumas)
        mouth_var = sum(((v - m) ** 2 for v in mouth_lumas)) / len(mouth_lumas)
    eyes_ok = eye_ratio >= 0.02 or eye_var >= 120.0
    mouth_ok = mouth_ratio >= 0.015 or mouth_var >= 80.0
    return (eyes_ok, mouth_ok, {'eye_dark_ratio': eye_ratio, 'mouth_dark_ratio': mouth_ratio, 'eye_var': eye_var, 'mouth_var': mouth_var})

def force_expression_mask_exterior(original: bytes, edited: bytes, mask: Image.Image | None=None) -> bytes:
    """真 inpaint 同几何后：遮罩外强制底图像素（抑 VAE 轻微渗色，非位移贴回）。"""
    o = Image.open(BytesIO(original)).convert('RGB')
    e = Image.open(BytesIO(edited)).convert('RGB')
    if e.size != o.size:
        e = e.resize(o.size, Image.Resampling.LANCZOS)
    if mask is None:
        mask = build_face_feature_mask(min(o.size)).point(lambda v: 255 if v >= 96 else 0)
    if mask.size != o.size:
        mask = mask.resize(o.size, Image.Resampling.NEAREST)
    hard = mask.point(lambda v: 255 if v >= 96 else 0)
    out = Image.composite(e, o, hard)
    buf = BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()

def build_face_feature_mask_hard(size: int=768) -> Image.Image:
    """眉/眼/嘴硬遮罩（白=可编辑），供真 inpaint；无羽化渗到发丝。"""
    return build_face_feature_mask(int(size)).point(lambda v: 255 if v >= 96 else 0)

def build_eyes_only_mask_hard(size: int=768) -> Image.Image:
    """21:30 / 21:25：沉思只重画眼部——更紧眼+眉遮罩，不含嘴，挖掉瞳孔中心。"""
    s = int(size)
    mask = Image.new('L', (s, s), 0)
    from PIL import ImageDraw as _ID
    d = _ID.Draw(mask)
    d.ellipse((int(s * 0.26), int(s * 0.16), int(s * 0.74), int(s * 0.34)), fill=255)
    d.ellipse((int(s * 0.26), int(s * 0.3), int(s * 0.74), int(s * 0.46)), fill=255)
    pr = max(4, int(s * 0.035))
    for cx in (int(s * 0.38), int(s * 0.62)):
        cy = int(s * 0.38)
        d.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=0)
    return mask.point(lambda v: 255 if v >= 96 else 0)

def auto_tighten_face_crop(data: bytes, *, size: int=768, min_face_height_frac: float=0.35, max_face_height_frac: float=0.8, face_key: str | None=None, max_rounds: int=6) -> bytes:
    """19:01：脸格头高自动拉近——不足 35% 则围绕脸框逐步缩小取景再 cover。"""
    base = data
    last_err: Exception | None = None
    tight = data
    for round_i in range(max_rounds):
        try:
            candidate = enforce_head_shoulders_square(base, size=size, max_upscale=min(2.4, 1.5 + 0.2 * round_i), check_coverage=False, face_closeup_gate=False)
            if round_i > 0:
                img = Image.open(BytesIO(candidate)).convert('RGB')
                w, h = img.size
                bb = _detect_face_bbox_xyxy(candidate)
                if bb is None:
                    bb = _heuristic_skin_face_bbox(img)
                if bb is not None:
                    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
                    fh = max(8.0, fy2 - fy1)
                    fw = max(8.0, fx2 - fx1)
                    fcx = (fx1 + fx2) / 2.0
                    side = int(max(fh / max(0.4, min_face_height_frac + 0.08), fw * 1.4, 64) / (1.0 + 0.22 * round_i))
                    side = max(64, min(side, w, h))
                    left = max(0, min(w - side, int(round(fcx - side / 2.0))))
                    top = max(0, min(h - side, int(round(fy1 - 0.12 * side))))
                    crop = img.crop((left, top, left + side, top + side))
                    crop = crop.resize((size, size), Image.Resampling.LANCZOS)
                    buf = BytesIO()
                    crop.save(buf, format='PNG')
                    candidate = buf.getvalue()
            assert_face_closeup_framing(candidate, min_face_height_frac=min_face_height_frac, max_face_height_frac=max_face_height_frac, face_key=face_key)
            return candidate
        except CharacterSheetError as e:
            last_err = e
            tight = candidate if 'candidate' in locals() else tight
            continue
    if last_err is not None:
        raise last_err
    raise CharacterSheetError(f'face auto-tighten failed (<{min_face_height_frac:.2f})', status_code=422)

def _pick_best_face_with_yaw(cands: list[bytes], face_key: str) -> tuple[bytes, dict]:
    scored: list[tuple[float, float | None, float, bytes]] = []
    for b in cands:
        yaw = estimate_face_yaw_deg(b)
        ang = _score_face_angle_candidate(b, face_key)
        ok = yaw_ok_for_face_key(yaw, face_key)
        joint = ang + (40.0 if ok else -25.0)
        if face_crop_looks_ok(b):
            joint += 35.0
        else:
            joint -= 55.0
        if yaw is not None:
            target = {'face_front': 0.0, 'face_three_quarter': 42.0, 'face_side': 90.0}.get(face_key, 0.0)
            joint -= abs(abs(yaw) - target) * 0.35
        scored.append((joint, yaw, ang, b))
    scored.sort(key=lambda t: t[0], reverse=True)
    passed = [t for t in scored if yaw_ok_for_face_key(t[1], face_key)]
    if passed:
        best = passed[0]
        return (best[3], {'yaw': best[1], 'angle_score': best[2], 'joint': best[0], 'yaw_ok': True, 'n': len(cands), 'n_pass': len(passed)})
    target = {'face_front': 0.0, 'face_three_quarter': 42.0, 'face_side': 90.0}.get(face_key, 0.0)
    scored.sort(key=lambda t: (abs((abs(t[1]) if t[1] is not None else 999.0) - target), -t[0]))
    best = scored[0]
    return (best[3], {'yaw': best[1], 'angle_score': best[2], 'joint': best[0], 'yaw_ok': False, 'n': len(cands), 'n_pass': 0})

def _build_sheet_graph(prompt: str, *, ckpt_name: str, width: int, height: int, seed: int | None, filename_prefix: str, style: str, negative: str | None=None) -> tuple[dict, set[str]]:
    from app.workflows.model_profiles import is_nextgen, nextgen_recipe, profile_for
    from app.workflows.nextgen import NextgenParams, build_nextgen_graph
    from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
    neg = negative or _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE['anime'])
    neg = _with_ancient_spec_negative(neg, style)
    pl = prompt.lower()
    if 'product still life' in pl or 'product shot' in pl or 'rain boots' in pl or ('flat lay' in pl):
        neg = neg + ', person, face, body, human, model, mannequin, wearing clothes, legs, feet, silhouette, bodysuit, tight suit'
    if 'trousers' in pl or 'long pants' in pl or 'pant legs' in pl or ('pants' in pl and 'product' in pl):
        neg = neg + ', ' + _COSTUME_ITEM_NEGATIVE['pants']
    if 'rain boots' in pl or ('boots' in pl and 'product' in pl):
        neg = neg + ', ' + _COSTUME_ITEM_NEGATIVE['boots']
    if 'head and shoulders' in pl or 'extreme face closeup' in pl:
        neg = neg + ', full body, half body, standing pose, waist, legs, chinese text, caption, subtitle, label on image'
    if is_nextgen(ckpt_name):
        prof = profile_for(ckpt_name)
        recipe = nextgen_recipe(ckpt_name)
        kw: dict[str, Any] = dict(model_name=ckpt_name, positive=prompt, negative=neg if getattr(prof, 'neg_prompt', True) else '', width=width, height=height, steps=getattr(prof, 'steps', 20), cfg=getattr(prof, 'cfg', 3.5), sampler=getattr(prof, 'sampler', 'euler'), scheduler=getattr(prof, 'scheduler', 'simple'), batch_size=1, filename_prefix=filename_prefix)
        if seed is not None:
            kw['seed'] = seed
        graph = build_nextgen_graph(NextgenParams(**kw))
        required = {ckpt_name}
        if recipe is not None:
            for attr in ('clip_name', 'vae_name', 'unet_name'):
                v = getattr(recipe, attr, None)
                if v:
                    required.add(v)
        return (graph, required)
    params_kw: dict = dict(positive=prompt, negative=neg, ckpt_name=ckpt_name, width=width, height=height, filename_prefix=filename_prefix, steps=28 if sheet_uses_anime_xl(style) else 22, cfg=6.0 if sheet_uses_anime_xl(style) else 7.0)
    if seed is not None:
        params_kw['seed'] = seed
    return (build_txt2img_graph(Txt2ImgParams(**params_kw)), {ckpt_name})

def _build_ipa_graph(prompt: str, *, ref_image: str, ckpt_name: str, width: int, height: int, seed: int | None, filename_prefix: str, style: str) -> dict:
    from app.workflows.ipadapter import IPAdapterTxt2ImgParams, build_ipadapter_txt2img_graph
    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE['anime']), style)
    kw: dict[str, Any] = dict(positive=prompt, ref_image=ref_image, negative=neg, ckpt_name=ckpt_name, width=width, height=height, filename_prefix=filename_prefix, weight=0.85, steps=28 if sheet_uses_anime_xl(style) else 22, cfg=6.0 if sheet_uses_anime_xl(style) else 7.0, preset='PLUS FACE (portraits)')
    if seed is not None:
        kw['seed'] = seed
    return build_ipadapter_txt2img_graph(IPAdapterTxt2ImgParams(**kw))

def _build_sheet_mask_inpaint_graph(prompt: str, *, image_name: str, mask_name: str, ckpt_name: str, seed: int | None, filename_prefix: str, style: str='anime', denoise: float=0.62, grow_mask_by: int=4, negative_extra: str='') -> dict:
    """18:30：真局部 inpaint —— 禁止 VAEEncodeForInpaint + denoise<1（遮罩区预填 0.5 灰去不掉）。

    改用 VAEEncode(原图像素) + SetLatentNoiseMask，denoise 0.55–0.7，在原图 latent 上重绘遮罩区。
    grow_mask_by 保留签名兼容，当前路径由调用方硬遮罩控制，不在图内扩张。
    """
    del grow_mask_by
    d = float(denoise)
    if d < 1.0 - 1e-09:
        pass
    if not 0.55 - 1e-09 <= d <= 0.7 + 1e-09:
        d = max(0.55, min(0.7, d))
    neg = _STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE['anime'])
    if negative_extra:
        neg = f'{neg}, {negative_extra}'
    neg = neg + ', gray smear, flat gray face, muddy skin, melted face, double face, ghosting, misaligned features, watermark, text, logo, emblem, badge, solid gray fill, 0.5 gray patch, featureless face'
    s = int(seed) if seed is not None else int(uuid.uuid4().int % (2 ** 31 - 1))
    steps = 28 if sheet_uses_anime_xl(style) else 22
    cfg = 6.5 if sheet_uses_anime_xl(style) else 7.0
    return {'4': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': ckpt_name}}, '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['4', 1]}}, '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': neg, 'clip': ['4', 1]}}, '11': {'class_type': 'LoadImage', 'inputs': {'image': image_name}}, '12': {'class_type': 'LoadImage', 'inputs': {'image': mask_name}}, '13': {'class_type': 'ImageToMask', 'inputs': {'image': ['12', 0], 'channel': 'red'}}, '32': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['11', 0], 'vae': ['4', 2]}}, '33': {'class_type': 'SetLatentNoiseMask', 'inputs': {'samples': ['32', 0], 'mask': ['13', 0]}}, '3': {'class_type': 'KSampler', 'inputs': {'model': ['4', 0], 'seed': s, 'steps': steps, 'cfg': cfg, 'sampler_name': 'euler_ancestral', 'scheduler': 'normal', 'positive': ['6', 0], 'negative': ['7', 0], 'latent_image': ['33', 0], 'denoise': float(d)}}, '8': {'class_type': 'VAEDecode', 'inputs': {'samples': ['3', 0], 'vae': ['4', 2]}}, '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': filename_prefix}}}

def _build_img2img_graph(prompt: str, *, image_name: str, ckpt_name: str, seed: int | None, filename_prefix: str, style: str, denoise: float=0.62, negative_extra: str='') -> dict:
    from app.workflows.img2img import Img2ImgParams, build_img2img_graph
    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE['anime']), style)
    if negative_extra:
        neg = f'{neg}, {negative_extra}'
    pl = prompt.lower()
    if 'flat lay' in pl or 'garments laid flat' in pl or 'product still life' in pl or ('product shot' in pl) or ('rain boots' in pl):
        neg = neg + ', person, face, body, human, wearing clothes, model, mannequin, full body portrait, legs, feet, silhouette, bodysuit, tight suit'
    if 'expr' in pl or 'closeup' in pl or 'head and shoulders' in pl:
        neg = neg + ', full body, half body, standing pose, waist up wide, legs, hands holding props, chinese text, caption, subtitle, label'
    kw: dict[str, Any] = dict(positive=prompt, image=image_name, negative=neg, ckpt_name=ckpt_name, denoise=denoise, filename_prefix=filename_prefix, steps=28 if sheet_uses_anime_xl(style) else 22, cfg=6.5 if sheet_uses_anime_xl(style) else 7.0)
    if seed is not None:
        kw['seed'] = seed
    return build_img2img_graph(Img2ImgParams(**kw))

def _build_sheet_qwen_edit_graph(prompt: str, *, image_name: str, seed: int | None, filename_prefix: str, fast: bool=False) -> dict:
    """设定卡表情编辑：在 :8262/:8195 本地跑 Qwen-Image-Edit（不走 :8194/:8196）。

    22:02：默认 fast=False（约 20 步 / 更高 CFG），整图编辑、不加遮罩。
    """
    from app.workflows.qwen_edit import QwenEditParams, build_qwen_edit_graph
    unet = 'Qwen-Image-Edit-2509_fp8_e4m3fn.safetensors'
    params = QwenEditParams(image=image_name, positive=prompt, fast=bool(fast), filename_prefix=filename_prefix, **{'seed': seed} if seed is not None else {})
    graph = build_qwen_edit_graph(params)
    if '1' in graph and isinstance(graph['1'], dict):
        inputs = graph['1'].setdefault('inputs', {})
        inputs['unet_name'] = unet
    return graph

async def regenerate_hires_side_head_master(pool: 'WorkerPool', *, client: Any, side_master: bytes, front_face: bytes | None, ckpt: str, seed: int | None, worker: str | None, style: str, prompt: str, reject_dir: Path | None=None, out_size: int=1280, min_clip: float=0.58) -> bytes | None:
    """00:31：侧母版头肩高分辨率重出（同参数族），CLIP 对正脸门禁后再裁入卡。

    禁止改脸超分模型；用 img2img/Qwen 在放大后的头肩初值上重绘清晰线条，保持脸型发型。
    """
    init = prepare_hires_side_head_init(side_master, out_size=out_size)
    try:
        if reject_dir is not None:
            (reject_dir / f'hires_side_init_{int(seed or 0)}.png').write_bytes(init)
    except Exception:
        pass
    init_name = await client.upload_image(init, f'sheet_hires_side_init_{int(seed or 0)}.png')
    hires_prompt = (prompt or '').strip() + ' sharp clean anime lineart, high resolution head and shoulders only, same face shape same hairstyle, three-quarter view, NO face morphing, NO front facing, NO full body'
    _neg = 'blurry, melted face, deformed eyes, front face, symmetrical frontal, full body, text, watermark, logo, long hair past shoulders'
    cands: list[bytes] = []
    for ci in range(2):
        cseed = None if seed is None else int(seed) + 8972 + ci * 97
        try:
            raw = await generate_panel_bytes(pool, '在保持同一人物、同一发型、同一¾侧脸角度与雨衣领口的前提下，输出更清晰的头肩特写；不要改脸型发型，不要正面化，不要全身。', ckpt_name=ckpt, width=out_size, height=out_size, seed=cseed, worker=worker, filename_prefix=f'ToIV_char_sheet_hires_side_q{ci}', style=style, client=client, ref_image=init_name, ref_mode='qwen_edit', denoise=1.0, negative_extra=_neg)
        except Exception as qe:
            logger.warning('hires side qwen fail cand%s: %s', ci, qe)
            try:
                raw = await generate_panel_bytes(pool, hires_prompt, ckpt_name=ckpt, width=out_size, height=out_size, seed=cseed, worker=worker, filename_prefix=f'ToIV_char_sheet_hires_side_i{ci}', style=style, client=client, ref_image=init_name, ref_mode='img2img', denoise=0.48, negative_extra=_neg)
            except Exception as ie:
                logger.warning('hires side img2img fail cand%s: %s', ci, ie)
                continue
        try:
            raw = enforce_head_shoulders_square(raw, size=out_size, face_closeup_gate=True)
        except CharacterSheetError as fe:
            dump_rejected_panel(raw, seed=seed, panel='face_three_quarter', gate='hires_side_frame', detail=str(fe), dump_dir=reject_dir)
            continue
        if front_face is not None:
            sim = clip_image_cosine_sim(raw, front_face)
            if sim is not None and sim + 1e-12 < float(min_clip):
                dump_rejected_panel(raw, seed=seed, panel='face_three_quarter', gate='hires_side_clip', detail=f'clip={sim:.4f}<{min_clip}', dump_dir=reject_dir)
                continue
        try:
            base_crop = crop_face_slot_from_master(side_master, slot='face_three_quarter', size=768)
            if _edge_sharpness_score(raw) + 0.5 < _edge_sharpness_score(base_crop):
                dump_rejected_panel(raw, seed=seed, panel='face_three_quarter', gate='hires_side_sharp', detail='not sharper', dump_dir=reject_dir)
                continue
        except Exception:
            pass
        cands.append(raw)
    if not cands:
        return None
    cands.sort(key=lambda b: _edge_sharpness_score(b), reverse=True)
    best = cands[0]
    try:
        if reject_dir is not None:
            (reject_dir / f'hires_side_best_{int(seed or 0)}.png').write_bytes(best)
    except Exception:
        pass
    return best

async def generate_panel_bytes(pool: 'WorkerPool', prompt: str, *, ckpt_name: str, width: int=768, height: int=1024, seed: int | None=None, worker: str | None=None, filename_prefix: str='ToIV_char_sheet', style: str='anime', client: Any | None=None, ref_image: str | None=None, ref_mode: str='auto', denoise: float=0.62, negative_extra: str='', mask_image: str | None=None, grow_mask_by: int=4) -> bytes:
    """单格出图 → PNG bytes。

    ref_mode: auto|ipa|img2img|qwen_edit|inpaint|none
      - anime 默认 img2img(规避 hassaku/IPA glitch)
      - 18:30 表情真局部 inpaint（mask_image + VAEEncode+SetLatentNoiseMask；禁 VAEEncodeForInpaint+denoise<1）
      - ancient 默认 ipa
    注意:忽略 pool.pick,强制 :8262/:8264。
    """
    del pool
    from app.comfy.client import ComfyUIError
    cli = client or await _pick_sheet_client(worker)
    mode = ref_mode
    if mode == 'auto':
        if not ref_image:
            mode = 'none'
        elif sheet_uses_anime_xl(style):
            mode = 'img2img'
        else:
            mode = 'ipa'
    try:
        if ref_image and mode == 'inpaint':
            if not mask_image:
                raise CharacterSheetError('inpaint 模式需要 mask_image', status_code=422)
            graph = _build_sheet_mask_inpaint_graph(prompt, image_name=ref_image, mask_name=mask_image, ckpt_name=ckpt_name, seed=seed, filename_prefix=filename_prefix, style=style, denoise=denoise, grow_mask_by=grow_mask_by, negative_extra=negative_extra)
        elif ref_image and mode == 'qwen_edit':
            graph = _build_sheet_qwen_edit_graph(prompt, image_name=ref_image, seed=seed, filename_prefix=filename_prefix)
        elif ref_image and mode == 'img2img':
            graph = _build_img2img_graph(prompt, image_name=ref_image, ckpt_name=ckpt_name, seed=seed, filename_prefix=filename_prefix, style=style, denoise=denoise, negative_extra=negative_extra)
        elif ref_image and mode == 'ipa':
            graph = _build_ipa_graph(prompt, ref_image=ref_image, ckpt_name=ckpt_name, width=width, height=height, seed=seed, filename_prefix=filename_prefix, style=style)
        else:
            graph, _required = _build_sheet_graph(prompt, ckpt_name=ckpt_name, width=width, height=height, seed=seed, filename_prefix=filename_prefix, style=style)
        if negative_extra:
            for nid, node in list(graph.items()):
                if not isinstance(node, dict):
                    continue
                if node.get('class_type') == 'CLIPTextEncode':
                    inputs = node.get('inputs') or {}
                    t = str(inputs.get('text') or '')
                    if 'ugly' in t.lower() or 'bad' in t.lower() or 'worst' in t.lower():
                        inputs['text'] = f'{t}, {negative_extra}'
        prompt_id = await cli.queue_prompt(graph, client_id=uuid.uuid4().hex)
    except ComfyUIError as e:
        raise CharacterSheetError(f'出图后端不可用:{e}', status_code=503) from e
    except CharacterSheetError:
        raise
    except Exception as e:
        raise CharacterSheetError(f'出图提交失败:{e}', status_code=503) from e
    images = await _wait_images(cli, prompt_id)
    img = images[0]
    try:
        data, _ = await cli.get_image_bytes(img['filename'], img.get('subfolder', ''), img.get('type', 'output'))
    except ComfyUIError as e:
        raise CharacterSheetError(f'取图失败:{e}', status_code=502) from e
    return data

async def load_image_bytes_from_url(url: str) -> bytes | None:
    from app.storage import drama_output_root
    u = (url or '').strip()
    if not u:
        return None
    marker = '/api/studio/files/'
    if marker in u:
        name = u.split(marker, 1)[-1].split('?', 1)[0]
        if '/' in name or name.startswith('.'):
            return None
        path = drama_output_root() / 'studio' / name
        if path.is_file():
            return path.read_bytes()
    try:
        import httpx
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(u if u.startswith('http') else f'http://127.0.0.1:8090{u}')
            ctype = r.headers.get('content-type', '')
            if r.status_code == 200 and (r.content[:4] == b'\x89PNG' or ctype.startswith('image/')):
                return r.content
    except Exception:
        logger.warning('设定卡:拉取参考图失败 url=%s', u[:120])
    return None

async def generate_character_sheet(*, character_id: str, meta: SheetMeta, pool: 'WorkerPool', ckpt_name: str | None=None, worker: str | None=None, seed: int | None=None, panels_override: dict[str, bytes] | None=None, reuse_ref_urls: list[str] | None=None, allow_reuse_refs: bool=False, expr_base_panels: dict[str, bytes] | None=None, expr_lock_meta: dict[str, dict] | None=None) -> tuple[str, bytes, dict[str, str]]:
    """出齐分格 → 拼版 → 落盘。返回 (sheet_url, png_bytes, panel_urls)。

    allow_reuse_refs 默认 False(17:45 纠偏#2:禁止复用旧 sample 三视图)。
    reuse_ref_urls 仅在 allow_reuse_refs=True 时生效。
    """
    if not (meta.name or '').strip():
        raise CharacterSheetError('角色名为空', status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422)
    resolve_cjk_font(24)
    meta.design_notes = build_design_notes(meta)
    prompts = build_panel_prompts(meta)
    _ANCIENT_SPEC_NEG_CTX.set(ancient_spec_negative(meta))
    _acc_fix = ancient_accessory_prompt_fix(meta)
    if _acc_fix['pos']:
        logger.info('ancient accessory prompt fix name=%s wooden_hairpin=%s umbrella_in_hand=%s', meta.name, _acc_fix['wooden_hairpin'], _acc_fix['umbrella_in_hand'])
    panels: dict[str, bytes] = dict(panels_override or {})
    override_keys: set[str] = set(panels.keys())
    _expr_lock_meta: dict[str, dict] = {str(k): dict(v) for k, v in dict(expr_lock_meta or {}).items() if str(k).startswith('expr_') and isinstance(v, dict)}
    _expr_bases: dict[str, bytes] = {k: v for k, v in dict(expr_base_panels or {}).items() if k.startswith('expr_') and v}
    panel_urls: dict[str, str] = {}
    reject_dir = Path(os.environ.get('TOIV_SHEET_REJECT_DIR', f'/home/merlin/toiv/tmp/toiv_report_sheet_rejects_{int(seed or 0)}'))
    reject_dir.mkdir(parents=True, exist_ok=True)
    for _ok, _ob in list(panels.items()):
        try:
            (reject_dir / f'override_{_ok}.png').write_bytes(_ob)
        except Exception:
            pass
    _last_reject: dict[str, Any] = {'key': None, 'data': None}
    _reject_token = _SHEET_REJECT_CTX.set({'dir': reject_dir, 'seed': seed, 'panels': panels, 'current_key': None})
    if allow_reuse_refs and reuse_ref_urls:
        views = [u for u in reuse_ref_urls if u and (not is_sheet_url(u))]
        slot_map = ('front', 'side', 'back')
        for i, key in enumerate(slot_map):
            if key in panels or i >= len(views):
                continue
            data = await load_image_bytes_from_url(views[i])
            if data:
                panels[key] = data
        if 'portrait' not in panels and views:
            data = await load_image_bytes_from_url(views[0])
            if data:
                panels['portrait'] = data
    ckpt = ckpt_name or _SHEET_CKPT.get(meta.style, _SHEET_CKPT['anime'])
    client = await _pick_sheet_client(worker)
    if 'portrait' not in panels:
        w, h = _panel_size('portrait', meta.style)
        last_err = None
        front_ref_name = None
        if panels.get('front'):
            try:
                front_ref_name = await client.upload_image(panels['front'], f'sheet_front_ref_{character_id[:8]}_{meta.style}.png')
            except Exception as e:
                logger.warning('upload front ref for portrait edit failed: %s', e)
                front_ref_name = None
        for attempt in range(6):
            try:
                s = None if seed is None else int(seed) + attempt * 9973
                bust = f', unique layout variant {attempt}-{s or 0}, plain flat chest no badge no emblem no star patch'
                if front_ref_name:
                    panels['portrait'] = await generate_panel_bytes(pool, prompts['portrait'] + ', edit from reference front view into full-body main portrait, same character same outfit same colors, plain flat chest, ' + bust, ckpt_name=ckpt, width=w, height=h, seed=s, worker=worker, filename_prefix=f'ToIV_char_sheet_portrait_fromfront_a{attempt}', style=meta.style, client=client, ref_image=front_ref_name, ref_mode='img2img', denoise=0.48)
                else:
                    panels['portrait'] = await generate_panel_bytes(pool, prompts['portrait'] + bust, ckpt_name=ckpt, width=w, height=h, seed=s, worker=worker, filename_prefix=f'ToIV_char_sheet_portrait_a{attempt}', style=meta.style, client=client)
                if sheet_uses_anime_gates(meta.style) and portrait_has_chest_emblem(panels['portrait'], ref=panels.get('front')):
                    try:
                        ref_p = await client.upload_image(panels['portrait'], f'sheet_portrait_emblem_{attempt}.png')

                        async def _make_plain(denoise, _ref=ref_p):
                            return await generate_panel_bytes(pool, prompts['portrait'] + ', plain flat chest only, remove chest badge emblem star logo patch, ' + bust, ckpt_name=ckpt, width=w, height=h, seed=(s or 0) + 171, worker=worker, filename_prefix=f'ToIV_char_sheet_portrait_plain_a{attempt}', style=meta.style, client=client, ref_image=_ref, ref_mode='img2img', denoise=denoise)
                        cleaned = await _emblem_cleanup(make_plain=_make_plain, is_emblem=lambda img: portrait_has_chest_emblem(img, ref=panels.get('front')))
                        if cleaned is None:
                            raise CharacterSheetError('主立绘胸口徽标，img2img 去标失败禁铺色', status_code=422)
                        panels['portrait'] = cleaned
                        logger.info('portrait emblem cleared via img2img attempt=%s', attempt)
                    except CharacterSheetError as ce:
                        last_err = ce
                        logger.warning('portrait emblem inpaint fail attempt=%s: %s', attempt, ce)
                        continue
                if sheet_uses_anime_gates(meta.style):
                    try:
                        assert_fullbody_portrait_face_ok(panels['portrait'])
                    except CharacterSheetError as gate_e:
                        last_err = gate_e
                        logger.warning('portrait face gate fail attempt=%s: %s', attempt, gate_e)
                        continue
                    if panels.get('front'):
                        p_hex = _panel_garment_dominant_hex(panels['portrait'])
                        f_hex = _panel_garment_dominant_hex(panels['front'])
                        if not p_hex or not f_hex:
                            last_err = CharacterSheetError('颜色门禁失败:主立绘/旧正面无法取服装主色', status_code=422)
                            logger.warning('portrait relative color fail attempt=%s: %s', attempt, last_err)
                            continue
                        dist = _hex_dist(p_hex, f_hex)
                        if dist > 110:
                            last_err = CharacterSheetError(f'颜色门禁失败:主立绘({p_hex})与旧正面({f_hex})色差={dist}>110', status_code=422)
                            logger.warning('portrait vs front color fail attempt=%s: %s', attempt, last_err)
                            continue
                        logger.info('portrait color locked to front override %s~%s dist=%s', p_hex, f_hex, dist)
                    else:
                        try:
                            assert_garment_near_slate_gray(panels['portrait'], label='主立绘')
                        except CharacterSheetError as color_e:
                            last_err = color_e
                            logger.warning('portrait slate gate fail attempt=%s: %s; try img2img slate recolor then seed', attempt, color_e)
                            # F5: 禁止整图着色；一次低 denoise img2img 把服装拉回 #5A6A7A 后再验
                            try:
                                ref_p = await client.upload_image(panels['portrait'], f'sheet_portrait_slate_{attempt}.png')
                                recolored = await generate_panel_bytes(
                                    pool,
                                    prompts['portrait'] + ', keep same pose and face, ONLY recolor raincoat to mid-tone slate gray #5A6A7A, not jet black, not near-white, plain flat chest, ' + bust,
                                    ckpt_name=ckpt,
                                    width=w,
                                    height=h,
                                    seed=(s or 0) + 313,
                                    worker=worker,
                                    filename_prefix=f'ToIV_char_sheet_portrait_slate_a{attempt}',
                                    style=meta.style,
                                    client=client,
                                    ref_image=ref_p,
                                    ref_mode='img2img',
                                    denoise=0.42,
                                )
                                assert_garment_near_slate_gray(recolored, label='主立绘')
                                panels['portrait'] = recolored
                                logger.info('portrait slate recovered via img2img attempt=%s', attempt)
                            except Exception as slate_e:
                                logger.warning('portrait slate img2img recover fail attempt=%s: %s; retry seed', attempt, slate_e)
                                continue
                elif meta.style == 'ancient_realistic' and ancient_spec_target_hex(meta):
                    try:
                        assert_garment_near_spec_color(panels['portrait'], ancient_spec_target_hex(meta), label='主立绘')
                    except CharacterSheetError as color_e:
                        last_err = color_e
                        logger.warning('portrait ancient spec color gate fail attempt=%s: %s; retry seed', attempt, color_e)
                        continue
                if meta.style == 'ancient_realistic' and ancient_accessory_prompt_fix(meta)['wooden_hairpin']:
                    try:
                        _hp = hair_ornament_gold_frac(panels['portrait'])
                        _f = _hp.get('frac')
                        if _f is not None and _f > HAIRPIN_GOLD_MAX_FRAC:
                            logger.warning('portrait ancient hairpin soft check: gold_frac=%.3f>%s (spec 木簪) attempt=%s box=%s; log only', _f, HAIRPIN_GOLD_MAX_FRAC, attempt, _hp.get('box'))
                        else:
                            logger.info('portrait ancient hairpin soft check ok attempt=%s gold_frac=%s', attempt, _f)
                    except Exception as acc_e:
                        logger.warning('portrait ancient hairpin soft check error: %s', acc_e)
                if meta.style == 'ancient_realistic' and build_ancient_accessory_qa_prompt(meta):
                    try:
                        _qa = await classify_ancient_accessory_qa(panels['portrait'], meta=meta, worker_url=worker, seed=42 + attempt)
                    except CharacterSheetError as qa_e:
                        _qa = {'reasons': [], 'error': str(qa_e)}
                        logger.warning('portrait ancient accessory VLM unavailable attempt=%s: %s; pass', attempt, qa_e)
                    _rs = _qa.get('reasons') or []
                    if _rs and attempt < ACCESSORY_QA_HARD_ATTEMPTS:
                        last_err = CharacterSheetError(f"饰品门禁失败:主立绘 {';'.join(_rs)},重出", status_code=422)
                        logger.warning('portrait ancient accessory VLM gate fail attempt=%s reasons=%s q1=%s q2=%s model=%s; retry seed', attempt, _rs, _qa.get('q1'), _qa.get('q2'), _qa.get('model'))
                        continue
                    logger.info('portrait ancient accessory VLM gate %s attempt=%s q1=%s q2=%s model=%s reasons=%s', 'ok' if not _rs else 'exhausted(accept, log only)', attempt, _qa.get('q1'), _qa.get('q2'), _qa.get('model'), _rs)
                break
            except CharacterSheetError as e:
                last_err = e
                logger.warning('portrait gen fail attempt=%s: %s', attempt, e)
        else:
            raise last_err or CharacterSheetError('主立绘生成失败', status_code=422)
    if 'portrait' not in override_keys:
        assert_no_large_uniform_rect(panels['portrait'], label='主立绘', ref=panels.get('front'))
        assert_skin_not_blue_gray(panels['portrait'], label='主立绘', ref=panels.get('front'))
    panel_urls['portrait'] = save_panel_png(panels['portrait'], character_id=character_id, style=meta.style, key='portrait')
    ref_name: str | None = None
    face_ref_name: str | None = None
    try:
        ref_name = await client.upload_image(panels['portrait'], f'sheet_ref_{character_id[:8]}_{meta.style}.png')
        face_bytes = crop_face_ref(panels['portrait'])
        face_ref_name = await client.upload_image(face_bytes, f'sheet_face_{character_id[:8]}_{meta.style}.png')
    except Exception as e:
        logger.warning('设定卡:上传立绘/脸参考失败,后续退回 txt2img: %s', e)
        ref_name = ref_name
    need_keys = list(_PANEL_KEYS) + list(_EXPR_KEYS)
    for key in need_keys:
        if key == 'portrait' or key in panels:
            continue
        if key == 'costume':
            try:
                if sheet_uses_anime_gates(meta.style) and panels.get('portrait'):
                    panels['costume'] = build_costume_collage_from_portrait(panels['portrait'], style=meta.style)
                else:
                    panels['costume'] = await _generate_costume_collage(pool, meta=meta, ckpt=ckpt, worker=worker, client=client, seed=seed)
                    panels['costume'] = ensure_costume_bad_cells_replaced(panels['costume'], portrait=panels.get('portrait'), front=panels.get('front'), n=len(ancient_costume_items(meta) if meta.style == 'ancient_realistic' else _COSTUME_ITEMS))
            except CharacterSheetError as ce:
                dump_rejected_panel(panels.get('costume'), seed=seed, panel='costume', gate='costume_cells', detail=str(ce), dump_dir=reject_dir)
                raise
            continue
        w, h = _panel_size(key, meta.style)
        use_ref = None
        ref_mode = 'none'
        denoise = 0.62
        if key in ('front', 'side', 'back'):
            if sheet_uses_anime_gates(meta.style):
                if not ref_name:
                    raise CharacterSheetError('三视图缺主立绘参考，无法 img2img', status_code=422)
                last_err = None
                for attempt in range(4):
                    try:
                        s = None if seed is None else seed + abs(hash(key)) % 10000 + attempt * 8111
                        bust = f', keep exact same raincoat color #5A6A7A long sleeves pantyhose boots as reference portrait, unique view {attempt}-{s or 0}'
                        den = 0.42 + 0.04 * attempt
                        raw = await generate_panel_bytes(pool, prompts[key] + bust, ckpt_name=ckpt, width=w, height=h, seed=s, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_i2i_a{attempt}', style=meta.style, client=client, ref_image=ref_name, ref_mode='img2img', denoise=den)
                        raw = normalize_turnaround_figure(raw, out_w=w, out_h=h)
                        if key in ('front', 'side') and portrait_has_chest_emblem(raw):
                            ref_up = await client.upload_image(raw, f'sheet_{key}_emblem_{attempt}.png')

                            async def _make_plain(denoise, _ref=ref_up):
                                return await generate_panel_bytes(pool, prompts[key] + ', plain flat chest no badge no emblem no star, ' + bust, ckpt_name=ckpt, width=w, height=h, seed=(s or 0) + 333, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_plain_a{attempt}', style=meta.style, client=client, ref_image=_ref, ref_mode='img2img', denoise=denoise)

                            def _still_emblem(img):
                                return portrait_has_chest_emblem(normalize_turnaround_figure(img, out_w=w, out_h=h))
                            cleaned = await _emblem_cleanup(make_plain=_make_plain, is_emblem=_still_emblem)
                            if cleaned is None:
                                raise CharacterSheetError(f'img2img {key}胸口徽标残留，禁铺色须重出', status_code=422)
                            raw = normalize_turnaround_figure(cleaned, out_w=w, out_h=h)
                        p_hex = _panel_garment_dominant_hex(panels['portrait'])
                        t_hex = _panel_garment_dominant_hex(raw)
                        if p_hex and t_hex and (_hex_dist(p_hex, t_hex) > 110):
                            raise CharacterSheetError(f'img2img {key}服装色差过大({t_hex} vs {p_hex})，禁强制着色须重出', status_code=422)
                        if key not in override_keys:
                            assert_panel_output_gates(raw, label=key, key=key)
                        panels[key] = raw
                        last_err = None
                        break
                    except CharacterSheetError as e:
                        last_err = e
                        logger.warning('img2img turnaround %s fail attempt=%s: %s', key, attempt, e)
                if last_err is not None:
                    raise last_err
                panel_urls[key] = save_panel_png(panels[key], character_id=character_id, style=meta.style, key=key)
                continue
            use_op, _why = await _probe_openpose_available(client)
            if use_op and ref_name:
                assets = ensure_openpose_assets(height_cm=meta.height_cm or 165)
                pose_name = await client.upload_image(assets[key].read_bytes(), f'sheet_pose_{character_id[:8]}_{key}.png')
                last_err = None
                for attempt in range(4):
                    try:
                        s = None if seed is None else seed + abs(hash(key)) % 10000 + attempt * 8111
                        raw = await generate_panel_bytes_openpose(pool, prompts[key], pose_image_name=pose_name, ckpt_name=ckpt, width=w, height=h, seed=s, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_pose', style=meta.style, client=client, ref_image=ref_name, skip_preprocess=True)
                        raw = normalize_turnaround_figure(raw, out_w=w, out_h=h)
                        if ancient_spec_target_hex(meta) and key not in override_keys:
                            assert_garment_near_spec_color(raw, ancient_spec_target_hex(meta), label=key)
                        panels[key] = raw
                        last_err = None
                        break
                    except CharacterSheetError as e:
                        last_err = e
                        logger.warning('openpose %s fail attempt=%s: %s', key, attempt, e)
                if last_err is not None:
                    raise last_err
                panel_urls[key] = save_panel_png(panels[key], character_id=character_id, style=meta.style, key=key)
                continue
            if ref_name:
                use_ref = ref_name
                ref_mode = 'ipa'
                denoise = 0.65
        elif key == 'faces':
            try:
                tri = build_faces_tri_from_masters(portrait=panels.get('portrait'), front=panels.get('front'), side=panels.get('side'), back=panels.get('back'), size=768)
            except CharacterSheetError as fe:
                dump_rejected_panel(None, seed=seed, panel='faces', gate='faces_master_crop', detail=str(fe), dump_dir=reject_dir)
                raise
            for fk in ('face_front', 'face_three_quarter', 'face_side'):
                im = Image.open(BytesIO(tri[fk])).convert('RGB')
                if im.size[0] < 64 or sum(im.convert('L').resize((32, 32)).getdata()) < 100:
                    dump_rejected_panel(tri.get(fk), seed=seed, panel=str(fk), gate='faces_crop_empty', detail='empty crop', dump_dir=reject_dir)
                    raise CharacterSheetError(f'faces {fk} master crop empty', status_code=422)
                frac = measure_face_height_frac(tri[fk])
                logger.info('faces %s hard-crop face_height_frac=%s', fk, frac)
                _y = estimate_face_yaw_deg(tri[fk])
                logger.info('faces %s crop-from-master yaw=%s ok=%s', fk, _y, yaw_ok_for_face_key(_y, fk))
            if os.environ.get('TOIV_SHEET_SIDE_DEBLUR', '').strip() in ('1', 'true', 'yes'):
                for _side_fk, _seed_off in (('face_three_quarter', 2023),):
                    try:
                        side_crop = tri[_side_fk]
                        side_name = await client.upload_image(side_crop, f'sheet_{_side_fk}_crop_{character_id[:8]}_{meta.style}.png')
                        _deblur_prompt = '整图修复侧面/¾侧头像的融化与错位线条（禁止局部遮罩）：恢复清晰二次元五官——可见的一侧眼睛轮廓清楚、鼻梁一条干净线、嘴巴位置正确；保持同一发型、同一头身角度、同一雨衣领口与配色；不要正面化、不要改成长发、不要加第二张脸、不要重影、不要加文字徽标。'
                        _cands: list[bytes] = []
                        for _ci in range(3):
                            _cseed = None if seed is None else int(seed) + int(_seed_off) + int(_ci) * 17
                            cleaned = await generate_panel_bytes(pool, _deblur_prompt, ckpt_name=ckpt, width=768, height=768, seed=_cseed, worker=worker, filename_prefix=f'ToIV_char_sheet_{_side_fk}_deblur_c{_ci}', style=meta.style, client=client, ref_image=side_name, ref_mode='qwen_edit', denoise=1.0)
                            try:
                                cleaned = enforce_head_shoulders_square(cleaned, size=768, face_closeup_gate=True)
                            except CharacterSheetError:
                                dump_rejected_panel(cleaned, seed=seed, panel=str(_side_fk), gate='side_deblur_frame', detail=f'cand{_ci} frame gate', dump_dir=reject_dir)
                                continue
                            _cands.append(cleaned)
                        _id_ref = tri.get('face_front') or panels.get('portrait')
                        best = pick_best_side_deblur_candidate(_cands, side_crop, master_side=panels.get('side'), identity_ref=_id_ref)
                        if best is not None:
                            tri[_side_fk] = best
                            logger.info('faces %s Qwen deblur accepted (%d cands)', _side_fk, len(_cands))
                        else:
                            logger.info('faces %s Qwen deblur all rejected → keep crop (%d cands)', _side_fk, len(_cands))
                    except Exception as de:
                        logger.warning('faces %s Qwen deblur skipped: %s', _side_fk, de)
            else:
                logger.info('faces face_three_quarter 00:31 Lanczos native (Qwen deblur off)')
            try:
                side_src = panels.get('side')
                if side_src:
                    _tq, _tq_meta = crop_face_slot_from_master_with_meta(side_src, slot='face_three_quarter', size=768)
                    if not _tq_meta.get('readable', True):
                        logger.info('faces face_three_quarter unreadable meta=%s → hires side master', {k: _tq_meta.get(k) for k in ('native_side', 'upscale', 'face_frac')})
                        _hires = await regenerate_hires_side_head_master(pool, client=client, side_master=side_src, front_face=tri.get('face_front') or panels.get('portrait'), ckpt=ckpt, seed=seed, worker=worker, style=meta.style, prompt=prompts.get('face_three_quarter') or prompts.get('side') or '', reject_dir=reject_dir)
                        if _hires:
                            _hires_crop = crop_face_slot_from_master(_hires, slot='face_three_quarter', size=768)
                            _front_ref = tri.get('face_front') or panels.get('portrait')
                            _ok, _ainfo = side_three_quarter_accept(_hires_crop, front_face=_front_ref)
                            if _ok:
                                tri['face_three_quarter'] = _hires_crop
                                try:
                                    if reject_dir is not None:
                                        (reject_dir / f'hires_side_used_{int(seed or 0)}.png').write_bytes(_hires)
                                except Exception:
                                    pass
                                logger.info('faces face_three_quarter hires accepted %s', _ainfo)
                            else:
                                logger.warning('faces hires side reject gates %s → body side fallback', _ainfo)
                                try:
                                    if reject_dir is not None:
                                        (reject_dir / f'hires_side_reject_gates_{int(seed or 0)}.txt').write_text(str(_ainfo), encoding='utf-8')
                                        (reject_dir / f'hires_side_rejected_crop_{int(seed or 0)}.png').write_bytes(_hires_crop)
                                except Exception:
                                    pass
                                _body = crop_face_slot_from_master(side_src, slot='face_three_quarter', size=768)
                                _bok, _binfo = side_three_quarter_accept(_body, front_face=_front_ref)
                                tri['face_three_quarter'] = _body
                                logger.info('faces face_three_quarter body-side fallback accept=%s info=%s', _bok, _binfo)
                        else:
                            logger.warning('faces hires side master rejected/failed → keep Lanczos crop')
                            tri['face_three_quarter'] = _tq
            except CharacterSheetError:
                raise
            except Exception as he:
                logger.warning('faces hires side master skipped: %s', he)
            try:
                if not side_hist_match_enabled():
                    logger.info('faces hist-match skipped (TOIV_SHEET_SIDE_HIST_MATCH off, default 18:02 → 1618 path)')
                    _front_ref_hm = None
                else:
                    _front_ref_hm = tri.get('face_front') or panels.get('portrait')
                _side_src_fb = panels.get('side')
                if _front_ref_hm and tri.get('face_three_quarter'):
                    _before = tri['face_three_quarter']
                    _matched = match_side_head_coat_hair_to_front(_before, _front_ref_hm)
                    _mok, _minfo = side_three_quarter_accept(_matched, front_face=_front_ref_hm)
                    if _mok:
                        tri['face_three_quarter'] = _matched
                        logger.info('faces face_three_quarter hist-match accepted %s', _minfo)
                    else:
                        _bok0, _binfo0 = side_three_quarter_accept(_before, front_face=_front_ref_hm)
                        if _bok0:
                            tri['face_three_quarter'] = _before
                            logger.warning('faces hist-match reject %s → keep pre-match', _minfo)
                        elif _side_src_fb:
                            _body = crop_face_slot_from_master(_side_src_fb, slot='face_three_quarter', size=768)
                            try:
                                _body_m = match_side_head_coat_hair_to_front(_body, _front_ref_hm)
                                _bmok, _bminfo = side_three_quarter_accept(_body_m, front_face=_front_ref_hm)
                                if _bmok:
                                    _body = _body_m
                                    logger.info('faces body-side hist ok %s', _bminfo)
                                else:
                                    logger.warning('faces body-side hist reject %s → plain crop', _bminfo)
                            except Exception as _bhe:
                                logger.warning('faces body hist skipped: %s', _bhe)
                            _bok, _binfo = side_three_quarter_accept(_body, front_face=_front_ref_hm)
                            tri['face_three_quarter'] = _body
                            logger.warning('faces hist/hires fail → body-side fallback accept=%s info=%s (was %s)', _bok, _binfo, _minfo)
                            try:
                                if reject_dir is not None:
                                    (reject_dir / f'side_body_fallback_{int(seed or 0)}.txt').write_text(f'hist_or_hires_reject {_minfo} → body {_binfo}', encoding='utf-8')
                            except Exception:
                                pass
                        else:
                            tri['face_three_quarter'] = _before
                            logger.warning('faces hist reject %s and no side master', _minfo)
            except Exception as hme:
                logger.warning('faces hist-match skipped: %s', hme)
            try:
                _front_final = tri.get('face_front') or panels.get('portrait')
                _side_final = panels.get('side')
                if tri.get('face_three_quarter') and _side_final:
                    _fok, _finfo = side_three_quarter_accept_in_panel_cell(tri['face_three_quarter'], front_face=_front_final)
                    if not _fok:
                        _body2 = crop_face_slot_from_master(_side_final, slot='face_three_quarter', size=768)
                        tri['face_three_quarter'] = _body2
                        _fok2, _finfo2 = side_three_quarter_accept_in_panel_cell(_body2, front_face=_front_final)
                        logger.warning('faces final accept fail %s → forced body-side accept=%s %s', _finfo, _fok2, _finfo2)
            except Exception as fae:
                logger.warning('faces final accept skipped: %s', fae)
            panels['faces'] = compose_faces_triptych(tri, style=meta.style, size=_panel_size('faces', meta.style), master_crop=True)
            continue
        elif key.startswith('expr_'):
            missing_expr = [ek for ek in _EXPR_KEYS if ek not in panels]
            if not missing_expr:
                continue
            bases: dict[str, bytes] = {}
            for ek in _EXPR_KEYS:
                if ek in _expr_bases:
                    bases[ek] = _expr_bases[ek]
                elif ek in panels:
                    bases[ek] = panels[ek]
                else:
                    try:
                        bases[ek] = crop_face_ref(panels['portrait'], size=768)
                    except Exception as ce:
                        raise CharacterSheetError(f'{ek} 无表情底且无法从主立绘裁脸: {ce}', status_code=422) from ce
            for ek, bb in list(bases.items()):
                fixed, area = assert_expr_base_face_area(bb, expr_key=ek, min_area=0.15)
                bases[ek] = fixed
                logger.info('expr base %s face_area=%.3f ok', ek, area)
            _expr_neg = 'text, watermark, logo, emblem, badge, chinese characters, long hair, hair past shoulders, gray smear, muddy skin, melted face, double face, ghosting, misaligned features, heart pupils, heart-shaped pupils, extra eyes, third eye, heterochromia, brown iris, red iris, glowing pupils, redrawn pupil highlight, sparkling star eyes'
            last_expr_err: Exception | None = None
            n_fail = 0
            for ek in _EXPR_KEYS:
                if ek in panels and ek in override_keys:
                    _lm = dict(_expr_lock_meta.get(ek) or {})
                    _locked_b = panels[ek]
                    try:
                        _locked_b = squareize_face_center_crop(_locked_b, size=768)
                        _locked_b = _trim_letterbox_bars(_locked_b)
                        try:
                            _locked_b = squareize_face_center_crop(_locked_b, size=768)
                        except CharacterSheetError:
                            pass
                        assert_expr_cell_no_white_border(_locked_b, expr_key=ek)
                        assert_mouth_in_frame(_locked_b)
                        assert_expr_cell_face_height_frac(_locked_b, expr_key=ek, min_face_height_frac=0.55, max_face_height_frac=0.65)
                        panels[ek] = _locked_b
                    except CharacterSheetError as _le:
                        logger.warning('expr %s locked normalize soft-fail (keep raw): %s', ek, _le)
                    _rec = {'expr_key': ek, 'locked': True, 'skipped_inpaint': True, 'skipped_vlm': True, 'approved_by_parent': bool(_lm.get('approved_by_parent')), 'source': _lm.get('source'), 'note': _lm.get('note') or 'panels_override lock', 'md5': hashlib.md5(panels[ek]).hexdigest(), 'normalized_2130': True}
                    try:
                        (reject_dir / f'{ek}_locked_{int(seed or 0)}.json').write_text(json.dumps(_rec, ensure_ascii=False, indent=2), encoding='utf-8')
                        (reject_dir / f'{ek}_locked_{int(seed or 0)}.png').write_bytes(panels[ek])
                    except Exception:
                        pass
                    logger.info('expr %s locked skip inpaint/vlm approved_by_parent=%s source=%s', ek, _rec['approved_by_parent'], _rec.get('source'))
                    continue
                if ek in ('expr_2', 'expr_3'):
                    ei = _EXPR_KEYS.index(ek)
                    try:
                        _ = _build_sheet_qwen_edit_graph('ping', image_name='__probe__.png', seed=0, filename_prefix='ToIV_probe')
                    except Exception as _qe:
                        raise CharacterSheetError(f'{ek} Qwen-Image-Edit-2509 图构造不可用，拒绝回落 inpaint: {_qe}', status_code=503) from _qe
                    _locked_cells = [panels[_k] for _k in ('expr_0', 'expr_1', 'expr_4', 'expr_5') if panels.get(_k) and _k in override_keys]
                    expr_frame = locked_expr_frame(_locked_cells)
                    _eb_cands: list[tuple[str, bytes]] = []
                    for _bk in (ek, 'expr_2', 'expr_3'):
                        if bases.get(_bk) and all((_bk != c[0][6:] for c in _eb_cands)):
                            _eb_cands.append((f'bases_{_bk}', bases[_bk]))
                    if panels.get('portrait'):
                        try:
                            _eb_cands.append(('portrait_face_ref', crop_face_ref(panels['portrait'], size=768)))
                        except Exception:
                            pass
                    edit_base = None
                    _id_ref = None
                    _eb_src = ''
                    _eb_why: list[str] = []
                    for _src, _cand in _eb_cands:
                        try:
                            _ref = crop_expr_head_closeup(_cand, size=768, frame=expr_frame)
                            assert_no_uniform_bottom_band(_ref, expr_key=f'{ek}_edit_base')
                        except CharacterSheetError as _ce:
                            _eb_why.append(f'{_src}: {_ce}')
                            continue
                        edit_base, _id_ref, _eb_src = (_cand, _ref, _src)
                        break
                    if edit_base is None:
                        raise CharacterSheetError(f"{ek} 无可用宽头肩编辑底（禁止灰垫）: {' | '.join(_eb_why) or '无候选'}", status_code=422)
                    try:
                        (reject_dir / f'{ek}_edit_base_{int(seed or 0)}.json').write_text(json.dumps({'src': _eb_src, 'frame': expr_frame, 'route': '0430_wide_base'}, ensure_ascii=False, indent=2), encoding='utf-8')
                    except Exception:
                        pass
                    prompt_x = _EXPR_EDIT_INSTRUCTIONS[ei]
                    if ek == 'expr_2':
                        prompt_x += ' eyes looking down to one side, slightly knit brows, lips closed, mouth closed not open, no O-shaped mouth, same framing head and shoulders, same hair same clothes'
                    else:
                        prompt_x += ' warm gentle smile, lips together, mouth corners clearly upturned, soft warm friendly eyes, soft relaxed brows, visibly tender kind expression, no open mouth no teeth, same framing head and shoulders, same hair same clothes'
                    picked: bytes | None = None
                    pick_err: Exception | None = None
                    _qwaits = 0
                    _qwait_log: list[float] = []
                    attempt = -1
                    while attempt < 5:
                        attempt += 1
                        raw = None
                        cell_b = None
                        try:
                            ref_name = await client.upload_image(edit_base, f'sheet_expr_qedit_base_{character_id[:8]}_{ek}_a{attempt}.png')
                            e_seed = None if seed is None else int(seed) + 2318 + ei * 9973 + attempt * 7919
                            p_try = prompt_x
                            if attempt:
                                p_try = p_try + f' variant{attempt}, stronger expression change, expression must be obvious at a glance'
                            raw = await generate_panel_bytes(pool, p_try, ckpt_name=ckpt, width=768, height=768, seed=e_seed, worker=worker, filename_prefix=f'ToIV_char_sheet_{ek}_qedit_a{attempt}', style=meta.style, client=client, ref_image=ref_name, ref_mode='qwen_edit')
                            try:
                                (reject_dir / f'{ek}_qedit_raw_{int(seed or 0)}_a{attempt}.png').write_bytes(raw)
                            except Exception:
                                pass
                            assert_no_hard_seam_contour(raw, expr_key=ek, size=768, stage='raw')
                            cell_b = crop_expr_head_closeup(raw, size=768, frame=expr_frame)
                            try:
                                (reject_dir / f'{ek}_qedit_headcrop_{int(seed or 0)}_a{attempt}.png').write_bytes(cell_b)
                            except Exception:
                                pass
                            assert_no_hard_seam_contour(cell_b, expr_key=ek, size=768, stage='crop')
                            assert_no_flat_hairline_cut(cell_b, expr_key=ek, min_run_px=40)
                            assert_no_uniform_bottom_band(cell_b, expr_key=ek)
                            assert_expr_cell_no_white_border(cell_b, expr_key=ek)
                            assert_expr_cell_content_coverage(cell_b, expr_key=ek, min_coverage=1.0)
                            if expr_frame:
                                assert_expr_frame_match(cell_b, expr_frame, expr_key=ek)
                            else:
                                assert_expr_cell_face_height_frac(cell_b, expr_key=ek, min_face_height_frac=0.38, max_face_height_frac=0.55)
                            assert_mouth_in_frame(cell_b)
                            _face_id = _id_ref
                            _sim = clip_image_cosine_sim(cell_b, _face_id)
                            if _sim is not None and _sim + 1e-12 < 0.72:
                                raise CharacterSheetError(f'{ek}身份CLIP不足 sim={_sim:.3f}<0.72 (vs approved_portrait face)', status_code=422)
                            try:
                                (reject_dir / f'{ek}_qedit_clip_{int(seed or 0)}_a{attempt}.json').write_text(json.dumps({'sim': _sim, 'min': 0.72, 'ref': 'edit_base_face', 'route': 'qwen_full_headcrop_qa'}, ensure_ascii=False), encoding='utf-8')
                            except Exception:
                                pass
                            _emblem_ref = _id_ref
                            if portrait_has_chest_emblem(cell_b, ref=_emblem_ref, below_face=True):
                                raise CharacterSheetError(f'{ek}头部特写裁剪内相对 edit_base 出现新徽标/字样', status_code=422)
                            assert_iris_hue_match(cell_b, edit_base, expr_key=ek)
                            qa_result = await classify_expression_qa(cell_b, expr_key=ek, worker_url=getattr(client, 'base_url', None) or worker, seed=int(e_seed or 42) + attempt)
                            assert_expression_qa_match(ek, qa_result)
                            _mz = crop_mouth_zoom(cell_b)
                            try:
                                (reject_dir / f'{ek}_mouthzoom_{int(seed or 0)}_a{attempt}.png').write_bytes(_mz)
                            except Exception:
                                pass
                            mz_result = await classify_expression_qa(_mz, expr_key='mouth_zoom', worker_url=getattr(client, 'base_url', None) or worker, seed=int(e_seed or 42) + attempt)
                            try:
                                (reject_dir / f'{ek}_mouthzoom_qa_{int(seed or 0)}_a{attempt}.json').write_text(json.dumps(mz_result, ensure_ascii=False, indent=2), encoding='utf-8')
                            except Exception:
                                pass
                            assert_mouth_zoom_closed(ek, mz_result)
                            qa_result['mouth_zoom'] = {'q1': mz_result.get('q1'), 'q2': mz_result.get('q2'), 'model': mz_result.get('model')}
                            try:
                                (reject_dir / f'{ek}_qa_{int(seed or 0)}_a{attempt}.json').write_text(json.dumps(qa_result, ensure_ascii=False, indent=2), encoding='utf-8')
                                (reject_dir / f'{ek}_qa_cell_{int(seed or 0)}_a{attempt}.png').write_bytes(cell_b)
                                (reject_dir / f'{ek}_qedit_ok_{int(seed or 0)}.png').write_bytes(cell_b)
                                (reject_dir / f'{ek}_qedit_meta_{int(seed or 0)}.json').write_text(json.dumps({'route': 'qwen_image_edit_2509_full_headcrop', 'input': 'approved_portrait', 'attempt': attempt, 'expr_key': ek, 'max_attempts': 6, 'judge': 'specialized_qa', 'paste_back': False, 'seam_gate': True, 'note': '01:50 full Qwen output + head closeup + seam gate; no face paste'}, ensure_ascii=False, indent=2), encoding='utf-8')
                            except Exception:
                                pass
                            try:
                                others = {ok: panels[ok] for ok in _EXPR_KEYS if ok != ek and ok in panels and panels.get(ok)}
                                assert_expression_diversity(cell_b, expr_key=ek, neutral_ref=edit_base, other_exprs=others)
                            except CharacterSheetError as de:
                                if attempt < 5:
                                    raise
                                logger.warning('expr %s diversity soft: %s', ek, de)
                            logger.info('expr %s qwen_edit full_headcrop+qa ok attempt=%s', ek, attempt)
                            picked = cell_b
                            pick_err = None
                            break
                        except CharacterSheetQueueWait as qw:
                            _qwaits += 1
                            _qwait_log.append(qw.queue_wait)
                            logger.warning('expr %s queue_wait attempt=%s n=%s: %s', ek, attempt, _qwaits, qw)
                            try:
                                (reject_dir / f'{ek}_queue_wait_{int(seed or 0)}.json').write_text(json.dumps({'n': _qwaits, 'waits': _qwait_log, 'attempt_not_counted': attempt}, ensure_ascii=False), encoding='utf-8')
                            except Exception:
                                pass
                            if _qwaits > _QUEUE_WAIT_RETRY_MAX:
                                pick_err = CharacterSheetError(f'{ek} 队列持续拥堵 queue_wait×{_qwaits}（非出图失败，未完成）', status_code=503)
                                break
                            attempt -= 1
                            continue
                        except CharacterSheetError as ge:
                            pick_err = ge
                            logger.warning('expr %s qwen_edit fail attempt=%s: %s', ek, attempt, ge)
                            try:
                                if locals().get('raw'):
                                    (reject_dir / f'{ek}_qedit_raw_fail_{int(seed or 0)}_a{attempt}.png').write_bytes(locals()['raw'])
                            except Exception:
                                pass
                            dump_rejected_panel(locals().get('cell_b') or locals().get('raw'), seed=seed, panel=ek, gate=_expr_reject_cause(ge), detail=str(ge), dump_dir=reject_dir)
                        except Exception as ge:
                            pick_err = CharacterSheetError(str(ge), status_code=422)
                            logger.warning('expr %s qwen_edit fail attempt=%s: %s', ek, attempt, ge)
                    if picked is None:
                        n_fail += 1
                        last_expr_err = pick_err
                        panels[ek] = edit_base
                        logger.warning('expr %s qwen_edit all attempts failed → portrait fallback FAIL', ek)
                    else:
                        panels[ek] = picked
                    continue
                base_b = bases[ek]
                try:
                    base_b = squareize_face_center_crop(base_b, size=768)
                except CharacterSheetError:
                    base_im0 = Image.open(BytesIO(base_b)).convert('RGB')
                    side0 = min(base_im0.size)
                    left0 = (base_im0.width - side0) // 2
                    top0 = (base_im0.height - side0) // 2
                    cropped0 = base_im0.crop((left0, top0, left0 + side0, top0 + side0))
                    cropped0 = cropped0.resize((768, 768), Image.Resampling.LANCZOS)
                    buf0 = BytesIO()
                    cropped0.save(buf0, format='PNG')
                    base_b = buf0.getvalue()
                bases[ek] = base_b
                base_im = Image.open(BytesIO(base_b)).convert('RGB')
                side = min(base_im.size)
                hard_mask = build_face_feature_mask_hard(side)
                m_rgb = Image.merge('RGB', (hard_mask, hard_mask, hard_mask))
                mbuf = BytesIO()
                m_rgb.save(mbuf, format='PNG')
                mask_bytes = mbuf.getvalue()
                ei = _EXPR_KEYS.index(ek)
                prompt_x = _EXPR_INPAINT_PROMPTS[ei]
                prompt_x = prompt_x + '。 ' + _EXPR_EDIT_INSTRUCTIONS[ei]
                prompt_x = prompt_x + ', blue-violet iris eyes identical to reference, short chin-length black hair'
                if ek == 'expr_0':
                    prompt_x += ', chin raised looking down at viewer, sharp narrowed eyes, eyebrows lowered, tight closed mouth, no wide eyes, no blank stare, no smile'
                elif ek == 'expr_1':
                    prompt_x += ', expressionless, half-lidded eyes, flat mouth, eyebrows neutral, no frown, no smile'
                elif ek == 'expr_2':
                    prompt_x += ', eyes looking down and to the side, head slightly tilted, relaxed brows, faraway gaze, only edit eyes and brows, keep mouth unchanged, no frown, no furrowed brows'
                elif ek == 'expr_3':
                    prompt_x += ', gentle smile, mouth corners up, soft relaxed brows, eyes softly curved, no neutral face without smile, no frown no pout no furrowed brows'
                elif ek == 'expr_5':
                    prompt_x += ', determined firm closed mouth, focused eyes, eyebrows slightly lowered, no open mouth, no surprised, no raised brows'
                picked: bytes | None = None
                pick_err: Exception | None = None
                for attempt in range(4):
                    try:
                        ref_name = await client.upload_image(base_b, f'sheet_expr_inpaint_base_{character_id[:8]}_{ek}_a{attempt}.png')
                        mask_name = await client.upload_image(mask_bytes, f'sheet_expr_inpaint_mask_{character_id[:8]}_{ek}_a{attempt}.png')
                        e_seed = None if seed is None else int(seed) + 1738 + ei * 9973 + attempt * 7919
                        p_try = prompt_x
                        if attempt:
                            p_try = p_try + f' variant{attempt}, stronger eyebrow eye mouth change, expression must be obvious at a glance'
                        _neg_try = _expr_neg
                        try:
                            _ei_neg = _EXPR_KEYS.index(ek)
                            _neg_try = _neg_try + ', ' + _EXPR_INPAINT_NEGATIVES[_ei_neg]
                        except Exception:
                            pass
                        if ek == 'expr_0':
                            _neg_try = _neg_try + ', heart pupils'
                        raw = await generate_panel_bytes(pool, p_try, ckpt_name=ckpt, width=side, height=side, seed=e_seed, worker=worker, filename_prefix=f'ToIV_char_sheet_{ek}_inpaint_a{attempt}', style=meta.style, client=client, ref_image=ref_name, ref_mode='inpaint', denoise=(0.62 if attempt < 2 else 0.7) if ek == 'expr_3' else 0.58 if attempt < 2 else 0.68, negative_extra=_neg_try, mask_image=mask_name, grow_mask_by=4)
                        mae_raw = expression_mask_exterior_mae(base_b, raw, hard_mask)
                        logger.info('expr %s attempt=%s raw_exterior_mae=%.3f', ek, attempt, mae_raw)
                        if mae_raw > 12.0:
                            raise CharacterSheetError(f'{ek} inpaint 遮罩外漂移过大 mae={mae_raw:.2f}', status_code=422)
                        blended = force_expression_mask_exterior(base_b, raw, hard_mask)
                        mae = assert_expression_inpaint_exterior(base_b, blended, hard_mask, max_mae=0.5, expr_key=ek)
                        smear = assert_expression_no_gray_smear(base_b, blended, hard_mask, expr_key=ek)
                        assert_expression_eyes_mouth_in_mask(blended, hard_mask, expr_key=ek, require_mouth=ek != 'expr_2')
                        assert_expression_identity_gates(blended, portrait_ref=panels.get('portrait'), expr_key=ek, skip_chest_emblem=True, hair_ref=base_b, relative_hair_only=True)
                        cell_b = squareize_face_center_crop(blended, size=768)
                        assert_expr_cell_no_white_border(cell_b, expr_key=ek)
                        assert_expr_cell_face_height_frac(cell_b, expr_key=ek, min_face_height_frac=0.55, max_face_height_frac=0.65)
                        assert_expression_semantic(cell_b, expr_key=ek, neutral_ref=base_b)
                        vlm_result = await classify_expression_vlm(cell_b, worker_url=getattr(client, 'base_url', None) or worker)
                        assert_expression_vlm_match(cell_b, ek, vlm_result)
                        try:
                            (reject_dir / f'{ek}_vlm_{int(seed or 0)}.json').write_text(json.dumps(vlm_result, ensure_ascii=False, indent=2), encoding='utf-8')
                            (reject_dir / f'{ek}_vlm_cell_{int(seed or 0)}.png').write_bytes(cell_b)
                        except Exception:
                            pass
                        try:
                            others = {ok: panels[ok] for ok in _EXPR_KEYS if ok != ek and ok in panels and panels.get(ok)}
                            assert_expression_diversity(cell_b, expr_key=ek, neutral_ref=bases.get(ek), other_exprs=others)
                        except CharacterSheetError as de:
                            if attempt < 3:
                                raise
                            logger.warning('expr %s diversity soft: %s', ek, de)
                        logger.info('expr %s inpaint ok attempt=%s mae=%.3f smear=%s', ek, attempt, mae, {k: round(v, 3) for k, v in smear.items()})
                        try:
                            (reject_dir / f'{ek}_inpaint_ok_{int(seed or 0)}.png').write_bytes(cell_b)
                            (reject_dir / f'{ek}_inpaint_raw_{int(seed or 0)}_a{attempt}.png').write_bytes(raw)
                        except Exception:
                            pass
                        picked = cell_b
                        pick_err = None
                        break
                    except CharacterSheetError as ge:
                        pick_err = ge
                        logger.warning('expr %s inpaint fail attempt=%s: %s', ek, attempt, ge)
                        try:
                            if locals().get('raw'):
                                (reject_dir / f'{ek}_inpaint_raw_fail_{int(seed or 0)}_a{attempt}.png').write_bytes(locals()['raw'])
                            if locals().get('blended'):
                                (reject_dir / f'{ek}_inpaint_blend_fail_{int(seed or 0)}_a{attempt}.png').write_bytes(locals()['blended'])
                        except Exception:
                            pass
                        dump_rejected_panel(locals().get('blended') or locals().get('raw'), seed=seed, panel=ek, gate=_expr_reject_cause(ge), detail=str(ge), dump_dir=reject_dir)
                    except Exception as ge:
                        pick_err = CharacterSheetError(str(ge), status_code=422)
                        logger.warning('expr %s inpaint fail attempt=%s: %s', ek, attempt, ge)
                if picked is None:
                    n_fail += 1
                    last_expr_err = pick_err
                    panels[ek] = bases[ek]
                    logger.warning('expr %s inpaint all attempts failed → base fallback FAIL', ek)
                else:
                    panels[ek] = picked
            if n_fail > 0:
                panels['_expr_grid_fallback'] = b'1'
                try:
                    (reject_dir / f'expr_grid_fallback_{int(seed or 0)}.txt').write_text('FAIL final_review=false do_not_deliver\n' + f'inpaint_fail_n={n_fail} last={last_expr_err}', encoding='utf-8')
                    (reject_dir / f'expr_grid_fallback_flag_{int(seed or 0)}.json').write_text('{"expr_grid_fallback": true, "final_review": false, "deliver": false, "route": "2318_qwen_edit_2509+fill_first"}', encoding='utf-8')
                except Exception:
                    pass
            else:
                logger.info('expr true-inpaint all ok locked=%s', [ek for ek in _EXPR_KEYS if ek in override_keys and ek in panels])
            continue
        last_err = None
        same_cause = None
        same_cause_n = 0
        raw = None
        max_attempts = 6 if key.startswith('expr_') else 4
        for attempt in range(max_attempts):
            try:
                s = None if seed is None else seed + abs(hash(key)) % 10000 + attempt * 7919
                bust = f', unique layout variant {attempt}-{s or 0}'
                if key.startswith('expr_'):
                    bust += ', plain flat chest unbranded no logo no text no emblem, short chin-length black hair no lengthening'
                _neg_x = ''
                if key.startswith('expr_'):
                    _neg_x = 'long hair, hair past shoulders, waist length hair, hair lengthening, flowing long locks, logo, emblem, badge, chest patch, text on clothes, chinese characters'
                _prompt_x = prompts[key] + (bust if attempt else '')
                if key.startswith('expr_') and ref_mode == 'qwen_edit':
                    _ei = _EXPR_KEYS.index(key) if key in _EXPR_KEYS else 0
                    _prompt_x = _EXPR_EDIT_INSTRUCTIONS[_ei]
                    if attempt:
                        _prompt_x = _prompt_x + f' 变体{attempt}。务必加大五官表情幅度，眉眼嘴变化必须非常明显。'
                        if key == 'expr_4':
                            _prompt_x += ' 嘴巴必须明显张开。'
                if key.startswith('expr_') and ref_mode == 'qwen_edit' and (use_ref or key in _expr_bases):
                    _base_face = None
                    try:
                        if panels.get('portrait'):
                            _base_face = crop_face_ref(panels['portrait'], size=768)
                    except Exception:
                        _base_face = None
                    _edit_ref_name = use_ref
                    if key in _expr_bases:
                        try:
                            _edit_ref_name = await client.upload_image(_expr_bases[key], f'sheet_expr_base_{character_id[:8]}_{key}.png')
                            logger.info('%s Qwen use_ref=expr_base_%s (2023b-class)', key, key)
                        except Exception as ue:
                            logger.warning('%s upload expr_base failed: %s; fall back face ref', key, ue)
                    if not _edit_ref_name:
                        raise CharacterSheetError(f'{key} missing Qwen edit ref', status_code=422)
                    cands: list[bytes] = []
                    for ci in range(4):
                        s_i = None if seed is None else int(seed) + abs(hash(key)) % 10000 + attempt * 7919 + ci * 13331
                        _px = _prompt_x
                        if ci:
                            _px = _px + f' 候选{ci + 1}。加大眉眼嘴变化，五官差异必须非常明显。'
                        edited = await generate_panel_bytes(pool, _px, ckpt_name=ckpt, width=w, height=h, seed=s_i, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_a{attempt}_c{ci}', style=meta.style, client=client, ref_image=_edit_ref_name, ref_mode=ref_mode, denoise=denoise, negative_extra=_neg_x)
                        edited = enforce_head_shoulders_square(edited, size=768, face_closeup_gate=True)
                        cands.append(edited)
                    _neutral = _base_face
                    raw = pick_best_expression_candidate(cands, neutral_ref=_neutral, portrait_ref=panels.get('portrait'), expr_key=key, min_clip=0.72)
                else:
                    raw = await generate_panel_bytes(pool, _prompt_x, ckpt_name=ckpt, width=w, height=h, seed=s, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_a{attempt}', style=meta.style, client=client, ref_image=use_ref, ref_mode=ref_mode, denoise=denoise, negative_extra=_neg_x)
                if key.startswith('expr_'):
                    raw = enforce_head_shoulders_square(raw, size=768, face_closeup_gate=True)
                    try:
                        assert_expression_identity_gates(raw, portrait_ref=panels.get('portrait'), expr_key=key)
                    except CharacterSheetError as ge:
                        if _expr_reject_cause(ge) == 'hair':
                            try:
                                im = Image.open(BytesIO(raw)).convert('RGB')
                                w, h = im.size
                                cut = im.crop((0, 0, w, int(h * 0.72)))
                                side = max(cut.width, cut.height, 8)
                                canvas = Image.new('RGB', (side, side), (240, 240, 244))
                                canvas.paste(cut, ((side - cut.width) // 2, 0))
                                canvas = canvas.resize((768, 768), Image.Resampling.LANCZOS)
                                buf = BytesIO()
                                canvas.save(buf, format='PNG')
                                raw2 = buf.getvalue()
                                assert_expression_identity_gates(raw2, portrait_ref=panels.get('portrait'), expr_key=key)
                                raw = raw2
                                logger.info('%s hair recovery via bottom-crop ok', key)
                            except CharacterSheetError:
                                raise ge
                        else:
                            raise
                    _neutral = None
                    try:
                        if panels.get('portrait'):
                            _neutral = crop_face_ref(panels['portrait'], size=768)
                    except Exception:
                        _neutral = None
                    _others = {ek: panels[ek] for ek in _EXPR_KEYS if ek in panels and ek != key and panels.get(ek)}
                    assert_expression_diversity(raw, expr_key=key, neutral_ref=_neutral, other_exprs=_others)
                if key in ('front', 'side') and sheet_uses_anime_gates(meta.style):
                    if portrait_has_chest_emblem(raw):
                        raise CharacterSheetError(f'{key}胸口徽标，重试', status_code=422)
                if key in ('front', 'side', 'back') and meta.style == 'ancient_realistic' and ancient_spec_target_hex(meta):
                    assert_garment_near_spec_color(normalize_turnaround_figure(raw, out_w=w, out_h=h), ancient_spec_target_hex(meta), label=key)
                panels[key] = raw
                last_err = None
                break
            except CharacterSheetError as e:
                last_err = e
                logger.warning('panel %s fail attempt=%s: %s', key, attempt, e)
                if key.startswith('expr_'):
                    dump_rejected_panel(raw, seed=seed, panel=str(key), gate=_expr_reject_cause(e), detail=str(e), dump_dir=reject_dir)
                    cause = _expr_reject_cause(e)
                    if cause == same_cause:
                        same_cause_n += 1
                    else:
                        same_cause = cause
                        same_cause_n = 1
                    if same_cause_n >= 3:
                        raise CharacterSheetError(f'{key}同因连败3次({cause}): {e}；停下修根因', status_code=422) from e
        if last_err is not None:
            raise last_err
        if key in ('front', 'side', 'back'):
            panels[key] = normalize_turnaround_figure(panels[key], out_w=w, out_h=h)
            panel_urls[key] = save_panel_png(panels[key], character_id=character_id, style=meta.style, key=key)
    try:
        assert_sheet_garment_consistency(panels, style=meta.style, skip_keys=override_keys)
    except CharacterSheetError as _ce:
        dump_rejected_panel(panels.get('portrait') or _last_reject.get('data'), seed=seed, panel=str(_last_reject.get('key') or 'portrait'), gate='assert_sheet_garment_consistency', detail=str(_ce), dump_dir=reject_dir)
        raise
    if sheet_uses_anime_gates(meta.style) and (not meta.colors):
        meta.colors = ['#E8C4A8', '#5A6A7A', '#D4D3D8', '#C98A7A', '#2C2C34', '#1A1A1E']
    # 四视图板只出五格(toonflow_board → compose_reference_board)
    png = compose_reference_board(panels, meta) if meta.template == 'toonflow_board' else compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    _SHEET_REJECT_CTX.reset(_reject_token)
    return (url, png, panel_urls)

def _score_expression_head_ratio(data: bytes) -> float:
    """表情格启发式:上半部脸/肤色占比越高越好;鼓励头肩特写(目标≥0.40)。"""
    if _panel_is_blank_or_glitch(data):
        return -1000000000.0
    img = Image.open(BytesIO(data)).convert('RGB')
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = small.size
    face = 0
    total = 0
    for y in range(int(sh * 0.05), int(sh * 0.7)):
        for x in range(int(sw * 0.15), int(sw * 0.85)):
            total += 1
            r, g, b = px[y * sw + x]
            if r > 80 and g > 55 and (b > 45) and (r >= g - 20):
                face += 1
            elif abs(r - g) < 25 and abs(g - b) < 25 and (40 < r < 220):
                face += 0.6
    ratio = face / max(1, total)
    bottom_dark = 0
    bt = 0
    for y in range(int(sh * 0.75), sh):
        for x in range(sw):
            bt += 1
            r, g, b = px[y * sw + x]
            if r < 60 and g < 60 and (b < 70):
                bottom_dark += 1
    dark_ratio = bottom_dark / max(1, bt)
    score = ratio * 100.0
    if ratio < 0.4:
        score -= (0.4 - ratio) * 120.0
    if dark_ratio > 0.35 and ratio < 0.45:
        score -= 25.0
    return score

def _score_turnaround_candidate(data: bytes, key: str) -> float:
    """分数越高越好;side/back 优先非正脸;back 严惩「无脸正面/空白脸椭圆」。"""
    if _panel_is_blank_or_glitch(data):
        return -1000000000.0
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    small = img.resize((48, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = small.size
    left = [px[y * sw + x] for y in range(sh) for x in range(sw // 2)]
    right = [px[y * sw + x] for y in range(sh) for x in range(sw // 2, sw)]

    def _mean(cells):
        n = max(1, len(cells))
        return tuple((sum((c[i] for c in cells)) / n for i in range(3)))
    ml, mr = (_mean(left), _mean(right))
    asym = sum((abs(ml[i] - mr[i]) for i in range(3)))
    face_score = 0.0
    blank_face = 0.0
    hair_dark = 0.0
    head_cells = 0
    for y in range(int(sh * 0.08), int(sh * 0.42)):
        for x in range(int(sw * 0.28), int(sw * 0.72)):
            head_cells += 1
            r, g, b = px[y * sw + x]
            if r > 90 and g > 70 and (b > 60) and (r >= g - 10):
                face_score += 1.0
            if r > 210 and g > 210 and (b > 210) and (abs(r - g) < 18) and (abs(g - b) < 18):
                blank_face += 1.0
            if r + g + b < 140 and max(r, g, b) - min(r, g, b) < 40:
                hair_dark += 1.0
    face_score /= max(1, sw * sh)
    blank_ratio = blank_face / max(1, head_cells)
    hair_ratio = hair_dark / max(1, head_cells)
    score = 100.0 - (face_score * 200.0 if key in ('side', 'back') else 0.0)
    if key in ('side', 'back'):
        score += asym * 0.8
    else:
        score += face_score * 50.0
    if key == 'back':
        score -= blank_ratio * 180.0
        score += hair_ratio * 60.0
        score -= face_score * 120.0
    score += 10.0
    return score

def _score_face_angle_candidate(data: bytes, face_key: str) -> float:
    """面部三格角度启发式:front 奖励对称;3/4 奖励中等不对称;side 奖励强侧影。"""
    if _panel_is_blank_or_glitch(data):
        return -1000000000.0
    img = Image.open(BytesIO(data)).convert('RGB')
    small = img.resize((64, 64), Image.Resampling.BILINEAR)
    px = list(small.getdata())
    sw, sh = (64, 64)
    left = [px[y * sw + x] for y in range(int(sh * 0.15), int(sh * 0.7)) for x in range(8, 32)]
    right = [px[y * sw + x] for y in range(int(sh * 0.15), int(sh * 0.7)) for x in range(32, 56)]

    def _mean(cells: list) -> tuple[float, float, float]:
        n = max(1, len(cells))
        return tuple((sum((c[i] for c in cells)) / n for i in range(3)))
    ml, mr = (_mean(left), _mean(right))
    asym = sum((abs(ml[i] - mr[i]) for i in range(3)))
    center_face = 0.0
    ct = 0
    for y in range(int(sh * 0.2), int(sh * 0.62)):
        for x in range(int(sw * 0.32), int(sw * 0.68)):
            ct += 1
            r, g, b = px[y * sw + x]
            if r > 85 and g > 60 and (b > 50) and (r >= g - 15):
                center_face += 1.0
            elif abs(r - g) < 28 and abs(g - b) < 28 and (45 < r < 220):
                center_face += 0.55
    center_ratio = center_face / max(1, ct)
    mass_x = 0.0
    mass = 0.0
    for y in range(int(sh * 0.18), int(sh * 0.68)):
        for x in range(sw):
            r, g, b = px[y * sw + x]
            if r > 230 and g > 230 and (b > 230):
                continue
            if abs(r - g) < 12 and abs(g - b) < 12 and (160 <= r <= 230):
                continue
            mass_x += x
            mass += 1.0
    cx = mass_x / mass if mass > 10 else 32.0
    offset = abs(cx - 32.0)
    head = _score_expression_head_ratio(data)
    score = head * 0.35
    if face_key == 'face_front':
        score += (1.0 - min(1.0, asym / 40.0)) * 40.0
        score += center_ratio * 50.0
        score -= offset * 1.2
    elif face_key == 'face_three_quarter':
        if 8.0 <= asym <= 45.0:
            score += 35.0
        else:
            score -= abs(asym - 22.0) * 0.8
        if 4.0 <= offset <= 14.0:
            score += 25.0
        else:
            score -= abs(offset - 8.0) * 1.5
        score += center_ratio * 20.0
    else:
        score += min(55.0, asym * 1.4)
        score += min(30.0, offset * 2.2)
        score -= center_ratio * 35.0
        if asym < 10:
            score -= 40.0
        if offset < 3:
            score -= 25.0
        white_blob = 0
        for y in range(int(sh * 0.15), int(sh * 0.7)):
            for x in range(int(sw * 0.2), int(sw * 0.8)):
                r, g, b = px[y * sw + x]
                if r > 230 and g > 230 and (b > 230):
                    white_blob += 1
        if white_blob > 180:
            score -= 50.0
        if white_blob > 280:
            score -= 40.0
    return score

def _pick_best_candidate(cands: list[bytes], key: str) -> bytes:
    if not cands:
        raise CharacterSheetError(f'无候选:{key}', status_code=500)
    if key in ('front', 'side', 'back'):
        ranked = sorted(cands, key=lambda b: _score_turnaround_candidate(b, key), reverse=True)
        return ranked[0]
    if key.startswith('face_'):
        ranked = sorted(cands, key=lambda b: _score_face_angle_candidate(b, key), reverse=True)
        return ranked[0]
    if key.startswith('expr_'):
        ranked = sorted(cands, key=lambda b: _score_expression_head_ratio(b), reverse=True)
        return ranked[0]
    item_key = key.split('costume_', 1)[-1] if key.startswith('costume_') else ''
    ranked = sorted(cands, key=lambda b: (0 if _panel_is_blank_or_glitch(b) else 1, -(_costume_item_penalty(b, item_key) if item_key else 0.0)), reverse=True)
    if item_key in ('pants', 'boots') and ranked:
        ok = []
        for b in ranked:
            img = Image.open(BytesIO(b)).convert('RGB').resize((64, 64))
            blobs = _count_dark_blobs(list(img.getdata()))
            if blobs <= (2 if item_key == 'boots' else 3):
                ok.append(b)
        if ok:
            return ok[0]
    return ranked[0]

def _middle_gray_stripe_x_bounds(img: Image.Image, *, y0_frac: float=0.3, y1_frac: float=0.7) -> tuple[float, float]:
    """立绘「浅边 + 中间人物条」：按行取深色/服装列（跳过近白与浅灰底），汇总左右界。"""
    w, h = img.size
    if w < 8 or h < 8:
        return (0.0, 1.0)
    y0, y1 = (int(h * y0_frac), int(h * y1_frac))
    y0, y1 = (max(0, y0), min(h, max(y0 + 1, y1)))
    lefts: list[int] = []
    rights: list[int] = []
    px = img.load()

    def _is_bg(r, g, b) -> bool:
        if r > 230 and g > 230 and (b > 230):
            return True
        if abs(r - g) < 14 and abs(g - b) < 14 and (r >= 185):
            return True
        return False
    for y in range(y0, y1, max(1, (y1 - y0) // 24)):
        xs = []
        for x in range(w):
            r, g, b = px[x, y][:3]
            if _is_bg(r, g, b):
                continue
            xs.append(x)
        if len(xs) < max(4, w // 20):
            continue
        lefts.append(xs[0])
        rights.append(xs[-1])
    if not lefts:
        return (0.2, 0.8)
    x0 = float(sorted(lefts)[len(lefts) // 4]) / float(w)
    x1 = float(sorted(rights)[3 * len(rights) // 4]) / float(w)
    if x1 <= x0 + 0.08:
        return (0.2, 0.8)
    return (max(0.0, x0), min(1.0, x1))

def _collar_box(img: Image.Image) -> tuple[float, float, float, float]:
    """17:38：领口——下巴到锁骨含帽口；禁止裁到肩部素布。

    优先 insightface/级联脸框下巴；全身误检或无人脸时，用上半身中心亮肤/头肩几何估下巴。
    """
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    mid = (gx0 + gx1) / 2.0
    span = max(0.12, gx1 - gx0)
    chin_y: float | None = None
    face_x0 = mid - span * 0.2
    face_x1 = mid + span * 0.2
    try:
        buf = BytesIO()
        img.save(buf, format='PNG')
        bb = _detect_face_bbox_xyxy(buf.getvalue())
        if bb is not None:
            fy1, fy2 = (float(bb[1]) / float(h), float(bb[3]) / float(h))
            fh = max(0.02, fy2 - fy1)
            if fh <= 0.35:
                chin_y = fy2
                face_x0 = float(bb[0]) / float(w)
                face_x1 = float(bb[2]) / float(w)
    except Exception:
        pass
    if chin_y is None:
        try:
            import numpy as np
            arr = np.asarray(img.convert('RGB'))
            y1 = max(8, int(h * 0.02))
            y2 = max(y1 + 8, int(h * 0.38))
            x1 = max(0, int(w * max(0.25, gx0 + span * 0.15)))
            x2 = min(w, int(w * min(0.75, gx1 - span * 0.15)))
            roi = arr[y1:y2, x1:x2]
            r = roi[:, :, 0].astype('int16')
            g = roi[:, :, 1].astype('int16')
            b = roi[:, :, 2].astype('int16')
            warm = (r > 150) & (g > 120) & (b > 100) & (r - b > 6)
            row_frac = warm.mean(axis=1) if warm.size else None
            if row_frac is not None and len(row_frac):
                hits = [i for i, v in enumerate(row_frac) if float(v) >= 0.04]
                if hits:
                    chin_y = (y1 + hits[-1]) / float(h)
                    col_frac = warm.mean(axis=0)
                    cols = [i for i, v in enumerate(col_frac) if float(v) >= 0.04]
                    if cols:
                        face_x0 = (x1 + cols[0]) / float(w)
                        face_x1 = (x1 + cols[-1]) / float(w)
        except Exception:
            chin_y = None
    if chin_y is None:
        side = min(int(w * 0.72), int(h * 0.38), w, h)
        top = max(0, int(h * 0.01))
        chin_y = (top + side * 0.72) / float(h)
    y0 = max(0.05, float(chin_y) - 0.025)
    y1 = min(0.4, float(chin_y) + max(0.09, 0.11))
    if y1 <= y0 + 0.06:
        y1 = min(0.42, y0 + 0.1)
    cx = (float(face_x0) + float(face_x1)) / 2.0
    half = max(0.14, (float(face_x1) - float(face_x0)) * 0.9, span * 0.26)
    x0 = max(gx0 + span * 0.04, cx - half)
    x1 = min(gx1 - span * 0.04, cx + half)
    if x1 <= x0 + 0.08:
        x0 = max(gx0, mid - 0.16)
        x1 = min(gx1, mid + 0.16)
    return (float(x0), float(y0), float(x1), float(y1))

def _hem_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:18：下摆——衣摆水平缝线带，钳人物灰条。"""
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    span = max(0.12, gx1 - gx0)
    mid = (gx0 + gx1) / 2.0
    half = max(0.14, span * 0.36)
    x0 = max(gx0 + span * 0.05, mid - half)
    x1 = min(gx1 - span * 0.05, mid + half)
    best = (x0, 0.64, x1, 0.78)
    best_ed = -1.0
    for y0 in (0.58, 0.6, 0.62, 0.64, 0.66, 0.68):
        y1 = min(0.84, y0 + 0.14)
        xa, ya = (int(w * x0), int(h * y0))
        xb, yb = (int(w * x1), int(h * y1))
        if xb - xa < 12 or yb - ya < 12:
            continue
        crop = img.crop((xa, ya, xb, yb))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
        if r < 0.25:
            continue
        ed = costume_cell_edge_density(crop)
        if ed > best_ed:
            best_ed = ed
            best = (x0, y0, x1, y1)
    return best

def _wrist_cuff_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:53 / 15:52：袖口+手——回到 1552 裁框；水平强制钳进中间灰条人物区，禁止浅色外框。

    在人物躯干左右侧找含袖缘/肤色的框；浅边占比高则丢弃；cover 前目标非背景≥0.25。
    """
    w, h = img.size
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    span = max(0.1, gx1 - gx0)
    gx0 = min(0.48, gx0 + span * 0.04)
    gx1 = max(gx0 + 0.12, gx1 - span * 0.04)
    span = max(0.1, gx1 - gx0)
    mid = (gx0 + gx1) / 2.0
    candidates = [(gx0 + span * 0.16, 0.48), (gx1 - span * 0.16, 0.48), (gx0 + span * 0.22, 0.52), (gx1 - span * 0.22, 0.52), (gx0 + span * 0.28, 0.46), (gx1 - span * 0.28, 0.46), (gx0 + span * 0.12, 0.5), (gx1 - span * 0.12, 0.5), (gx0 + span * 0.2, 0.54), (gx1 - span * 0.2, 0.54)]
    best_box = None
    best_score = -1.0
    half_w, half_h = (0.11, 0.085)
    px = img.load()

    def _skin_frac(crop: Image.Image) -> float:
        pts = list(crop.convert('RGB').getdata())
        if not pts:
            return 0.0
        n = 0
        for r, g, b in pts:
            if r > 200 and g > 160 and (b > 130) and (r >= g >= b - 20):
                n += 1
            elif 150 < r < 240 and 110 < g < 200 and (90 < b < 180) and (r > b + 15):
                n += 1
        return n / float(len(pts))

    def _clamp_box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        x0 = max(gx0, min(x0, gx1 - 0.06))
        x1 = min(gx1, max(x1, gx0 + 0.06))
        if x1 <= x0 + 0.06:
            if (x0 + x1) / 2.0 < mid:
                x0, x1 = (gx0, min(gx1, gx0 + max(0.18, half_w * 2)))
            else:
                x1, x0 = (gx1, max(gx0, gx1 - max(0.18, half_w * 2)))
        y0 = max(0.36, min(y0, 0.62))
        y1 = min(0.66, max(y1, y0 + 0.08))
        return (x0, y0, x1, y1)
    for cx, cy in candidates:
        for scale in (1.0, 1.15, 1.35, 1.55):
            hw, hh = (half_w * scale, half_h * scale)
            x0, y0, x1, y1 = _clamp_box(cx - hw, cy - hh, cx + hw, cy + hh * 1.1)
            if x0 < gx0 - 1e-06 or x1 > gx1 + 1e-06:
                continue
            if x1 <= x0 + 0.05 or y1 <= y0 + 0.05:
                continue
            xa, ya = (int(w * x0), int(h * y0))
            xb, yb = (int(w * x1), int(h * y1))
            if xb - xa < 8 or yb - ya < 8:
                continue
            crop = img.crop((xa, ya, xb, yb))
            r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=True)
            edge = _light_edge_frac(crop, edge=max(4, (xb - xa) // 12))
            skin = _skin_frac(crop)
            if edge > 0.35 and r < 0.35:
                continue
            if r < 0.12 and skin < 0.01:
                continue
            center_pen = 0.22 * (1.0 - abs(cx - mid) / max(0.05, span / 2.0))
            score = r + 1.5 * skin - 0.75 * edge - max(0.0, center_pen)
            if score > best_score:
                best_score = score
                best_box = (x0, y0, x1, y1)
            if r + 1e-12 >= 0.55 and edge < 0.28 and (skin > 0.015 or abs(cx - mid) > span * 0.18):
                return best_box
    if best_box is None:
        best_box = (gx0 + span * 0.05, 0.44, gx0 + span * 0.4, 0.6)
    x0, y0, x1, y1 = best_box
    x0, y0, x1, y1 = _clamp_box(x0, y0, x1, y1)
    if x1 - x0 < 0.16:
        cx = (x0 + x1) / 2.0
        x0 = max(gx0, cx - 0.09)
        x1 = min(gx1, cx + 0.09)
        if x1 - x0 < 0.16:
            if cx < mid:
                x0, x1 = (gx0, min(gx1, gx0 + 0.22))
            else:
                x1, x0 = (gx1, max(gx0, gx1 - 0.22))
    return (x0, y0, x1, y1)

def _legs_box(img: Image.Image) -> tuple[float, float, float, float]:
    """01:16：腿脚贴底、水平居中人物条；禁扩到浅色外框。"""
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    span = max(0.1, gx1 - gx0)
    gx0 = gx0 + span * 0.08
    gx1 = gx1 - span * 0.08
    mid = (gx0 + gx1) / 2.0
    half = max(0.1, min(0.16, (gx1 - gx0) * 0.28))
    x0 = max(gx0, mid - half)
    x1 = min(gx1, mid + half)
    y0, y1 = (0.82, 0.995)
    w, h = img.size
    xa, ya = (int(w * x0), int(h * y0))
    xb, yb = (int(w * x1), int(h * y1))
    crop = img.crop((xa, ya, xb, max(ya + 8, yb)))
    r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
    if r < 0.18:
        y0 = 0.76
    return (x0, y0, x1, y1)

def _boots_box(img: Image.Image) -> tuple[float, float, float, float]:
    """16:18：靴子格——脚踝到鞋底贴底；水平收紧脚部，优先含靴形前景。"""
    base = _legs_box(img)
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in base]
    y1 = 0.995
    y0 = max(0.74, min(y0, 0.78))
    best = (x0, y0, x1, y1)
    best_r = -1.0
    mid = (x0 + x1) / 2.0
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    for half in (0.1, 0.12, 0.14, 0.16):
        xa = max(gx0, mid - half)
        xb = min(gx1, mid + half)
        if xb <= xa + 0.06:
            continue
        crop = img.crop((int(w * xa), int(h * y0), int(w * xb), int(h * y1)))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=False)
        ed = costume_cell_edge_density(crop)
        score = r + 0.5 * ed
        if score > best_r:
            best_r = score
            best = (xa, y0, xb, y1)
    return best

def _highest_edge_square(img: Image.Image, box: tuple[float, float, float, float], *, treat_mid_gray_bg: bool=False, min_fg: float=0.35) -> Image.Image | None:
    """在归一化框内滑动方窗，取边缘密度最高且前景够用的窗口（抑纯色布）。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    xa, ya = (int(w * x0), int(h * y0))
    xb, yb = (int(w * x1), int(h * y1))
    xa, xb = (max(0, min(xa, xb)), min(w, max(xa, xb)))
    ya, yb = (max(0, min(ya, yb)), min(h, max(ya, yb)))
    bw, bh = (xb - xa, yb - ya)
    if bw < 16 or bh < 16:
        return None
    side0 = min(bw, bh)
    best = None
    best_ed = -1.0
    for scale in (1.0, 0.85, 0.7, 0.55):
        side = max(16, int(side0 * scale))
        if side > bw or side > bh:
            continue
        step = max(4, side // 6)
        for yy in range(ya, yb - side + 1, step):
            for xx in range(xa, xb - side + 1, step):
                crop = img.crop((xx, yy, xx + side, yy + side))
                r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
                if r + 1e-12 < float(min_fg):
                    continue
                ed = costume_cell_edge_density(crop)
                if ed > best_ed:
                    best_ed = ed
                    best = crop
    return best

def assert_costume_cells_edge_density(costume_png: bytes, *, min_density: float | None=None, n: int=4) -> list[float]:
    """服饰格边缘密度门禁：纯色布料拒收（只量格内中心，避开拼板留白边）。"""
    md = float(_COSTUME_MIN_EDGE_DENSITY if min_density is None else min_density)
    im = Image.open(BytesIO(costume_png)).convert('RGB')
    w, h = im.size
    cell_w = max(1, w // max(1, n))
    dens: list[float] = []
    bad: list[int] = []
    for i in range(n):
        x0 = i * cell_w
        x1 = w if i == n - 1 else (i + 1) * cell_w
        cell = im.crop((x0, 0, x1, h))
        cw, ch = cell.size
        ix0, iy0 = (int(cw * 0.12), int(ch * 0.12))
        ix1, iy1 = (max(ix0 + 8, int(cw * 0.88)), max(iy0 + 8, int(ch * 0.88)))
        inner = cell.crop((ix0, iy0, ix1, iy1))
        d = costume_cell_edge_density(inner)
        dens.append(d)
        if d + 1e-12 < md:
            bad.append(i)
    if bad:
        raise CharacterSheetError(f'costume cells solid-fabric (low edge density): idx={bad} density={[round(x, 4) for x in dens]} min={md}', status_code=422)
    return dens

def _costume_cell_fg_ratio(cell: Image.Image, *, treat_mid_gray_bg: bool=False) -> float:
    """单格非背景像素占比（近白/浅灰底不计；板岩雨衣~90 仍算前景）。

    treat_mid_gray_bg：额外把更深一档的中灰底也当背景（仍保护 <120 的雨衣）。
    """
    px = list(cell.convert('RGB').getdata())
    if not px:
        return 0.0
    fg = 0
    for r, g, b in px:
        if r > 230 and g > 230 and (b > 230):
            continue
        if abs(r - g) < 14 and abs(g - b) < 14 and (r >= 185):
            continue
        if abs(r - g) < 8 and abs(g - b) < 8 and (140 < r < 210):
            continue
        if treat_mid_gray_bg and abs(r - g) < 12 and (abs(g - b) < 12) and (120 <= r < 185):
            continue
        fg += 1
    return fg / float(len(px))

def _light_edge_frac(cell: Image.Image, edge: int=12) -> float:
    """左右边缘浅色（近白/浅灰）占比，袖口浅边检测用。"""
    w, h = cell.size
    if w < edge * 2 + 2 or h < 4:
        return 1.0
    px = cell.convert('RGB').load()
    n = 0
    light = 0
    for y in range(h):
        for x in list(range(edge)) + list(range(w - edge, w)):
            r, g, b = px[x, y]
            n += 1
            if r > 220 and g > 220 and (b > 220):
                light += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and (r > 180):
                light += 1
    return light / float(max(1, n))

def _cover_square_no_light_edge(crop: Image.Image, *, size: int=768) -> Image.Image:
    """内容 cover 铺满方格；先去浅边再放大，缝隙用服饰边缘色填（禁浅灰垫边）。"""
    im = crop.convert('RGB')
    w, h = im.size
    px = im.load()

    def _row_light(y: int) -> bool:
        lit = 0
        for x in range(0, w, max(1, w // 48)):
            r, g, b = px[x, y]
            if r > 220 and g > 220 and (b > 220):
                lit += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and (r > 185):
                lit += 1
        return lit >= max(2, w // max(1, w // 48) // 2)

    def _col_light(x: int) -> bool:
        lit = 0
        for y in range(0, h, max(1, h // 48)):
            r, g, b = px[x, y]
            if r > 220 and g > 220 and (b > 220):
                lit += 1
            elif abs(r - g) < 12 and abs(g - b) < 12 and (r > 185):
                lit += 1
        return lit >= max(2, h // max(1, h // 48) // 2)
    x0, y0, x1, y1 = (0, 0, w, h)
    while x0 < x1 - 8 and _col_light(x0):
        x0 += 1
    while x1 > x0 + 8 and _col_light(x1 - 1):
        x1 -= 1
    while y0 < y1 - 8 and _row_light(y0):
        y0 += 1
    while y1 > y0 + 8 and _row_light(y1 - 1):
        y1 -= 1
    im = im.crop((x0, y0, x1, y1))
    scale = max(size / im.width, size / im.height)
    nw, nh = (max(1, int(im.width * scale)), max(1, int(im.height * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - size) // 2)
    top = max(0, (nh - size) // 2)
    im = im.crop((left, top, left + size, top + size))
    if im.size != (size, size):
        fill = _sample_garment_fill_color(crop)
        canvas = Image.new('RGB', (size, size), fill)
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
        im = canvas
    return im

def _sample_garment_fill_color(im: Image.Image) -> tuple[int, int, int]:
    px = list(im.convert('RGB').getdata())
    pts = [(r, g, b) for r, g, b in px if not (r > 220 and g > 220 and (b > 220)) and (not (abs(r - g) < 12 and abs(g - b) < 12 and (r > 180)))]
    if not pts:
        return (90, 106, 122)
    pts.sort(key=lambda t: t[0] + t[1] + t[2])
    return pts[len(pts) // 2]

def _tighten_crop_to_fg(crop: Image.Image, *, treat_mid_gray_bg: bool=False, pad_frac: float=0.06) -> Image.Image:
    """在裁框内按前景包围盒收紧，提高非背景占比（腿脚/下摆细长件）。"""
    w, h = crop.size
    if w < 8 or h < 8:
        return crop
    px = crop.load()

    def _fg(r, g, b) -> bool:
        if r > 230 and g > 230 and (b > 230):
            return False
        if abs(r - g) < 14 and abs(g - b) < 14 and (r >= 185):
            return False
        if abs(r - g) < 8 and abs(g - b) < 8 and (140 < r < 210):
            return False
        if treat_mid_gray_bg and abs(r - g) < 12 and (abs(g - b) < 12) and (120 <= r < 185):
            return False
        return True
    min_x, min_y, max_x, max_y = (w, h, -1, -1)
    for y in range(h):
        for x in range(w):
            if _fg(*px[x, y][:3]):
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x < min_x or max_y < min_y:
        return crop
    pw = int((max_x - min_x + 1) * pad_frac) + 2
    ph = int((max_y - min_y + 1) * pad_frac) + 2
    min_x = max(0, min_x - pw)
    min_y = max(0, min_y - ph)
    max_x = min(w - 1, max_x + pw)
    max_y = min(h - 1, max_y + ph)
    return crop.crop((min_x, min_y, max_x + 1, max_y + 1))

def _densest_fg_square(img: Image.Image, box: tuple[float, float, float, float], *, treat_mid_gray_bg: bool=False, min_fg: float=0.6) -> Image.Image | None:
    """在归一化框内滑动方窗，取前景占比最高且 ≥min_fg 的窗口。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    xa, ya = (int(w * x0), int(h * y0))
    xb, yb = (int(w * x1), int(h * y1))
    xa, xb = (max(0, min(xa, xb)), min(w, max(xa, xb)))
    ya, yb = (max(0, min(ya, yb)), min(h, max(ya, yb)))
    bw, bh = (xb - xa, yb - ya)
    if bw < 16 or bh < 16:
        return None
    side0 = min(bw, bh)
    best = None
    best_r = -1.0
    for scale in (1.0, 0.85, 0.7, 0.55):
        side = max(16, int(side0 * scale))
        if side > bw or side > bh:
            continue
        step = max(4, side // 6)
        for yy in range(ya, yb - side + 1, step):
            for xx in range(xa, xb - side + 1, step):
                crop = img.crop((xx, yy, xx + side, yy + side))
                r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
                if r > best_r:
                    best_r = r
                    best = crop
                if r + 1e-12 >= min_fg:
                    return crop
    if best is not None and best_r + 1e-12 >= min_fg * 0.85:
        return best
    return best if best_r >= 0.45 else None

def _crop_costume_band_filled(img: Image.Image, box: tuple[float, float, float, float], *, size: int=768, min_fg: float=0.6, treat_mid_gray_bg: bool=False) -> bytes:
    """按归一化框裁切；前景 < min_fg 时自动扩/平移裁框直到达标或触边。"""
    w, h = img.size
    x0, y0, x1, y1 = [float(v) for v in box]
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    x0 = max(x0, gx0)
    x1 = min(x1, gx1)
    if x1 <= x0 + 0.04:
        x0, x1 = (gx0, gx1)
    best = None
    best_r = -1.0
    for step in range(8):
        xa, ya = (int(w * x0), int(h * y0))
        xb, yb = (int(w * x1), int(h * y1))
        xa, xb = (max(0, min(xa, xb)), min(w, max(xa, xb)))
        ya, yb = (max(0, min(ya, yb)), min(h, max(ya, yb)))
        if xb - xa < 8 or yb - ya < 8:
            break
        crop = img.crop((xa, ya, xb, yb))
        r = _costume_cell_fg_ratio(crop, treat_mid_gray_bg=treat_mid_gray_bg)
        if r > best_r:
            best_r = r
            best = crop
        if r + 1e-12 >= min_fg:
            break
        pad = 0.06
        x0 = max(0.0, x0 - pad)
        y0 = max(0.0, y0 - pad * 0.5)
        x1 = min(1.0, x1 + pad)
        y1 = min(1.0, y1 + pad)
        if step >= 3:
            cx = (x0 + x1) / 2.0
            cy = (y0 + y1) / 2.0
            dx = (0.5 - cx) * 0.08
            dy = (0.55 - cy) * 0.08
            x0, x1 = (x0 + dx, x1 + dx)
            y0, y1 = (y0 + dy, y1 + dy)
            x0, x1 = (max(0.0, x0), min(1.0, x1))
            y0, y1 = (max(0.0, y0), min(1.0, y1))
    if best is None:
        raise CharacterSheetError('costume band crop empty', status_code=422)
    if best_r + 1e-12 < float(min_fg):
        tight = _tighten_crop_to_fg(best, treat_mid_gray_bg=treat_mid_gray_bg)
        tr = _costume_cell_fg_ratio(tight, treat_mid_gray_bg=treat_mid_gray_bg)
        if tr > best_r:
            best, best_r = (tight, tr)
            logger.info('costume band tighten fg→%.3f', best_r)
    if best_r + 1e-12 < float(min_fg):
        dense = _densest_fg_square(img, (x0, y0, x1, y1), treat_mid_gray_bg=treat_mid_gray_bg, min_fg=min_fg)
        if dense is not None:
            dr = _costume_cell_fg_ratio(dense, treat_mid_gray_bg=treat_mid_gray_bg)
            if dr > best_r:
                best, best_r = (dense, dr)
                logger.info('costume band densest fg→%.3f', best_r)
    if best_r + 1e-12 < float(min_fg) - 0.02:
        raise CharacterSheetError(f'costume band fg {best_r:.3f} < {min_fg:.2f} after auto-adjust', status_code=422)
    crop = best
    covered = _cover_square_no_light_edge(crop, size=size)
    post = _costume_cell_fg_ratio(covered, treat_mid_gray_bg=treat_mid_gray_bg)
    if post + 1e-12 < max(0.35, float(min_fg) * 0.55):
        fill = _sample_garment_fill_color(crop)
        scale = max(size / max(1, crop.width), size / max(1, crop.height))
        nw, nh = (max(1, int(crop.width * scale)), max(1, int(crop.height * scale)))
        im2 = crop.resize((nw, nh), Image.Resampling.LANCZOS)
        canvas = Image.new('RGB', (size, size), fill)
        canvas.paste(im2, ((size - nw) // 2, (size - nh) // 2))
        left = max(0, (nw - size) // 2) if nw > size else 0
        top = max(0, (nh - size) // 2) if nh > size else 0
        if nw > size or nh > size:
            covered = im2.crop((left, top, left + size, top + size))
            if covered.size != (size, size):
                c2 = Image.new('RGB', (size, size), fill)
                c2.paste(covered, ((size - covered.width) // 2, (size - covered.height) // 2))
                covered = c2
        else:
            covered = canvas
        post = _costume_cell_fg_ratio(covered, treat_mid_gray_bg=False)
        logger.info('costume cover fallback fill post_fg=%.3f (light-edge wipe avoided)', post)
    crop = covered
    buf = BytesIO()
    crop.save(buf, format='PNG')
    return buf.getvalue()

def build_costume_collage_from_portrait(portrait: bytes, *, style: str='anime', size: int=768, min_fg: float=0.6, min_edge_density: float | None=None) -> bytes:
    """15:52 / 16:18：从主立绘裁 4 格（领口/袖口/下摆/靴子）；ROI 对齐真部位；边缘密度拒纯色。"""
    if not portrait:
        raise CharacterSheetError('costume portrait crops: empty portrait', status_code=422)
    img = Image.open(BytesIO(portrait)).convert('RGB')
    items: list[bytes] = []
    gx0, gx1 = _middle_gray_stripe_x_bounds(img)
    md = float(_COSTUME_MIN_EDGE_DENSITY if min_edge_density is None else min_edge_density)
    for key, box in _COSTUME_PORTRAIT_BANDS:
        if key == 'collar':
            use_box = _collar_box(img)
        elif key == 'cuff':
            use_box = _wrist_cuff_box(img)
        elif key == 'hem':
            use_box = _hem_box(img)
        elif key in ('boots', 'legs'):
            use_box = _boots_box(img)
        else:
            x0, y0, x1, y1 = [float(v) for v in box]
            x0 = max(x0, gx0)
            x1 = min(x1, gx1)
            if x1 <= x0 + 0.06:
                mid = (gx0 + gx1) / 2.0
                half = max(0.1, (gx1 - gx0) * 0.22)
                x0, x1 = (max(gx0, mid - half), min(gx1, mid + half))
            use_box = (x0, y0, x1, y1)
        treat_bg = key == 'cuff'
        if key in ('boots', 'legs'):
            band_min = 0.45
        elif key in ('collar', 'cuff', 'hem'):
            band_min = min(float(min_fg), 0.55)
        else:
            band_min = min_fg
        cell = _crop_costume_band_filled(img, use_box, size=size, min_fg=band_min, treat_mid_gray_bg=treat_bg)
        r = _costume_cell_fg_ratio(Image.open(BytesIO(cell)).convert('RGB'), treat_mid_gray_bg=treat_bg)
        ed = costume_cell_edge_density(cell)
        if key != 'collar':
            edge_win = _highest_edge_square(img, use_box, treat_mid_gray_bg=treat_bg, min_fg=max(0.3, band_min * 0.7))
            if edge_win is not None:
                buf2 = BytesIO()
                covered2 = _cover_square_no_light_edge(edge_win, size=size)
                covered2.save(buf2, format='PNG')
                alt = buf2.getvalue()
                ed2 = costume_cell_edge_density(alt)
                if ed2 > ed + 1e-06:
                    cell, ed = (alt, ed2)
                    r = _costume_cell_fg_ratio(Image.open(BytesIO(cell)).convert('RGB'), treat_mid_gray_bg=treat_bg)
        if ed + 1e-12 < md and key == 'cuff':
            gx0b, gx1b = (gx0, gx1)
            spanb = max(0.1, gx1b - gx0b)
            midb = (gx0b + gx1b) / 2.0
            cx_cur = (use_box[0] + use_box[2]) / 2.0
            if cx_cur < midb:
                alt_box = (gx1b - spanb * 0.34, 0.42, gx1b - spanb * 0.02, 0.58)
            else:
                alt_box = (gx0b + spanb * 0.02, 0.42, gx0b + spanb * 0.34, 0.58)
            alt_cell = _crop_costume_band_filled(img, alt_box, size=size, min_fg=band_min, treat_mid_gray_bg=True)
            ed_alt = costume_cell_edge_density(alt_cell)
            edge_win2 = _highest_edge_square(img, alt_box, treat_mid_gray_bg=True, min_fg=max(0.3, band_min * 0.7))
            if edge_win2 is not None:
                buf3 = BytesIO()
                _cover_square_no_light_edge(edge_win2, size=size).save(buf3, format='PNG')
                alt2 = buf3.getvalue()
                ed2 = costume_cell_edge_density(alt2)
                if ed2 > ed_alt:
                    alt_cell, ed_alt = (alt2, ed2)
            if ed_alt > ed:
                cell, ed = (alt_cell, ed_alt)
                use_box = alt_box
                logger.info('costume cuff alt-side edge=%.4f', ed)
        if ed + 1e-12 < md:
            raise CharacterSheetError(f'costume {key} solid-fabric edge_density={ed:.4f} < {md}', status_code=422)
        items.append(cell)
        logger.info('costume portrait crop %s box=%s post_lb_fg≈%.3f edge=%.4f', key, use_box, r, ed)
    out = collage_costume_items(items, style=style)
    assert_costume_cells_nonempty(out, min_ratio=0.12, n=_COSTUME_PORTRAIT_N)
    assert_costume_cells_edge_density(out, min_density=md, n=_COSTUME_PORTRAIT_N)
    return out

async def _generate_costume_collage(pool: 'WorkerPool', *, meta: SheetMeta, ckpt: str, worker: str | None, client: Any, seed: int | None, n_candidates: int=1) -> bytes:
    """五件单品各出图再 collage;古风用汉服单品,现代用雨衣套装。"""
    del n_candidates
    suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX['anime'])
    item_bytes: list[bytes] = []
    items = ancient_costume_items(meta) if meta.style == 'ancient_realistic' else _COSTUME_ITEMS
    for idx, (item_key, item_prompt) in enumerate(items):
        prompt = f'{item_prompt}, {suf}'
        if item_key == 'boots':
            prompt = 'exactly two black rain boots only, one left boot and one right boot, a single isolated pair centered large in frame with empty white space around, NOT three, NOT four, NOT five, NOT a row, NOT a shelf, NOT repeated, product still life, no person, ' + prompt + ', footwear product photography, only two boots'
        elif item_key == 'pants':
            prompt = 'single pair of long black trousers laid flat centered, full length to ankles, one item only filling the frame, plain white background only, NOT shorts, NOT multiple, NOT repeated, NOT a row of pants, NOT empty panels, NOT UI mockup, NOT wireframe boxes, NOT empty slots, product shot, no person, no mannequin, ' + prompt + ', clothing flat lay only'
        elif item_key == 'umbrella':
            prompt = 'single open clear transparent plastic rain umbrella only, visible metal ribs and black handle shaft, product still life on white background, NOT a lamp, NOT a hat, NOT a dome light, NOT opaque, ' + prompt + ', umbrella product photography only'
        elif item_key == 'raincoat':
            prompt = 'flat lay complete slate-gray hooded raincoat #5A6A7A only, plain unbranded no logo, hood and sleeves visible, mid-tone gray not jet black, product shot, no person, no mannequin, garment fills frame, ' + prompt + ', clothing only, not empty white frame'
        n_try = 4 if meta.style == 'ancient_realistic' else 1
        use_ckpt, use_style = (ckpt, meta.style)
        w, h = (768, 768) if sheet_uses_anime_xl(meta.style) else (512, 512)
        if meta.style == 'ancient_realistic':
            use_ckpt = 'animagineXL40.safetensors'
            use_style = 'anime'
            w, h = (768, 768)
            prompt = prompt + ', anime product illustration, flat lay, no person, no face'
        cands: list[bytes] = []
        for ci in range(n_try):
            cands.append(await generate_panel_bytes(pool, prompt, ckpt_name=use_ckpt, width=w, height=h, seed=None if seed is None else seed + 7000 + idx * 17 + ci * 41, worker=worker, filename_prefix=f'ToIV_char_sheet_costume_{item_key}', style=use_style, client=client, ref_image=None, ref_mode='none', denoise=1.0))
        data = _pick_best_candidate(cands, f'costume_{item_key}')
        item_bytes.append(data)
    return collage_costume_items(item_bytes, style=meta.style)

def openpose_asset_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / 'assets' / 'openpose'

def render_openpose_skeleton(view: str, *, width: int=768, height: int=1152, height_cm: int=165) -> bytes:
    """程序绘制 OpenPose 风格正/侧/背关键点骨架图(黑底彩线,按成人比例占满高度)。"""
    del height_cm
    view = (view or 'front').lower()
    if view == 'side':
        kps = _OPENPOSE_SIDE
    elif view == 'back':
        kps = _OPENPOSE_BACK
    else:
        kps = _OPENPOSE_FRONT
    img = Image.new('RGB', (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin_x = int(width * 0.18)
    top = int(height * 0.04)
    usable_h = int(height * 0.92)
    usable_w = width - 2 * margin_x

    def _xy(i: int) -> tuple[int, int]:
        x, y = kps[i]
        return (int(margin_x + x * usable_w), int(top + y * usable_h))
    thick = max(4, width // 96)
    for a, b, color in _OPENPOSE_LIMBS:
        draw.line([_xy(a), _xy(b)], fill=color, width=thick)
    r = max(5, width // 64)
    for i in range(len(kps)):
        x, y = _xy(i)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))
    hx, hy = _xy(0)
    hr = max(10, width // 28)
    draw.ellipse([hx - hr, hy - hr - 4, hx + hr, hy + hr + 4], outline=(255, 255, 0), width=3)
    buf = BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()

def ensure_openpose_assets(*, height_cm: int=165) -> dict[str, Path]:
    """生成并落盘正/侧/背骨架 PNG;返回 view→路径。"""
    d = openpose_asset_dir()
    d.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}
    for view in ('front', 'side', 'back'):
        p = d / f'openpose_{view}_165.png'
        data = render_openpose_skeleton(view, height_cm=height_cm)
        p.write_bytes(data)
        out[view] = p
    meta = d / 'README.txt'
    meta.write_text('Programmatic OpenPose BODY18-like skeletons for Batch7 turnaround.\nViews: front/side/back at 165cm adult proportions.\n', encoding='utf-8')
    return out

def render_openpose_face_skeleton(view: str, *, width: int=768, height: int=768) -> bytes:
    """程序绘制头肩 OpenPose:front / three_quarter / side。"""
    view = (view or 'front').lower().replace('-', '_')
    if view in ('three_quarter', 'face_three_quarter', '3_4', 'tq'):
        kps = _OPENPOSE_FACE_THREE_QUARTER
    elif view in ('side', 'face_side', 'profile'):
        kps = _OPENPOSE_FACE_SIDE
    else:
        kps = _OPENPOSE_FACE_FRONT
    img = Image.new('RGB', (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin_x = int(width * 0.08)
    top = int(height * 0.06)
    usable_h = int(height * 0.88)
    usable_w = width - 2 * margin_x

    def _xy(i: int) -> tuple[int, int]:
        x, y = kps[i]
        return (int(margin_x + x * usable_w), int(top + y * usable_h))
    thick = max(5, width // 80)
    limbs = [(1, 2, (255, 0, 0)), (1, 5, (0, 255, 0)), (2, 3, (255, 85, 0)), (3, 4, (255, 170, 0)), (5, 6, (0, 255, 85)), (6, 7, (0, 255, 170)), (1, 8, (170, 0, 255)), (1, 11, (255, 0, 170)), (0, 1, (255, 0, 85)), (0, 14, (255, 255, 0)), (0, 15, (255, 255, 0)), (14, 16, (0, 255, 255)), (15, 17, (0, 255, 255))]
    for a, b, color in limbs:
        draw.line([_xy(a), _xy(b)], fill=color, width=thick)
    r = max(6, width // 56)
    for i in range(len(kps)):
        x, y = _xy(i)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255))
    hx, hy = _xy(0)
    if view in ('side', 'face_side', 'profile'):
        draw.ellipse([hx - 18, hy - 55, hx + 70, hy + 55], outline=(255, 255, 0), width=4)
    elif view in ('three_quarter', 'face_three_quarter', '3_4', 'tq'):
        draw.ellipse([hx - 35, hy - 58, hx + 55, hy + 52], outline=(255, 255, 0), width=4)
    else:
        draw.ellipse([hx - 48, hy - 58, hx + 48, hy + 52], outline=(255, 255, 0), width=4)
    buf = BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()

def ensure_openpose_face_assets() -> dict[str, Path]:
    """生成并落盘面部正/3-4/侧骨架;返回 face_key→路径。"""
    d = openpose_asset_dir()
    d.mkdir(parents=True, exist_ok=True)
    mapping = {'face_front': 'front', 'face_three_quarter': 'three_quarter', 'face_side': 'side'}
    out: dict[str, Path] = {}
    for fk, view in mapping.items():
        p = d / f'openpose_face_{view}_768.png'
        p.write_bytes(render_openpose_face_skeleton(view))
        out[fk] = p
    return out

def _trim_letterbox_rgb(img: Image.Image) -> Image.Image:
    """去掉四周近灰/近白/近黑信箱,供面部格 cover 铺满(fix13)。"""
    rgb = img.convert('RGB')
    w, h = rgb.size
    small = rgb.resize((64, 64), Image.Resampling.BILINEAR)
    sp = small.load()
    xs, ys = ([], [])
    for y in range(64):
        for x in range(64):
            r, g, b = sp[x, y]
            mx, mn = (max(r, g, b), min(r, g, b))
            if r > 235 and g > 235 and (b > 235):
                continue
            if mx - mn < 14 and 65 <= mx <= 210:
                continue
            if mx < 24 and mx - mn < 10:
                continue
            xs.append(x)
            ys.append(y)
    if len(xs) < 12:
        return img
    minx, maxx = (min(xs), max(xs))
    miny, maxy = (min(ys), max(ys))
    pad = 2
    minx, miny = (max(0, minx - pad), max(0, miny - pad))
    maxx, maxy = (min(63, maxx + pad), min(63, maxy + pad))
    left = int(minx * w / 64)
    right = int((maxx + 1) * w / 64)
    top = int(miny * h / 64)
    bot = int((maxy + 1) * h / 64)
    if right - left < 8 or bot - top < 8:
        return img
    return img.crop((left, top, right, bot))

def _fit_cover_focus(img: Image.Image, box: tuple[int, int, int, int], focus_xy: tuple[float, float] | None=None) -> tuple[Image.Image, tuple[int, int]]:
    """cover 铺满格子;若给 focus_xy(源图像素)则裁切窗对准该点(防侧脸居中砍掉五官)。"""
    x, y, w, h = box
    src = img.convert('RGBA')
    sw, sh = src.size
    scale = max(w / sw, h / sh)
    nw, nh = (max(1, int(sw * scale)), max(1, int(sh * scale)))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    if focus_xy is None:
        left = max(0, (nw - w) // 2)
        top = max(0, (nh - h) // 2)
    else:
        fx = float(focus_xy[0]) * (nw / max(sw, 1))
        fy = float(focus_xy[1]) * (nh / max(sh, 1))
        left = int(round(fx - w / 2.0))
        top = int(round(fy - h / 2.0))
        left = max(0, min(nw - w, left))
        top = max(0, min(nh - h, top))
    src = src.crop((left, top, left + w, top + h))
    return (src, (x, y))

def tighten_side_square_to_face_frac(data: bytes, *, target: float=0.3, min_frac: float=0.28, max_frac: float=0.35, size: int=768) -> bytes:
    """16:53：侧头方图裁框收紧到 face_frac≈0.3（只调几何，不重出侧母版）。

    face_frac 已在 [min_frac, max_frac] 则原样返回；过小则围绕脸框缩小取景。
    """
    frac = measure_face_height_frac(data)
    if frac is None:
        return data
    f = float(frac)
    if f + 1e-12 >= float(min_frac) and f - 1e-12 <= float(max_frac):
        return data
    if f + 1e-12 >= float(min_frac) and abs(f - float(target)) < 0.02:
        return data
    if f > float(max_frac) + 1e-12:
        return data
    img = Image.open(BytesIO(data)).convert('RGB')
    w, h = img.size
    bb = _detect_face_bbox_xyxy(data)
    if bb is None:
        bb = _heuristic_skin_face_bbox(img)
    if bb is None:
        return data
    fx1, fy1, fx2, fy2 = [float(v) for v in bb]
    face_h = max(8.0, fy2 - fy1)
    face_w = max(8.0, fx2 - fx1)
    fcx = (fx1 + fx2) / 2.0
    fcy = (fy1 + fy2) / 2.0
    tgt = max(0.26, min(0.4, float(target)))
    side = face_h / tgt
    side = max(side, face_w * 1.15, face_h * 1.45)
    side = min(side, float(w), float(h))
    for _ in range(4):
        left = max(0.0, min(float(w) - side, fcx - side / 2.0))
        top = max(0.0, min(float(h) - side, fy1 - side * 0.18))
        crop = img.crop((int(left), int(top), int(left + side), int(top + side)))
        out_im = crop.resize((size, size), Image.Resampling.LANCZOS)
        buf = BytesIO()
        out_im.save(buf, format='PNG')
        out = buf.getvalue()
        nf = measure_face_height_frac(out)
        if nf is None:
            return out
        if float(nf) + 1e-12 >= float(min_frac):
            if float(nf) - 1e-12 <= 0.5:
                return out
            side = min(float(w), float(h), side * (float(nf) / tgt))
        else:
            side = max(64.0, side * 0.92)
    return out

def compose_faces_triptych(faces: dict[str, bytes], *, style: str='anime', size: tuple[int, int]=(1024, 640), skip_enforce_keys: set[str] | frozenset[str] | None=None, master_crop: bool=False) -> bytes:
    """正/3-4/侧 三个头部特写横拼为 faces 面板。

    fix16:锁定格与生成格同一 face-center cover(禁垫边缩水);每格 assert_panel_coverage>=0.90。
    入格 cover 按人脸焦点裁(高格水平居中会砍掉侧脸五官)。
    二次元浅底:已正方形铺满源谨慎 trim,避免 cel 线/浅底被当灰边。
    18:23 master_crop=True：母版裁切直接拼，近景门禁失败则原图 LANCZOS 铺满，不 422。
    """
    bg = (248, 248, 252) if sheet_uses_anime_xl(style) else (20, 22, 28)
    canvas = Image.new('RGB', size, bg)
    keys = ('face_front', 'face_three_quarter', 'face_side')
    cell_w = size[0] // 3
    skip = set(skip_enforce_keys or ())
    for i, key in enumerate(keys):
        raw = faces.get(key)
        if not raw:
            continue
        try:
            if master_crop or key in skip:
                if master_crop and key == 'face_three_quarter':
                    im = Image.open(BytesIO(raw)).convert('RGB')
                    if im.size != (768, 768):
                        im = im.resize((768, 768), Image.Resampling.LANCZOS)
                    buf = BytesIO()
                    im.save(buf, format='PNG')
                    filled = buf.getvalue()
                else:
                    filled = enforce_head_shoulders_square(raw, size=768, skip_reframe=True, face_closeup_gate=not master_crop, check_coverage=False)
            else:
                filled = enforce_head_shoulders_square(raw, size=768, face_closeup_gate=True)
        except CharacterSheetError as ge:
            if not master_crop:
                raise
            logger.warning('compose_faces master_crop soft skip %s: %s', key, ge)
            im = Image.open(BytesIO(raw)).convert('RGB').resize((768, 768), Image.Resampling.LANCZOS)
            buf = BytesIO()
            im.save(buf, format='PNG')
            filled = buf.getvalue()
        focus = None
        _preserve_side_frac = bool(master_crop and key == 'face_three_quarter')
        if key not in skip and (not _preserve_side_frac):
            bb = _detect_face_bbox_xyxy(filled)
            if bb is not None:
                focus = ((bb[0] + bb[2]) / 2.0, (bb[1] + bb[3]) / 2.0)
            else:
                him = Image.open(BytesIO(filled)).convert('RGB')
                hbb = _heuristic_skin_face_bbox(him)
                if hbb is not None:
                    focus = ((hbb[0] + hbb[2]) / 2.0, (hbb[1] + hbb[3]) / 2.0)
        img = Image.open(BytesIO(filled)).convert('RGBA')
        iw, ih = img.size
        if _preserve_side_frac:
            try:
                frac0 = measure_face_height_frac(filled)
                if frac0 is not None and float(frac0) + 1e-12 < 0.3:
                    tight = tighten_side_square_to_face_frac(filled, target=0.32, min_frac=0.28, max_frac=0.38, size=768)
                    filled = tight
                    img = Image.open(BytesIO(filled)).convert('RGBA')
                    iw, ih = img.size
                    frac0 = measure_face_height_frac(filled)
                if frac0 is not None and float(frac0) > 0.42:
                    target = 0.38
                    pad_scale = float(frac0) / target
                    side_n = max(img.width, img.height)
                    canvas_n = int(round(side_n * pad_scale))
                    canvas_n = max(canvas_n, side_n + 8)
                    bg_rgb = (248, 248, 252) if sheet_uses_anime_xl(style) else (20, 22, 28)
                    pad = Image.new('RGBA', (canvas_n, canvas_n), bg_rgb + (255,))
                    pad.paste(img, ((canvas_n - img.width) // 2, (canvas_n - img.height) // 2))
                    img = pad
                    iw, ih = img.size
            except Exception:
                pass
        elif iw != ih or min(iw, ih) < 200:
            img = _trim_letterbox_rgb(img).convert('RGBA')
        else:
            sample = img.convert('RGB').resize((32, 32), Image.Resampling.BILINEAR)
            spx = list(sample.getdata())

            def _edge_gray(cols, rows):
                n = 0
                g = 0
                for yy in rows:
                    for xx in cols:
                        r, gv, b = spx[yy * 32 + xx]
                        n += 1
                        mx, mn = (max(r, gv, b), min(r, gv, b))
                        if r > 230 and gv > 230 and (b > 230) or (mx - mn < 14 and 65 <= mx <= 210):
                            g += 1
                return g / max(n, 1)
            left_g = _edge_gray(range(0, 3), range(32))
            right_g = _edge_gray(range(29, 32), range(32))
            top_g = _edge_gray(range(32), range(0, 3))
            bot_g = _edge_gray(range(32), range(29, 32))
            if left_g > 0.85 and right_g > 0.85 and (top_g > 0.5 or bot_g > 0.5):
                img = _trim_letterbox_rgb(img).convert('RGBA')
                if focus is not None and iw > 0 and (ih > 0):
                    focus = (focus[0] * img.width / iw, focus[1] * img.height / ih)
        box = (i * cell_w + 4, 4, cell_w - 8, size[1] - 8)
        fitted, pos = _fit_cover_focus(img, box, focus_xy=focus)
        canvas.paste(fitted.convert('RGB'), pos)
    buf = BytesIO()
    canvas.save(buf, format='PNG')
    return buf.getvalue()

async def _probe_openpose_available(client: Any) -> tuple[bool, str]:
    """探测 worker 是否具备 openpose 控网+预处理器。

    须走 ComfyUIClient.get_object_info / object_info;缺方法则直接 GET /object_info。
    不可用时返回 (False, reason)——调用方对三视图必须 raise,禁止静默 IPA 假成功。
    """
    info: dict[str, Any] = {}
    try:
        if hasattr(client, 'get_object_info'):
            info = await client.get_object_info()
        elif hasattr(client, 'object_info'):
            chunk = await client.object_info('ControlNetLoader')
            if isinstance(chunk, dict):
                info.update(chunk)
            try:
                chunk2 = await client.object_info('AIO_Preprocessor')
                if isinstance(chunk2, dict):
                    info.update(chunk2)
            except Exception:
                pass
        else:
            base = getattr(client, 'base_url', None) or getattr(client, '_base_url', None)
            if not base:
                return (False, 'client 无 get_object_info/base_url,无法探测 object_info')
            import httpx
            async with httpx.AsyncClient(timeout=12.0) as hx:
                r = await hx.get(f"{str(base).rstrip('/')}/object_info")
                if r.status_code != 200:
                    return (False, f'GET /object_info HTTP {r.status_code}')
                info = r.json() if isinstance(r.json(), dict) else {}
    except Exception as e:
        return (False, f'object_info 探测失败:{e}')
    if not isinstance(info, dict) or not info:
        return (False, 'object_info 为空')
    node = info.get('ControlNetLoader') or {}
    inputs = (node.get('input') or {}).get('required') or {}
    cn = inputs.get('control_net_name')
    models = cn[0] if isinstance(cn, list) and cn and isinstance(cn[0], list) else cn or []
    model_blob = ' '.join((str(m) for m in models)).lower()
    if 'openpose' not in model_blob and 'union' not in model_blob:
        return (False, 'worker 未装 openpose/union controlnet 模型')
    has_prep = any((k in info for k in ('AIO_Preprocessor', 'OpenposePreprocessor', 'DWPreprocessor', 'OpenPosePreprocessor')))
    if not has_prep:
        return (False, '缺少 Openpose/AIO/DW Preprocessor 节点')
    try:
        assets = ensure_openpose_assets(height_cm=165)
    except Exception as e:
        return (False, f'openpose 骨架资产生成失败:{e}')
    missing = [k for k, p in assets.items() if not p.is_file()]
    if missing:
        return (False, f"openpose 骨架资产缺失:{','.join(missing)}")
    return (True, f"openpose ok assets={','.join(sorted(assets))}")

async def generate_panel_bytes_openpose(pool: 'WorkerPool', prompt: str, *, pose_image_name: str, ckpt_name: str, width: int, height: int, seed: int | None, worker: str | None, filename_prefix: str, style: str, client: Any | None=None, ref_image: str | None=None, skip_preprocess: bool=True, strength: float=0.88, ipa_weight: float=0.72, ipa_start: float=0.0, ipa_end: float=1.0, negative_extra: str='') -> bytes:
    """openpose ControlNet 出图(尺寸覆盖 EmptyLatent)。

    skip_preprocess=True:合成骨架图直喂 ControlNet(不再跑 OpenposePreprocessor)。
    ref_image:可选主立绘,注入 IPAdapter 保同一人。
    """
    del pool
    from app.comfy.client import ComfyUIError
    from app.workflows.controlnet import ControlNetParams, build_controlnet_graph
    cli = client or await _pick_sheet_client(worker)
    neg = _with_ancient_spec_negative(_STYLE_NEGATIVE.get(style, _STYLE_NEGATIVE['anime']), style)
    if negative_extra:
        neg = f'{neg}, {negative_extra}'
    kw: dict[str, Any] = dict(positive=prompt, image=pose_image_name, control_type='openpose', negative=neg, ckpt_name=ckpt_name, strength=strength, steps=28 if sheet_uses_anime_xl(style) else 22, cfg=6.0 if sheet_uses_anime_xl(style) else 7.0, filename_prefix=filename_prefix)
    if seed is not None:
        kw['seed'] = seed
    graph = build_controlnet_graph(ControlNetParams(**kw))
    if '5' in graph and 'inputs' in graph['5']:
        graph['5']['inputs']['width'] = width
        graph['5']['inputs']['height'] = height
    if skip_preprocess:
        apply = graph.get('15') or {}
        if isinstance(apply, dict) and 'inputs' in apply:
            apply['inputs']['image'] = ['10', 0]
        graph.pop('12', None)
    if ref_image:
        from app.workflows.ipadapter import DEFAULT_PRESET
        graph['200'] = {'class_type': 'IPAdapterUnifiedLoader', 'inputs': {'model': ['4', 0], 'preset': DEFAULT_PRESET}}
        graph['202'] = {'class_type': 'LoadImage', 'inputs': {'image': ref_image}}
        graph['201'] = {'class_type': 'IPAdapterAdvanced', 'inputs': {'model': ['200', 0], 'ipadapter': ['200', 1], 'image': ['202', 0], 'weight': ipa_weight, 'weight_type': 'linear', 'combine_embeds': 'concat', 'embeds_scaling': 'V only', 'start_at': ipa_start, 'end_at': ipa_end}}
        if '3' in graph and 'inputs' in graph['3']:
            graph['3']['inputs']['model'] = ['201', 0]
    try:
        prompt_id = await cli.queue_prompt(graph, client_id=uuid.uuid4().hex)
    except ComfyUIError as e:
        raise CharacterSheetError(f'openpose 出图提交失败:{e}', status_code=503) from e
    images = await _wait_images(cli, prompt_id)
    img = images[0]
    data, _ = await cli.get_image_bytes(img['filename'], img.get('subfolder', ''), img.get('type', 'output'))
    return data

async def regenerate_sheet_panels(*, character_id: str, meta: SheetMeta, pool: 'WorkerPool', locked_panels: dict[str, bytes], regen_keys: list[str], n_candidates: int=3, ckpt_name: str | None=None, worker: str | None=None, seed: int | None=None) -> tuple[str, bytes, dict[str, str], dict[str, Any]]:
    """分区锁定 + 单格重生成。

    locked_panels: 已合格锁定的键→PNG bytes(跳过生成)。
    regen_keys: 须重做的键(front/side/back/expr_*/costume/faces/palette 等)。
    各 regen 键出 n_candidates 后启发式挑一张。
    返回 (sheet_url, png_bytes, panel_urls, debug_info)。
    """
    if not (meta.name or '').strip():
        raise CharacterSheetError('角色名为空', status_code=422)
    if meta.style not in SHEET_STYLES:
        raise CharacterSheetError(f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422)
    resolve_cjk_font(24)
    meta.design_notes = build_design_notes(meta)
    prompts = build_panel_prompts(meta)
    _ANCIENT_SPEC_NEG_CTX.set(ancient_spec_negative(meta))
    _acc_fix = ancient_accessory_prompt_fix(meta)
    if _acc_fix['pos']:
        logger.info('ancient accessory prompt fix name=%s wooden_hairpin=%s umbrella_in_hand=%s', meta.name, _acc_fix['wooden_hairpin'], _acc_fix['umbrella_in_hand'])
    panels: dict[str, bytes] = dict(locked_panels or {})
    panel_urls: dict[str, str] = {}
    debug: dict[str, Any] = {'locked': sorted(panels.keys()), 'regen_keys': list(regen_keys), 'n_candidates': n_candidates, 'openpose': {}, 'picks': {}}
    ckpt = ckpt_name or _SHEET_CKPT.get(meta.style, _SHEET_CKPT['anime'])
    client = await _pick_sheet_client(worker)
    if 'portrait' not in panels:
        raise CharacterSheetError('locked_panels 缺少 portrait', status_code=422)
    panel_urls['portrait'] = save_panel_png(panels['portrait'], character_id=character_id, style=meta.style, key='portrait')
    ref_name: str | None = None
    face_ref_name: str | None = None
    try:
        ref_name = await client.upload_image(panels['portrait'], f'sheet_ref_{character_id[:8]}_{meta.style}.png')
        face_bytes = crop_face_ref(panels['portrait'])
        face_ref_name = await client.upload_image(face_bytes, f'sheet_face_{character_id[:8]}_{meta.style}.png')
    except Exception as e:
        logger.warning('设定卡 regenerate:上传参考失败: %s', e)
    use_openpose, openpose_reason = await _probe_openpose_available(client)
    debug['openpose'] = {'enabled': use_openpose, 'reason': openpose_reason}
    need = [k for k in regen_keys if k and k != 'portrait']
    turnaround_need = [k for k in need if k in ('front', 'side', 'back')]
    if turnaround_need and (not use_openpose):
        raise CharacterSheetError(f"openpose 不可用,拒绝静默 IPA 出三视图({','.join(turnaround_need)}):{openpose_reason}", status_code=503)
    for key in need:
        if key == 'costume':
            picked_items: list[bytes] = []
            suf = _STYLE_SUFFIX.get(meta.style, _STYLE_SUFFIX['anime'])
            locked_item_keys: list[str] = []
            regen_item_keys: list[str] = []
            costume_items = ancient_costume_items(meta) if meta.style == 'ancient_realistic' else _COSTUME_ITEMS
            for idx, (item_key, item_prompt) in enumerate(costume_items):
                lock_key = f'costume_{item_key}'
                if lock_key in panels and panels[lock_key]:
                    picked_items.append(panels[lock_key])
                    locked_item_keys.append(item_key)
                    continue
                regen_item_keys.append(item_key)
                cands: list[bytes] = []
                prompt = f'{item_prompt}, {suf}'
                if item_key == 'boots':
                    prompt = 'exactly two black rain boots only, one left boot and one right boot, a single isolated pair centered large in frame with empty white space around, NOT three, NOT four, NOT five, NOT a row, NOT a shelf, NOT repeated, product still life, no person, ' + prompt + ', footwear product photography, only two boots'
                elif item_key == 'pants':
                    prompt = 'single pair of long black trousers laid flat centered, full length to ankles, one item only filling the frame, plain white background only, NOT shorts, NOT multiple, NOT repeated, NOT a row of pants, NOT empty panels, NOT UI mockup, NOT wireframe boxes, NOT empty slots, product shot, no person, no mannequin, ' + prompt + ', clothing flat lay only'
                elif item_key == 'raincoat':
                    prompt = 'flat lay complete black hooded raincoat only, hood and sleeves visible, product shot, no person, no mannequin, garment fills frame, ' + prompt + ', clothing only, not empty white frame'
                elif item_key == 'umbrella':
                    prompt = 'transparent clear umbrella only, open canopy with ribs, product shot, ' + prompt + ', not a hat, not a lamp'
                elif item_key == 'bag':
                    prompt = 'white plastic shopping bag only, product shot, ' + prompt + ', white polyethylene, not blue'
                item_prompt_final = prompt
                if item_key == 'boots':
                    item_prompt_final = 'clean anime product illustration, ONE single black rubber rain boot only, exactly one boot, solo wellington, visible shaft opening and thick sole, glossy, large centered, empty white background, no text, NOT a pair, NOT two boots, NOT three, NOT a row, NOT multiple, ' + item_prompt + ', single footwear product only'
                rounds = 3 if item_key in ('boots', 'pants', 'beizi', 'jiaoling', 'sash', 'hairpin', 'fan') else 1
                for round_i in range(rounds):
                    for ci in range(max(1, n_candidates)):
                        use_ckpt = ckpt
                        use_style = meta.style
                        wh = (768, 768) if sheet_uses_anime_xl(meta.style) else (512, 512)
                        if meta.style == 'ancient_realistic' and item_key in ('beizi', 'jiaoling', 'sash', 'hairpin', 'fan', 'ruqun'):
                            use_ckpt = 'animagineXL40.safetensors'
                            use_style = 'anime'
                            wh = (768, 768)
                            item_prompt_final = item_prompt_final + ', anime product illustration, clothing flat lay catalog, no person, no face, no hands'
                        w, h = wh
                        cands.append(await generate_panel_bytes(pool, item_prompt_final, ckpt_name=use_ckpt, width=w, height=h, seed=None if seed is None else seed + 8000 + idx * 10 + ci + round_i * 170, worker=worker, filename_prefix=f'ToIV_char_sheet_costume_{item_key}', style=use_style, client=client, ref_image=None, ref_mode='none', denoise=1.0))
                    best_try = _pick_best_candidate(cands, f'costume_{item_key}')
                    img = Image.open(BytesIO(best_try)).convert('RGB').resize((64, 64))
                    blobs = _count_dark_blobs(list(img.getdata()))
                    if item_key == 'boots':
                        if blobs <= 2:
                            break
                        logger.warning('单靴候选多件 blobs=%s,再抽', blobs)
                    elif item_key == 'pants':
                        if blobs <= 3:
                            break
                    else:
                        break
                best = _pick_best_candidate(cands, f'costume_{item_key}')
                if item_key == 'boots':
                    best = compose_boot_pair(best, style=meta.style)
                picked_items.append(best)
            panels['costume'] = collage_costume_items(picked_items, style=meta.style)
            panels['costume'] = ensure_costume_bad_cells_replaced(panels['costume'], portrait=panels.get('portrait'), front=panels.get('front'), n=len(picked_items) if picked_items else 5)
            debug['picks']['costume'] = {'items': [k for k, _ in costume_items], 'locked_items': locked_item_keys, 'regen_items': regen_item_keys}
            continue
        if key == 'faces':
            tri = build_faces_tri_from_masters(portrait=panels.get('portrait'), front=panels.get('front'), side=panels.get('side'), back=panels.get('back'), size=768)
            for fk in ('face_front', 'face_three_quarter', 'face_side'):
                try:
                    tri[fk] = auto_tighten_face_crop(tri[fk], size=768, face_key=fk)
                except CharacterSheetError:
                    if fk != 'face_side':
                        raise
            try:
                _fr = tri.get('face_front') or panels.get('portrait')
                if side_hist_match_enabled() and _fr and tri.get('face_three_quarter'):
                    tri['face_three_quarter'] = match_side_head_coat_hair_to_front(tri['face_three_quarter'], _fr)
                elif not side_hist_match_enabled():
                    logger.info('regen faces hist-match skipped (TOIV_SHEET_SIDE_HIST_MATCH off)')
            except Exception as hme:
                logger.warning('regen faces hist-match skipped: %s', hme)
            panels['faces'] = compose_faces_triptych(tri, style=meta.style, size=_panel_size('faces', meta.style), master_crop=True)
            debug['picks']['faces'] = {'mode': 'master_crop_1901_head35+1552_hist' if side_hist_match_enabled() else 'master_crop_1901_head35+1822_no_hist', 'keys': ['face_front', 'face_three_quarter', 'face_side'], 'scores': {}}
            continue
        cands = []
        w, h = _panel_size(key, meta.style)
        for ci in range(max(1, n_candidates)):
            use_ref = None
            ref_mode = 'none'
            denoise = 0.62
            prompt = prompts.get(key) or prompts.get('front', '')
            if key in ('front', 'side', 'back'):
                if key == 'side':
                    prompt = prompts['side'] + ', extreme side silhouette, ear visible, only one eye visible, nose profile, 90 degree turn, NOT looking at camera'
                elif key == 'back':
                    prompt = prompts['back'] + ', completely back facing, no eyes, no nose, no mouth, occiput and hood from behind only'
                if use_openpose:
                    assets = ensure_openpose_assets(height_cm=meta.height_cm or 165)
                    pose_path = assets[key]
                    pose_name = await client.upload_image(pose_path.read_bytes(), f'sheet_pose_{character_id[:8]}_{key}.png')
                    data = await generate_panel_bytes_openpose(pool, prompt, pose_image_name=pose_name, ckpt_name=ckpt, width=w, height=h, seed=None if seed is None else seed + abs(hash(key + str(ci))) % 10000, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}_pose', style=meta.style, client=client, ref_image=ref_name, skip_preprocess=True)
                    data = normalize_turnaround_figure(data, out_w=w, out_h=h)
                    cands.append(data)
                    continue
                if ref_name:
                    use_ref = ref_name
                    ref_mode = 'ipa'
                    denoise = 0.7
            elif key.startswith('expr_'):
                face = face_ref_name or ref_name
                if face:
                    use_ref = face
                    ref_mode = 'qwen_edit'
                    denoise = 1.0
                    _ei = _EXPR_KEYS.index(key) if key in _EXPR_KEYS else 0
                    prompt = _EXPR_EDIT_INSTRUCTIONS[_ei]
            data = await generate_panel_bytes(pool, prompt, ckpt_name=ckpt, width=w, height=h, seed=None if seed is None else seed + abs(hash(key + str(ci))) % 10000, worker=worker, filename_prefix=f'ToIV_char_sheet_{key}', style=meta.style, client=client, ref_image=use_ref, ref_mode=ref_mode, denoise=denoise)
            cands.append(data)
        if key in ('front', 'side', 'back') and meta.style == 'ancient_realistic' and ancient_spec_target_hex(meta):
            _ok, _last_ce = ([], None)
            for _c in cands:
                try:
                    assert_garment_near_spec_color(_c, ancient_spec_target_hex(meta), label=key)
                    _ok.append(_c)
                except CharacterSheetError as _ce:
                    _last_ce = _ce
            if not _ok:
                raise _last_ce or CharacterSheetError(f'{key}颜色门禁全拒', status_code=422)
            cands = _ok
        best = _pick_best_candidate(cands, key)
        if key.startswith('expr_'):
            gated: list[bytes] = []
            last_ge = None
            same_cause = None
            same_cause_n = 0
            for cand in cands:
                try:
                    g = enforce_head_shoulders_square(cand, size=768, face_closeup_gate=True)
                    assert_expression_identity_gates(g, portrait_ref=panels.get('portrait'), expr_key=key)
                    _neutral = None
                    try:
                        if panels.get('portrait'):
                            _neutral = crop_face_ref(panels['portrait'], size=768)
                    except Exception:
                        _neutral = None
                    assert_expression_diversity(g, expr_key=key, neutral_ref=_neutral, other_exprs={ek: panels[ek] for ek in _EXPR_KEYS if ek in panels and ek != key and panels.get(ek)})
                    gated.append(g)
                except CharacterSheetError as ge:
                    last_ge = ge
                    cause = _expr_reject_cause(ge)
                    if cause == same_cause:
                        same_cause_n += 1
                    else:
                        same_cause = cause
                        same_cause_n = 1
                    if same_cause_n >= 3 and (not gated):
                        raise CharacterSheetError(f'{key}同因连败3次({cause}): {ge}；停下修根因', status_code=422) from ge
            if not gated:
                raise last_ge or CharacterSheetError(f'{key}表情门禁全拒', status_code=422)
            best = _pick_best_candidate(gated, key)
        if key in ('front', 'side', 'back'):
            best = normalize_turnaround_figure(best, out_w=w, out_h=h)
        panels[key] = best
        debug['picks'][key] = {'n': len(cands), 'blank_rejected': sum((1 for b in cands if _panel_is_blank_or_glitch(b))), 'score': _score_turnaround_candidate(best, key) if key in ('front', 'side', 'back') else _score_expression_head_ratio(best) if key.startswith('expr_') else None, 'head_enforced': key.startswith('expr_')}
        if key in ('front', 'side', 'back'):
            panel_urls[key] = save_panel_png(panels[key], character_id=character_id, style=meta.style, key=key)
    if 'faces' not in panels and 'front' in panels:
        panels['faces'] = panels['front']
    if 'costume' not in panels:
        ph = placeholder_panel((220, 220, 226), _panel_size('costume', meta.style))
        buf = BytesIO()
        ph.convert('RGB').save(buf, format='PNG')
        panels['costume'] = buf.getvalue()
    for ek in _EXPR_KEYS:
        if ek not in panels and ek not in locked_panels:
            panels[ek] = crop_face_ref(panels['portrait'], size=768)
    png = compose_reference_board(panels, meta) if meta.template == 'toonflow_board' else compose_character_sheet(panels, meta)
    url = save_sheet_png(png, character_id=character_id, style=meta.style)
    return (url, png, panel_urls, debug)
