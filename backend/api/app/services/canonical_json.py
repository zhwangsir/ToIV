"""规范 JSON 序列化 —— 防跨端 sha256 漂移。

挂账 3（TL 审过）：ingest / freeze 一律走本模块，禁止 json.dumps 默认参数。

伪代码（钉死）::

    def canonical_dumps(obj) -> bytes:
        # 1. 递归规范化：dict → 按 key 的 UTF-8 字节序排序后的有序映射；
        #    list 保序；标量原样；禁止 NaN/Infinity；不输出 null 键。
        # 2. 序列化：UTF-8、separators=(',', ':')（无空白）、
        #    ensure_ascii=False、sort_keys=True（顶层与嵌套均排序）。
        # 3. 末尾不加换行；不加 BOM。
        # 4. sha256 = hashlib.sha256(canonical_dumps(obj)).hexdigest()

文件字节钉哈希（试点黄潜 JSON）：若夹具已是「磁盘上的权威字节」，
ingest 可用 raw file bytes 校验 expected_sha256；一旦进入 store，
后续 freeze/blob 比较一律用本模块对「逻辑文档」再规范化。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_dumps(obj: Any) -> bytes:
    """返回规范序列化字节（UTF-8、稳定 key 序、无空白、无尾换行）。"""
    text = json.dumps(
        obj,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return text.encode("utf-8")


def canonical_sha256(obj: Any) -> str:
    """对规范字节做 sha256 hex。"""
    return hashlib.sha256(canonical_dumps(obj)).hexdigest()


def sha256_bytes(raw: bytes) -> str:
    """对原始字节做 sha256 hex（夹具文件钉哈希用）。"""
    return hashlib.sha256(raw).hexdigest()
