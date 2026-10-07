"""短剧视频步管线名（单一来源）。

用户 2026-10-07 拍板：默认 = 逐镜独立 Ref2VA（每镜 4 张定妆参考，不续写上一镜）+ 首尾帧拼接成片；
Motion Context 续写族（c / c_hybrid）保留为显式可选。
"""
from __future__ import annotations

# 逐镜独立 Ref2VA：不读 / 不写 context_latent，不接首帧
INDEP_PIPELINE = "ref2va"
# Motion Context 续写族：c = Ref2VA+MotionContext；c_hybrid = 首帧锚定 Hybrid
C_PIPELINES: tuple[str, ...] = ("c", "c_hybrid")
# H3 可选管线（legacy 另算：旧 t2v 回退）
VIDEO_PIPELINES: tuple[str, ...] = (INDEP_PIPELINE,) + C_PIPELINES
DEFAULT_VIDEO_PIPELINE = INDEP_PIPELINE
# 每镜定妆参考张数（《两小时的注定》v2 实证档）
INDEP_REFS_PER_SHOT = 4
