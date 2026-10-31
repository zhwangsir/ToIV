"""Admin 模型资产域(2026-09-22,D2/D6)——静态数据只读端点。

- GET /api/admin/model-sources   模型出处清单(docs/MODEL_SOURCES.json 的部署快照;
  候选路径 app/data → 仓库 docs,60s 进程内缓存)
- GET /api/admin/test-matrix     实测矩阵 L0(结构扫描 550)+L2(真 GPU 热路径 24)
  汇总与逐行结果(静态 jsonl,部署在 app/data/app_test_matrix/)

数据均为只读静态快照,无写路径;更新源文件后重启/等缓存过期自然生效。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_admin
from app.models import User

router = APIRouter(tags=["admin-model-assets"])

_CACHE_TTL = 60.0
_cache: dict[str, tuple[float, object]] = {}

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
# 候选路径:部署快照(app/data)优先;仓库 docs(本地开发源文件)兜底
_MODEL_SOURCES_CANDIDATES = [
    _DATA_DIR / "model_sources.json",
    _DATA_DIR.parent.parent.parent.parent / "docs" / "MODEL_SOURCES.json",
]
_MATRIX_DIR = _DATA_DIR / "app_test_matrix"


def _cached(key: str, loader):
    """60s 进程内缓存(静态文件,低频读)。"""
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < _CACHE_TTL:
        return hit[1]
    data = loader()
    _cache[key] = (time.monotonic(), data)
    return data


def _load_model_sources() -> dict:
    for p in _MODEL_SOURCES_CANDIDATES:
        if p.is_file():
            try:
                data = json.loads(p.read_text())
            except (ValueError, OSError) as e:
                raise HTTPException(status_code=500, detail=f"模型出处清单损坏: {e}") from e
            if isinstance(data, dict) and isinstance(data.get("items"), list):
                data["_source_path"] = str(p)
                return data
            raise HTTPException(status_code=500, detail="模型出处清单结构非法(缺 items)")
    raise HTTPException(status_code=404, detail="模型出处清单未部署(app/data/model_sources.json 缺失)")


def _load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError):
        return None


def _load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                rows.append(obj)
    except OSError:
        pass
    return rows


@router.get("/admin/model-sources")
def model_sources(_: User = Depends(get_current_admin)) -> dict:
    """模型出处清单(D2 只读视图):updated_at/totals/sources_scanned/items(813)。

    items 条目:basename/rel_path/source_kind/source_url/repo/revision/filename/
    license_or_gated/downloaded_at/status(ok|blocked)/bytes/notes/batch。
    """
    data = _cached("model_sources", _load_model_sources)
    return {
        "updated_at": data.get("updated_at"),
        "totals": data.get("totals") or {},
        "sources_scanned": data.get("sources_scanned") or [],
        "items": data.get("items") or [],
    }


@router.get("/admin/test-matrix")
def test_matrix(_: User = Depends(get_current_admin)) -> dict:
    """实测矩阵(D6):L0 结构扫描 + L2 真 GPU 热路径的汇总与逐行结果。

    数据为静态快照(app/data/app_test_matrix/,源自 .regen_tmp 2026-09-11 批次);
    L0=550 应用结构检查(无 GPU),L2=24 热路径真提交(含 run_http/run_response)。
    """
    def _load() -> dict:
        cands_raw = _load_json(_MATRIX_DIR / "l2_hotpath_candidates.json")
        # 文件是 {generated_at,count,selection_notes,candidates:[…]} 包装;兼容裸数组
        if isinstance(cands_raw, dict):
            cands = cands_raw.get("candidates") or []
        elif isinstance(cands_raw, list):
            cands = cands_raw
        else:
            cands = []
        return {
            "l0_summary": _load_json(_MATRIX_DIR / "l0_summary.json"),
            "l0_results": _load_jsonl(_MATRIX_DIR / "l0_results.jsonl"),
            "l2_summary": _load_json(_MATRIX_DIR / "l2_summary.json"),
            "l2_results": _load_jsonl(_MATRIX_DIR / "l2_results.jsonl"),
            "l2_candidates": cands,
        }

    data = _cached("test_matrix", _load)
    if data["l0_summary"] is None and data["l2_summary"] is None:
        raise HTTPException(status_code=404, detail="实测矩阵结果未部署(app/data/app_test_matrix/ 缺失)")
    return data
