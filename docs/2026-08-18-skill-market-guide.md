# Skill 市场使用指南（2026-08-18）

> 适用版本：2026-08-18 起（市场化改造 + 检索增强）
> 入口：桌面端左上角灵动岛首项「Skill 市场」；窄屏端底部导航「更多」抽屉第一项；直达 URL `/?view=skills`
> 本文是长期维护文档：功能变化时须同步更新（见文末「维护机制」）

---

## 1. Skill 市场是什么

Skill 市场是 ToIV 的**提示词人格技能**交易与管理中心。每个「技能」= 一张绑定 `system_prompt`（主人格提示词）的卡片，在两类 LLM 场景作为**人格前缀**生效：

| 消费场景 | 入口 | 生效方式 |
|---|---|---|
| 提示词优化 | 各生成表单「优化」按钮（OptimizeButton）→ 技能列表 | 三层叠加：自定义风格 > 技能人格 > 风格预设 > 引擎方言系统提示 |
| 分镜 AI 扩写 | 创作工作台分镜卡「AI 扩写」→ 风格技能下拉 | `skill.system_prompt + 扩写系统提示`，走 L3 精修层 |

技能**不注入** AI 助手对话（⌘K 助手是独立链路）。

## 2. 市场导航：三个分区

打开市场后技能按属主分三区（自上而下）：

| 分区 | 来源 | 可见性 | 卡片信息 |
|---|---|---|---|
| **我的技能** | 本人从市场导入（`POST /api/skills/import`） | 仅本人 | 图标 / 名称 / 描述 / 适用范围 tag /「我的」tag / R18 tag |
| **公共技能** | admin 在管理页创建（`POST /api/agents`） | 全员 | 同上（无「我的」tag） |
| **内置技能** | 启动时幂等播种的 23 个种子（`agents_seed.BUILTIN_AGENTS`） | 全员 | 同上；含 10 原始 SFW + 2 非图像类 + 5 NSFW + 8 流行风格（吉卜力/新海诚/像素/黑色电影/皮克斯 3D/哥特/蒸汽波/拍立得） |

- 点卡片**名称** → Modal 只读查看完整 `system_prompt`
- 分区头右侧计数徽标实时反映当前过滤结果
- 「我的技能」区头右侧有**导入技能**按钮

## 3. 技能搜索与筛选（2026-08-18 检索增强）

页面顶部工具栏，**客户端即时过滤**，三区共用：

| 控件 | 行为 |
|---|---|
| 搜索框 | 名称 + 描述包含匹配，不区分大小写；`type="search"` 自带清除 |
| 范围 chips | 全部范围 / 图片 / 视频 / 音频；匹配 `applies_to` 包含该值（`all` 的技能恒中） |
| R18 chip | 仅显示 `is_nsfw` 技能（R18 技能本身需在 R18 模式下才会出现在列表，SFW 上下文服务端直接剔除） |

三条件叠加（AND）；全部命中为空时显示「没有匹配的技能」提示。

> 后端 `GET /api/agents?kind=` 亦支持服务端范围过滤（OptimizeButton 在用）；市场页为体验一致性走客户端过滤。

## 4. 安装（导入）技能：两种模式

点「导入技能」→ Modal 顶部 tab 切换：

### 4.1 手填表单

| 字段 | 必填 | 约束 |
|---|---|---|
| 名称 | ✅ | ≤120 字符 |
| 描述 | — | ≤500 字符 |
| 图标 | — | 9 个白名单 lucide 图标下拉（sparkles/camera/palette/film/brush/cpu/package/mic/database） |
| 适用范围 | — | 全部 / 图片 / 视频 / 音频 / 图片+视频 |
| 提示词（system_prompt） | ✅ | ≤20000 字符，技能人格核心 |
| R18 技能 | — | 开关；后端要求请求处于 R18 上下文（X-NSFW），否则 403 |

### 4.2 粘贴 JSON

粘贴他人「分享」复制的 JSON（结构见 6.3），前端校验 `name`/`system_prompt` 必填后导入。

两种模式最终都走 `POST /api/skills/import`，产物为 `user_id=属主` 的**个人技能**。id 省略时自动生成 `slug-时分秒`（防全局冲突）；指定 id 撞已有 → 409。

## 5. 管理技能

| 操作 | 谁可以 | 路径 |
|---|---|---|
| 编辑 | 个人技能属主 | 「我的技能」卡铅笔按钮，表单预填，`PUT /api/agents/{id}` |
| 删除 | 个人技能属主 | 卡删除按钮 → 二次确认 Modal（危险门）→ `DELETE /api/agents/{id}` |
| 分享 | 任何人（对可见技能） | 卡分享按钮 → 序列化 JSON 复制到剪贴板（失败降级弹窗展示） |
| 公共技能管理 | 仅 admin | 管理页 AgentsAdminView（创建/编辑/删除公共自定义 + 现场测试） |

**权限矩阵**（后端强制，404 不泄露存在性）：

| 对象 | 看 | 改 | 删 |
|---|---|---|---|
| 个人技能 | 仅属主 | 属主 | 属主 |
| 公共自定义 | 全员 | admin | admin |
| 内置技能 | 全员 | admin（可改不可删，`is_builtin` 恒不变；改后种子不覆盖） | ❌ 403 |
| R18 技能 | 仅 R18 上下文 | 同上 | 同上 |

## 6. 技能与生成链路集成

### 6.1 提示词优化（OptimizeButton）

生成表单点「优化」→ 弹层内智能体 listbox（按引擎 kind 过滤）→ 选中即以该技能人格优化当前提示词；选中项写入 localStorage 全局默认（`toiv_default_agent`），并同步服务端 `PUT /api/account/preferences { default_agent_id }`。

### 6.2 分镜 AI 扩写（创作工作台）

分镜卡「AI 扩写」面板 → 「风格技能(Skill 市场)」下拉选技能 → `optimizeStudioShot(pid, {brief, skill_id})`（120s 超时）。

### 6.3 分享 JSON 结构（SkillSharePayload）

```json
{
  "name": "技能名",
  "description": "描述",
  "icon": "sparkles",
  "applies_to": "image,video",
  "system_prompt": "主人格提示词全文",
  "is_nsfw": false,
  "llm_model_override": null
}
```

不含 id / 属主 —— 导入方获得自己的个人副本，与原作者解耦。

## 7. 最佳实践

- **写好 system_prompt**：技能是「人格 + 领域知识」前缀，写清角色、风格词汇表、输出结构；触发词/镜头语言等确定性内容直接写死，不留给 LLM 发挥
- **适用范围准确**：范围不符的技能在对应引擎的优化列表中不可选（400）
- **R18 技能**命名加醒目前缀便于治理；分享 JSON 跨设备传播注意合规
- **个人技能想公开**：当前发布通道为 admin 在管理页创建（普通用户无申请通道，属已知限制）

## 8. 已知限制（2026-08-18 快照）

1. 无站内分享码/短链（分享靠剪贴板 JSON 手动传递）
2. 无分页/懒加载（技能全量返回渲染，当前量级无压力）
3. JSON 导入校验浅（仅必填校验；icon/applies_to 非法值由前端展示兜底为 sparkles/原样）
4. 编辑不可改 `llm_model_override` 与 `sort`
5. 旧 M5 drama_skills 三端点为死接口（无前端消费者），与技能市场是两套概念

## 9. 维护机制（长期任务）

- **功能变化时**：改动 Skill 市场相关代码（`components/skills/SkillMarketView.tsx`、`routes/agents.py`、`agents_seed.py`、`lib/agents.ts`）须同步本文对应章节，并在 TEST_LOG.md 记里程碑
- **内置技能增删**：改 `apps/api/app/agents_seed.py`（记得更新头注释数量——2026-08-18 已知滞后：头注释写 15 实为 23），重启幂等播种；同步本文第 2 节数字
- **定期复核**（建议每月）：核对三区技能数量、权限矩阵与代码一致；清理第 8 节已修复项
- 相关代码索引：前端 `apps/web/components/skills/SkillMarketView.tsx`（视图）+ `apps/web/lib/agents.ts`（API 层）；后端 `apps/api/app/routes/agents.py`（6 端点）+ `apps/api/app/agents_seed.py`（种子）+ `apps/api/app/models.py` Agent 表
