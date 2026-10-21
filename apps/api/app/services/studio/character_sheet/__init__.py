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
