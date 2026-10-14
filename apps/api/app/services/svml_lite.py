"""SVML-lite 词锚定短剧脚本解析器。

设计来源:hypit(修改版 Apache-2.0,单租户本地自用许可,详见
docs/ops/TECH_STACK_EXEC_LOG_20261014.md 批次 2)的 SVML 词锚定语法——
时间轴锚定到「词/拍」而非秒数,改台词后时序可重排。本模块取其语法核心
(拍分隔 ||、词锚 @{cue}…@{/cue}、说话人 <名字|voice> 前缀),做成
ToIV 短剧线的确定性导入器:不依赖 LLM,纯解析。

支持两种形态(可混用,按空行/分隔线 --- 分镜):

XML 形态::

    <?svml?>
    <svml>
      <shot scene="雨夜巷口" mood="紧张" beat="开场" duration="6">
        <v>镜头缓推 || 巷口霓虹闪烁 || @{脚步声}她加快脚步@{/脚步声}</v>
        <林夏>别跟着我。||我说了,别跟着我。</林夏>
      </shot>
    </svml>

行式形态::

    [scene:雨夜巷口][mood:紧张][beat:开场]
    <林夏> 别跟着我。||我说了,别跟着我。
    镜头缓推 || 霓虹闪烁
    ---

产出 ShotDraft 与 drama_studio._create_shots_from_analysis 的 coerced
dict 同构(scene/prompt/characters/dialogue/speaker/duration_sec/mood/beat)。
prompt=视觉拍文本(草稿级,中文场景描述可后续经 LLM 精修);
dialogue 存锚点剥离后的纯文本(与现管线 TTS/口型兼容),原始脚本整体
保留在 project.script,词锚信息随时可从原文重析(为 W4-5 词锚定时间轴留底)。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

# 中文语速粗估:IndexTTS 2.5 实测约 4~5 字/秒,取 4.2 保守值
_CHARS_PER_SEC = 4.2
_MIN_SHOT_SEC = 2
_MAX_SHOT_SEC = 15
_DEFAULT_SHOT_SEC = 6

_NARRATOR_NAMES = {"narrator", "旁白", "narration", "vo"}

_ANCHOR_RE = re.compile(r"@\{([^{}]*)\}(.*?)@\{/\1\}", re.DOTALL)
_ANCHOR_TOKEN_RE = re.compile(r"@\{/([^{}]*)\}|@\{([^{}]*)\}")
_XML_SHOT_RE = re.compile(r"<shot\b([^>]*)>(.*?)</shot>", re.DOTALL)
_ATTR_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"')
_SPEAKER_LINE_RE = re.compile(r"^\s*<([^<>|]+)(?:\|([^<>]*))?>\s*(.*)$")
_META_LINE_RE = re.compile(r"\[([a-zA-Z_]+)\s*:\s*([^\]]*)\]\s*")
_BRACKET_LINE_RE = re.compile(r"^\s*[a-zA-Z_]+\s*:")
_SVML_DECL_RE = re.compile(r"^\s*<\?svml[^>]*\?>\s*$")


@dataclass
class Beat:
    """一个叙事拍:|| 切分出的最小朗读/演出单元。

    词锚 @{cue}…@{/cue} 可跨拍(hypit 原语义):cue 在开启到闭合之间
    经过的每一拍都记录在 cues 里,该拍内处于锚内的文字记入 anchor_words。
    """

    text: str = ""  # 剥锚后纯文本
    cues: list[str] = field(default_factory=list)  # 本拍内激活的 cue 名(按出现序)
    anchor_words: str = ""  # 本拍内处于锚内的词(拼接)


@dataclass
class ShotDraft:
    """解析产出的分镜草稿(与 _create_shots_from_analysis 的 coerced 同构)。"""

    scene: str = ""
    prompt: str = ""
    dialogue: str = ""
    speaker: str = ""
    characters: list[str] = field(default_factory=list)
    duration_sec: int = _DEFAULT_SHOT_SEC
    duration_auto: bool = True  # duration 是估算(非显式声明)
    mood: str = ""
    beat: str = ""
    beats: list[Beat] = field(default_factory=list)  # 全部拍(含台词+视觉,按序)


def strip_anchors(text: str) -> str:
    """剥离 @{cue}…@{/cue} 词锚标记,保留内部文字;未闭合锚按原文保留并报错由调用方处理。"""
    prev = None
    while prev != text:
        prev = text
        text = _ANCHOR_RE.sub(lambda m: m.group(2), text)
    return text


def _check_anchors(text: str) -> str | None:
    """返回第一个词锚语法错误的描述,无错返回 None。"""
    depth_pos: list[tuple[str, int]] = []
    for m in re.finditer(r"@\{/([^{}]*)\}|@\{([^{}]*)\}", text):
        closing, opening = m.group(1), m.group(2)
        if opening:
            depth_pos.append((opening, m.start()))
        else:
            if not depth_pos:
                return f"位置 {m.start()}: 多余的锚闭合 @{{/{closing or ''}}}"
            depth_pos.pop()
    if depth_pos:
        name, pos = depth_pos[0]
        return f"位置 {pos}: 锚 @{{{name}}} 未闭合"
    return None


def parse_beats(text: str) -> list[Beat]:
    """把一段文本按 || 切拍;@{cue}…@{/cue} 锚可跨拍,激活状态叠加到经过的拍上。"""
    beats: list[Beat] = []
    open_cues: list[str] = []
    for raw in text.split("||"):
        chunks: list[tuple[str, bool]] = []  # (片段, 是否锚内)
        cue_order = [c for c in dict.fromkeys(open_cues)]  # 进入本拍时已激活的锚
        pos = 0
        for m in _ANCHOR_TOKEN_RE.finditer(raw):
            chunks.append((raw[pos:m.start()], bool(open_cues)))
            if m.group(2):  # 开锚 @{cue}
                open_cues.append(m.group(2))
                if m.group(2) not in cue_order:
                    cue_order.append(m.group(2))
            elif open_cues:  # 闭锚 @{/cue}
                open_cues.pop()
            pos = m.end()
        chunks.append((raw[pos:], bool(open_cues)))
        text_plain = "".join(c for c, _ in chunks).strip()
        anchor_words = "".join(c for c, a in chunks if a).strip()
        if text_plain or anchor_words:
            beats.append(Beat(text=text_plain, cues=cue_order, anchor_words=anchor_words))
    return beats


def estimate_duration(text: str) -> int:
    """按剥离锚后的有效字数估时,夹在 [_MIN, _MAX];空文本回默认值。"""
    effective = re.sub(r"[\s|]+", "", strip_anchors(text))
    if not effective:
        return _DEFAULT_SHOT_SEC
    est = math.ceil(len(effective) / _CHARS_PER_SEC)
    return max(_MIN_SHOT_SEC, min(_MAX_SHOT_SEC, int(est)))


def _attrs(raw: str) -> dict[str, str]:
    return {k: v.strip() for k, v in _ATTR_RE.findall(raw)}


def _is_narrator(name: str) -> bool:
    return name.strip().lower() in _NARRATOR_NAMES


def _shot_from_blocks(
    metas: dict[str, str],
    lines: list[tuple[str, str, str]],  # (kind, speaker, text) kind∈{v,d}
) -> ShotDraft:
    shot = ShotDraft(
        scene=metas.get("scene", ""),
        mood=metas.get("mood", ""),
        beat=metas.get("beat", ""),
    )
    if metas.get("duration"):
        try:
            shot.duration_sec = max(_MIN_SHOT_SEC, min(_MAX_SHOT_SEC, int(float(metas["duration"]))))
            shot.duration_auto = False
        except ValueError:
            pass

    visual_parts: list[str] = []
    dialogue_parts: list[str] = []
    speakers: list[str] = []
    for kind, speaker, text in lines:
        # || 拍分隔不进落库文本(拍结构已在 beats 里),剥锚后以空格衔接
        cleaned = strip_anchors(text).replace("||", " ").strip()
        beats = parse_beats(text)
        shot.beats.extend(beats)
        if kind == "v":
            visual_parts.append(cleaned)
        else:
            dialogue_parts.append(cleaned)
            if speaker and not _is_narrator(speaker) and speaker not in speakers:
                speakers.append(speaker)

    shot.prompt = ", ".join(p for p in visual_parts if p)
    shot.dialogue = " ".join(d for d in dialogue_parts if d)
    if speakers:
        shot.speaker = speakers[0]
        shot.characters = speakers
    elif metas.get("speaker"):
        shot.speaker = metas["speaker"]
    if shot.duration_auto:
        shot.duration_sec = estimate_duration(shot.dialogue) if shot.dialogue else (
            max(3, 2 * len([b for b in shot.beats if not b.cues]) or _DEFAULT_SHOT_SEC)
        )
    return shot


def parse_svml_script(text: str) -> list[ShotDraft]:
    """解析 SVML-lite 脚本为分镜草稿列表。

    语法错误(未闭合锚/未闭合 shot 标签)抛 ValueError,带位置描述。
    """
    if not text or not text.strip():
        raise ValueError("脚本文本为空")

    err = _check_anchors(text)
    if err:
        raise ValueError(f"词锚语法错误:{err}")

    shots: list[ShotDraft] = []

    # 1) XML 形态:<shot …>…</shot> 块逐个解析;块外文本若含实质内容则走行式解析
    xml_spans: list[tuple[int, int]] = []
    for m in _XML_SHOT_RE.finditer(text):
        xml_spans.append(m.span())
        attrs = _attrs(m.group(1))
        body = m.group(2)
        lines: list[tuple[str, str, str]] = []
        # <v>…</v> 视觉块
        for vm in re.finditer(r"<v>(.*?)</v>", body, re.DOTALL):
            lines.append(("v", "", vm.group(1)))
            body = body.replace(vm.group(0), "", 1)
        # <名字>…</名字> / <名字|voice>…</名字|voice> 台词块
        for dm in re.finditer(r"<([^<>|/]+)(?:\|([^<>]*))?>(.*?)</\1\s*>", body, re.DOTALL):
            lines.append(("d", dm.group(1).strip(), dm.group(3)))
            body = body.replace(dm.group(0), "", 1)
        residue = body.strip()
        if residue:
            # shot 块内未包裹的散文本视作视觉描述
            lines.append(("v", "", residue))
        if lines:
            shots.append(_shot_from_blocks(attrs, lines))

    # 2) 行式形态:去掉 XML 块与声明行后按空行/--- 分镜
    rest = text
    for start, end in reversed(xml_spans):
        rest = rest[:start] + "\n" + rest[end:]
    rest = "\n".join(
        ln for ln in rest.splitlines() if not _SVML_DECL_RE.match(ln)
    )
    rest = re.sub(r"</?svml\s*>", "", rest)

    blocks: list[list[str]] = []
    cur: list[str] = []
    for ln in rest.splitlines():
        s = ln.strip()
        if s in ("---", "***", "==="):
            if cur:
                blocks.append(cur)
                cur = []
            continue
        if not s:
            if cur:
                blocks.append(cur)
                cur = []
            continue
        cur.append(ln)
    if cur:
        blocks.append(cur)

    for block in blocks:
        metas: dict[str, str] = {}
        lines: list[tuple[str, str, str]] = []
        for raw in block:
            s = raw.strip()
            meta_matches = _META_LINE_RE.findall(s)
            if meta_matches and not _BRACKET_LINE_RE.search(_META_LINE_RE.sub("", s).strip() or "x"):
                for k, v in meta_matches:
                    metas[k.lower()] = v.strip()
                s = _META_LINE_RE.sub("", s).strip()
                if not s:
                    continue
            sm = _SPEAKER_LINE_RE.match(s)
            if sm:
                # group(3)=正文(group(2) 是 |voice 提示,v1 丢弃)
                lines.append(("d", sm.group(1).strip(), sm.group(3) or ""))
            else:
                lines.append(("v", "", s))
        if lines or metas:
            shots.append(_shot_from_blocks(metas, lines))

    if not shots:
        raise ValueError("未解析出任何分镜:检查 <shot> 块或行式分段(空行/--- 分隔)")
    return shots


def drafts_to_coerced(drafts: list[ShotDraft]) -> list[dict]:
    """转成 _create_shots_from_analysis 消费的 coerced dict 列表。"""
    return [
        {
            "scene": d.scene or d.beat or "",
            "prompt": d.prompt,
            "characters": d.characters,
            "dialogue": d.dialogue,
            "speaker": d.speaker,
            "duration_sec": d.duration_sec,
            "seam_to_next": "",
            "seam_anchor": "",
            "mood": d.mood,
            "beat": d.beat,
        }
        for d in drafts
    ]
