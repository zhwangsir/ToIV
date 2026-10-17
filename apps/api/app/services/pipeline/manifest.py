"""FU5 管线 manifest 声明化:stage/skill/produces/success_criteria + 校验 + 归档。

理念借鉴 OpenMontage 的「管线即声明」思想(AGPL,**只读借鉴理念,未抄任何
代码/文本**):把合成管线表达成可校验的声明数据,而不是散落的过程脚本——
每段(stage)声明所需 skill、产出(produces)与成功判据(success_criteria),
checkpoint/history 以 append-only 事件归档,素材以 manifest 内 id 引用解析。

本模块是 ToIV 自研实现,纯数据模型:
- validate_manifest:手写的 JSON Schema 等价校验(必填字段/类型/未知键/重复 id)
- History/Event:append-only 归档(append 返回新实例,旧实例不可变)
- resolve_asset_refs:把引用 id 解析成 manifest 内素材定义
- drama_compose_manifest:短剧合成 6 段内置模板(script→assets→shots→render→
  voice→compose)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence


class ManifestError(ValueError):
    """manifest 声明不合法(缺字段/类型错/未知键/引用不存在)。"""


# --------------------------------------------------------------- 声明模型


@dataclass(frozen=True)
class Stage:
    """一段管线:skill 执行体、产出键、成功判据、可选上游素材引用(needs)。"""

    id: str
    skill: str
    produces: tuple[str, ...]
    success_criteria: tuple[str, ...]
    needs: tuple[str, ...] = ()


@dataclass(frozen=True)
class AssetRef:
    """manifest 内素材定义:id 为引用键,kind 分类,url/hash 为可选定位。"""

    id: str
    kind: str
    url: str | None = None
    hash: str | None = None


@dataclass(frozen=True)
class Manifest:
    """一份管线声明:name 全局标识,stages 有序,assets 供 id 引用解析。"""

    name: str
    stages: tuple[Stage, ...]
    assets: tuple[AssetRef, ...] = ()
    version: int = 1


# --------------------------------------------------------------- 手写校验


_STAGE_REQUIRED = ("id", "skill", "produces", "success_criteria")
_STAGE_OPTIONAL = ("needs",)
_ASSET_REQUIRED = ("id", "kind")
_ASSET_OPTIONAL = ("url", "hash")
_MANIFEST_REQUIRED = ("name", "stages")
_MANIFEST_OPTIONAL = ("version", "assets")


def _require_str(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{path} 必须是非空字符串")
    return value.strip()


def _require_str_list(value: Any, path: str, *, allow_empty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ManifestError(f"{path} 必须是字符串列表")
    out = []
    for i, item in enumerate(value):
        out.append(_require_str(item, f"{path}[{i}]"))
    if not out and not allow_empty:
        raise ManifestError(f"{path} 不能为空")
    return tuple(out)


def _check_keys(data: Mapping[str, Any], required: Sequence[str], optional: Sequence[str], path: str) -> None:
    for key in required:
        if key not in data:
            raise ManifestError(f"{path} 缺少必填字段:{key}")
    allowed = set(required) | set(optional)
    for key in data:
        if key not in allowed:
            raise ManifestError(f"{path} 含未知字段:{key}")


def _parse_stage(data: Any, path: str) -> Stage:
    if not isinstance(data, Mapping):
        raise ManifestError(f"{path} 必须是对象")
    _check_keys(data, _STAGE_REQUIRED, _STAGE_OPTIONAL, path)
    needs = _require_str_list(data["needs"], f"{path}.needs", allow_empty=True) if "needs" in data else ()
    return Stage(
        id=_require_str(data["id"], f"{path}.id"),
        skill=_require_str(data["skill"], f"{path}.skill"),
        produces=_require_str_list(data["produces"], f"{path}.produces"),
        success_criteria=_require_str_list(data["success_criteria"], f"{path}.success_criteria"),
        needs=needs,
    )


def _parse_asset(data: Any, path: str) -> AssetRef:
    if not isinstance(data, Mapping):
        raise ManifestError(f"{path} 必须是对象")
    _check_keys(data, _ASSET_REQUIRED, _ASSET_OPTIONAL, path)
    url = data.get("url")
    ah = data.get("hash")
    if url is not None and not isinstance(url, str):
        raise ManifestError(f"{path}.url 必须是字符串")
    if ah is not None and not isinstance(ah, str):
        raise ManifestError(f"{path}.hash 必须是字符串")
    return AssetRef(
        id=_require_str(data["id"], f"{path}.id"),
        kind=_require_str(data["kind"], f"{path}.kind"),
        url=url,
        hash=ah,
    )


def validate_manifest(data: Mapping[str, Any]) -> Manifest:
    """手写 JSON Schema 等价校验:必填字段/类型/未知键/重复 stage id 全拒。"""
    if not isinstance(data, Mapping):
        raise ManifestError("manifest 必须是对象")
    _check_keys(data, _MANIFEST_REQUIRED, _MANIFEST_OPTIONAL, "manifest")
    name = _require_str(data["name"], "manifest.name")
    raw_stages = data["stages"]
    if not isinstance(raw_stages, list) or not raw_stages:
        raise ManifestError("manifest.stages 必须是非空列表")
    stages = tuple(_parse_stage(s, f"manifest.stages[{i}]") for i, s in enumerate(raw_stages))
    seen: set[str] = set()
    for s in stages:
        if s.id in seen:
            raise ManifestError(f"manifest.stages 重复 id:{s.id}")
        seen.add(s.id)
    raw_assets = data.get("assets", [])
    if not isinstance(raw_assets, list):
        raise ManifestError("manifest.assets 必须是列表")
    assets = tuple(_parse_asset(a, f"manifest.assets[{i}]") for i, a in enumerate(raw_assets))
    version = data.get("version", 1)
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ManifestError("manifest.version 必须是正整数")
    return Manifest(name=name, stages=stages, assets=assets, version=version)


# --------------------------------------------------------------- 归档结构


@dataclass(frozen=True)
class Event:
    """归档事件:kind 分类,at 时间戳,data 任意载荷(checkpoint 带 stage 三元组)。"""

    kind: str
    at: str
    data: Mapping[str, Any] = field(default_factory=dict)


def checkpoint_event(
    stage_id: str,
    status: str,
    produced: Sequence[str] = (),
    at: str = "",
) -> Event:
    """stage checkpoint 事件:记录到哪一段、什么状态、产出了什么。"""
    return Event(
        kind="checkpoint",
        at=at,
        data={
            "stage_id": _require_str(stage_id, "checkpoint.stage_id"),
            "status": _require_str(status, "checkpoint.status"),
            "produced": tuple(produced),
        },
    )


@dataclass(frozen=True)
class History:
    """append-only 事件流:append 返回新实例,旧实例永不被改写。"""

    events: tuple[Event, ...] = ()

    def append(self, event: Event) -> "History":
        if not isinstance(event, Event):
            raise ManifestError("History.append 只接受 Event")
        return History(events=self.events + (event,))

    def to_json(self) -> str:
        return json.dumps(
            [
                {"kind": e.kind, "at": e.at, "data": dict(e.data)}
                for e in self.events
            ],
            ensure_ascii=False,
        )

    @classmethod
    def from_json(cls, raw: str) -> "History":
        try:
            rows = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise ManifestError(f"History JSON 解析失败:{exc}") from exc
        if not isinstance(rows, list):
            raise ManifestError("History JSON 必须是事件数组")
        events: list[Event] = []
        for i, row in enumerate(rows):
            if not isinstance(row, Mapping) or "kind" not in row or "at" not in row:
                raise ManifestError(f"History 事件 [{i}] 缺 kind/at")
            data = row.get("data", {})
            if not isinstance(data, Mapping):
                raise ManifestError(f"History 事件 [{i}] 的 data 必须是对象")
            # tuple 在 JSON 里退化为 list,恢复时统一还原成 tuple 保持形状稳定
            norm = {k: tuple(v) if isinstance(v, list) else v for k, v in data.items()}
            events.append(Event(kind=str(row["kind"]), at=str(row["at"]), data=norm))
        return cls(events=tuple(events))


# --------------------------------------------------------------- 引用解析


def resolve_asset_refs(manifest: Manifest, refs: Sequence[str]) -> dict[str, AssetRef]:
    """把引用 id 解析为 manifest 内素材定义;任何未知 id 直接报错(不静默跳过)。"""
    by_id = {a.id: a for a in manifest.assets}
    out: dict[str, AssetRef] = {}
    for ref in refs:
        asset = by_id.get(ref)
        if asset is None:
            raise ManifestError(f"manifest 内不存在素材引用:{ref}")
        out[ref] = asset
    return out


# --------------------------------------------------------------- 内置模板


def _stage_dict(sid: str, skill: str, produces: Sequence[str], criteria: Sequence[str], needs: Sequence[str] = ()) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": sid,
        "skill": skill,
        "produces": list(produces),
        "success_criteria": list(criteria),
    }
    if needs:
        d["needs"] = list(needs)
    return d


#: 短剧合成 6 段内置模板(声明形态;script→assets→shots→render→voice→compose)
DRAMA_COMPOSE_MANIFEST_DICT: dict[str, Any] = {
    "name": "drama-compose",
    "version": 1,
    "stages": [
        _stage_dict(
            "script",
            "drama.script",
            ("script_doc",),
            ("script_doc 非空且含至少一幕",),
        ),
        _stage_dict(
            "assets",
            "drama.assets",
            ("character_refs", "scene_refs"),
            ("每个出场角色有参考图", "每个场景有参考图"),
            needs=("script_doc",),
        ),
        _stage_dict(
            "shots",
            "drama.shots",
            ("shot_list",),
            ("每个场景至少一个分镜", "分镜含 prompt 与预估时长"),
            needs=("script_doc", "character_refs", "scene_refs"),
        ),
        _stage_dict(
            "render",
            "drama.render",
            ("shot_videos",),
            ("每个分镜产出视频且时长偏差<20%",),
            needs=("shot_list",),
        ),
        _stage_dict(
            "voice",
            "drama.voice",
            ("voice_tracks",),
            ("每句台词有配音轨且与分镜对齐",),
            needs=("shot_list",),
        ),
        _stage_dict(
            "compose",
            "drama.compose",
            ("final_cut",),
            ("音画轨齐全", "总时长与分镜时长和一致±2s"),
            needs=("shot_videos", "voice_tracks"),
        ),
    ],
    "assets": [],
}


def drama_compose_manifest() -> Manifest:
    """返回通过校验的短剧合成 6 段模板(模板即数据,与手写 manifest 同校验)。"""
    return validate_manifest(DRAMA_COMPOSE_MANIFEST_DICT)
