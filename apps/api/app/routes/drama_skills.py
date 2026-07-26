"""M5: Skill 市场雏形 —— 预设创作流程模板,一键应用到新项目。

对标 liblib.tv 的 Skill 市场:内置 4 个短剧模板(武侠/言情/科幻/喜剧),
用户选择后一键创建项目 + 角色卡,内置 style_hint / script_template / 分辨率 / fps。

设计要点:
  · Skill 模板硬编码(无需数据库表),改动通过修改 _BUILTIN_SKILLS
  · apply 端点复用 drama_studio 的 _append_process / _project_dict / _character_dict
  · 鉴权用 get_current_user,项目归属当前用户
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import DramaCharacter, DramaProject, User
from app.routes.drama_studio import _append_process, _character_dict, _project_dict

router = APIRouter()


# ===========================================================================
# 内置 Skill 模板(硬编码,对标 liblib.tv 的预设创作流程)
# ===========================================================================
_BUILTIN_SKILLS: list[dict] = [
    {
        "id": "skill-wuxia",
        "name": "武侠对决",
        "category": "action",
        "description": "武侠风格短剧,含对决场景,9 镜头节奏",
        "style_hint": "wuxia, ancient chinese, cinematic, film grain, martial arts",
        "default_num_shots": 9,
        "width": 768,
        "height": 384,
        "fps": 16,
        "character_templates": [
            {
                "name": "主角",
                "description": "正派侠客",
                "visual_prompt": "1boy, ancient chinese warrior, long black hair, blue robe, sword",
            },
            {
                "name": "对手",
                "description": "反派高手",
                "visual_prompt": "1boy, dark robe, scar on face, cold eyes",
            },
        ],
        "script_template": "主角追踪对手至悬崖,两人展开终极对决...",
        "tags": ["动作", "古风", "对决"],
    },
    {
        "id": "skill-romance",
        "name": "都市言情",
        "category": "romance",
        "description": "现代都市情感短剧,16 镜头慢节奏",
        "style_hint": "modern city, soft lighting, romance, shallow depth of field",
        "default_num_shots": 16,
        "width": 768,
        "height": 432,
        "fps": 24,
        "character_templates": [
            {
                "name": "女主",
                "description": "职场女性",
                "visual_prompt": "1girl, modern office lady, short hair, white shirt",
            },
            {
                "name": "男主",
                "description": "商务精英",
                "visual_prompt": "1boy, business suit, gentle smile",
            },
        ],
        "script_template": "雨夜咖啡馆偶遇,两人目光交汇...",
        "tags": ["现代", "情感", "慢节奏"],
    },
    {
        "id": "skill-scifi",
        "name": "科幻史诗",
        "category": "scifi",
        "description": "太空科幻短剧,12 镜头大场面",
        "style_hint": "sci-fi, space, neon, cyberpunk, cinematic, epic scale",
        "default_num_shots": 12,
        "width": 768,
        "height": 384,
        "fps": 16,
        "character_templates": [
            {
                "name": "舰长",
                "description": "星际舰队舰长",
                "visual_prompt": "1boy, space captain uniform, determined eyes",
            },
        ],
        "script_template": "星际舰队遭遇未知文明,舰长面临抉择...",
        "tags": ["科幻", "太空", "史诗"],
    },
    {
        "id": "skill-comedy",
        "name": "轻松喜剧",
        "category": "comedy",
        "description": "日常搞笑短剧,8 镜头快节奏",
        "style_hint": "bright lighting, comedy, warm colors, everyday scene",
        "default_num_shots": 8,
        "width": 768,
        "height": 384,
        "fps": 24,
        "character_templates": [
            {
                "name": "倒霉蛋",
                "description": "总是出糗的主角",
                "visual_prompt": "1boy, casual clothes, funny expression",
            },
        ],
        "script_template": "早起赶地铁却一路倒霉...",
        "tags": ["喜剧", "日常", "快节奏"],
    },
]


def _find_skill(skill_id: str) -> dict | None:
    for s in _BUILTIN_SKILLS:
        if s["id"] == skill_id:
            return s
    return None


# ===========================================================================
# 端点
# ===========================================================================
@router.get("/drama/skills")
def list_skills(
    category: str | None = Query(default=None, description="按分类过滤(action/romance/scifi/comedy)"),
    user: User = Depends(get_current_user),
) -> dict:
    """M5: 列出所有内置 Skill 模板,支持 ?category= 过滤。"""
    skills = _BUILTIN_SKILLS
    if category:
        skills = [s for s in skills if s.get("category") == category]
    return {"skills": skills}


@router.get("/drama/skills/{skill_id}")
def get_skill(
    skill_id: str,
    user: User = Depends(get_current_user),
) -> dict:
    """M5: 获取单个 Skill 模板详情。不存在返回 404。"""
    skill = _find_skill(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill 不存在")
    return skill


@router.post("/drama/skills/{skill_id}/apply")
def apply_skill(
    skill_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M5: 一键应用 Skill —— 基于模板创建新 DramaProject + 角色卡。

    复用 ProjectIn 的字段(style/script/width/height/fps),并把 skill 的
    style_hint 写入 style、script_template 写入 script、character_templates
    逐个创建 DramaCharacter。返回创建的 project_dict(含 characters 数组)。
    """
    skill = _find_skill(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill 不存在")

    # 创建项目
    project = DramaProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=skill["name"],
        premise=skill.get("description", ""),
        style=skill.get("style_hint", ""),
        script=skill.get("script_template", ""),
        width=skill.get("width", 768),
        height=skill.get("height", 384),
        fps=skill.get("fps", 16),
    )
    session.add(project)
    session.commit()
    session.refresh(project)

    # 创建角色卡
    created_chars: list[DramaCharacter] = []
    for tpl in skill.get("character_templates", []):
        c = DramaCharacter(
            project_id=project.id,
            name=tpl.get("name", ""),
            description=tpl.get("description", ""),
            visual_prompt=tpl.get("visual_prompt", ""),
        )
        session.add(c)
        created_chars.append(c)
    session.commit()
    for c in created_chars:
        session.refresh(c)

    # 记录创作过程
    _append_process(project, "skill_apply", f"应用 Skill: {skill['name']}")
    session.add(project)
    session.commit()
    session.refresh(project)

    out = _project_dict(project)
    out["characters"] = [_character_dict(c) for c in created_chars]
    return out
