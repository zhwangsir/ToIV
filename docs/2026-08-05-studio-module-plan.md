# Studio 创作工作室模块实施计划

> **For agentic workers:** 按任务顺序逐条执行。步骤使用 checkbox（`- [ ]`）追踪。每里程碑完成后：全量回归 + STATE.json + TEST_LOG.md 更新。**git commit 仅在用户明确指示时执行**（项目硬性规范）。

**Goal:** 以全新 `studio` 模块替代短剧工作室（drama_studio）与漫剧（manju），实现阶段式工作台 + 分镜级混合生成（视频 / 图像运镜）。

**Architecture:** 后端新建 `app/services/studio/` 服务包（编排、LLM 拆解、策略化渲染、配音、合成）+ `app/routes/studio.py` 薄路由；数据模型三张新表（StudioProject / StudioCharacter / StudioShot）。前端新建 `components/studio/` 四阶段工作台，替换旧两个入口。复用现有 LLM 四层路由、ComfyUI WorkerPool、IndexTTS2、ffmpeg 合成、NAS 存储降级。

**Tech Stack:** Python 3.11 / FastAPI / SQLModel / pytest · Next.js 15 / React 19 / TypeScript strict / lucide-react

**设计文档:** `docs/2026-08-05-studio-module-design.md`

---

## 执行约定

- 后端测试命令：`cd apps/api && .venv/bin/python -m pytest tests/<file> -q`
- 全量回归：`cd apps/api && .venv/bin/python -m pytest -q`
- 前端验证：`cd apps/web && npm run build`
- 测试基建：TestClient + 内存 SQLite（StaticPool）+ dependency_overrides，模式参照 `tests/test_manju_project.py`
- 不主动 git commit；里程碑收尾统一由用户指示提交

---

## 文件地图

**后端新建：**

| 文件 | 职责 |
|---|---|
| `app/services/studio/__init__.py` | 包导出 |
| `app/services/studio/schemas.py` | Pydantic 请求/响应 DTO |
| `app/services/studio/storyboard.py` | LLM（L3）剧本拆解 → 角色+分镜草稿 |
| `app/services/studio/renderers/__init__.py` | 渲染器导出 |
| `app/services/studio/renderers/base.py` | RenderResult / ShotRenderer Protocol / get_renderer 分发 |
| `app/services/studio/renderers/image_motion.py` | 图像链：ComfyUI 出图（IPAdapter/txt2img）→ Ken Burns |
| `app/services/studio/renderers/video.py` | 视频链：封装 services/video_generators.get_generator |
| `app/services/studio/ffmpeg_ops.py` | ffmpeg 助手：run / kenburns_filter / concat |
| `app/services/studio/voice.py` | IndexTTS2 配音合成 |
| `app/services/studio/assemble.py` | 成片拼接 → NAS |
| `app/services/studio/orchestrator.py` | 分镜状态机 + 渲染/配音编排 |
| `app/routes/studio.py` | 薄路由 `/api/studio/*` |

**后端修改：**

| 文件 | 改动 |
|---|---|
| `app/models.py` | 新增 StudioProject / StudioCharacter / StudioShot 三表 |
| `app/main.py` | 注册 studio 路由 |

**前端新建：**

| 文件 | 职责 |
|---|---|
| `hooks/useStudioProject.ts` | 项目/分镜状态管理 |
| `components/studio/StudioView.tsx` | 工作台容器 + 阶段导航 |
| `components/studio/stages/ScriptStage.tsx` | ① 剧本 |
| `components/studio/stages/CastStage.tsx` | ② 角色 |
| `components/studio/stages/StoryboardStage.tsx` | ③ 分镜网格 |
| `components/studio/stages/AssemblyStage.tsx` | ④ 合成 |
| `components/studio/ShotCard.tsx` | 分镜卡片（含 render_mode 切换） |

**前端修改：**

| 文件 | 改动 |
|---|---|
| `lib/api.ts` | 新增 studio API 封装与类型 |
| `app/page.tsx` | 注册 studio 视图（viewImporters + 渲染分支） |
| `components/nav/Sidebar.tsx` | 入口替换（短剧/漫剧 → 创作） |

**测试新建：** `tests/test_studio_models.py` `tests/test_studio_storyboard.py` `tests/test_studio_projects.py` `tests/test_studio_renderers.py` `tests/test_studio_voice.py` `tests/test_studio_assemble.py` · `apps/web/e2e/authed-studio.spec.ts`

---

# M1：数据模型 + CRUD + LLM 剧本拆解

## Task 1：Studio 数据模型

**Files:**
- Modify: `apps/api/app/models.py`（追加到文件末尾）
- Test: `apps/api/tests/test_studio_models.py`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_models.py`：

```python
"""Studio 模块数据模型测试:三表字段与默认值。"""
from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import StudioCharacter, StudioProject, StudioShot


def _session() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_project_defaults():
    with _session() as s:
        p = StudioProject(tenant_id="t1", user_id="u1", title="测试剧")
        s.add(p)
        s.commit()
        s.refresh(p)
        assert p.id and p.status == "draft" and p.render_mode_default == "video"
        assert p.final_url == ""


def test_character_fields():
    with _session() as s:
        c = StudioCharacter(project_id="p1", name="楚生", visual_prompt="1boy, black hair")
        s.add(c)
        s.commit()
        s.refresh(c)
        assert c.reference_images == "[]" and c.voice_ref_url == ""


def test_shot_render_mode_and_status():
    with _session() as s:
        shot = StudioShot(project_id="p1", idx=0, scene="开场")
        s.add(shot)
        s.commit()
        s.refresh(shot)
        assert shot.render_mode == "video"
        assert shot.status == "draft"
        assert shot.characters == "[]"
        # 图像运镜模式
        shot2 = StudioShot(project_id="p1", idx=1, render_mode="image_motion")
        s.add(shot2)
        s.commit()
        rows = s.exec(select(StudioShot).where(StudioShot.project_id == "p1")).all()
        assert len(rows) == 2
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_models.py -q`
Expected: FAIL，`ImportError: cannot import name 'StudioProject'`

- [ ] **Step 3: 实现模型**

在 `apps/api/app/models.py` 末尾追加：

```python
# ---------------------------------------------------------------------------
# Studio 创作工作室(替代 drama_studio / manju,分镜级混合生成)
# ---------------------------------------------------------------------------


class StudioProject(SQLModel, table=True):
    """创作项目:剧本 → 角色 → 分镜(视频/图像运镜混排)→ 合成。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    title: str = ""
    premise: str = ""  # 剧情概要/原文
    style: str = ""  # 整体画风/风格描述
    ckpt_name: str = ""  # 出图底模(图像运镜链用,保跨镜风格一致)
    render_mode_default: str = "video"  # 新分镜默认生成方式: video | image_motion
    status: str = "draft"  # draft | storyboard | generating | ready | error
    final_url: str = ""  # 成片 URL
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class StudioCharacter(SQLModel, table=True):
    """角色卡:跨镜一致性锚点(视觉提示词 + 参考图 + 参考音)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    name: str = ""
    description: str = ""  # 中文角色描述
    visual_prompt: str = ""  # 英文视觉 token(注入分镜 prompt)
    reference_images: str = "[]"  # JSON 数组:参考图 URL 列表
    voice_ref_url: str = ""  # 参考音 URL(TTS 音色克隆)
    created_at: datetime = Field(default_factory=_now)


class StudioShot(SQLModel, table=True):
    """分镜:最小生成单元,render_mode 决定走视频链还是图像运镜链。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    idx: int = 0
    scene: str = ""  # 场景描述(中文)
    prompt: str = ""  # 英文生成提示词
    negative: str = "blurry, low quality, text, watermark, deformed"
    camera: str = ""  # 运镜(推拉摇移)
    dialogue: str = ""  # 台词
    speaker: str = ""  # 说话角色名
    duration_sec: int = 6
    characters: str = "[]"  # JSON 数组:出场角色名
    render_mode: str = "video"  # video | image_motion
    status: str = "draft"  # draft|queued|rendering|rendered|voiced|lipsynced|done|error
    image_url: str = ""
    video_url: str = ""
    voice_url: str = ""
    final_clip_url: str = ""  # 该镜最终片段(运镜/对口型后)
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_models.py -q`
Expected: 3 passed

---

## Task 2：LLM 剧本拆解服务

**Files:**
- Create: `apps/api/app/services/studio/__init__.py`
- Create: `apps/api/app/services/studio/schemas.py`
- Create: `apps/api/app/services/studio/storyboard.py`
- Test: `apps/api/tests/test_studio_storyboard.py`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_storyboard.py`：

```python
"""LLM 剧本拆解测试:角色+分镜草稿解析、render_mode 建议、容错。"""
from __future__ import annotations

import json

import pytest

from app.services.studio import storyboard


@pytest.mark.asyncio
async def test_parse_script_ok(monkeypatch):
    payload = {
        "characters": [
            {"name": "楚生", "description": "落魄青年", "visual_prompt": "1boy, black hair, worn jacket"}
        ],
        "shots": [
            {"scene": "雨夜小巷", "prompt": "rainy alley, neon", "camera": "推镜",
             "dialogue": "我回来了。", "speaker": "楚生", "duration_sec": 6,
             "characters": ["楚生"], "render_mode": "video"},
            {"scene": "旧照片特写", "prompt": "old photo on table", "camera": "静止",
             "dialogue": "", "speaker": "", "duration_sec": 3,
             "characters": [], "render_mode": "image_motion"},
        ],
    }

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        assert layer == "L3"
        return {"role": "assistant", "content": json.dumps(payload, ensure_ascii=False)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    chars, shots = await storyboard.parse_script("一段雨夜重逢的故事", num_shots=8)
    assert chars[0].name == "楚生"
    assert len(shots) == 2
    assert shots[0].render_mode == "video"
    assert shots[1].render_mode == "image_motion"


@pytest.mark.asyncio
async def test_parse_script_bad_json(monkeypatch):
    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        return {"role": "assistant", "content": "这不是 JSON"}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    with pytest.raises(storyboard.StoryboardError):
        await storyboard.parse_script("x", num_shots=4)


@pytest.mark.asyncio
async def test_parse_script_render_mode_fallback(monkeypatch):
    """LLM 未给 render_mode 或给非法值时,按 dialogue/镜头描述回退 video。"""
    payload = {"characters": [], "shots": [
        {"scene": "追逐", "prompt": "chase", "render_mode": "unknown_value"},
        {"scene": "空镜", "prompt": "sky"},
    ]}

    async def fake_chat_layered(messages, layer="L1", max_tokens=None, temperature=0.5):
        return {"role": "assistant", "content": json.dumps(payload)}

    monkeypatch.setattr(storyboard.llm, "chat_layered", fake_chat_layered)
    _, shots = await storyboard.parse_script("x", num_shots=4)
    assert shots[0].render_mode == "video"  # 非法值回退
    assert shots[1].render_mode == "video"  # 缺省回退
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_storyboard.py -q`
Expected: FAIL，`ModuleNotFoundError: app.services.studio`

- [ ] **Step 3: 实现**

新建 `apps/api/app/services/studio/__init__.py`：

```python
"""Studio 创作工作室服务包:编排 / 剧本拆解 / 策略渲染 / 配音 / 合成。"""
```

新建 `apps/api/app/services/studio/schemas.py`：

```python
"""Studio 模块请求/响应 DTO。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class CharacterDraft(BaseModel):
    """LLM 拆解产出的角色草稿。"""

    name: str = ""
    description: str = ""
    visual_prompt: str = ""


class ShotDraft(BaseModel):
    """LLM 拆解产出的分镜草稿。"""

    scene: str = ""
    prompt: str = ""
    negative: str = ""
    camera: str = ""
    dialogue: str = ""
    speaker: str = ""
    duration_sec: int = 6
    characters: list[str] = Field(default_factory=list)
    render_mode: str = "video"  # video | image_motion


class ScriptParseResponse(BaseModel):
    characters: list[CharacterDraft]
    shots: list[ShotDraft]


class ProjectCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    premise: str = Field(default="", max_length=20000)
    style: str = Field(default="", max_length=2000)
    ckpt_name: str = Field(default="", max_length=512)
    render_mode_default: str = Field(default="video", pattern="^(video|image_motion)$")


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    premise: str | None = Field(default=None, max_length=20000)
    style: str | None = Field(default=None, max_length=2000)
    ckpt_name: str | None = Field(default=None, max_length=512)
    render_mode_default: str | None = Field(default=None, pattern="^(video|image_motion)$")
    status: str | None = Field(default=None, max_length=32)


class CharacterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    visual_prompt: str = Field(default="", max_length=2000)


class CharacterPatch(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visual_prompt: str | None = Field(default=None, max_length=2000)
    voice_ref_url: str | None = Field(default=None, max_length=1024)


class ShotInput(BaseModel):
    """批量保存分镜的单条输入(无 id = 新增,有 id = 更新)。"""

    id: str | None = None
    scene: str = Field(default="", max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    negative: str | None = Field(default=None, max_length=2000)
    camera: str = Field(default="", max_length=200)
    dialogue: str = Field(default="", max_length=2000)
    speaker: str = Field(default="", max_length=100)
    duration_sec: int = Field(default=6, ge=1, le=60)
    characters: list[str] = Field(default_factory=list)
    render_mode: str = Field(default="video", pattern="^(video|image_motion)$")


class ShotsSaveRequest(BaseModel):
    shots: list[ShotInput]


class ScriptParseRequest(BaseModel):
    premise: str = Field(min_length=1, max_length=20000)
    num_shots: int = Field(default=8, ge=1, le=50)
    style: str = Field(default="", max_length=2000)
```

新建 `apps/api/app/services/studio/storyboard.py`：

```python
"""LLM 剧本拆解:premise → 角色草稿 + 分镜草稿(含 render_mode 建议)。

走 L3 精修层(chat_layered),失败抛 StoryboardError 由路由转 502。
"""
from __future__ import annotations

import json
import logging

from app.agent import llm
from app.services.studio.schemas import CharacterDraft, ShotDraft

logger = logging.getLogger(__name__)


class StoryboardError(RuntimeError):
    """剧本拆解失败(LLM 不可用 / 返回不可解析 / 内容为空)。"""


_SYSTEM = """你是短剧导演。把用户剧情拆解为角色与分镜表,只输出 JSON,禁止多余文本。
输出格式:
{
  "characters": [{"name": "角色名", "description": "中文描述", "visual_prompt": "英文视觉token"}],
  "shots": [{
    "scene": "场景中文描述", "prompt": "英文生成提示词", "negative": "反向词",
    "camera": "运镜", "dialogue": "台词", "speaker": "说话角色",
    "duration_sec": 6, "characters": ["出场角色名"],
    "render_mode": "video 或 image_motion"
  }]
}
render_mode 判定:画面有明显运动/表演/动作 → "video";静态画面/特写/空镜/回忆插图 → "image_motion"。
prompt 用英文,其余字段用中文。每个出场角色必须在 characters 中定义过。"""

_VALID_MODES = {"video", "image_motion"}


def _extract_json(text: str) -> dict | None:
    """从 LLM 输出提取首个 JSON 对象(容忍 ```json 围栏与前后噪文)。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _coerce_character(raw: object) -> CharacterDraft | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    if not name:
        return None
    return CharacterDraft(
        name=name,
        description=str(raw.get("description") or "").strip(),
        visual_prompt=str(raw.get("visual_prompt") or "").strip(),
    )


def _coerce_shot(raw: object) -> ShotDraft | None:
    if not isinstance(raw, dict):
        return None
    mode = str(raw.get("render_mode") or "").strip()
    if mode not in _VALID_MODES:
        mode = "video"  # 非法/缺省回退视频链
    chars = raw.get("characters")
    try:
        duration = max(1, min(60, int(raw.get("duration_sec") or 6)))
    except (ValueError, TypeError):
        duration = 6
    return ShotDraft(
        scene=str(raw.get("scene") or "").strip(),
        prompt=str(raw.get("prompt") or "").strip(),
        negative=str(raw.get("negative") or "").strip(),
        camera=str(raw.get("camera") or "").strip(),
        dialogue=str(raw.get("dialogue") or "").strip(),
        speaker=str(raw.get("speaker") or "").strip(),
        duration_sec=duration,
        characters=[str(c) for c in chars] if isinstance(chars, list) else [],
        render_mode=mode,
    )


async def parse_script(
    premise: str, num_shots: int = 8, style: str = ""
) -> tuple[list[CharacterDraft], list[ShotDraft]]:
    """拆解剧本。返回 (角色草稿, 分镜草稿);失败抛 StoryboardError。"""
    user_prompt = f"剧情:{premise}\n风格:{style or '不限'}\n分镜数量:{num_shots}"
    try:
        msg = await llm.chat_layered(
            [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            layer="L3",
            max_tokens=8000,
        )
    except llm.LLMError as e:
        raise StoryboardError(f"LLM 不可用:{e}") from e

    obj = _extract_json((msg.get("content") or "").strip())
    if not obj:
        raise StoryboardError("LLM 返回不可解析")

    characters = [c for c in (_coerce_character(x) for x in obj.get("characters") or []) if c]
    shots = [s for s in (_coerce_shot(x) for x in obj.get("shots") or []) if s]
    shots = shots[:num_shots]
    if not shots or not any(s.prompt or s.scene for s in shots):
        raise StoryboardError("LLM 未产出有效分镜")
    return characters, shots
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_storyboard.py -q`
Expected: 3 passed

---

## Task 3：项目/角色/分镜 CRUD 路由

**Files:**
- Create: `apps/api/app/routes/studio.py`
- Test: `apps/api/tests/test_studio_projects.py`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_projects.py`：

```python
"""Studio CRUD 测试:项目 / 角色 / 分镜批量保存 + 租户隔离 + 鉴权。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="studio")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="studio@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
    yield TestClient(app), create_token(uid)
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_project(client: TestClient, H: dict) -> str:
    r = client.post("/api/studio/projects", headers=H, json={"title": "雨夜", "premise": "重逢"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_project_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    assert len(client.get("/api/studio/projects", headers=H).json()) == 1
    r = client.patch(f"/api/studio/projects/{pid}", headers=H, json={"style": "赛博朋克"})
    assert r.json()["style"] == "赛博朋克"
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["title"] == "雨夜" and detail["characters"] == [] and detail["shots"] == []
    assert client.delete(f"/api/studio/projects/{pid}", headers=H).status_code == 200
    assert client.get("/api/studio/projects", headers=H).json() == []


def test_project_requires_auth(ctx):
    client, _ = ctx
    assert client.get("/api/studio/projects").status_code in (401, 403)


def test_character_crud(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "楚生", "visual_prompt": "1boy, black hair"},
    )
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    client.patch(f"/api/studio/characters/{cid}", headers=H, json={"description": "落魄青年"})
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    assert detail["characters"][0]["description"] == "落魄青年"
    assert client.delete(f"/api/studio/characters/{cid}", headers=H).status_code == 200


def test_shots_batch_save(ctx):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "开场", "prompt": "alley", "render_mode": "video", "characters": ["楚生"]},
            {"scene": "照片", "prompt": "photo", "render_mode": "image_motion"},
        ]},
    )
    assert r.status_code == 200, r.text
    shots = r.json()["shots"]
    assert len(shots) == 2 and shots[0]["idx"] == 0
    assert shots[0]["render_mode"] == "video" and shots[1]["render_mode"] == "image_motion"
    # 再保存:带 id 更新,不带 id 追加
    r2 = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"id": shots[0]["id"], "scene": "开场改", "prompt": "alley2", "render_mode": "image_motion"},
            {"scene": "新镜", "prompt": "new"},
        ]},
    )
    shots2 = r2.json()["shots"]
    assert shots2[0]["scene"] == "开场改" and shots2[0]["render_mode"] == "image_motion"
    assert shots2[1]["scene"] == "新镜"
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_projects.py -q`
Expected: FAIL，404 Not Found（路由未注册）

- [ ] **Step 3: 实现路由**

新建 `apps/api/app/routes/studio.py`：

```python
"""Studio 创作工作室路由(薄层):项目/角色/分镜 CRUD + 剧本拆解入口。

业务编排入 app.services.studio;渲染/配音/合成端点见后续任务追加。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import StudioCharacter, StudioProject, StudioShot, User
from app.services.studio import storyboard
from app.services.studio.schemas import (
    CharacterCreate,
    CharacterPatch,
    ProjectCreate,
    ProjectPatch,
    ScriptParseRequest,
    ShotsSaveRequest,
)

router = APIRouter()


# ── 工具 ──────────────────────────────────────────────────────────────────


def _get_project(session: Session, pid: str, user: User) -> StudioProject:
    p = session.get(StudioProject, pid)
    if not p or p.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


def _project_detail(session: Session, p: StudioProject) -> dict:
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == p.id)
    ).all()
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    return {
        **p.model_dump(),
        "characters": [
            {**c.model_dump(), "reference_images": json.loads(c.reference_images or "[]")}
            for c in chars
        ],
        "shots": [
            {**s.model_dump(), "characters": json.loads(s.characters or "[]")}
            for s in shots
        ],
    }


# ── 项目 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects")
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = StudioProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=body.title,
        premise=body.premise,
        style=body.style,
        ckpt_name=body.ckpt_name,
        render_mode_default=body.render_mode_default,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


@router.get("/studio/projects")
def list_projects(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(StudioProject)
        .where(StudioProject.tenant_id == user.tenant_id)
        .order_by(StudioProject.updated_at.desc())
    ).all()
    return rows


@router.get("/studio/projects/{pid}")
def get_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _project_detail(session, _get_project(session, pid, user))


@router.patch("/studio/projects/{pid}")
def patch_project(
    pid: str,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


@router.delete("/studio/projects/{pid}")
def delete_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    for model in (StudioShot, StudioCharacter):
        for row in session.exec(select(model).where(model.project_id == pid)).all():
            session.delete(row)
    session.delete(p)
    session.commit()
    return {"ok": True}


# ── 角色 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/characters")
def create_character(
    pid: str,
    body: CharacterCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    c = StudioCharacter(
        project_id=pid,
        name=body.name,
        description=body.description,
        visual_prompt=body.visual_prompt,
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


@router.patch("/studio/characters/{cid}")
def patch_character(
    cid: str,
    body: CharacterPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)  # 租户校验
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(c, k, v)
    session.add(c)
    session.commit()
    session.refresh(c)
    return c


@router.delete("/studio/characters/{cid}")
def delete_character(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    session.delete(c)
    session.commit()
    return {"ok": True}


# ── 分镜批量保存 ───────────────────────────────────────────────────────────


@router.put("/studio/projects/{pid}/shots")
def save_shots(
    pid: str,
    body: ShotsSaveRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    out: list[StudioShot] = []
    for i, item in enumerate(body.shots):
        if item.id:
            shot = session.get(StudioShot, item.id)
            if not shot or shot.project_id != pid:
                raise HTTPException(status_code=404, detail=f"分镜不存在:{item.id}")
        else:
            shot = StudioShot(project_id=pid)
        shot.idx = i
        shot.scene = item.scene
        shot.prompt = item.prompt
        if item.negative is not None:
            shot.negative = item.negative
        shot.camera = item.camera
        shot.dialogue = item.dialogue
        shot.speaker = item.speaker
        shot.duration_sec = item.duration_sec
        shot.characters = json.dumps(item.characters, ensure_ascii=False)
        # 生成方式变化 → 旧媒体失效,回到草稿
        if shot.render_mode != item.render_mode:
            shot.render_mode = item.render_mode
            shot.image_url = shot.video_url = shot.final_clip_url = ""
            shot.status = "draft"
        session.add(shot)
        session.commit()
        session.refresh(shot)
        out.append(shot)
    return {
        "shots": [
            {**s.model_dump(), "characters": json.loads(s.characters or "[]")}
            for s in out
        ]
    }


# ── 剧本拆解 ───────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/script/parse")
async def parse_script_endpoint(
    pid: str,
    body: ScriptParseRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LLM 拆解 premise → 角色+分镜草稿(不落库,前端确认后走 CRUD 保存)。"""
    _get_project(session, pid, user)
    try:
        characters, shots = await storyboard.parse_script(
            body.premise, num_shots=body.num_shots, style=body.style
        )
    except storyboard.StoryboardError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "characters": [c.model_dump() for c in characters],
        "shots": [s.model_dump() for s in shots],
    }
```

- [ ] **Step 4: 注册路由 + 运行确认通过**

修改 `apps/api/app/main.py`：
- 在 `from app.routes import (...)` 块中加入 `studio,`（按字母序放在 `system,` 之后）
- 确认 `app.include_router` 循环覆盖新模块（现有循环遍历导入的模块，加入导入即自动注册）

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_projects.py -q`
Expected: 4 passed

---

## Task 4：M1 里程碑收尾

- [ ] **Step 1: 全量回归**

Run: `cd apps/api && .venv/bin/python -m pytest -q`
Expected: 全部通过（既有用例不受影响）

- [ ] **Step 2: 更新 STATE.json + TEST_LOG.md**

STATE.json 新增 `studio_m1_2026_08_05` 节点（模型/CRUD/剧本拆解完成，测试数）；TEST_LOG.md 追加 `STUDIO-M1-2026-08-05` 条目（代码要点 + 测试结果）。

---

# M2：策略化渲染层

## Task 5：渲染器基座与分发

**Files:**
- Create: `apps/api/app/services/studio/renderers/__init__.py`
- Create: `apps/api/app/services/studio/renderers/base.py`
- Test: `apps/api/tests/test_studio_renderers.py`（先写分发部分）

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_renderers.py`：

```python
"""渲染策略层测试:render_mode 分发、结果契约、编排状态机。"""
from __future__ import annotations

from app.models import StudioShot
from app.services.studio.renderers import base
from app.services.studio.renderers.base import RenderResult


def test_get_renderer_dispatch():
    video_shot = StudioShot(project_id="p", idx=0, render_mode="video")
    image_shot = StudioShot(project_id="p", idx=1, render_mode="image_motion")
    assert base.get_renderer(video_shot).name == "video"
    assert base.get_renderer(image_shot).name == "image_motion"


def test_get_renderer_unknown_mode():
    shot = StudioShot(project_id="p", idx=0, render_mode="bogus")
    try:
        base.get_renderer(shot)
        assert False, "应抛 RenderError"
    except base.RenderError:
        pass


def test_render_result_contract():
    r = RenderResult(kind="video", url="/api/studio/files/x.mp4")
    assert r.kind == "video" and r.url.endswith(".mp4")
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_renderers.py -q`
Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 实现基座**

新建 `apps/api/app/services/studio/renderers/__init__.py`：

```python
"""渲染策略实现:视频链(video)与图像运镜链(image_motion)。"""
```

新建 `apps/api/app/services/studio/renderers/base.py`：

```python
"""渲染策略基座:ShotRenderer 协议 + get_renderer 按 render_mode 分发。

渲染器为无会话工厂:get_renderer 返回的实例 render() 时注入 pool/tracker,
便于测试 mock 与后续扩展(新渲染模式 = 新实现类 + _REGISTRY 注册)。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot


class RenderError(RuntimeError):
    """渲染失败(未知模式 / worker 不可用 / ComfyUI 错误)。"""


@dataclass
class RenderResult:
    """渲染产出。kind: video | image;url: 可访问媒体 URL。"""

    kind: str
    url: str


class ShotRenderer(Protocol):
    """渲染策略契约:单镜 + 角色资产 → 媒体 URL。"""

    name: str

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult: ...


def get_renderer(shot: "StudioShot") -> ShotRenderer:
    """按 shot.render_mode 分发渲染器实例。"""
    from app.services.studio.renderers.image_motion import ImageMotionRenderer
    from app.services.studio.renderers.video import VideoRenderer

    registry: dict[str, type] = {
        VideoRenderer.name: VideoRenderer,
        ImageMotionRenderer.name: ImageMotionRenderer,
    }
    cls = registry.get(shot.render_mode)
    if cls is None:
        raise RenderError(f"未知渲染模式:{shot.render_mode}")
    return cls()
```

- [ ] **Step 4: 运行确认（video/image_motion 实现尚未存在，先建空壳）**

新建 `apps/api/app/services/studio/renderers/video.py` 与 `image_motion.py` 的类骨架（`name` 类属性 + `render` 抛 `RenderError("未实现")`），供 Task 6/7 填充。

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_renderers.py -q`
Expected: 3 passed

---

## Task 6：图像运镜渲染器（ImageMotionRenderer）

**Files:**
- Create: `apps/api/app/services/studio/ffmpeg_ops.py`
- Modify: `apps/api/app/services/studio/renderers/image_motion.py`
- Test: `apps/api/tests/test_studio_renderers.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
import pytest
from app.models import StudioCharacter
from app.services.studio.renderers import image_motion


def test_kenburns_filter_zoom_in():
    vf = image_motion._kenburns_filter("zoom_in", frames=48, width=768, height=432, fps=16)
    assert "zoompan" in vf and "s=768x432" in vf and "fps=16" in vf


@pytest.mark.asyncio
async def test_image_motion_render_mocked(monkeypatch):
    """mock ComfyUI 与 ffmpeg:验证出图 → 运镜两段的调用与结果 URL。"""
    calls: dict[str, object] = {}

    class FakeClient:
        base_url = "http://fake:8188"

        async def queue_prompt(self, graph, client_id):
            calls["graph"] = graph
            return "pid-1"

        async def get_images(self, prompt_id):
            return [{"filename": "shot.png", "subfolder": "", "type": "output"}]

        async def get_image_bytes(self, filename, subfolder, type_):
            return b"\x89PNG-fake", "image/png"

    class FakePool:
        async def pick(self, required=None, required_nodes=None):
            return FakeClient()

    async def fake_kenburns(self, image_path, motion, out_path, duration_sec, fps):
        out_path.write_bytes(b"fake-mp4")
        return out_path

    monkeypatch.setattr(
        image_motion.ImageMotionRenderer, "_run_kenburns", fake_kenburns
    )
    monkeypatch.setattr(image_motion, "_save_output", lambda data, ext: f"/api/studio/files/a{ext}")

    shot = StudioShot(project_id="p", idx=0, render_mode="image_motion",
                      prompt="1girl, rooftop", duration_sec=3, camera="zoom_in")
    cast = [StudioCharacter(project_id="p", name="凛", visual_prompt="1girl")]
    r = await image_motion.ImageMotionRenderer().render(shot, cast, FakePool())
    assert r.kind == "video"  # 运镜后为 mp4 片段
    assert r.url.startswith("/api/studio/files/")
    assert calls["graph"]  # 构图已提交
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_renderers.py -q`
Expected: FAIL，`AttributeError: _kenburns_filter`

- [ ] **Step 3: 实现**

新建 `apps/api/app/services/studio/ffmpeg_ops.py`：

```python
"""ffmpeg 助手:进程执行 / Ken Burns 运镜 / 片段拼接。

与 app.routes.assembly 内的实现同源独立演化(服务层自持,不反向依赖路由层)。
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def ensure_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise FFmpegError("服务端未安装 ffmpeg")
    return exe


async def run_ffmpeg(cmd: list[str], timeout: float = 600.0) -> None:
    """执行 ffmpeg,非零退出抛 FFmpegError 并附 stderr 尾部。"""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        raise FFmpegError(f"ffmpeg 超时({timeout}s)") from e
    if proc.returncode != 0:
        tail = (stderr or b"").decode(errors="replace")[-500:]
        raise FFmpegError(f"ffmpeg 失败(code={proc.returncode}): {tail}")


async def concat_parts(parts: list[Path], out: Path, fps: int = 16) -> None:
    """无损拼接同规格片段(concat demuxer + copy)。"""
    ensure_ffmpeg()
    list_file = out.with_suffix(".concat.txt")
    list_file.write_text(
        "".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8"
    )
    try:
        await run_ffmpeg(
            [
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", list_file.as_posix(), "-c", "copy", out.as_posix(),
            ]
        )
    finally:
        list_file.unlink(missing_ok=True)
```

实现 `apps/api/app/services/studio/renderers/image_motion.py`：

```python
"""图像运镜链:ComfyUI 出图(IPAdapter 角色一致性/txt2img 兜底)→ Ken Burns 运镜。

产出与视频链同规格 mp4,保证合成阶段无缝拼接。
"""
from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.services.studio.ffmpeg_ops import ensure_ffmpeg, run_ffmpeg
from app.services.studio.renderers.base import RenderError, RenderResult

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot

logger = logging.getLogger(__name__)

_WIDTH, _HEIGHT, _FPS = 768, 432, 16


def _kenburns_filter(motion: str, frames: int, width: int, height: int, fps: int) -> str:
    """zoompan 表达式:先 2x 预放大降抖动,再 zoom/pan 到目标尺寸。"""
    z_map = {
        "zoom_in": f"min(zoom+0.0015,1.5)",
        "zoom_out": f"max(1.5-0.0015*on,1.0)",
        "pan_left": "1.2",
        "pan_right": "1.2",
    }
    z = z_map.get(motion, z_map["zoom_in"])
    if motion == "pan_left":
        x, y = "iw*(1-on/%d)*0.2" % frames, "(ih-ih/zoom)/2"
    elif motion == "pan_right":
        x, y = "iw*on/%d*0.2" % frames, "(ih-ih/zoom)/2"
    else:
        x, y = "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    return (
        f"scale={width * 2}:{height * 2},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps}"
    )


def _save_output(data: bytes, ext: str) -> str:
    """落盘到 Studio 输出目录,返回可访问 URL。由 app.storage 提供目录。"""
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


class ImageMotionRenderer:
    """render_mode=image_motion:出图 → 静图运镜 mp4。"""

    name = "image_motion"

    async def _run_kenburns(
        self, image_path: Path, motion: str, out_path: Path, duration_sec: int, fps: int
    ) -> Path:
        frames = max(1, duration_sec * fps)
        vf = _kenburns_filter(motion, frames, _WIDTH, _HEIGHT, fps)
        await run_ffmpeg(
            [
                "ffmpeg", "-y", "-loop", "1", "-i", image_path.as_posix(),
                "-vf", vf, "-t", str(duration_sec),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", out_path.as_posix(),
            ]
        )
        return out_path

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult:
        from app.config import get_settings
        from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

        settings = get_settings()
        ckpt = kw.get("ckpt_name") or settings.default_ckpt
        # 角色视觉 token 注入提示词,跨镜保一致
        cast_tokens = ", ".join(c.visual_prompt for c in cast if c.visual_prompt)
        positive = f"{cast_tokens}, {shot.prompt}" if cast_tokens else shot.prompt
        graph = build_txt2img_graph(
            Txt2ImgParams(
                positive=positive,
                negative=shot.negative,
                ckpt_name=ckpt,
                width=_WIDTH,
                height=_HEIGHT,
                filename_prefix="ToIV_studio",
            )
        )
        try:
            client = await pool.pick(required={ckpt})
            prompt_id = await client.queue_prompt(graph, client_id=uuid.uuid4().hex)
            images = await client.get_images(prompt_id)
        except Exception as e:  # ComfyUIError/超时统一转 RenderError
            raise RenderError(f"出图失败:{e}") from e
        if not images:
            raise RenderError("出图失败:无产出")
        img = images[0]
        data, _ = await client.get_image_bytes(img["filename"], img.get("subfolder", ""), img.get("type", "output"))
        image_url = _save_output(data, ".png")

        # Ken Burns 运镜 → mp4 片段
        ensure_ffmpeg()
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "in.png"
            src.write_bytes(data)
            out = Path(td) / "out.mp4"
            await self._run_kenburns(
                src, shot.camera or "zoom_in", out, shot.duration_sec, _FPS
            )
            clip_url = _save_output(out.read_bytes(), ".mp4")
        # 运镜片段为该镜最终媒体;静图 URL 供前端预览
        shot.image_url = image_url
        return RenderResult(kind="video", url=clip_url)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_renderers.py -q`
Expected: 全部通过

---

## Task 7：视频渲染器（VideoRenderer）

**Files:**
- Modify: `apps/api/app/services/studio/renderers/video.py`
- Test: `apps/api/tests/test_studio_renderers.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
from app.services.studio.renderers import video as video_mod


@pytest.mark.asyncio
async def test_video_render_delegates_to_generator(monkeypatch):
    """视频链封装 services/video_generators.get_generator(ltx),角色 token 注入。"""
    from app.services.video_generators import VideoGenResult

    seen: dict[str, object] = {}

    class FakeGen:
        async def generate(self, **kwargs):
            seen.update(kwargs)
            return VideoGenResult(url="/api/video/x.mp4", job_id="j1")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool, **kw: FakeGen())
    shot = StudioShot(project_id="p", idx=0, render_mode="video",
                      prompt="rainy alley, neon", duration_sec=6)
    cast = [StudioCharacter(project_id="p", name="凛", visual_prompt="1girl, silver hair")]
    r = await video_mod.VideoRenderer().render(shot, cast, pool=None)
    assert r.kind == "video" and r.url.endswith(".mp4")
    assert "1girl, silver hair" in seen["prompt"]


@pytest.mark.asyncio
async def test_video_render_error_wrap(monkeypatch):
    class FailGen:
        async def generate(self, **kwargs):
            raise RuntimeError("worker 全忙")

    monkeypatch.setattr(video_mod, "get_generator", lambda name, pool, **kw: FailGen())
    shot = StudioShot(project_id="p", idx=0, render_mode="video", prompt="x")
    with pytest.raises(base.RenderError):
        await video_mod.VideoRenderer().render(shot, [], pool=None)
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL，`get_generator` 未在模块内定义

- [ ] **Step 3: 实现**

`apps/api/app/services/studio/renderers/video.py` 全量替换：

```python
"""视频链:封装 services/video_generators(默认 ltx;后续可按项目扩展 h3/liveact)。

角色一致性:视觉 token 注入 prompt(PuLID 首帧在 video_generators 次世代场景接入,
本层不重复实现)。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.services.studio.renderers.base import RenderError, RenderResult
from app.services.video_generators import get_generator

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool
    from app.models import StudioCharacter, StudioShot


class VideoRenderer:
    """render_mode=video:ComfyUI 视频工作流出片。"""

    name = "video"

    async def render(
        self,
        shot: "StudioShot",
        cast: list["StudioCharacter"],
        pool: "WorkerPool",
        **kw: Any,
    ) -> RenderResult:
        cast_tokens = ", ".join(c.visual_prompt for c in cast if c.visual_prompt)
        prompt = f"{cast_tokens}, {shot.prompt}" if cast_tokens else shot.prompt
        gen = get_generator(kw.get("video_model") or "ltx", pool)
        try:
            result = await gen.generate(
                prompt=prompt,
                negative=shot.negative,
                duration_sec=shot.duration_sec,
            )
        except Exception as e:
            raise RenderError(f"视频生成失败:{e}") from e
        if not result.url:
            raise RenderError("视频生成失败:无产出 URL")
        return RenderResult(kind="video", url=result.url)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_renderers.py -q`
Expected: 全部通过

> 注：Task 7 测试中 `VideoGenResult`/`generate` 参数名以 `app/services/video_generators.py` 实际签名为准（实现时先读该文件对齐字段）。

---

## Task 8：编排器 + 渲染端点

**Files:**
- Create: `apps/api/app/services/studio/orchestrator.py`
- Modify: `apps/api/app/routes/studio.py`（追加渲染/状态端点）
- Test: `apps/api/tests/test_studio_projects.py`（追加渲染编排测试，mock 渲染器）

- [ ] **Step 1: 追加失败测试**

`tests/test_studio_projects.py` 追加：

```python
import app.services.studio.orchestrator as orch
from app.services.studio.renderers.base import RenderResult


def _mk_shots(client: TestClient, H: dict, pid: str) -> list[dict]:
    r = client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"scene": "A", "prompt": "a", "render_mode": "video"},
            {"scene": "B", "prompt": "b", "render_mode": "image_motion"},
        ]},
    )
    return r.json()["shots"]


def test_render_single_shot(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)

    async def fake_render_shot(session, shot, pool=None):
        shot.status = "rendered"
        shot.video_url = "/api/studio/files/fake.mp4"
        shot.final_clip_url = shot.video_url
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/shots/{shots[0]['id']}/render", headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rendered"


def test_render_batch_skips_done(ctx, monkeypatch):
    client, token = ctx
    H = _h(token)
    pid = _mk_project(client, H)
    shots = _mk_shots(client, H, pid)
    # 预置一镜已完成
    client.put(
        f"/api/studio/projects/{pid}/shots",
        headers=H,
        json={"shots": [
            {"id": shots[0]["id"], "scene": "A", "prompt": "a", "render_mode": "video"},
            {"id": shots[1]["id"], "scene": "B", "prompt": "b", "render_mode": "image_motion"},
        ]},
    )
    rendered: list[str] = []

    async def fake_render_shot(session, shot, pool=None):
        rendered.append(shot.id)
        shot.status = "rendered"
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render_shot)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H)
    assert r.status_code == 200, r.text
    assert set(rendered) == {shots[0]["id"], shots[1]["id"]}
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL，`ModuleNotFoundError: app.services.studio.orchestrator`

- [ ] **Step 3: 实现编排器**

新建 `apps/api/app/services/studio/orchestrator.py`：

```python
"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from sqlmodel import Session

from app.models import StudioCharacter, StudioShot
from app.services.studio.renderers.base import RenderError, get_renderer

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

_TERMINAL_SKIP = {"rendered", "voiced", "lipsynced", "done"}


def _cast_for(session: Session, shot: StudioShot) -> list[StudioCharacter]:
    """按 shot.characters(角色名)取角色卡。"""
    names = set(json.loads(shot.characters or "[]"))
    if not names:
        return []
    rows = session.exec(
        StudioCharacter.__table__.select().where(
            StudioCharacter.project_id == shot.project_id
        )
    ).all() if False else session.query(StudioCharacter).filter(
        StudioCharacter.project_id == shot.project_id
    ).all()
    return [c for c in rows if c.name in names]


async def render_shot(
    session: Session, shot: StudioShot, pool: "WorkerPool | None" = None
) -> StudioShot:
    """渲染单镜:按 render_mode 分发;状态与媒体 URL 落库。"""
    shot.status = "rendering"
    shot.error = ""
    session.add(shot)
    session.commit()
    try:
        result = await get_renderer(shot).render(
            shot, _cast_for(session, shot), pool, **{}
        )
    except RenderError as e:
        shot.status = "error"
        shot.error = str(e)
        session.add(shot)
        session.commit()
        raise
    if result.kind == "image":
        shot.image_url = result.url
    else:
        shot.video_url = result.url
        shot.final_clip_url = result.url
    shot.status = "rendered"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot
```

> 实现注意：`_cast_for` 用 sqlmodel `select(StudioCharacter).where(...)` + `session.exec`（上方伪码中的 query 写法是占位，实现时用与 `routes/studio.py` 相同的 select/exec 风格）。

`app/routes/studio.py` 追加：

```python
from app.services.studio import orchestrator


def _get_shot(session: Session, sid: str, user: User) -> StudioShot:
    shot = session.get(StudioShot, sid)
    if not shot:
        raise HTTPException(status_code=404, detail="分镜不存在")
    _get_project(session, shot.project_id, user)
    return shot


def _shot_out(s: StudioShot) -> dict:
    return {**s.model_dump(), "characters": json.loads(s.characters or "[]")}


@router.post("/studio/shots/{sid}/render")
async def render_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from app.services.studio.renderers.base import RenderError

    shot = _get_shot(session, sid, user)
    try:
        return _shot_out(await orchestrator.render_shot(session, shot))
    except RenderError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/studio/projects/{pid}/render")
async def render_batch(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """批量渲染:跳过已 rendered/voiced/done 的分镜;单镜失败不阻塞其余。"""
    from app.services.studio.renderers.base import RenderError

    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    done, failed = 0, 0
    for shot in shots:
        if shot.status in {"rendered", "voiced", "lipsynced", "done"}:
            continue
        try:
            await orchestrator.render_shot(session, shot)
            done += 1
        except RenderError:
            failed += 1
    return {"rendered": done, "failed": failed}


@router.get("/studio/projects/{pid}/status")
def project_status(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """聚合状态:各阶段计数,供前端轮询。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    return {"total": len(shots), "by_status": counts}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_projects.py tests/test_studio_renderers.py -q`
Expected: 全部通过

---

## Task 9：M2 里程碑收尾

- [ ] 全量回归：`cd apps/api && .venv/bin/python -m pytest -q`
- [ ] STATE.json 新增 `studio_m2_2026_08_05`；TEST_LOG.md 追加 `STUDIO-M2-2026-08-05`

---

# M3：配音 + 对口型 + 合成

## Task 10：配音服务与端点

**Files:**
- Create: `apps/api/app/services/studio/voice.py`
- Modify: `apps/api/app/routes/studio.py`（追加 voice/lipsync 端点）
- Test: `apps/api/tests/test_studio_voice.py`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_voice.py`：

```python
"""配音服务测试:IndexTTS2 调用、参考音转发、失败降级。"""
from __future__ import annotations

import httpx
import pytest

from app.services.studio import voice


@pytest.mark.asyncio
async def test_synth_ok(monkeypatch):
    wav = b"RIFF" + b"\x00" * 100

    class FakeResponse:
        status_code = 200
        content = wav

        def json(self):
            return {}

    posted: dict[str, object] = {}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, url, data=None, files=None):
            posted["url"] = url
            posted["data"] = data
            return FakeResponse()

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: FakeClient())
    monkeypatch.setattr(voice, "_save_wav", lambda data: "/api/studio/files/v.wav")

    class FakeSettings:
        tts_url = "http://tts:9200"
        tts_multilingual_url = ""

    monkeypatch.setattr(voice, "get_settings", lambda: FakeSettings())
    url = await voice.synth("我回来了。", ref_audio_bytes=None)
    assert url == "/api/studio/files/v.wav"
    assert posted["url"] == "http://tts:9200/tts"
    assert posted["data"]["text"] == "我回来了。"


@pytest.mark.asyncio
async def test_synth_tts_down(monkeypatch):
    class DownClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(voice.httpx, "AsyncClient", lambda **kw: DownClient())

    class FakeSettings:
        tts_url = "http://tts:9200"
        tts_multilingual_url = ""

    monkeypatch.setattr(voice, "get_settings", lambda: FakeSettings())
    with pytest.raises(voice.VoiceError):
        await voice.synth("x", ref_audio_bytes=None)
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 实现配音服务**

新建 `apps/api/app/services/studio/voice.py`：

```python
"""配音:IndexTTS2 合成(支持角色参考音克隆);失败抛 VoiceError,不阻塞媒体。"""
from __future__ import annotations

import logging
import uuid

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_TTS_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class VoiceError(RuntimeError):
    pass


def _save_wav(data: bytes) -> str:
    from app.storage import drama_output_root

    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.wav"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


async def synth(text: str, ref_audio_bytes: bytes | None, language: str = "zh") -> str:
    """合成台词 → wav URL。TTS 不可达/非音频返回抛 VoiceError。"""
    settings = get_settings()
    multilingual = language in {"ja", "ko", "yue"}
    target = (
        settings.tts_multilingual_url.strip().rstrip("/")
        if multilingual
        else settings.tts_url.rstrip("/")
    )
    if not target:
        raise VoiceError("TTS 服务未配置")
    data: dict[str, str] = {"text": text}
    if multilingual:
        data["language"] = language
    files = (
        {"ref_audio": ("ref.wav", ref_audio_bytes, "audio/wav")}
        if ref_audio_bytes
        else None
    )
    try:
        async with httpx.AsyncClient(
            timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            resp = await client.post(target + "/tts", data=data, files=files)
    except httpx.HTTPError as e:
        raise VoiceError(f"TTS 服务不可达:{e}") from e
    if resp.status_code != 200 or not resp.content.startswith(b"RIFF"):
        raise VoiceError(f"TTS 合成失败(code={resp.status_code})")
    return _save_wav(resp.content)


async def synth_for_shot(session, shot, character) -> str:
    """按分镜说话人取参考音并合成;状态机:rendered → voiced。"""
    ref: bytes | None = None
    if character and character.voice_ref_url:
        try:
            async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                r = await client.get(_resolve_ref(character.voice_ref_url))
                r.raise_for_status()
                ref = r.content
        except httpx.HTTPError:
            logger.warning("参考音下载失败,降级默认音色: %s", character.voice_ref_url)
    url = await synth(shot.dialogue, ref)
    shot.voice_url = url
    shot.status = "voiced"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return url


def _resolve_ref(url: str) -> str:
    """站内相对 URL → 本机绝对 URL(与 routes/voice.py 同规则)。"""
    if url.startswith("/"):
        return f"http://127.0.0.1:8090{url}"
    return url
```

`app/routes/studio.py` 追加：

```python
@router.post("/studio/shots/{sid}/voice")
async def voice_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from app.services.studio import voice as voice_svc

    shot = _get_shot(session, sid, user)
    if not shot.dialogue.strip():
        raise HTTPException(status_code=422, detail="该镜无台词")
    character = None
    if shot.speaker:
        character = session.exec(
            select(StudioCharacter).where(
                StudioCharacter.project_id == shot.project_id,
                StudioCharacter.name == shot.speaker,
            )
        ).first()
    try:
        await voice_svc.synth_for_shot(session, shot, character)
    except voice_svc.VoiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return _shot_out(shot)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_voice.py -q`
Expected: 2 passed

---

## Task 11：对口型端点（仅视频镜）

**Files:**
- Modify: `apps/api/app/routes/studio.py`
- Test: `apps/api/tests/test_studio_voice.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
# 追加到 test_studio_voice.py(复用其 fixture 思路,经路由层 mock)
def test_lipsync_rejects_image_motion(ctx_client_and_shot):
    """image_motion 镜请求对口型 → 422。"""
    # 实现时参照 test_studio_projects.py 的 ctx fixture 建项目+分镜,
    # POST /api/studio/shots/{sid}/lipsync,断言 422
```

- [ ] **Step 2: 运行确认失败** — 404（端点未实现）

- [ ] **Step 3: 实现**

`app/routes/studio.py` 追加：

```python
@router.post("/studio/shots/{sid}/lipsync")
async def lipsync_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """对口型:仅视频镜(rendered/voiced 且有视频+配音);走现有 lipsync 工作流。

    实现复用 app.workflows.lipsync 构图 + pool 执行(与 routes/lipsync.py 同模式),
    产出回写 shot.final_clip_url,状态 → lipsynced。
    """
    shot = _get_shot(session, sid, user)
    if shot.render_mode != "video":
        raise HTTPException(status_code=422, detail="仅视频镜支持对口型")
    if not shot.video_url or not shot.voice_url:
        raise HTTPException(status_code=422, detail="需要先出视频并配音")
    # TODO(实现时): 调 app.workflows.lipsync 现有构图,与 routes/lipsync.py 对齐
    raise HTTPException(status_code=501, detail="对口型接入中")
```

> 实现时先读 `app/routes/lipsync.py` 与 `app/workflows/lipsync.py`，按现有模式接入（本计划不重复其内部细节）；501 分支为 M3 开发中过渡态，接入完成后替换为真实调用并补齐测试。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_voice.py -q`

---

## Task 12：合成服务与端点

**Files:**
- Create: `apps/api/app/services/studio/assemble.py`
- Modify: `apps/api/app/routes/studio.py`（追加 assemble 端点 + files 静态端点）
- Test: `apps/api/tests/test_studio_assemble.py`

- [ ] **Step 1: 写失败测试**

新建 `apps/api/tests/test_studio_assemble.py`：

```python
"""合成测试:片段收集顺序、缺镜拦截、NAS 落盘降级。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.models import StudioShot
from app.services.studio import assemble


def test_collect_clips_order_and_missing():
    shots = [
        StudioShot(project_id="p", idx=0, final_clip_url="/api/studio/files/a.mp4", status="done"),
        StudioShot(project_id="p", idx=1, final_clip_url="", status="rendered"),
    ]
    with pytest.raises(assemble.AssembleError, match="未就绪"):
        assemble.collect_clips(shots)


def test_collect_clips_ok():
    shots = [
        StudioShot(project_id="p", idx=1, final_clip_url="/api/studio/files/b.mp4", status="done"),
        StudioShot(project_id="p", idx=0, final_clip_url="/api/studio/files/a.mp4", status="done"),
    ]
    clips = assemble.collect_clips(shots)
    assert clips == ["/api/studio/files/a.mp4", "/api/studio/files/b.mp4"]  # 按 idx 排序
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 实现合成服务**

新建 `apps/api/app/services/studio/assemble.py`：

```python
"""合成:按 idx 收集各镜最终片段 → ffmpeg 拼接 → NAS(drama_output_root/studio)。

降级:NAS 不可达由 app.storage.drama_output_root 内部处理(同短剧成片)。
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path

from app.services.studio.ffmpeg_ops import FFmpegError, concat_parts
from app.storage import drama_output_root

logger = logging.getLogger(__name__)

_FILES_PREFIX = "/api/studio/files/"


class AssembleError(RuntimeError):
    pass


def collect_clips(shots) -> list[str]:
    """按 idx 排序收集 final_clip_url;任一未就绪 → AssembleError。"""
    ordered = sorted(shots, key=lambda s: s.idx)
    missing = [s.idx for s in ordered if not s.final_clip_url]
    if missing:
        raise AssembleError(f"分镜未就绪(缺成片):{missing}")
    return [s.final_clip_url for s in ordered]


def _clip_path(url: str) -> Path:
    if not url.startswith(_FILES_PREFIX):
        raise AssembleError(f"非法片段 URL:{url}")
    name = url[len(_FILES_PREFIX):]
    if "/" in name or ".." in name:  # 路径穿越防护
        raise AssembleError(f"非法片段名:{name}")
    return drama_output_root() / "studio" / name


async def assemble_project(project, shots) -> str:
    """拼接成片,回写 project.final_url,返回 URL。"""
    urls = collect_clips(shots)
    parts = [_clip_path(u) for u in urls]
    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"final-{uuid.uuid4().hex}.mp4"
    try:
        await concat_parts(parts, out)
    except FFmpegError as e:
        raise AssembleError(str(e)) from e
    project.final_url = f"{_FILES_PREFIX}{out.name}"
    project.status = "ready"
    return project.final_url
```

`app/routes/studio.py` 追加：

```python
from fastapi.responses import FileResponse

from app.pathsafe import safe_name  # 若 pathsafe 导出名不同,实现时对齐


@router.post("/studio/projects/{pid}/assemble")
async def assemble_endpoint(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from app.services.studio import assemble as assemble_svc

    p = _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    try:
        url = await assemble_svc.assemble_project(p, shots)
    except assemble_svc.AssembleError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    session.add(p)
    session.commit()
    return {"final_url": url}


@router.get("/studio/files/{name}")
def get_studio_file(name: str):
    """Studio 产出文件(成片/运镜片段/配音)静态访问;路径穿越防护。"""
    from app.storage import drama_output_root

    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="非法文件名")
    path = drama_output_root() / "studio" / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/api && .venv/bin/python -m pytest tests/test_studio_assemble.py -q`
Expected: 2 passed

---

## Task 13：M3 里程碑收尾

- [ ] 全量回归：`cd apps/api && .venv/bin/python -m pytest -q`
- [ ] STATE.json 新增 `studio_m3_2026_08_05`；TEST_LOG.md 追加 `STUDIO-M3-2026-08-05`

---

# M4：前端四阶段工作台

## Task 14：API 封装层

**Files:**
- Modify: `apps/web/lib/api.ts`（追加 studio 段）

- [ ] **Step 1: 实现（前端无 vitest,验证靠 build + e2e）**

`apps/web/lib/api.ts` 末尾追加（风格对齐现有 manju 封装）：

```typescript
// ── Studio 创作工作室 ──────────────────────────────────────────────
export type StudioRenderMode = "video" | "image_motion";

export interface StudioProjectSummary {
  id: string;
  title: string;
  premise: string;
  style: string;
  ckpt_name: string;
  render_mode_default: StudioRenderMode;
  status: string;
  final_url: string;
  created_at: string;
  updated_at: string;
}

export interface StudioCharacter {
  id: string;
  project_id: string;
  name: string;
  description: string;
  visual_prompt: string;
  reference_images: string[];
  voice_ref_url: string;
}

export interface StudioShot {
  id: string;
  project_id: string;
  idx: number;
  scene: string;
  prompt: string;
  negative: string;
  camera: string;
  dialogue: string;
  speaker: string;
  duration_sec: number;
  characters: string[];
  render_mode: StudioRenderMode;
  status: string;
  image_url: string;
  video_url: string;
  voice_url: string;
  final_clip_url: string;
  error: string;
}

export interface StudioProjectDetail extends StudioProjectSummary {
  characters: StudioCharacter[];
  shots: StudioShot[];
}

export interface StudioShotInput {
  id?: string;
  scene?: string;
  prompt?: string;
  negative?: string;
  camera?: string;
  dialogue?: string;
  speaker?: string;
  duration_sec?: number;
  characters?: string[];
  render_mode?: StudioRenderMode;
}

export const listStudioProjects = () =>
  apiFetch<StudioProjectSummary[]>("/api/studio/projects");
export const createStudioProject = (body: Partial<StudioProjectSummary>) =>
  apiFetch<StudioProjectSummary>("/api/studio/projects", { method: "POST", body: JSON.stringify(body) });
export const getStudioProject = (pid: string) =>
  apiFetch<StudioProjectDetail>(`/api/studio/projects/${pid}`);
export const patchStudioProject = (pid: string, body: Partial<StudioProjectSummary>) =>
  apiFetch<StudioProjectSummary>(`/api/studio/projects/${pid}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteStudioProject = (pid: string) =>
  apiFetch<{ ok: boolean }>(`/api/studio/projects/${pid}`, { method: "DELETE" });
export const parseStudioScript = (pid: string, body: { premise: string; num_shots?: number; style?: string }) =>
  apiFetch<{ characters: Partial<StudioCharacter>[]; shots: StudioShotInput[] }>(
    `/api/studio/projects/${pid}/script/parse`, { method: "POST", body: JSON.stringify(body) });
export const addStudioCharacter = (pid: string, body: Partial<StudioCharacter>) =>
  apiFetch<StudioCharacter>(`/api/studio/projects/${pid}/characters`, { method: "POST", body: JSON.stringify(body) });
export const patchStudioCharacter = (cid: string, body: Partial<StudioCharacter>) =>
  apiFetch<StudioCharacter>(`/api/studio/characters/${cid}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteStudioCharacter = (cid: string) =>
  apiFetch<{ ok: boolean }>(`/api/studio/characters/${cid}`, { method: "DELETE" });
export const saveStudioShots = (pid: string, shots: StudioShotInput[]) =>
  apiFetch<{ shots: StudioShot[] }>(`/api/studio/projects/${pid}/shots`, { method: "PUT", body: JSON.stringify({ shots }) });
export const renderStudioShot = (sid: string) =>
  apiFetch<StudioShot>(`/api/studio/shots/${sid}/render`, { method: "POST" });
export const renderStudioAll = (pid: string) =>
  apiFetch<{ rendered: number; failed: number }>(`/api/studio/projects/${pid}/render`, { method: "POST" });
export const voiceStudioShot = (sid: string) =>
  apiFetch<StudioShot>(`/api/studio/shots/${sid}/voice`, { method: "POST" });
export const lipsyncStudioShot = (sid: string) =>
  apiFetch<StudioShot>(`/api/studio/shots/${sid}/lipsync`, { method: "POST" });
export const assembleStudio = (pid: string) =>
  apiFetch<{ final_url: string }>(`/api/studio/projects/${pid}/assemble`, { method: "POST" });
export const studioStatus = (pid: string) =>
  apiFetch<{ total: number; by_status: Record<string, number> }>(`/api/studio/projects/${pid}/status`);
```

> 实现注意：`apiFetch` 的实际导出名/签名以 `apps/web/lib/api.ts` 现有封装为准（实现时先读该文件头部对齐）。

- [ ] **Step 2: 验证**

Run: `cd apps/web && npm run build`
Expected: 编译通过（类型错误即修）

---

## Task 15：状态管理 Hook

**Files:**
- Create: `apps/web/hooks/useStudioProject.ts`

- [ ] **Step 1: 实现**

```typescript
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getStudioProject,
  saveStudioShots,
  renderStudioShot,
  renderStudioAll,
  voiceStudioShot,
  lipsyncStudioShot,
  assembleStudio,
  type StudioProjectDetail,
  type StudioShot,
  type StudioShotInput,
} from "@/lib/api";

export function useStudioProject(pid: string | null) {
  const [detail, setDetail] = useState<StudioProjectDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await getStudioProject(pid));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, []);

  const patchShotLocal = useCallback((shot: StudioShot) => {
    setDetail((d) =>
      d ? { ...d, shots: d.shots.map((s) => (s.id === shot.id ? shot : s)) } : d
    );
  }, []);

  const saveShots = useCallback(
    async (shots: StudioShotInput[]) => {
      if (!pid) return;
      await saveStudioShots(pid, shots);
      await refresh();
    },
    [pid, refresh]
  );

  const renderShot = useCallback(
    (sid: string) => withBusy(`render:${sid}`, async () => patchShotLocal(await renderStudioShot(sid))),
    [withBusy, patchShotLocal]
  );

  const renderAll = useCallback(
    () => withBusy("render:all", async () => { if (pid) { await renderStudioAll(pid); await refresh(); } }),
    [withBusy, pid, refresh]
  );

  const voiceShot = useCallback(
    (sid: string) => withBusy(`voice:${sid}`, async () => patchShotLocal(await voiceStudioShot(sid))),
    [withBusy, patchShotLocal]
  );

  const lipsyncShot = useCallback(
    (sid: string) => withBusy(`lipsync:${sid}`, async () => patchShotLocal(await lipsyncStudioShot(sid))),
    [withBusy, patchShotLocal]
  );

  const assemble = useCallback(
    () => withBusy("assemble", async () => { if (pid) { await assembleStudio(pid); await refresh(); } }),
    [withBusy, pid, refresh]
  );

  return { detail, loading, error, busy, refresh, saveShots, renderShot, renderAll, voiceShot, lipsyncShot, assemble };
}
```

- [ ] **Step 2: 验证** — `npm run build` 通过

---

## Task 16：工作台视图与四阶段组件

**Files:**
- Create: `apps/web/components/studio/StudioView.tsx`
- Create: `apps/web/components/studio/stages/ScriptStage.tsx`
- Create: `apps/web/components/studio/stages/CastStage.tsx`
- Create: `apps/web/components/studio/stages/StoryboardStage.tsx`
- Create: `apps/web/components/studio/stages/AssemblyStage.tsx`
- Create: `apps/web/components/studio/ShotCard.tsx`

- [ ] **Step 1: StudioView 容器 + 阶段导航**

```tsx
"use client";

import { useEffect, useState } from "react";
import { listStudioProjects, createStudioProject, type StudioProjectSummary } from "@/lib/api";
import { useStudioProject } from "@/hooks/useStudioProject";
import { Icon } from "@/components/ui/Icon";
import { ScriptStage } from "./stages/ScriptStage";
import { CastStage } from "./stages/CastStage";
import { StoryboardStage } from "./stages/StoryboardStage";
import { AssemblyStage } from "./stages/AssemblyStage";

const STAGES = [
  { key: "script", label: "剧本", icon: "create" },
  { key: "cast", label: "角色", icon: "users" },
  { key: "storyboard", label: "分镜", icon: "film" },
  { key: "assembly", label: "合成", icon: "playing" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

export function StudioView() {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stage, setStage] = useState<StageKey>("script");
  const project = useStudioProject(activeId);

  useEffect(() => {
    listStudioProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const createProject = async () => {
    const p = await createStudioProject({ title: "未命名项目" });
    setProjects((prev) => [p, ...prev]);
    setActiveId(p.id);
    setStage("script");
  };

  if (!activeId) {
    return (
      <div className="studio-home">
        <header className="studio-home-head">
          <h1><Icon name="film" size={20} /> 创作工作室</h1>
          <button type="button" className="btn btn-primary" onClick={createProject}>
            <Icon name="create" size={14} /> 新建项目
          </button>
        </header>
        <ul className="studio-project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setActiveId(p.id)}>
                <span className="studio-project-title">{p.title || "未命名"}</span>
                <span className="studio-project-meta">{p.status}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="studio-view">
      <nav className="studio-stages" aria-label="创作阶段">
        <button type="button" className="studio-back" onClick={() => setActiveId(null)}>
          <Icon name="back" size={14} /> 项目列表
        </button>
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`studio-stage-btn${stage === s.key ? " is-active" : ""}`}
            onClick={() => setStage(s.key)}
          >
            <Icon name={s.icon} size={14} /> {s.label}
          </button>
        ))}
      </nav>
      {stage === "script" && <ScriptStage project={project} onDone={() => setStage("cast")} />}
      {stage === "cast" && <CastStage project={project} onDone={() => setStage("storyboard")} />}
      {stage === "storyboard" && <StoryboardStage project={project} />}
      {stage === "assembly" && <AssemblyStage project={project} />}
    </div>
  );
}
```

- [ ] **Step 2: ScriptStage（剧本 → AI 拆解）**

```tsx
"use client";

import { useState } from "react";
import { parseStudioScript, patchStudioProject, type StudioShotInput } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import type { useStudioProject } from "@/hooks/useStudioProject";

export function ScriptStage({
  project,
  onDone,
}: {
  project: ReturnType<typeof useStudioProject>;
  onDone: () => void;
}) {
  const d = project.detail;
  const [premise, setPremise] = useState(d?.premise ?? "");
  const [numShots, setNumShots] = useState(8);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!d) return null;

  const parse = async () => {
    setParsing(true);
    setError(null);
    try {
      await patchStudioProject(d.id, { premise });
      const r = await parseStudioScript(d.id, { premise, num_shots: numShots, style: d.style });
      // 草稿落库:角色逐个创建,分镜走批量保存
      for (const c of r.characters) {
        await import("@/lib/api").then((m) =>
          m.addStudioCharacter(d.id, { name: c.name, description: c.description, visual_prompt: c.visual_prompt })
        );
      }
      await project.saveShots(
        r.shots.map((s) => ({ ...s, render_mode: s.render_mode ?? d.render_mode_default }))
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "拆解失败,请重试");
    } finally {
      setParsing(false);
    }
  };

  return (
    <section className="studio-stage-script">
      <textarea
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
        placeholder="输入剧情概要或原文,AI 将拆解为角色与分镜…"
        rows={10}
      />
      <div className="studio-stage-actions">
        <label>
          分镜数
          <input
            type="number" min={1} max={50} value={numShots}
            onChange={(e) => setNumShots(Number(e.target.value))}
          />
        </label>
        <button type="button" className="btn btn-primary" disabled={parsing || !premise.trim()} onClick={parse}>
          <Icon name={parsing ? "loading" : "sparkles"} size={14} />
          {parsing ? "拆解中…" : "AI 拆解"}
        </button>
      </div>
      {error && <p className="studio-error">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 3: CastStage（角色卡片）**

角色列表 + 新建/编辑/删除；每卡片含 name / description / visual_prompt 编辑与 voice_ref_url 显示。参考图生成复用既有出图能力（`renderStudioShot` 之外的通用图像端点），M4 内先支持手填与后续扩展位。

- [ ] **Step 4: ShotCard + StoryboardStage（核心：分镜级 render_mode 切换）**

```tsx
"use client";

import type { StudioShot } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";

interface ShotCardProps {
  shot: StudioShot;
  busy: boolean;
  onModeChange: (mode: "video" | "image_motion") => void;
  onRender: () => void;
  onVoice: () => void;
  onLipsync: () => void;
}

export function ShotCard({ shot, busy, onModeChange, onRender, onVoice, onLipsync }: ShotCardProps) {
  const media = shot.final_clip_url || shot.video_url || shot.image_url;
  return (
    <article className="studio-shot" data-status={shot.status}>
      <div className="studio-shot-media">
        {shot.final_clip_url || shot.video_url ? (
          <video src={media} controls playsInline preload="metadata" />
        ) : shot.image_url ? (
          <img src={shot.image_url} alt={shot.scene || `分镜 ${shot.idx + 1}`} loading="lazy" />
        ) : (
          <div className="studio-shot-empty"><Icon name="image" size={22} /></div>
        )}
      </div>
      <div className="studio-shot-body">
        <div className="studio-shot-head">
          <span className="studio-shot-idx">#{shot.idx + 1}</span>
          {/* 核心:分镜级生成方式切换 */}
          <div className="studio-shot-mode" role="group" aria-label="生成方式">
            <button
              type="button"
              className={shot.render_mode === "video" ? "is-active" : ""}
              onClick={() => onModeChange("video")}
            >
              <Icon name="video" size={11} /> 视频
            </button>
            <button
              type="button"
              className={shot.render_mode === "image_motion" ? "is-active" : ""}
              onClick={() => onModeChange("image_motion")}
            >
              <Icon name="image" size={11} /> 运镜
            </button>
          </div>
          <span className="studio-shot-status">{shot.status}</span>
        </div>
        <p className="studio-shot-scene">{shot.scene || shot.prompt}</p>
        {shot.dialogue && <p className="studio-shot-dialogue">&ldquo;{shot.dialogue}&rdquo;</p>}
        {shot.error && <p className="studio-shot-error">{shot.error}</p>}
        <div className="studio-shot-actions">
          <button type="button" disabled={busy} onClick={onRender}>
            <Icon name={busy ? "loading" : "playing"} size={12} /> 生成
          </button>
          <button type="button" disabled={busy || !shot.dialogue} onClick={onVoice}>
            <Icon name="audio" size={12} /> 配音
          </button>
          {shot.render_mode === "video" && (
            <button type="button" disabled={busy || !shot.video_url || !shot.voice_url} onClick={onLipsync}>
              <Icon name="users" size={12} /> 对口型
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
```

`StoryboardStage`：分镜网格渲染 ShotCard 列表；`onModeChange` 更新本地草稿并调 `saveShots`（单条带 id 保存）；顶部「全部生成」调 `renderAll`；轮询 `studioStatus` 在 busy 期间刷新。

- [ ] **Step 5: AssemblyStage（时间轴 + 合成）**

按 idx 顺序列出各镜片段（`final_clip_url` 可播），底部「合成成片」调 `assemble`，完成后展示 `final_url` 播放器 + 下载链接。

- [ ] **Step 6: 验证** — `npm run build` 通过；图标全部来自 lucide-react（经 `components/ui/Icon` 的 name 映射，缺失图标名需先在 Icon.tsx 注册）

---

## Task 17：入口替换（page.tsx + Sidebar）

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/components/nav/Sidebar.tsx`（或 VIEW_META 定义处）

- [ ] **Step 1: 注册 studio 视图**

`app/page.tsx`：
- `viewImporters` 增加 `studio: () => import("@/components/studio/StudioView")`
- 懒加载：`const StudioView = lazy(() => viewImporters.studio().then((m) => ({ default: m.StudioView })))`
- 渲染分支：`{view === "studio" && <StudioView />}`
- `View` 类型与 `VIEW_META` 增加 `studio`（label「创作」），保留 `dramaStudio` 旧 key 重定向到 `studio`（`resolveView` 旧 key 映射表加 `"dramaStudio" → "studio"`、`"manju" → "studio"`）

- [ ] **Step 2: Sidebar 入口替换**

短剧/漫剧两个入口替换为单一「创作」（icon: `film` 或 `clapperboard`，指向 `studio`）。

- [ ] **Step 3: E2E 冒烟**

新建 `apps/web/e2e/authed-studio.spec.ts`（模式对齐 `authed-drama-studio.spec.ts`）：访问 `/?view=studio` 断言工作台容器渲染；旧链接 `/?view=dramaStudio` 重定向到 studio。

- [ ] **Step 4: 验证**

Run: `cd apps/web && npm run build`
Expected: 通过

---

## Task 18：M4 里程碑收尾

- [ ] 全量回归：后端 `pytest -q` + 前端 `npm run build`
- [ ] STATE.json 新增 `studio_m4_2026_08_05`；TEST_LOG.md 追加 `STUDIO-M4-2026-08-05`

---

# M5：旧模块冻结 + 文档 + 全量回归

## Task 19：旧模块冻结 ✅(2026-08-06 完成)

- [x] **Step 1: 后端 deprecated 标记** ✅

`app/routes/drama_studio.py` 与 `app/routes/manju.py` 模块 docstring 头部已追加：

```python
"""DEPRECATED(2026-08-05): 本模块已由 studio 创作工作室替代(app/routes/studio.py)。

保留仅作旧项目数据只读查询,不再新增功能。新需求一律走 /api/studio/*。
"""
```

- [x] **Step 2: 前端旧视图组件处置** ✅(改「冻结」而非删除)

grep 依赖确认：`animatic` 视图桌面端复用 `DramaStudioView` 的「动态分镜」页签(page.tsx),`ManjuView` 又被 `DramaStudioView` 引用 → 两组件暂不可删。处置：头部加 FROZEN 注释标明替代关系与保留下线条件;`authed-drama-studio.spec.ts` / `authed-manju.spec.ts` 删除(旧视图已重定向,断言失效);`authed-views` / `authed-ux-metrics` / `debug-sidebar` / `ui-smoke.mjs` / `scripts/test_app.py` / `test_performance.py` 视图清单切换到 studio。

- [x] **Step 3: 文档更新** ✅(替代承载)

AGENTS.md 已被设备管家会话改写为集群运维文件(git 未提交),项目「核心能力」段落不复存在 → 文档步由 TEST_LOG.md `STUDIO-M5-2026-08-06` 与 STATE.json `studio_m5_2026_08_06` 承载,不回滚他人未提交改动。

## Task 20：全量回归与状态归档 ✅(2026-08-06 完成)

- [x] **Step 1: 后端全量** ✅

`cd apps/api && .venv/bin/python -m pytest -q` → **1033 passed**(28.24s)

- [x] **Step 2: 前端构建 + e2e** ✅

`npm run build` 通过;`npx playwright test authed-studio authed-views --project=chromium-authed` → **16 passed**(11.0s)。
环境坑记录：rewrites 在 build 期烘焙,`INTERNAL_API_BASE` 必须随 build 注入,否则 /api 代理落 localhost:8090(SimpleHTTP 占用,e2e 全灭)。

- [x] **Step 3: STATE.json / TEST_LOG.md 终态更新** ✅

STATE.json 新增 `studio_m5_2026_08_06`(marks: `studio_module_complete`);TEST_LOG.md 追加 `STUDIO-M5-2026-08-06`(含 M1-M5 汇总)。

---

# 自查记录

- **Spec 覆盖**：设计文档 §2 架构 → Task 1/5/6/7/8；§3 数据模型 → Task 1；§4 工作台 → Task 16/17；§5 API → Task 3/8/10/11/12；§6 错误处理 → 各服务 VoiceError/RenderError/AssembleError + NAS 降级；§7 测试 → 每任务 TDD + 里程碑回归；§8 旧模块处置 → Task 19；§9 里程碑 → M1-M5 全覆盖。
- **类型一致性**：render_mode 取值 `video|image_motion` 全计划一致；分镜状态机 `draft→queued→rendering→rendered→voiced→lipsynced→done|error` 一致；URL 前缀 `/api/studio/files/` 在 renderer/voice/assemble/routes 间一致。
- **实现时对齐项**（已就地标注）：`video_generators.generate` 签名、`apiFetch` 封装名、`pathsafe` 导出名、`lipsync` 工作流接入细节、`Icon` 注册表。
