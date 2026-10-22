"""角色设定卡包(待办 #6 拆分):constants / templates / gates / layout / retry / _impl。"""
from __future__ import annotations

from app.services.studio.character_sheet import constants as constants
from app.services.studio.character_sheet import gates as gates
from app.services.studio.character_sheet import layout as layout
from app.services.studio.character_sheet import retry as retry
from app.services.studio.character_sheet import templates as templates
from app.services.studio.character_sheet import _impl as _impl
from app.services.studio.character_sheet import ux as ux

for _mod in (constants, templates, gates, layout, retry, _impl, ux):
    globals().update({k: v for k, v in vars(_mod).items() if not k.startswith("__")})

del _mod

# F5: 各子模块函数的 __globals__ 绑在定义模块；拆分后交叉调用会 NameError。
# 包 init 后互相补齐缺失符号（不覆盖已有定义）。
def _bridge_missing(dst, *donors):
    for donor in donors:
        for k, v in vars(donor).items():
            if k.startswith("__"):
                continue
            if k not in dst.__dict__:
                setattr(dst, k, v)

_bridge_missing(gates, layout, _impl, retry, ux)
_bridge_missing(layout, gates, _impl, retry, ux)
_bridge_missing(_impl, gates, layout, retry, ux)
del _bridge_missing
