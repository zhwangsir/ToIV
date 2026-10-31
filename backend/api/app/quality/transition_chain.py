"""转场链完整性评估(P3)。

两层评估:
1. 确定性预检(零 LLM):anchor_overlap_score 计算 prev.seam_anchor 与
   next.prompt 开头/锚点词的词汇重合率(jieba 可用用词级,否则字符级 bigram
   Jaccard)。仅当 prev.seam_to_next ∈ {matchcut, overlap} 时计分;
   硬切/未声明返回 None 不计分。
2. LLM-as-judge(可注入):judge(prev, next) -> {"score": 0-1, "reason": str},
   缺省走确定性预检;prompt 模板见 TRANSITION_JUDGE_PROMPT。

聚合:score_transition_chain 输出逐接缝得分列表 + 锚点匹配率
(达标接缝/总接缝,单缝达标阈值 ANCHOR_PASS_THRESHOLD=0.3)。

与质量门衔接:R5.1 已接入 gateway.run_quality_checks(advisory,确定性预检,
不参与阻断);LLM judge 注入仅供离线评估/未来增强使用。
"""
from __future__ import annotations

try:  # jieba 非生产依赖;不可用则回退字符级 bigram
    import jieba as _jieba
except ImportError:  # pragma: no cover - 取决于运行环境
    _jieba = None

#: 计分的软转场类型;其余(硬切 cut/空)不计分
SEAM_KINDS_SCORED = frozenset({"matchcut", "overlap"})
#: 单缝达标阈值:重合率 ≥ 此值视为锚点连续
ANCHOR_PASS_THRESHOLD = 0.3
#: next.prompt 开头取样窗口(字符数)
_OPENING_WINDOW = 48

#: LLM-as-judge prompt 模板(评估接缝质量,输出 JSON)
TRANSITION_JUDGE_PROMPT = """你是一名动画分镜转场评审。只评估前后两镜的接缝质量,不评单镜美术。

【前镜离镜锚点 seam_anchor】
{prev_anchor}
【前镜结尾画面】
{prev_tail}
【后镜开头画面】
{next_head}

按三个维度评估:
1. 锚点连续性:前镜离镜锚点是否在后镜开头自然再现(匹配变形/共享帧),还是无因果换景;
2. 运动方向继承:接缝两侧的运动方向、速度趋势与视觉轴线是否一致;
3. 主体一致性:角色/道具的身份、比例、颜色在接缝两侧是否稳定。

只输出 JSON,不要任何额外文字:
{{"score": <0到1的小数,1为完美接缝>, "reason": "<一句话中文理由>"}}"""

# 分词时剔除的空白与标点(中英)
_PUNCT = set(" \t\r\n,.。、;:!?\"'()()[]【】《》<>—-…·/\\|~")


def _tokens(text: str) -> set[str]:
    """文本 → 词集合(jieba 词级)或字符 bigram 集合(回退)。"""
    chars = [c for c in (text or "") if c not in _PUNCT]
    if not chars:
        return set()
    if _jieba is not None:  # pragma: no cover - 生产环境未装 jieba 时走回退
        return {w for w in _jieba.lcut("".join(chars)) if w and w not in _PUNCT}
    if len(chars) < 2:
        return set(chars)
    return {"".join(chars[i : i + 2]) for i in range(len(chars) - 1)}


def anchor_overlap_score(prev_shot: dict, next_shot: dict) -> float | None:
    """prev.seam_anchor 与 next.prompt 开头/锚点词的词汇重合率(Jaccard)。

    Returns:
        float in [0,1];prev.seam_to_next 非 matchcut/overlap(硬切等)时返回 None
        表示不计分;声明了软转场却没有 seam_anchor 时返回 0.0(不达标)。
    """
    seam = str(prev_shot.get("seam_to_next") or "").strip().lower()
    if seam not in SEAM_KINDS_SCORED:
        return None
    anchor = str(prev_shot.get("seam_anchor") or "").strip()
    if not anchor:
        return 0.0
    nxt_text = str(next_shot.get("anchor") or "") + str(
        next_shot.get("prompt") or ""
    )[:_OPENING_WINDOW]
    a, b = _tokens(anchor), _tokens(nxt_text)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def score_transition_chain(shots: list[dict], judge=None) -> dict:
    """全链聚合:逐接缝评分 + 锚点匹配率(达标接缝/总接缝)。

    Args:
        shots: 分镜 dict 列表;转场字段在 prev 镜上声明:
               seam_to_next ∈ {matchcut, overlap, cut, ...}、seam_anchor 文本。
        judge: 可选 LLM-as-judge,签名 (prev, next) -> {"score": 0-1, "reason": str};
               仅对计分接缝调用(硬切不调用);judge 异常时回退确定性预检。

    Returns:
        dict: seams(逐接缝 {index, seam, scored, score, reason})、total_seams、
        scored_seams、passed_seams、anchor_match_rate、threshold。
    """
    seams: list[dict] = []
    for i in range(len(shots) - 1):
        prev, nxt = shots[i], shots[i + 1]
        seam_kind = str(prev.get("seam_to_next") or "cut").strip().lower()
        entry = {
            "index": i,
            "seam": seam_kind,
            "scored": False,
            "score": None,
            "reason": "",
        }
        if seam_kind not in SEAM_KINDS_SCORED:
            entry["reason"] = "硬切/未声明软转场,不计分"
            seams.append(entry)
            continue
        entry["scored"] = True
        if judge is not None:
            try:
                res = judge(prev, nxt) or {}
                score = min(1.0, max(0.0, float(res.get("score", 0.0))))
                entry["score"] = score
                entry["reason"] = str(res.get("reason", ""))
            except Exception as exc:  # judge 故障回退确定性预检,链评估不中断
                entry["score"] = anchor_overlap_score(prev, nxt)
                entry["reason"] = f"judge 故障回退确定性预检: {exc}"
        else:
            entry["score"] = anchor_overlap_score(prev, nxt)
        seams.append(entry)

    total = len(seams)
    scored = [s for s in seams if s["scored"]]
    passed = [
        s for s in scored if (s["score"] or 0.0) >= ANCHOR_PASS_THRESHOLD
    ]
    return {
        "seams": seams,
        "total_seams": total,
        "scored_seams": len(scored),
        "passed_seams": len(passed),
        "anchor_match_rate": (len(passed) / total) if total else 1.0,
        "threshold": ANCHOR_PASS_THRESHOLD,
    }
