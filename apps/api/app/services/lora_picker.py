"""从策划卡目录为 H3 / LTX / Wan 提交选 LoRA。

协议(v1,不新增 lora_mode 字段以免打坏客户端):
  · 客户端省略 loras / null → auto
  · 显式空列表 [] → off
  · 非空列表 → pin(文件名必须在目录内;强度缺省用卡面默认)

规则:按引擎过滤;SFW 永不挂 nsfw 卡;最多 3 张;加速最多一张;同角色
(pose/anatomy/concept/accel)不叠。R18 且提示偏空/无概念时补通用概念卡;
无概念卡则挂动态(motion)或任意非加速卡,避免空跑。永不自动挂 accel。
LLM 不选文件名:只允许将来把 prompt 映到 role 枚举,再由本模块确定性映到卡。
失败/无命中时规则路径仍返回(可能为空)。
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.lora_catalog import LoraCard, card_by_name, cards_for
from app.workflows.lora import LoraSpec

MAX_PICK = 3
_EXCLUSIVE_ROLES = frozenset({"pose", "anatomy", "concept", "accel"})
_EMPTYISH_LEN = 16


@dataclass(frozen=True)
class PickedLora:
    name: str
    strength: float
    role: str
    reason: str
    wan_side: str | None = None
    trigger_words: tuple[str, ...] = ()
    trigger_mode: str = "all"


def _picked(card: LoraCard, reason: str, strength: float | None = None) -> PickedLora:
    return PickedLora(
        name=card.name,
        strength=card.default_strength if strength is None else strength,
        role=card.role,
        reason=reason,
        wan_side=card.wan_side,
        trigger_words=card.trigger_words,
        trigger_mode=card.trigger_mode,
    )


def _eligible(engine: str, nsfw: bool) -> list[LoraCard]:
    """nsfw=False 只留 SFW 卡;True 保留 SFW+NSFW(运镜等 SFW 卡 R18 也能挂)。"""
    return list(cards_for(engine, nsfw=True if nsfw else False) if nsfw else cards_for(engine, nsfw=False))


def _conflicts(card: LoraCard, picked: list[PickedLora]) -> bool:
    if not picked:
        return False
    roles = {p.role for p in picked}
    names = {p.name for p in picked}
    if card.role in _EXCLUSIVE_ROLES and card.role in roles:
        return True
    if card.conflicts & roles or card.conflicts & names:
        return True
    for p in picked:
        # 已选卡的 conflicts 指向新卡角色或文件名
        other = card_by_name(p.name)
        if other is None:
            continue
        if card.role in other.conflicts or card.name in other.conflicts:
            return True
    return False


def _score(card: LoraCard, prompt_l: str) -> int:
    hits = 0
    for kw in card.keywords:
        if kw and kw.lower() in prompt_l:
            hits += 2 if len(kw) > 2 else 1
    for tw in card.trigger_words:
        if tw and tw.lower() in prompt_l:
            hits += 3
    return hits


def _greedy(cands: list[tuple[int, LoraCard, str]], limit: int = MAX_PICK) -> list[PickedLora]:
    out: list[PickedLora] = []
    for _score_v, card, reason in cands:
        if len(out) >= limit:
            break
        if _conflicts(card, out):
            continue
        # 自动路径永不主动挂加速(用户 pin 除外,pin 走另一入口)
        if card.role == "accel" and not reason.startswith("pin"):
            continue
        out.append(_picked(card, reason))
    return out


def pick_loras(
    engine: str,
    prompt: str,
    nsfw: bool,
    pinned: list | None = None,
    mode: str = "auto",
) -> list[PickedLora]:
    """选卡。mode=off 返回空;pin 用 pinned;auto 走规则。永不返回目录外文件名。"""
    if mode == "off":
        return []
    pool = {c.name: c for c in _eligible(engine, nsfw)}
    # basename 别名
    for c in list(pool.values()):
        pool.setdefault(c.name.replace("\\", "/").rsplit("/", 1)[-1], c)

    if mode == "pin":
        out: list[PickedLora] = []
        for item in pinned or []:
            if isinstance(item, str):
                name, strength = item, None
            elif isinstance(item, dict):
                name, strength = item.get("name") or "", item.get("strength")
            else:
                name = getattr(item, "name", "")
                strength = getattr(item, "strength", None)
            card = pool.get(name)
            if card is None:
                label = {"wan": "Wan NSFW", "h3": "H3", "ltx": "LTX"}.get(engine, engine)
                raise ValueError(f"未知 {label} LoRA: {name}")
            if _conflicts(card, out):
                continue
            if len(out) >= MAX_PICK:
                break
            out.append(_picked(card, "pin", None if strength is None else float(strength)))
        return out

    # auto
    prompt = prompt or ""
    prompt_l = prompt.lower()
    ranked: list[tuple[int, LoraCard, str]] = []
    for card in _eligible(engine, nsfw):
        s = _score(card, prompt_l)
        if s > 0:
            ranked.append((s, card, f"keyword:{card.role}"))
    ranked.sort(key=lambda t: -t[0])
    picks = _greedy(ranked)

    emptyish = len(prompt.strip()) < _EMPTYISH_LEN
    has_concept = any(p.role == "concept" for p in picks)
    if nsfw and (emptyish or not has_concept):
        eligible = _eligible(engine, nsfw)
        concept = next((c for c in eligible if c.role == "concept"), None)
        if concept is not None and not any(p.name == concept.name for p in picks):
            if _conflicts(concept, picks):
                # 挤掉最后一张非概念,给通用概念让位
                picks = [p for p in picks if p.role != "concept"]
                if len(picks) >= MAX_PICK:
                    picks = picks[: MAX_PICK - 1]
            if not _conflicts(concept, picks) and len(picks) < MAX_PICK:
                reason = "r18-default-concept" if emptyish else "r18-concept"
                picks.insert(0, _picked(concept, reason))
                picks = picks[:MAX_PICK]
        elif concept is None:
            # LTX 等无概念卡:先动态增强,再任意非加速卡(永不自动挂 accel)
            fallback = next((c for c in eligible if c.role == "motion"), None)
            reason = "r18-default-motion"
            if fallback is None:
                fallback = next((c for c in eligible if c.role != "accel"), None)
                reason = "r18-default-fallback"
            if (
                fallback is not None
                and not any(p.name == fallback.name for p in picks)
                and not _conflicts(fallback, picks)
                and len(picks) < MAX_PICK
            ):
                picks.insert(0, _picked(fallback, reason))
                picks = picks[:MAX_PICK]
    return picks


def resolve_submit_loras(
    engine: str,
    prompt: str,
    nsfw: bool,
    raw: list | None,
) -> tuple[list[PickedLora], str, str]:
    """提交层:None=auto, []=off, 非空=pin。返回 (picks, mode, reason)。"""
    if raw is None:
        picks = pick_loras(engine, prompt, nsfw, mode="auto")
        reason = ",".join(f"{p.name}:{p.reason}" for p in picks) or "auto:none"
        return picks, "auto", reason
    if len(raw) == 0:
        return [], "off", "off"
    picks = pick_loras(engine, prompt, nsfw, pinned=raw, mode="pin")
    reason = ",".join(f"{p.name}:pin" for p in picks) or "pin:none"
    return picks, "pin", reason


def inject_triggers(prompt: str, picks: list[PickedLora]) -> str:
    """把卡面触发词置前(all 全要;pick_one 走 Wan 注册表场景映射,否则取第一个)。"""
    if not picks:
        return prompt
    wan_names = [p.name for p in picks if p.wan_side]
    words: list[str] = []
    if wan_names:
        from app.workflows.wan_i2v import pick_trigger_words

        for w in pick_trigger_words(wan_names, prompt):
            if w not in words:
                words.append(w)
    for p in picks:
        if p.wan_side:
            continue
        if not p.trigger_words:
            continue
        if p.trigger_mode == "all":
            for w in p.trigger_words:
                if w not in words:
                    words.append(w)
        else:
            if p.trigger_words[0] not in words:
                words.append(p.trigger_words[0])
    missing = [w for w in words if w not in prompt]
    if not missing:
        return prompt
    return ", ".join(missing) + ", " + prompt


def to_specs(picks: list[PickedLora]) -> tuple[LoraSpec, ...]:
    return tuple(LoraSpec(name=p.name, weight=p.strength) for p in picks)


def split_wan_sides(picks: list[PickedLora]) -> tuple[tuple[tuple[str, float], ...], tuple[tuple[str, float], ...]]:
    high: list[tuple[str, float]] = []
    low: list[tuple[str, float]] = []
    for p in picks:
        (high if (p.wan_side or "high") == "high" else low).append((p.name, p.strength))
    return tuple(high), tuple(low)


def snapshot_loras(picks: list[PickedLora]) -> list[dict]:
    """写入 Job.params 快照,前端可展示已选卡。"""
    return [
        {"name": p.name, "strength": p.strength, "role": p.role, "reason": p.reason}
        for p in picks
    ]
