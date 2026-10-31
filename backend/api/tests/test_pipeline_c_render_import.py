"""部署门禁：pipeline_c_render 必须可直接 import（延迟导入会漏掉语法错）。"""
from __future__ import annotations


def test_pipeline_c_render_imports_clean():
    import app.services.studio.pipeline_c_render as m

    assert hasattr(m, "render_pipeline_c")
    assert callable(m.render_pipeline_c)
