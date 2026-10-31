"""baseline:现网 schema 锚点(空操作)。

Revision ID: 20261018_0001
Revises:
Create Date: 2026-10-18

切流策略:对已与 models/双轨对齐的库执行 `alembic stamp head`,
不要对生产跑本 revision 的 upgrade 指望它建表(upgrade/downgrade 均为 noop)。
后续增量 revision 才用 op.* 改 schema;双轨 _SQLITE_* 退场见 cutover 计划。
"""
from __future__ import annotations

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "20261018_0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """noop — 以 stamp 对齐现网,避免重复 create。"""
    pass


def downgrade() -> None:
    """noop — baseline 不可回滚为「无库」。"""
    pass
