"""RH 存量图的类键漂移修复(2026-10-15, ops):只加注册键,不复制第三方代码。

部署位:/opt/ComfyUI/custom_nodes/toiv_classkey_aliases/__init__.py(workstation 全实例共享树)。
来源三类(全经 object_info 实况核验过缺键):
  - Derfuu 自带但休眠的 utility/mapping_replace._mapping(Text→DF_Text 等 26 条);
  - toiv_FL_ImageBatchToGrid 只注册了无空格键,RH 图用带空格 display name 当类键;
  - ComfyUI-SCAIL-Pose 类键 RenderNLFPoses,RH 图用 "Render NLF Poses"。
失败隔离:任一兄弟包 import 失败只跳过该条并留 warning,不拖垮注册表(P-9/P-15)。
SCAIL 的 nodes.py 用相对导入:必须先挂合成包(__path__ 指向其目录)再按包内模块加载,
否则 "attempted relative import with no known parent package" 整条 alias 静默失效。
"""
import importlib.util
import logging
import pathlib
import sys
import types

log = logging.getLogger("toiv.classkey")
ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}


def _load(rel: str, name: str):
    p = ROOT / rel
    if not p.exists():
        log.warning("classkey alias skip(missing): %s", rel)
        return None
    spec = importlib.util.spec_from_file_location(name, p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001
        log.warning("classkey alias skip(import fail %s): %s", rel, e)
        return None
    return mod


def _load_in_package(rel: str, name: str):
    """按「合成包 + 包内模块」加载含相对导入的节点文件。"""
    p = ROOT / rel
    if not p.exists():
        log.warning("classkey alias skip(missing): %s", rel)
        return None
    pkg_name = f"_toivx_pkg_{p.parent.name.replace('-', '_')}"
    pkg = sys.modules.get(pkg_name)
    if pkg is None:
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(p.parent)]  # type: ignore[attr-defined]
        sys.modules[pkg_name] = pkg
    spec = importlib.util.spec_from_file_location(f"{pkg_name}.{p.stem}", p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001
        log.warning("classkey alias skip(import fail %s): %s", rel, e)
        return None
    return mod


_derf = _load("Derfuu_ComfyUI_ModdedNodes/__init__.py", "_toivx_derf")
_mr = _load("Derfuu_ComfyUI_ModdedNodes/utility/mapping_replace.py", "_toivx_derf_mr")
if _derf is not None and _mr is not None:
    for old, new in getattr(_mr, "_mapping", {}).items():
        cls = getattr(_derf, "NODE_CLASS_MAPPINGS", {}).get(new)
        if cls is not None:
            NODE_CLASS_MAPPINGS[old] = cls
            NODE_DISPLAY_NAME_MAPPINGS[old] = old

_fl = _load("toiv_FL_ImageBatchToGrid/FL_ImageBatchToGrid.py", "_toivx_fl")
if _fl is not None and hasattr(_fl, "FL_ImageBatchToGrid"):
    NODE_CLASS_MAPPINGS["FL Image Batch To Grid"] = _fl.FL_ImageBatchToGrid
    NODE_DISPLAY_NAME_MAPPINGS["FL Image Batch To Grid"] = "FL Image Batch To Grid"

_sc = _load_in_package("ComfyUI-SCAIL-Pose/nodes.py", "_toivx_scail")
if _sc is not None and hasattr(_sc, "RenderNLFPoses"):
    NODE_CLASS_MAPPINGS["Render NLF Poses"] = _sc.RenderNLFPoses
    NODE_DISPLAY_NAME_MAPPINGS["Render NLF Poses"] = "Render NLF Poses"

log.info("toiv_classkey_aliases registered %d alias keys", len(NODE_CLASS_MAPPINGS))
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
