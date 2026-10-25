# ToIV 设置页重设计方案（简洁主路径）

> 日期：2026-10-25（Asia/Shanghai）  
> 状态：**P0 已落地（本地未 commit）· 可控性见 §8 / MODEL_MIX_CONTROL · P1/P2 待继续**  
> 入口：`/studio/settings`（canvas `apps/canvas/web/src/pages/settings/`）  
> 对齐：LingGuo 简洁主路径 / `docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` / `IA_INTERACTION_SPEC_P1_P3`（设置=端口/模型/版本唯一产品露出点）

---

## 1. 目标用户场景

个人学习站：日常只改「默认用哪个模型 / 开不开 R18 / 算力是否在线」。  
不把渠道协议、NAS 换模、RunningHub、诊断当成进门第一屏。

---

## 2. 现状摸底（代码事实）

### 2.1 路由与壳

| 项 | 事实 |
|----|------|
| 产品入口 | `/studio/settings`（旧 `/?view=settings` 已导向 canvas） |
| 主文件 | `pages/settings/index.tsx`（~133 行） |
| 侧栏 section | 名义上 `channels` / `models`，实际 **几乎总是单页堆叠**（`models` pane 几乎不独立露出） |
| 本轮总代码量 | settings 目录合计 **~3100 行** |

### 2.2 当前一页堆叠顺序（channels pane）

1. **LocalComputePane**（~600 行）— 「模型与算力（本地优先）」  
   - ComputeStatusStrip（满量）  
   - 出图 / 出视频 / H3 三块 NAS 选模 + 绑定进度条  
   - Spark 对话说明（含端口/别名）  
   - 音频未接说明  
2. **ChannelSettingsPane**（~895 行）— 个人/系统渠道列表  
   - 连接信息（Base URL / API Key / Secret / Headers）  
   - 模型列表 tags + **ChannelModelSettings**（协议/能力抽屉）  
   - **ModelServiceEditor**（再一层编辑）  
   - 「云端可选」折叠（含 RunningHub 入口）  
3. **R18SettingsPane**（~118 行）— R18 开关 + 市场入口  
4. **ModelDefaultGrid**（~137 行）— 默认文/图/视/音/助手模型  

未挂进主页但同目录还在：`prompt-preferences-pane`、`runninghub-settings-pane`、`diagnostics-panel`（专家能力散落）。

### 2.3 痛点（3–5 条）

1. **单页瀑布**：本地算力 + 渠道编辑 + R18 + 默认模型全挤一屏，学习站首次打开信息密度过高。  
2. **运维话术进产品面**：worker 端口（`:8196` / `:8264` / `:8888`）、NAS 路径、object_info refresh、别名名单——与「我只想换默认模型」目标错位。  
3. **渠道编辑过重**：OpenAI/Gemini 协议、Headers、Secret Key、模型能力抽屉对主路径用户是噪声；且与「本地优先」叙事打架。  
4. **信息架构名实不符**：section 叫「模型与算力」，却混进云端渠道/R18；`models` section 几乎死代码。  
5. **专家面板孤儿化**：Prompt 偏好 / RunningHub / 诊断有组件，但没有清晰「高级」层级，用户要么找不到、要么突然撞上。

---

## 3. 目标信息架构（建议）

三层，默认只开第一层：

```
设置
├─ 常用（默认打开）
│  ├─ 默认模型（文 / 图 / 视 / 音 / 助手）← ModelDefaultGrid 精简版
│  ├─ 算力三态（可达/不可达，无端口）← ComputeStatusStrip compact
│  └─ R18 开关（确认门保留）
├─ 模型与算力（第二层）
│  ├─ 本地通道一览（出图 / 视频 / H3 / 对话）— 当前绑定名 +「更换」按钮
│  └─ 更换抽屉：NAS 选模 + 绑定进度（现 LocalComputePane 下沉）
└─ 高级（默认折叠 / 独立 section）
   ├─ 自定义渠道（ChannelSettingsPane）
   ├─ 云端可选 / RunningHub
   ├─ Prompt 偏好
   └─ 诊断
```

原则（对齐 LingGuo / IA 规格）：

- **产品面不展示端口**；端口只在「更换」抽屉或 Admin。  
- **本地默认，云端可选且默认收起**（已有雏形，需升格为层级而非同屏邻居）。  
- **一个主任务一条路径**：换默认模型 ≠ 换 NAS 权重 ≠ 配云 API Key。

---

## 4. 线框（markdown）

### 4.1 常用

```
┌─────────────────────────────────────────────┐
│ 设置 · 常用                    [模型与算力] [高级] │
├─────────────────────────────────────────────┤
│ 算力：工作站 ●  配音 ●  视频引擎 ●  对话 ●     │
│                                             │
│ 默认文本模型    [ DeepSeek-V4.1-Flash-1017 ▾] │
│ 默认生图模型    [ 本地出图 · Qwen-Rapid…   ▾] │
│ 默认视频模型    [ 本地 H3 / Wan…          ▾] │
│ 默认音频模型    [ 未接（SenseVoice）        ] │
│ 助手模型        [ 跟随默认文本              ] │
│                                             │
│ R18 上下文      ( ) 关闭  /  (•) 开启…       │
└─────────────────────────────────────────────┘
```

### 4.2 模型与算力

```
┌─────────────────────────────────────────────┐
│ 本地通道                                      │
│  出图   当前: xxx.safetensors      [更换]    │
│  视频   当前: wan/…                [更换]    │
│  H3     当前: h3/…                 [更换]    │
│  对话   Mia :8888（经 /api/llm/v1） 只读说明  │
│                                             │
│ （点击更换 → 右侧/底部抽屉：Select + 绑定进度） │
└─────────────────────────────────────────────┘
```

### 4.3 高级

```
┌─────────────────────────────────────────────┐
│ ▸ 自定义渠道（Base URL / Key / 协议）         │
│ ▸ 云端可选 / RunningHub                      │
│ ▸ Prompt 偏好                                │
│ ▸ 诊断                                       │
└─────────────────────────────────────────────┘
```

---

## 5. 落地节奏

### P0（立刻减负，小改、可本周）— **已落地 2026-10-25**

1. `index.tsx` 真正分成 **常用 / 模型与算力 / 高级** 三个 section（URL `?section=`）。  
2. 默认落地 **常用**：只留 ModelDefaultGrid + compact 算力条 + R18。  
3. LocalComputePane / ChannelSettingsPane 挪到对应 section；渠道编辑默认不展开。  
4. 文案去端口：产品面标签改「本地出图 / 本地视频 / 本地对话」；端口进 drawer helper。  
5. 删或隐藏 `models` 死 section；云端块保持默认折叠。

### P1（结构清晰）

1. NAS 绑定改为「更换」抽屉，主列表只读当前绑定。  
2. ChannelModelSettings / ModelServiceEditor 仅在「编辑渠道」进入。  
3. Prompt / RunningHub / Diagnostics 挂进高级并给入口。

### P2（大改，对齐 LingGuo）

1. 设置页视觉与短剧主路径同壳（阶段感、少卡片嵌套）。  
2. 与 Admin 舰队观测分工写死：产品设置不复制 Admin 四 tab。  
3. 用户级 LLM override 与系统 `/api/system/llm` 展示对齐（避免设置里别名与顶栏 display 不一致）。

---

## 6. 本轮明确不做

- 不在本方案确认前重写 settings 大 UI。  
- 不把 Acc / 安全 Dly 相关设置拉进常用。  
- 不 commit / 不 push（由用户拍板）。

---

## 7. 待用户拍板

| # | 问题 | 建议 |
|---|------|------|
| S1 | P0 是否按「常用 / 模型与算力 / 高级」三 section 开工？ | 是 |
| S2 | 产品面是否彻底隐藏端口号？ | 是（drawer/Admin 可见） |
| S3 | 自定义云渠道是否默认进「高级」且默认折叠？ | 是 |
| S4 | Prompt 偏好是否进设置高级，还是短剧项目级？ | 先高级，后视短剧主路径再下沉 |


---

## 8. 可控性升级（多模型搭配）

P0 三区解决的是**噪音与层级**，未解决「设备上很多模型、不同任务怎么搭配」。

完整心智与落地节奏见：**[`MODEL_MIX_CONTROL_PLAN_20261025.md`](./MODEL_MIX_CONTROL_PLAN_20261025.md)**  
（角色槽 · 配方 · 库存；设置 vs 短剧工作台分工；P0.5 最小补丁；待拍板 M1–M3）。

在该方案拍板前：**不按「再堆默认模型下拉」继续改常用区**；下一刀优先槽位表 + 配方芯片，而非新的瀑布区块。

## 库存接入（2026-10-25）

LoRA 管理弹层已接调研可用库存（A+B × P-A/P-B）；P-A 标「确定」，P-B 显示类型标签，来源 URL 可点；隔离项不出现。
