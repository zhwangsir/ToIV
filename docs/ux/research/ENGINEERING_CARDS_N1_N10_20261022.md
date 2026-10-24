> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# ENGINEERING CARDS — 近窗 N1–N10（可开工，不写实现码）

> **文档日期**：2026-10-22（Asia/Shanghai）  
> **状态**：只读调研落盘；**禁止**本窗业务编码 / commit / push / 部署 / 下载模型 / 重启服务  
> **对齐 tip**：`e5307c63`（`git rev-parse` = `e5307c639d717f002cfd0e726b09a9e2ce92e200`）  
> **分支**：`work/p0-fusion-20261016`  
> **本机路径**：`/Users/wangzhenyu/Desktop/ALLProject/ToIV`  
> **上游**：`AUDIT_MASTER` §2 N1–N10；`COMPETITIVE_RESEARCH…` §9 P1–P3、§12、§13；`AGENTS.md` §三–§四（H3=**:8264**、IndexTTS=**:9200**、VLM=**:9311**）  
> **咬合**：`IA_INTERACTION_SPEC_P1_P3_20261022.md`（壳层规格）；本文件 = **工程触点卡**（文件+改法+测点+风险+依赖）

---

## 0. 怎么用这张卡

每条 N 统一六栏：

1. **现状证据**（路径 + 符号/字符串，tip 实查）  
2. **拟改文件清单**（精确到文件；目录级标范围）  
3. **建议改法**（产品语义级，非大段代码）  
4. **单测 / 契约测 / 手工验收**  
5. **破坏半径与回滚**  
6. **依赖顺序**（哪些必须先于哪些）

**建议全局开工序**（详见表尾 §开工顺序）：

`N9 → N6`（纯文档，可并行） → `N1 → N2`（默认口+注册表，同批测） → `N3∥N4∥N10`（P1 壳） → `N7`（管线 UX 语义） → `N5`（P3） → `N8`（持续纪律卡，非一次性 PR）

---

## N1 — H3 默认基址 :8195 → :8264

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N1；AGENTS §三「H3 生产口=:8264」；§12.6 禁盲抄 :8195 |
| **验收信号** | 新环境无 env 也不会打死人口；`.env.example` 禁写「生产=8195」 |

### 1) 现状证据（tip `e5307c63`）

| 路径 | 证据 |
|------|------|
| `apps/api/app/config.py` L364–L375 | 注释写「workstation :8195」；`h3_base_url: str = "http://192.168.71.127:8195"`；`h3_base_urls` 注释仍写「生产 = WS :8195 + PC01 :8198」 |
| `apps/api/.env.example` L90–L96 | `TOIV_H3_BASE_URL=http://192.168.71.127:8195`；注释「:8195」 |
| `deploy/.env.example` L38–L42 | 同上，默认 :8195 |
| `apps/api/app/services/h3.py` L3、L71–L74 | 模块头注释默认 :8195；`H3_WORKER_OVERRIDE_WHITELIST` **同时含** `:8195` 与 `:8264`（白名单可留 legacy） |
| `apps/api/app/services/worker_warmup.py` L30 | `_ALLOWED_WARMUP_PORTS = {8195, 8262, 8264}`（8195 仍允许预热） |
| 对照（已对的） | `apps/canvas/.../local-model-defaults.ts`：`LOCAL_H3_WORKER_LABEL = ":8264"` + `LOCAL_H3_FORBIDDEN_DEFAULT_WORKER = ":8195"`；`nasmodels/inventory.go` `DefaultH3Worker = ":8264"` |

**注意**：管线/白名单里 **保留 :8195 作 overflow/评测 pin**（见 `docs/ops/PIPELINE_C_API.md`）是刻意能力，N1 只改「无 env 时的生产默认」与 example 文案，**不是**从白名单抹掉 8195。

### 2) 拟改文件清单

- **必改**：`apps/api/app/config.py`；`apps/api/.env.example`；`deploy/.env.example`；`apps/api/app/services/h3.py`（注释 + 文档字符串）  
- **建议同步文案**：`apps/api/app/services/worker_warmup.py` 注释（端口集合可暂留 8195=legacy 允许）  
- **勿动**：生产机已有 `TOIV_H3_BASE_URL=...:8264` 的真实 `.env`（本窗不部署、不改现网）；`H3_WORKER_OVERRIDE_WHITELIST` 中的 8195 条目  
- **文档债旁注（可并 N9）**：历史 ops 日志里的 :8195 叙事不改史实

### 3) 建议改法

1. `Settings.h3_base_url` 默认改为 `http://192.168.71.127:8264`（或与 AGENTS 一致的 TS/LAN 口径二选一，**全仓统一一种**）。  
2. `.env.example` / `deploy/.env.example`：默认 URL→8264；注释写明「:8195 已 stop+disable，仅评测/溢出白名单」。  
3. `h3.py` 头注释与「单实例默认」叙述改为 8264；白名单两口并存。  
4. 可选负向：单测断言「默认 base 不含 :8195」。

### 4) 单测 / 契约测 / 手工验收

- **单测**：扩展或新增断言 `get_settings().h3_base` 默认后缀 `:8264`（mock 无 env）；`validate_worker_override(":8195")` 仍通过。  
- **契约**：扫 `.env.example`：`rg 'TOIV_H3_BASE_URL=.*8195' apps/api/.env.example deploy/.env.example` → 0 命中。  
- **手工**：清空本地覆盖 env 起 api 一次（仅开发机），`/api/...` 或 admin 探活指向 8264；**不**在战役窗重启生产。

### 5) 破坏半径与回滚

- **半径**：新装/无 env 开发机、文档复制粘贴默认；**不影响**已设 env 的生产。  
- **回滚**：恢复 `config.py` / example 三处字符串即可；白名单未删则评测 pin 不受影响。

### 6) 依赖顺序

- **先于** N2（注册表 H3 口与默认一致，避免「默认 8264、舰队卡片仍 8195」）。  
- **可与** N9 文档横幅并行。  
- **不阻塞** N3–N5、N10 前端。

**主触点文件数（必改）**：约 **4**（config + 2×env.example + h3.py）；建议+1 warmup 注释。

---

## N2 — fleet_registry + test_fleet 对齐 AGENTS §三

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N2；AUDIT_A；L1 舰队分母 |
| **验收信号** | Admin 在线率分母与现网一致；单测断言同步 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `apps/api/app/services/fleet_registry.py` workstation `services`（约 L53–79） | 仍列 **H3:8195**、**超分#1:8261**、**CosyVoice2/3:9201/9202**、**Qwen3-TTS:9203**、**OpenTalking:4403**、FlashTalk:9004 等 |
| 同文件 | **缺**：生产 H3 **:8264**、通用扩容 **:8265**、VLM **:9311** |
| `apps/api/tests/test_fleet.py` L59–63 | `test_registry_workstation_services_match_fleet` 断言端口集 **含** `{8195, 8261, 9201, 9202, 9203, 4403, …}`，**不含** `8264/8265/9311` |
| `AGENTS.md` §三 | 常驻：LB:8188、:8196、:8197、H3:**:8264**（:8195 ~~停~~）、VLM:**:9311**、超分 :8262/:8263（**:8261 已撤**）、:8265、Embedding:9302、IndexTTS:**:9200**、:9220/:9100；opentalking **已下架** |

### 2) 拟改文件清单

- **必改**：`apps/api/app/services/fleet_registry.py`；`apps/api/tests/test_fleet.py`  
- **只读对照**：`AGENTS.md` §三（真源）；`docs/ux/research/AUDIT_A_FLEET_MODELS_20261022.md`  
- **勿在本卡**：关停真实 CosyVoice unit、改 systemd（运维另窗）

### 3) 建议改法

按 AGENTS §三 **重写 workstation.services 内容**（保留探测引擎 `fleet.py` 不动）：

| 动作 | 端口/服务 |
|------|-----------|
| **改指向** | H3 主力：`8195` → **`8264`**（note=GPU1 · 生产） |
| **新增** | `:8265`（通用 worker#3）；`:9311`（ToIV VLM） |
| **摘退役/下架** | `:8261`；OpenTalking `:4403`；按现网确认后的 CosyVoice×3 / 其它已归档项（以 AGENTS+真机为准，不确定则标 `note=legacy/归档` 并移出「在线率分母」或单独 `optional` 组——**产品决策：默认摘出分母**） |
| **保留** | IndexTTS `:9200`；:8196/:8197/:8199；:8262/:8263；:9302；:9220；sysmetrics:9403 等 AGENTS 仍列项 |
| **单测** | 期望端口集改为含 `8264,8265,9311,9200,…`；**负向**可选：`8195 not in production_ports` 或注释「8195 不得作为唯一 H3」 |

### 4) 单测 / 契约测 / 手工验收

- **单测**：`pytest apps/api/tests/test_fleet.py -q` 全绿；断言集与 registry 同 PR。  
- **契约**：Admin `/api/fleet`（admin token）`workstation.services_total` 与 AGENTS 常驻行数一致量级；假 down 的 CosyVoice/4403 不再拉低「核心在线率」（若 UI 分核心/可选，在本卡注明）。  
- **手工**：Admin Observability 舰队卡片：H3 显示 8264 up；无「假 OpenTalking down」吓运维。

### 5) 破坏半径与回滚

- **半径**：Admin 舰队 UI、在线率分母、依赖 registry 的脚本。  
- **回滚**：还原 `fleet_registry.py` + `test_fleet.py`；不涉及 GPU 进程。

### 6) 依赖顺序

- **依赖** N1（默认口叙事一致）。  
- **可并行** N9（INVENTORY 横幅指向同一 AGENTS 表）。  
- **先于** 任何「按 registry 自动告警」运维脚本改动。

**主触点文件数**：**2**（registry + test_fleet）。

---

## N3 — 首页主 CTA 语义：「新建画布创作」→「新建短剧」

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N3；方案 §9 P1.1；G1；D1-A |
| **验收信号** | 学习站进门不落自由画布 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `apps/canvas/web/src/pages/home/home-dashboard.tsx` L16–L23 | `aria-label="新建画布"`；按钮文案 **「新建画布创作」**；`navigate("/canvas?mode=new")` |
| 同文件 L56–L68 | 「最近项目」拉 **画布** `CanvasLibrarySummary`；空态「创建第一个画布」→ 仍进 canvas |
| `apps/canvas/web/src/pages/home/home-data.ts` L31–L36 | 能力瓷砖多条直链 `/canvas?mode=new&add=…`（与主 CTA **三重镜像**，OPTIMIZE P1 收权） |
| `apps/canvas/web/test/agent-product-entry-retired.test.tsx` | 断言含「新建画布创作」与画布路径 |
| 对照短剧入口 | `pages/toiv/drama-page.tsx`：列表 `/toiv/drama`；空态引导「对智能体说…」；有「从图片创建」；**缺**显式「新建空白短剧」主按钮 |
| 后端已有 | `routes/studio.py` `@router.post("/studio/projects")` `create_project`；样片 `POST /studio/sample-projects/rain-night`（L6/D8-A 旁路） |

### 2) 拟改文件清单

- **必改**：`home-dashboard.tsx`；相关单测 `agent-product-entry-retired.test.tsx`（及任何硬编码「新建画布创作」的测试）  
- **建议**：`home-data.ts`（能力瓷砖降权/移出首页，与 OPTIMIZE「首页能力瓷砖收权」同波）  
- **建议补**：`drama-page.tsx` + `services/toiv/client.ts`（若尚无前端 `createStudioProject` 封装，补一层调 `POST /studio/projects`）  
- **可选**：`IA` 规格已写文案表时，与之一词对齐

### 3) 建议改法

1. 主 CTA 文案 → **「新建短剧」**；点击 → `POST /studio/projects`（或先 `navigate('/toiv/drama')` 再弹建项——推荐 **直建并进** `/toiv/ws/{id}`）。  
2. Hero `aria-label` 改「新建短剧」。  
3. 「最近项目」优先 **Studio 短剧列表**（`fetchDramaProjects`）；画布最近降为次级折叠或侧栏「项目」。  
4. 空态文案：「创建第一个短剧」；次按钮「打开自由画布（专家）」。  
5. 能力瓷砖：本卡可只改主 CTA；瓷砖收权可并 OPTIMIZE P1 首项。

### 4) 单测 / 契约测 / 手工验收

- **单测**：首页渲染断言主按钮文案含「新建短剧」且 **不含**「新建画布创作」；点击 mock navigate 目标为 `/toiv/ws/` 或 `/toiv/drama` 前缀，而非裸 `/canvas?mode=new`。  
- **e2e（可选）**：authed 首页点主 CTA → 工作台壳出现。  
- **手工**：学习站新用户 10 秒能指出「下一步=短剧」；不进 xyflow 空画布。

### 5) 破坏半径与回滚

- **半径**：首页信息架构、依赖旧文案的测试/脚本（`beeftv-local-network-audit.mjs` 等含「新建画布」）。  
- **回滚**：还原 dashboard + 测试期望。

### 6) 依赖顺序

- **与 N4 同语义包**（一词一义）；建议同 PR 或紧邻 PR。  
- **不依赖** N1/N2。  
- **先于** N5（添加菜单是专家画布内事）。  
- 若补「空白新建」API 封装，可与 N10 Create 迁出共用 agent/短剧入口叙事。

**主触点文件数**：约 **3–5**（dashboard + tests + drama-page/client）。

---

## N4 — 侧栏「新建项目」语义：主新建→短剧

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N4；§9 P1.2；D1-A |
| **验收信号** | 与 N3 一词一义 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `workspace-sidebar-nav.tsx` L46 | `{ id: "new", title: "新建项目", to: "/canvas?mode=new" }` |
| 同文件 L52–L60 | 已有「短剧工作台」`/toiv/drama`、任务中心、工具箱；「新建」却进画布 |
| `workspace-command-palette.tsx` L49 | 「新建项目」→ `/canvas?mode=new` |
| `manifest.webmanifest` | shortcut「新建画布」→ `/studio/canvas?mode=new` |
| `canvas-project-top-bar.tsx` | 「创建新项目」Link → `/canvas?mode=new`（画布内顶栏，可保留为画布语境） |

### 2) 拟改文件清单

- **必改**：`workspace-sidebar-nav.tsx`；`workspace-command-palette.tsx`；对应测试 `workspace-command-palette-f9.test.ts`  
- **建议**：`manifest.webmanifest`（PWA 快捷：主 shortcut→短剧）  
- **可留画布语境**：`canvas-project-top-bar.tsx` / 画布空态「新建画布」——改标题为「新建画布（专家）」以免与侧栏冲突

### 3) 建议改法

1. 侧栏主「新建」：标题 **「新建短剧」**（或「新建项目」但 `to` 进短剧创建流），目标与 N3 相同。  
2. 命令面板同步。  
3. 画布新建降到：侧栏「项目」区、或「高级 / 自由画布」分组内「新建画布」。  
4. 侧栏稳态序（并 OPTIMIZE）：短剧默认 → 任务只读 → 工具台 → 自由画布(可折) → 设置——本卡至少保证 **新建≠画布**。

### 4) 单测 / 契约测 / 手工验收

- **单测**：palette/sidebar 源码或渲染：`to` 不含主路径 `/canvas?mode=new` 作为「新建项目」；可断言含 `/toiv/drama` 或创建 API。  
- **手工**：侧栏点新建 → 短剧工作台；专家用户仍能从「项目/画布」进自由画布。

### 5) 破坏半径与回滚

- **半径**：导航习惯、PWA shortcut、F9 命令面板测试。  
- **回滚**：还原 nav + palette + manifest。

### 6) 依赖顺序

- **与 N3 绑定**（同语义）。  
- **可与 N10 并行**（任务中心只读）。

**主触点文件数**：约 **3–4**。

---

## N5 — 添加菜单一级语义：引擎名 → 创作类型（P3）

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N5；G6；§9 P3.3；D3 |
| **验收信号** | 产品面无引擎名作节点类型 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `local-capability-surface.ts` L292–L373 | `LOCAL_CREATE_PRESETS`：标签 **本地·出图 / 本地·H3 / 本地·Wan / LongCat / VACE / Animate2 / Continue / Avatar**（引擎当一级） |
| `add-node-menu-tools.tsx` L7、L23 | `...LOCAL_CREATE_PRESETS.map(...)` 挂进添加菜单 |
| `local-capability-surface.test.ts` | 断言预设长度 8、含「本地·H3」等字符串 |
| 对照 KEEP | protocol/`modelRef` 映射能力须保留，只改 **一级展示信息架构** |

### 2) 拟改文件清单

- **必改**：`local-capability-surface.ts`（预设结构或映射层）；`add-node-menu-tools.tsx`；`local-capability-surface.test.ts` 及相关 create-menu 测试  
- **建议**：节点设置/检视器入口（P3.4 右侧检视器）露出 model/engine——可与 OPTIMIZE「参数右侧检视器」衔接；本卡至少「菜单不露引擎一级」  
- **勿删**：`toiv-h3` / `toiv-comfy-video` 协议与默认 modelRef（能力保留）

### 3) 建议改法

1. 添加菜单一级：**文本 / 图像 / 视频 / 音频 / 合成 / 分组**（与方案一致）。  
2. 选「视频」后：节点落盘 + **默认**绑定现网推荐引擎（如 H3 ref2va）；引擎/模型在 **节点设置** 下拉切换（Wan/LongCat/…）。  
3. `LOCAL_CREATE_PRESETS` 可降为「设置页推荐配置」或内部 `enginePresets`，不再直接 `map` 进一级菜单。  
4. 市场精选标签同步改创作语义（AUDIT_C / OPTIMIZE P3「市场精选创作语义标签」可后续）。

### 4) 单测 / 契约测 / 手工验收

- **单测**：菜单工具标题集合 **不含** `本地·H3`/`本地·Wan` 等；含「图像」「视频」等。  
- **契约**：新建视频节点仍能提交 toiv-h3（默认 modelRef 单测）。  
- **手工**：添加菜单无端口、无「本地·引擎」一级；设置里能换引擎。

### 5) 破坏半径与回滚

- **半径**：画布添加习惯、依赖旧预设 label 的 e2e/脚本。  
- **回滚**：恢复 PRESETS→menu 直挂。  
- **风险**：默认引擎选错 → 明确默认=H3:8264 能力，与 N1 一致。

### 6) 依赖顺序

- **建议在 N3/N4 之后**（先稳住「进门≠画布」，再改画布内菜单）。  
- **属 P3**；可晚于 N7/N10。  
- **依赖** N1 默认口正确（否则设置里默认 worker 文案易再露 :8195）。

**主触点文件数**：约 **3–5**。

---

## N6 — 产品方案 Ref2VA 文档：承认 tip 已切（非再立项「切默认」）

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N6；D7-A；§12.6 |
| **验收信号** | 代理/同学不再按「切默认」开工 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `docs/AI短剧产品方案.md` L16 | 「⚠ 代码现状（2026-10-08）」：**默认仍是 `c`**，`pipe = (pipeline or "c")`，**尚未做**（见 §8） |
| 同文件 §8 L60 | 第一优先仍写「产品视频步默认切到逐镜独立 Ref2VA…」整包工程 |
| **tip 代码已相反** | `pipelines.py`：`INDEP_PIPELINE="ref2va"`；`DEFAULT_VIDEO_PIPELINE = INDEP_PIPELINE`；`orchestrator.py` L85/L260/L390：默认 ref2va；`routes/studio.py` Field `default="ref2va"` |

### 2) 拟改文件清单

- **必改**：`docs/AI短剧产品方案.md`（文首警告段 + §8）  
- **建议指针**：MASTER / COMPETITIVE §12 D7 已述，可在 §8 链到 tip SHA  
- **不改代码**（本卡纯文档）

### 3) 建议改法

1. 删除或改写 L16「尚未做 / 默认仍是 c」→ **「tip `e5307c63` 起默认 `ref2va`；c/c_hybrid 显式可选」**。  
2. §8 第一项改为剩余工作清单：  
   - 生产 env/进程是否已部署 tip 默认（**核对**，非再改默认码）  
   - UI 管线选择器（ref2va\|c\|c_hybrid）  
   - 真机一镜验收  
3. 标注「禁止再开『切 Ref2VA 默认』重复工程卡」。

### 4) 单测 / 契约测 / 手工验收

- **契约**：文档内不再出现「默认仍是 c」「尚未做」作为现行断言；可 `rg` 负向。  
- **手工**：新同学读 §8 不会去改 `DEFAULT_VIDEO_PIPELINE`。

### 5) 破坏半径与回滚

- **半径**：文档读者与代理任务理解。  
- **回滚**：git 还原该 md。

### 6) 依赖顺序

- **无代码依赖**；建议 **最先或与 N9 并行**（纠偏施工说明书）。  
- **先于** 任何 UI 管线选择器实现（OPTIMIZE P2「UI 管线选择器」）。

**主触点文件数**：**1**。

---

## N7 — Studio `next_step`：无台词越过 voice/lipsync

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N7；AUDIT_B #20；D6-A；§12 L3 |
| **验收信号** | 纯画面项目进度条可到 assemble |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `drama_pipeline.py` `compute_studio_next_step` L442–L478 | 对 **全体** shots 按 `render→voice→lipsync→assemble` 找未达集合；**不读** `StudioShot.dialogue` |
| `_STUDIO_REACH` L426–L430 | `voice` 需进入 `{voiced, lipsynced, done}`；无台词镜停在 `rendered` → **永久 voice pending** |
| Drama 对照 `_next_step` / stages L371–L378 | `voiceable = [s for s in shots if s.dialogue.strip()]`；无台词不进 voice/lipsync 分母 |
| `models.py` `StudioShot.dialogue` | 字段已存在 |
| `test_studio_voice.py` | 无台词配音路由 **422**（正确）；但 next_step 仍可能催配音 |

### 2) 拟改文件清单

- **必改**：`apps/api/app/services/drama_pipeline.py`（`compute_studio_next_step`）  
- **必改测**：`apps/api/tests/test_drama_pipeline.py`（或新建 `test_studio_next_step_no_dialogue.py`）  
- **建议**：前端 `drama-workspace.tsx` 进度文案若裸显 `next_step.label`，确认无台词时显示「合成成片」而非「分镜配音」  
- **相关只读**：`assemble.py`（AUDIT_B：无台词允许仅视频→final）

### 3) 建议改法（产品语义）

对 `compute_studio_next_step`：

1. 定义「需要声画」：`bool(dialogue.strip())`（与 Drama 一致）。  
2. 无台词镜：在 `render` 已达（`rendered` 或更高）时，**视为已越过 voice 与 lipsync**（可直接进入 assemble 候选池）。  
3. 有台词镜：行为不变（须 voiced→lipsynced→done）。  
4. 混合项目：next_step = 首个仍有「适用且未达」的阶段；`shot_ids` 只列适用镜。  
5. **不**在本卡改状态机写库（避免大批量自动标 done）；优先纯函数 next_step，与 AUDIT_B「对齐 Drama」一致。

### 4) 单测 / 契约测 / 手工验收

- **单测**：  
  - 全镜 `rendered` + 空 dialogue → `step=assemble`（或 `done` 若业务定义 assemble 已完成）  
  - 一镜有台词未配音 → 仍 `voice`  
  - 有台词已 voiced 未 lipsync → `lipsync`  
- **契约**：`GET /studio/projects/{pid}/status`（routes L2862/L3096 调用处）返回与上一致。  
- **手工**：纯画面短剧进度不再卡在「分镜配音」；可点合成。

### 5) 破坏半径与回滚

- **半径**：所有消费 `next_step` 的 Studio UI/Agent 建议动作。  
- **回滚**：还原纯函数 + 测试。  
- **风险**：误把「有台词但 dialogue 未写入」当成无声——验收要求拆镜写入台词字段；文档注明。

### 6) 依赖顺序

- **不依赖** N1–N5。  
- **建议在 N6 之后**（文档已承认声画主链，避免有人以为「砍配音」）。  
- **与 P2 阶段轨**同波最合适；可先于 N5。

**主触点文件数**：约 **2–3**（drama_pipeline + tests [+ 可选 workspace 文案]）。

---

## N8 — Drama∥Studio 收敛计划启动（纪律卡，非整包搬迁）

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N8；`PROJECT_DOMAIN_MERGE_ASSESSMENT_20261011.md`；AUDIT_B #22 |
| **验收信号** | 评估已定宿主；工程卡禁 Drama 写入新功能 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `docs/ops/PROJECT_DOMAIN_MERGE_ASSESSMENT_20261011.md` | **Studio 唯一宿主**；Drama 冻结新功能；经典视图 P4 只读 |
| 路由体量 | `drama_studio.py` **5708** 行；`studio.py` **3388** 行（AUDIT_D） |
| 前端现役 | canvas `drama-page` / `drama-workspace` 已走 **`/studio/projects`**（`fetchDramaProjects`），经典 Drama 域多为兼容 |
| KEEP | Drama 七阶段 `compute_drama_pipeline_status`、DramaAsset 等按评估保留至收束 |

### 2) 拟改文件清单（近窗「启动」=文档+门禁，不拆 5708）

- **必改（文档）**：新建或追加 `docs/ops/DRAMA_STUDIO_CONVERGENCE_GUARD_20261022.md`（或写入 STATE/AGENTS 短节）：  
  - 新功能只加 `routes/studio.py` + `services/studio/*` + canvas ToIV 页  
  - `drama_studio.py` / `/drama/*`：**bugfix only**；禁止新 endpoint 写能力  
  - PR 检查清单  
- **可选**：`.github` PR template 勾选项（若有）  
- **明确不做本卡**：alembic 大搬迁、删除 Drama 表、拆分 `drama_studio.py`（后者属 OPTIMIZE P2「按资源切分」另卡）

### 3) 建议改法

1. 发布 **收敛门禁**：评审拒绝「只加 Drama 域」的功能 PR。  
2. 列兼容日历：Drama API 只读至 P4；历史项目导出决策点保留评估文 §4。  
3. 新声画/门禁/UI 一律 Studio。

### 4) 单测 / 契约测 / 手工验收

- **契约**：门禁文档存在且 MASTER/本卡互链。  
- **流程验收**：下一功能需求的工程卡路径不含「写入 drama_studio 新业务」。  
- **无**强制 pytest（除非加 lint 禁令——可延后）。

### 5) 破坏半径与回滚

- **半径**：研发流程；零运行时。  
- **回滚**：撤门禁文档。

### 6) 依赖顺序

- **可与文档 N6/N9 并行启动**。  
- **不阻塞** N3/N4/N7。  
- 物理拆分 `drama_studio.py` **后置于**感知窗 P1–P2。

**主触点文件数**：约 **1**（门禁文档）；代码触点 **0**（近窗）。

---

## N9 — SERVICE_INVENTORY 过期横幅 + 10-15 勘误

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N9；§12.6 |
| **验收信号** | 禁盲抄端口 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `docs/SERVICE_INVENTORY.md` 文首 | **采集时间：2026-09-13**；无「过期」警告 |
| 同文件 H3 行 | ComfyUI H3 worker 端口列 **8195**，验收 `POST :8195/free` |
| 对照 | AGENTS §三：H3=**:8264**；IndexTTS=**:9200**；VLM=**:9311**；:8195 停用 |

### 2) 拟改文件清单

- **必改**：`docs/SERVICE_INVENTORY.md` 文首 + H3/TTS/VLM 相关行勘误表（不必重采全表）  
- **建议**：链到 `AGENTS.md` §三为「现网真源」；历史 09-13 表降为「迁移考古」

### 3) 建议改法

1. 文首加 **醒目过期警告**（Asia/Shanghai 日期）：「端口/常驻以 AGENTS §三为准；本表 2026-09-13 快照，禁止直接抄生产」。  
2. 勘误小节（最小）：  
   - H3 生产 **:8264**（:8195 disable）  
   - TTS 主路 IndexTTS **:9200**  
   - VLM **:9311**  
   - :8261 撤；:8265 入池 等与 AGENTS 冲突项  
3. 不在本卡 SSH 重采全库存——避免伪「已更新」幻觉。

### 4) 单测 / 契约测 / 手工验收

- **契约**：文首含「过期」或「以 AGENTS 为准」字样；`rg` 可检。  
- **手工**：新代理读 INVENTORY 不会把 H3 配到 8195。

### 5) 破坏半径与回滚

- **半径**：文档。  
- **回滚**：还原 md。

### 6) 依赖顺序

- **可最先**；与 N6 并行；**支撑** N1/N2 施工者认知。

**主触点文件数**：**1**。

---

## N10 — 任务中心 Create 迁出 + LocalBadges 去端口

| 栏 | 内容 |
|----|------|
| **来源** | AUDIT_MASTER N10；G3/G10；§9 P1.3/P1.6；Jellyfish |
| **验收信号** | 任务中心只读追踪；产品面无 `:8264` 徽章 |

### 1) 现状证据

| 路径 | 证据 |
|------|------|
| `tasks-page.tsx` L256–L327 | 整段 **「新建智能体任务」**（`aria-label`）；`createAgentRun` + textarea +「创建并拆解」 |
| `market-page.tsx` L72–L78 | `LocalBadges`：`label={badge.worker}` → 产品面直接显示 **`:8264`** 等 |
| `local-capability-surface.ts` | `LocalCapabilityBadge.worker` 注释「如 :8264」；精选 entry 填入 worker |
| 路由 | `router.tsx` `/toiv/tasks`；manifest 已有 `/studio/toiv/tasks`（深链另见 OPTIMIZE） |
| 对照 | `/toiv/agent` 已是智能体对话入口 |

### 2) 拟改文件清单

- **必改**：`tasks-page.tsx`（移除 Create section；可留「去智能体对话」Link）  
- **必改**：`market-page.tsx` `LocalBadges`（去掉 worker 徽章，或仅「本地」+引擎中文名）  
- **建议**：`local-capability-surface.ts` / 测试中「必须含 :8264」的 **产品面**断言改为设置页/admin；保留内部字段供运维  
- **相关测试**：`studio-market-gap-p1.test.ts`、`local-capability-surface.test.ts`、`toiv-market-m2.test.ts` 等

### 3) 建议改法

1. 任务中心：删除创建表单；顶部可加次要链接「在智能体对话中描述需求」→ `/toiv/agent`。  
2. 保留时间线合并、筛选、取消、刷新（Jellyfish 式只读）。  
3. LocalBadges：只保留「本地」成功态徽章；**worker 端口不进默认 UI**；引擎名可次级或进详情/设置。  
4. 深链 `/toiv/tasks` 404（G4）若未修，并 OPTIMIZE「`/toiv/tasks` 深链」——本卡可只做 Create+徽章。

### 4) 单测 / 契约测 / 手工验收

- **单测**：`tasks-page` 源码 **不含** `aria-label="新建智能体任务"`；market 渲染 HTML **不含** `:8264` 作为 badge 文本。  
- **手工**：任务中心无创作表单；工具箱卡片无端口号；设置/admin 仍可见 worker。

### 5) 破坏半径与回滚

- **半径**：习惯从任务页一句话建 run 的用户 → 引导至 agent。  
- **回滚**：还原两页 + 测试。

### 6) 依赖顺序

- **属 P1**；可与 N3/N4 **并行**。  
- **不依赖** N5（P3）。  
- 与 OPTIMIZE「状态中文化」「深链」可同波但不阻塞本卡。

**主触点文件数**：约 **3–6**（tasks + market + surface/tests）。

---

## 附录 A — OPTIMIZE P1 队列前 5 项 · 触点摘要（一行/项）

> 来源：AUDIT_MASTER §3.1 前 5 行（与方案 §9 P1 对齐）。非完整工程卡，仅开工索引。

| # | 项 | 触点摘要（路径 + 改什么） |
|---|-----|---------------------------|
| O1 | 首页能力瓷砖 / 意图条收权 | `home-dashboard.tsx` + `home-data.ts`（`beefTVCapabilityItems` / `homeIntentBarItems`）：首页只留 1 主 CTA（见 N3）+ 最近短剧；瓷砖/意图条删除或挪侧栏，消 G1 三重镜像 |
| O2 | 侧栏稳态序 | `workspace-sidebar-nav.tsx` `buildNav`：序改为 短剧默认 → 任务只读 → 工具台 → 自由画布(可折) → 设置；与 N4 新建语义同 PR 更佳 |
| O3 | `/toiv/tasks` 深链 | `apps/web/middleware.ts` 已有 `/tasks→/studio/toiv/tasks`；核公网 `/toiv/tasks` 与 canvas basename：补登录回跳或 301 到 `/studio/toiv/tasks`（G4）；测 `f12RetiredRedirects.test.ts` |
| O4 | 状态中文化（drama 键） | `drama-workspace.tsx` `STATUS_TONE` + 多处 `label={s.status}`：加展示层字典（ready/failed→已就绪/失败等），禁裸英文枚举（G2） |
| O5 | L1 忙闲只读摘要 | 创作台消费 fleet/hold 人话（`fleet.py` / hold_queue 只读 API + workspace 条）：显示排队/hold，**藏端口**；Admin 深潜保留（§12 L1） |

---

## 附录 B — 建议开工顺序与依赖图

```
N9 ──┐
N6 ──┼──► 文档纠偏（0 业务码）
     │
N1 ──► N2 ──►（Admin 分母可信）
     │
N3 ──┬── N4 ──┐
     │        ├──► P1 感知包（可 || N10）
N10 ─┴────────┘
     │
N7 ──► P2 声画进度（可紧随 P1）
     │
N5 ──► P3 画布菜单（晚于进门语义）
     │
N8 ──► 全程纪律（文档门禁，随时可亮）
```

| 波次 | 卡片 | 预估性质 |
|------|------|----------|
| Doc-0 | N9, N6, N8 | 纯文档 / 门禁 |
| Infra-1 | N1, N2 | api 默认+registry+测 |
| UX-P1 | N3, N4, N10 | canvas 壳 |
| Pipe-P2 | N7 | next_step 纯函数 |
| UX-P3 | N5 | 添加菜单 IA |

---

## 附录 C — 不确定处（需拍板或真机再核）

1. **N2 CosyVoice 9201–9203 / ASR 9210 等**：AGENTS 常驻表未列，但是否「进程仍在、仅不进分母」还是「已归档」——改 registry 前建议运维扫一眼 `ss/systemd`，避免误删仍在用的探针。  
2. **N1 LAN IP**：默认写 `192.168.71.127` 还是 TS `100.68.100.90`——现 config 用 LAN；canvas 侧多写 TS。全仓统一口径待运维拍板（功能上都可达时优先 **与现网 core `.env` 一致**）。  
3. **N3 空白新建**：`drama-page` 空态目前引导 Agent / 从图片创建；「一键空白 Studio 项目」产品是否要标题对话框，待与 IA 规格统一。  
4. **N7 assemble vs done**：无台词全 `rendered` 时 next_step 用 `assemble` 还是直接 `done`——依赖成片是否已存在；建议与 `GET status` 现有 assemble 语义对齐后写测。  
5. **N5 默认视频引擎**：菜单收拢后默认绑 H3 还是出图池——推荐 H3（短剧主路），但工具向用户可能期望「出图」默认，需产品一句确认。  
6. **生产是否已跑 tip 默认 ref2va**：N6 只改文档；若生产进程仍是旧包，属 **部署核对** 另窗（本纪律禁部署）。

---

## 附录 D — 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初版：N1–N10 工程卡 + OPTIMIZE P1 前 5 触点摘要；对齐 tip `e5307c63`；未编码未 commit |
