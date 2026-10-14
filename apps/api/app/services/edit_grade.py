"""渲染后自评闭环：客观 QA + 上限 3 轮找茬（FU2 件 5）。

移植自 video-use(MIT, Copyright (c) 2026 Browser Use) helpers/grade.py 与 SKILL 的
「渲染后自评」理念：对成片量响度(ebur128)、查黑场/冻结帧、切点爆音由渲染件 30ms
淡入淡出预防；VLM 找茬复用 eval_scorers.resolve_scorer(auto→VLM,缺配置落启发式),
不新造客户端。上限 3 轮,修不动就上报,不无限重渲。
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

#  web/短视频响度工作带(LUFS I);出带即 finding,由修复回调决定增益或上报
LOUDNESS_BAND = (-24.0, -12.0)
MAX_ROUNDS = 3

_I_RE = re.compile(r"I:\s+(-?\d+(?:\.\d+)?)\s+LUFS")
_LRA_RE = re.compile(r"LRA:\s+(\d+(?:\.\d+)?)\s+LU")
_BLACK_RE = re.compile(r"black_start:\s*(\d+(?:\.\d+)?)\s*black_end:\s*(\d+(?:\.\d+)?)")
_FREEZE_RE = re.compile(r"freeze_start:\s*(\d+(?:\.\d+)?)")


def _ffnull(video: Path, vf: str | None, af: str | None) -> str:
    cmd = ["ffmpeg", "-hide_banner", "-i", str(video)]
    if vf:
        cmd += ["-vf", vf]
    if af:
        cmd += ["-af", af]
    cmd += ["-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return r.stderr


def qa_render(video: Path, loudness_band: tuple[float, float] = LOUDNESS_BAND) -> dict:
    """量响度 + 黑场 + 冻结帧;返回 metrics 与 findings(空=自检过)。"""
    err_l = _ffnull(video, None, "ebur128=peak=true")
    err_v = _ffnull(video, "blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=1", None)
    m_i = _I_RE.search(err_l)
    m_lra = _LRA_RE.search(err_l)
    loudness = float(m_i.group(1)) if m_i else None
    blacks = [(float(a), float(b)) for a, b in _BLACK_RE.findall(err_v)]
    freezes = [float(t) for t in _FREEZE_RE.findall(err_v)]
    findings: list[dict] = []
    if loudness is None:
        findings.append({"kind": "no_audio", "message": "ebur128 未读出响度(可能无音轨)"})
    elif not (loudness_band[0] <= loudness <= loudness_band[1]):
        findings.append({"kind": "loudness_out_of_band", "value": loudness,
                         "message": f"响度 I={loudness} LUFS 出工作带 {loudness_band}"})
    for b in blacks:
        findings.append({"kind": "black_span", "span": b,
                         "message": f"黑场 {b[0]:.2f}-{b[1]:.2f}s(切点或素材问题)"})
    for t in freezes:
        findings.append({"kind": "freeze", "at": t, "message": f"冻结帧起点 {t:.2f}s"})
    return {"loudness_i": loudness,
            "lra": float(m_lra.group(1)) if m_lra else None,
            "black_spans": blacks, "freeze_starts": freezes,
            "findings": findings}


def self_review_loop(render, qa, fix=None, *, critic=None, max_rounds: int = MAX_ROUNDS) -> dict:
    """render→qa→(critic)→fix 循环;findings 空即过,修不动或到上限即停并上报。"""
    rounds: list[dict] = []
    out = None
    for i in range(max_rounds):
        out = render()
        metrics = qa(out)
        findings = list(metrics.get("findings") or [])
        if critic:
            findings = findings + list(critic(out) or [])
        rounds.append({"round": i, "out": out, "metrics": metrics, "findings": findings})
        if not findings:
            return {"ok": True, "rounds": rounds, "out": out}
        if fix is None or not fix(out, findings, metrics):
            break
    return {"ok": False, "rounds": rounds, "out": out}
