# 智能体驱动的提示词优化系统 — 设计契约

> 日期:2026-07-14
> 状态:已批准(方案 A,用户确认"自行组建 Agent 团队进行")
> 用途:作为多 Agent 并行实施的输入契约

---

## 一、目标

所有输入框旁的"优化提示词"按钮,改为可选择**智能体方向**的优化。
不同智能体优化的提示词内容/风格不同(写实摄影师 vs 动漫插画师 vs 国风水墨…)。

## 二、关键约束(用户明确)

1. **NSFW 智能体只在 /nsfw 页面下展示**,其他页面不展示 NSFW 智能体
2. **NSFW 智能体仅 R18 鉴权用户可见**(内部人员 + 机器学习测试通道)
3. **内置预设 + CRUD**:11 个内置智能体作种子,用户可在管理页增删改(内置可改不可删)
4. **双层选择**:顶栏全局默认 + 每个输入框可覆盖

## 三、智能体模型(后端 SQLModel)

```python
# apps/api/app/models.py 新增
class Agent(SQLModel, table=True):
    id: str = Field(primary_key=True)              # 'realist' / 'cinematographer' ...
    name: str                                       # 显示名
    description: str = ""                          # 一句话简介
    icon: str = "sparkles"                          # lucide-react 图标名
    applies_to: str = "all"                        # 'all' / 'image,video' / 'audio' / 'train'
    system_prompt: str                              # 主人格 system prompt
    is_nsfw: bool = False
    is_builtin: bool = False
    llm_model_override: str | None = None           # 绑定特定 LLM(None=走全局)
    sort: int = 100
    created_at: datetime
    updated_at: datetime
```

`applies_to` 解析:`","` 分隔字符串 → list;含 `"all"` 表示适用所有 kind。

## 四、11 个内置智能体(种子)

| id | name | icon | applies_to | is_nsfw | 风格描述 |
|---|---|---|---|---|---|
| realist | 写实摄影师 | camera | all | false | 高摄影感、布光、镜头语言、肤质、Bokeh |
| anime | 动漫插画师 | palette | all | false | danbooru 标签、风格化、人物表情动作、场景设计 |
| cinematic | 电影导演 | film | all | false | 镜头运动、景深、色温、胶片质感、叙事感 |
| ink_wash | 国风水墨画师 | brush | all | false | 水墨晕染、古籍笔意、诗词意象、东方美学 |
| oil_painting | 油画质感师 | brush | all | false | 笔触、画布、古典光影、名画象仿 |
| cyberpunk | 赛博朋克视觉师 | cpu | all | false | 霓虹、雨夜、金属质感、未来都市、故障艺术 |
| minimal | 极简美学师 | minus | all | false | 极简、留白、质感、几何、高级感 |
| product | 产品广告师 | package | all | false | 商品、静物、背景纯净、商业广告质感 |
| voice_dub | 译制配音师 | mic | audio | false | TTS 配音优化、语调、节奏、情感 |
| train_data | 训练数据师 | database | train | false | LoRA 训练样本描述、触发词设计、数据集规划 |
| nsfw_photographer | NSFW 摄影导演 | camera | image,video | true | NSFW 写实人像/光影/身体描述,不阉割 |
| nsfw_anime | NSFW 动漫师 | palette | image,video | true | NSFW 动漫/二次元/动作姿势,不阉割 |

## 五、数据库迁移

`apps/api/app/db.py` 的 `_SQLITE_MIGRATIONS` 追加(幂等):
```sql
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT 'sparkles',
    applies_to TEXT DEFAULT 'all',
    system_prompt TEXT NOT NULL,
    is_nsfw INTEGER DEFAULT 0,
    is_builtin INTEGER DEFAULT 0,
    llm_model_override TEXT,
    sort INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`apps/api/app/agents_seed.py` 新建,导出 `BUILTIN_AGENTS` 列表 + `seed_builtin_agents()` 幂等播种函数(已存在则跳过,不动用户改过的)。
`apps/api/app/main.py` 启动事件调 `seed_builtin_agents()`。

## 六、后端 API 端点

### `/api/agents` CRUD(新建 `apps/api/app/routes/agents.py`)

| 方法 | 路径 | 鉴权 | 行为 |
|---|---|---|---|
| GET | `/api/agents?kind=image` | 普通用户 | 列表;按 `applies_to` 过滤;NSFW 智能体仅 R18 用户可见;按 sort 排序 |
| GET | `/api/agents/{id}` | 普通用户 | 详情;NSFW 智能体需 R18 |
| POST | `/api/agents` | admin | 创建自定义(is_builtin=False) |
| PUT | `/api/agents/{id}` | admin | 改;内置的 is_builtin 不变;system_prompt 可改 |
| DELETE | `/api/agents/{id}` | admin | 删;内置(is_builtin=True)拒删返 403 |

响应模型:
```python
class AgentOut(BaseModel):
    id: str
    name: str
    description: str
    icon: str
    applies_to: list[str]          # 序列化时拆分
    system_prompt: str
    is_nsfw: bool
    is_builtin: bool
    llm_model_override: str | None
    sort: int
```

### `/api/optimize` 改造(`apps/api/app/routes/optimize.py`)

```python
class OptimizeRequest(BaseModel):
    prompt: str
    kind: str = "image"
    model: str | None = None
    agent_id: str | None = None   # 新增;None=用户默认 default_agent_id;仍 None=用 kind 默认 system
```

逻辑:
1. 解析 agent_id(None → 读 user.default_agent_id;仍 None → 走原 kind system prompt)
2. 校验:agent 不存在 → 404;agent.is_nsfw 且请求无 X-NSFW header → 403
3. 校验:agent.applies_to 不含 kind 且不含 "all" → 400(智能体不适用此 kind)
4. 组合 system prompt:`agent.system_prompt + "\n\n" + 原 kind 系统提示(含模型族方言)`
5. 调 LLM,解析返回(原逻辑不变)

### `/api/account` 改造(`apps/api/app/routes/account.py`)

加 preference 字段:
- `User.default_agent_id: str | None`(models.py 加字段,DB 加列)
- `PUT /api/account/preferences` 端点(改 default_agent_id)

## 七、前端类型 + API client(`apps/web/lib/agents.ts` 新建)

```typescript
export interface Agent {
  id: string;
  name: string;
  description: string;
  icon: string;
  applies_to: string[];          // 后端逗号串 → 前端数组
  system_prompt: string;
  is_nsfw: boolean;
  is_builtin: boolean;
  llm_model_override: string | null;
  sort: number;
}

export async function listAgents(kind?: string): Promise<Agent[]>
export async function getAgent(id: string): Promise<Agent>
export async function createAgent(data: Partial<Agent>): Promise<Agent>
export async function updateAgent(id: string, data: Partial<Agent>): Promise<Agent>
export async function deleteAgent(id: string): Promise<void>

// localStorage 持久化当前选中(顶栏切换用)
export const DEFAULT_AGENT_KEY = "toiv_default_agent";
export function getLocalAgent(): string | null
export function setLocalAgent(id: string | null): void
```

## 八、AgentSwitcher 顶栏组件(`apps/web/components/ui/AgentSwitcher.tsx` 新建)

- 紧凑按钮(图标 + 当前智能体名)+ Popover 下拉
- 列出 **SFW 智能体**(is_nsfw=false),按 sort 排序
- **不展示 NSFW 智能体**(用户约束:/nsfw 页面外不展示)
- 选中后写 localStorage + 调 `PUT /api/account/preferences` 持久化
- 接入位置:`apps/web/components/nav/Topbar.tsx` 右侧,NSFW 入口左边

## 九、OptimizeButton 升级(`apps/web/components/ui/OptimizeButton.tsx`)

新增 props(保持向后兼容,旧调用不破坏):
```typescript
interface OptimizeButtonProps {
  onClick?: () => Promise<string | void> | string | void;  // 旧逻辑
  prompt: string;
  kind?: string;                    // 新:image/video/audio/train
  model?: string;                   // 新:目标 checkpoint
  onOptimized?: (text: string, negative?: string) => void;  // 新:统一回填
  allowAgentOverride?: boolean;     // 新:是否允许在按钮旁覆盖全局智能体(默认 true)
  disabled?: boolean;
  label?: string;
}
```

行为:
- 点击 sparkles → 若 allowAgentOverride,弹紧凑 Popover 列出该 kind 可见智能体:
  - SFW 页面(kind 非 NSFW):只列非 NSFW 智能体
  - NSFW 页面(kind=video + R18 已开):列全部含 NSFW 智能体
- 选完智能体 → 调 `/api/optimize`(带 agent_id + kind + model)→ 回填 onOptimized
- loading 态防重复(已有)

向后兼容:无 kind/model 时退化为旧行为(调父级 onClick)。

## 十、各视图接入清单

| 视图 | 输入框 | kind | 接入方式 |
|---|---|---|---|
| CreateView | 正向/负向提示词 | image | 升级为新 OptimizeButton,传 kind="image" + model={ckptName} |
| NsfwVideoView | t2v/i2v/lipsync 正向提示词 | video | 新接入,kind="video",R18 已开可看 NSFW 智能体 |
| ManjuView | 角色台词/场景描述 | audio | 新接入,kind="audio",只可见 voice_dub + all |
| DubView | 译制对白/口型文本 | audio | 新接入,kind="audio" |
| TrainView | 训练样本描述/触发词 | train | 新接入,kind="train",只可见 train_data + all |
| BacklotView | 剧本/场景描述 | video | 新接入(如有输入框) |

## 十一、AgentsAdminView 管理页(`apps/web/components/admin/AgentsAdminView.tsx` 新建)

- 路由:`/admin/agents`(接入 AdminView 子页)
- 鉴权:仅 admin
- 功能:
  - 列表(全部智能体,含 NSFW)
  - 编辑(system_prompt 多行 textarea + 实时测试:输入示例 prompt → 调 /api/optimize 看输出)
  - 新建自定义
  - 删除(内置禁用,自定义可删)

## 十二、容错与限流

- LLM 不可用 → 503 + 友好错误
- 优化超时 30s → 504
- 限流:复用 `enforce_generation_rate_limit`
- 前端 loading 防重复(已有)
- agent_id 无效 → 404 + 退回默认
- NSFW 智能体对未授权用户 → 403 + 前端硬阻止选

## 十三、文件改动清单(给各 Agent)

### 后端(Agent A)
- 修改 `apps/api/app/models.py`(加 Agent + User.default_agent_id)
- 修改 `apps/api/app/db.py`(_SQLITE_MIGRATIONS 加 agents 表 + users.default_agent_id 列)
- 新建 `apps/api/app/agents_seed.py`
- 修改 `apps/api/app/main.py`(启动时 seed + 注册 agents router)
- 新建 `apps/api/app/routes/agents.py`
- 修改 `apps/api/app/routes/optimize.py`(加 agent_id)
- 修改 `apps/api/app/routes/account.py`(加 preferences 端点)
- 修改 `apps/api/tests/`(加 test_agents.py)

### 前端基础设施(Agent B)
- 新建 `apps/web/lib/agents.ts`
- 新建 `apps/web/components/ui/AgentSwitcher.tsx`
- 修改 `apps/web/components/ui/OptimizeButton.tsx`(升级)
- 修改 `apps/web/components/nav/Topbar.tsx`(接入 AgentSwitcher)
- 修改 `apps/web/components/ui/Icon.tsx`(补图标键:camera/palette/film/brush/cpu/minus/package/mic/database)

### 前端视图接入(Agent C + D)
- 修改 `apps/web/components/create/CreateView.tsx`
- 修改 `apps/web/components/nsfw/NsfwVideoView.tsx`
- 修改 `apps/web/components/manju/ManjuView.tsx`
- 修改 `apps/web/components/dub/DubView.tsx`
- 修改 `apps/web/components/train/TrainView.tsx`
- 修改 `apps/web/components/backlot/BacklotView.tsx`
- 新建 `apps/web/components/admin/AgentsAdminView.tsx`
- 修改 `apps/web/components/admin/AdminView.tsx`
