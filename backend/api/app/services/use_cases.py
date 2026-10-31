"""市场策展层(2026-09-12):应用用途分类体系常量。

与 App.category(按产物形态: image/video/audio/...)正交 —— use_case 按用户意图
(短剧/数字人/换脸/换装...)归类,供市场分类导航/合集位/搜索强化使用。
"""
from __future__ import annotations

# (id, 中文 label);顺序即市场导航展示顺序
USE_CASES: list[tuple[str, str]] = [
    ("drama", "短剧剧情"),
    ("avatar", "数字人口播"),
    ("face", "换脸人像"),
    ("fashion", "换装穿搭"),
    ("ecommerce", "电商产品"),
    ("anime", "动漫二次元"),
    ("art", "艺术创作"),
    ("photo", "写实摄影"),
    ("edit", "图片编辑"),
    ("motion", "动作迁移"),
    ("ad", "广告营销"),
    ("other", "其他"),
]

USE_CASE_IDS: set[str] = {uc for uc, _ in USE_CASES}

USE_CASE_LABELS: dict[str, str] = dict(USE_CASES)
