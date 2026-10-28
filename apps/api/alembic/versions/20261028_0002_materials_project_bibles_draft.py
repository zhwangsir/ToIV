"""DRAFT: material_* + project_bible* 空表骨架（未强制 apply）。

Revision ID: 20261028_0002
Revises: 20261018_0001
Create Date: 2026-10-28

本 revision 为 P0 API-only 落地挂账的 migrate **草稿**：
- 不要求生产 `alembic upgrade`；API 骨架走内存仓
- 表结构对齐 `.local/design-drafts/PROJECT_BIBLE_AND_MATERIAL_API_DRAFT.md` §2.5 / §3.3
- 若误在生产执行：仅 CREATE TABLE IF NOT EXISTS 语义（下方用 op.create_table）
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261028_0002"
down_revision: Union[str, Sequence[str], None] = "20261018_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "material_catalog",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("title", sa.Text()),
        sa.Column("summary", sa.Text()),
        sa.Column("category", sa.Text()),
        sa.Column("language", sa.Text()),
        sa.Column("status", sa.Text()),
        sa.Column("trust", sa.Text()),
        # 展示用；运行时禁止隐式 latest
        sa.Column("latest_version", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "material_version",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("material_id", sa.Text(), sa.ForeignKey("material_catalog.id"), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("blob_key", sa.Text(), nullable=False),
        sa.Column("bytes", sa.Integer()),
        sa.Column("meta_json", sa.Text()),
        sa.Column("published", sa.Boolean()),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("material_id", "version", name="uq_material_version"),
    )
    op.create_table(
        "project_bible",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("tenant_id", sa.Text(), index=True),
        sa.Column("title", sa.Text()),
        sa.Column("status", sa.Text()),
        sa.Column("current_version", sa.Text()),
        sa.Column("frozen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("facts_json", sa.Text()),
        sa.Column("characters_json", sa.Text()),
        sa.Column("locations_json", sa.Text()),
        sa.Column("timeline_beats_json", sa.Text()),
        sa.Column("style_prefix", sa.Text()),
        sa.Column("copyright_bans_json", sa.Text()),
        sa.Column("music_slots_json", sa.Text()),
        sa.Column("extensions_json", sa.Text()),
        sa.Column("change_log_json", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "project_bible_version",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("bible_id", sa.Text(), sa.ForeignKey("project_bible.id"), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text()),
        sa.Column("blob_key", sa.Text()),
        sa.Column("status", sa.Text()),
        sa.Column("frozen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("change_note", sa.Text()),
        sa.Column("created_by", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("bible_id", "version", name="uq_project_bible_version"),
    )


def downgrade() -> None:
    op.drop_table("project_bible_version")
    op.drop_table("project_bible")
    op.drop_table("material_version")
    op.drop_table("material_catalog")
