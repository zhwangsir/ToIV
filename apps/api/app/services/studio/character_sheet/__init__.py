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

# F5: gates 内函数 __globals__ 绑在 gates 模块；layout/_impl 符号需运行时注入，
# 否则 assert_expr_base_face_area / assert_costume_cells_nonempty 等会 NameError。
for _donor in (layout, _impl):
    for _k, _v in vars(_donor).items():
        if _k.startswith("__"):
            continue
        if _k not in gates.__dict__:
            setattr(gates, _k, _v)
del _donor, _k, _v
