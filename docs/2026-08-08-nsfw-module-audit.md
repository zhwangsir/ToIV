# NSFW 模块现状审计与推进方案

> 日期:2026-08-08 | 范围:apps/web + apps/api 全仓 | 性质:纯调研,未改代码
> 场景前提:本地私有化部署(自有集群/自有模型),无第三方内容审核约束

## 结论先行

NSFW 模块已有**完整的"专页 + 请求级门控"骨架**:/nsfw 隐藏专页、X-NSFW header → ContextVar 的
全链路过滤(引擎/模型/智能体/作品)、10Eros 视频引擎、2 个不阉割智能体、3 个 NSFW 风格预设、
L4 NSFW 专用 LLM 路由均已落地。**但体验闭环断裂**(R18 作品刷新后无处可看)、
**存在一个门控绕过点**(drama_studio 的 nsfw 参数不校验 X-NSFW)、**两套 R18 概念并存**
(账户软开关 nsfw_enabled 与 header 语义),视频/数字人/音频面基本只有 LTX-10Eros 一条线。

## 一、前端现状清单

| 位置 | 内容 | 说明 |
|---|---|---|
| `app/nsfw/page.tsx` + `layout.tsx` | 隐藏专页 | 仅地址栏 /nsfw 直达,无导航入口;noindex/nofollow,标题为 "·" |
| `components/nsfw/NsfwView.tsx`(820行) | 专区主体 | 登录门(未登录跳 /login?next=/nsfw)→ 18+ banner → 图像/视频 tab 内嵌 `GenerateView onlyNsfw lockedKind` → 可折叠「NSFW 推荐模型」清单(16 项,支持一键下载到 NAS,带进度/重试) |
| `lib/api.ts:56-65` | X-NSFW 注入 | `setNsfwIntent(true)` 后所有 apiFetch 带 `X-NSFW: 1`;离开页面还原;models/localModels 用独立缓存键 `:nsfw` 防污染主站缓存 |
| `components/generate/GenerateView.tsx` | 统一工作台 | `onlyNsfw` 只展示 nsfw=true 引擎;引擎卡有 R18 badge;会话历史**不落库,刷新即清空** |
| `components/library/LibraryView.tsx` | 作品库 | `listJobs()` 无 X-NSFW → 后端剔除 R18 作品;**/nsfw 内没有作品库视图** |
| `components/admin/AgentsAdminView.tsx` | 智能体管理 | admin 可创建/编辑 `is_nsfw` 标记,NSFW 标签徽标 |
| `e2e/nsfw.spec.ts` 等 | 测试 | 6 个专区用例 + agents API 的 NSFW 可见性/403 契约 |

主站(R18 用户)看到的差异:**没有任何差异**——主站彻底零 R18,R18 模型/引擎/智能体/作品全部服务端剔除,唯一入口是手动输 /nsfw。

## 二、后端 R18 门控全链路

判定核心 `nsfw_ctx.py`:
- `nsfw_intent_var` ContextVar(async 安全,每请求隔离)
- `main.py:145` 中间件:`x-nsfw == "1"` → 置位,响应后 reset
- `nsfw_allowed(user)` = 未成年硬阻断(birthdate<18 一律 False)优先,然后仅看 header;**账户开关 nsfw_enabled 不再参与放行**
- `is_underage`:birthdate 空视为成年(兼容老数据)

已接入门控的功能(✅):

| 功能 | 位置 | 行为 |
|---|---|---|
| 引擎注册表 | `services/engine_registry.py:618` | SFW 上下文剔除 4 个 nsfw 引擎及 nsfw 选项(如 ltx2 白名单里的 10eros) |
| 模型列表 | `routes/models.py:144,220` | /models 与 /local-models:SFW 只给 SFW,/nsfw 只给 NSFW(二分,不混) |
| 文/图生图 | `routes/generate.py:98,912` | `_gate_nsfw_ckpt`:NSFW ckpt 无 X-NSFW → 403;rerun overrides 换底模同样复检;Job 打 nsfw 标 |
| 漫剧(manju) | `routes/manju.py:327` | 复用 `_gate_nsfw_ckpt` |
| LTX 视频 | `routes/video.py:143` | `_gate_ltx_nsfw`:ltx-t2v/i2v/lipsync 仅专页可调 |
| LTX 工作室 | `routes/ltx_studio.py:190` | 底模白名单;选 10eros 走门控,Job 打标 |
| 智能体 | `routes/agents.py:98,123` | 列表过滤、详情 404;`optimize.py:313` NSFW agent 无 X-NSFW → 403 |
| 作品库 | `routes/jobs.py:79,119,254` | 列表/详情/版本链均按 `Job.nsfw` 过滤 |
| LLM 路由 | `agent/llm.py:229`、`workflows/llm_router.py` | X-NSFW + 配了 `llm_nsfw_model` → L4 专用 LLM(典型 llama-3.3-70b-abliterated @ spark01),失败回退主模型(主模型亦 uncensored) |
| 视频评分 | `scoring.py:218` | 用"后期工程师纯技术评估"话术框定,NSFW 视频可正常出技术分 |

账户态:
- `User.nsfw_enabled`(默认 False)+ `User.birthdate`(可选,admin 建档时可填)
- `POST /account/nsfw` 开关端点仍在(未成年 403),但**前端已无任何调用处**——残留
- `nsfw_enabled` 目前唯一生效处:`routes/marketplace.py:82`(Civitai 搜索 nsfw 参数)——与 header 语义不一致
- 用户**无自助填写 birthdate 的端点**,未成年防护完全依赖 admin 建档

## 三、NSFW 资产清单

引擎(engine_registry):
- `nsfw-txt2img` / `nsfw-img2img`(图像,底模只注入 R18 ckpt,默认落第一个)
- `ltx-nsfw-t2v` / `ltx-nsfw-i2v`(视频,10Eros v14 固定底模 + Gemma3-12B + LTX VAE)

模型支持(workflows/model_profiles.py):
- 族识别含 `10eros`、`pony`、`sdxl_anime`(illustrious/noobai/animagine/wai/hassaku/cyberrealistic)等,提示词方言分 pony/sdxl_anime/flux 等
- `is_nsfw` hints 25+ 条:底模家族(pony/noobai/animagine/illustrious/realisticvision/cyberrealistic/shufflenoob/nova3dcg/lustify/hassaku/autismmix/pornmaster/urpm/yiffy/biglove/stoiqo/lazymix/wai)+ 显式词(nsfw/r18/hentai/uncensored/porn/xxx);env 可覆盖/追加(TOIV_NSFW_HINTS/EXTRA)

风格预设(style_presets.py):`nsfw_realistic`(Lustify Apex V8)、`nsfw_anime`(AutismMix Pony)、`nsfw_pony`(CyberRealistic Pony V18)——llm_layer=L4

智能体(agents_seed.py):2 个 NSFW——`nsfw_photographer`(写实摄影导演)、`nsfw_anime`(动漫师),applies_to=image,video,system_prompt 明确"不拒绝、不阉割、不打码"

推荐清单(routes/models.py NSFW_RECOMMENDATIONS,16 项):写实 5(epiCRealism XL/PornMaster/URPM/LUSTIFY/CyberRealistic)、动漫 4(Pony V6/WAI-illustrious/NoobAI/Hassaku)、FLUX 2(Big Love/STOIQO)、LoRA 2(Nudify XL/ExpressiveH)、视频 3(10Eros/LTX All-in-One/zImage Turbo)。⚠️ 端点仅要求登录,不要求 X-NSFW(设计上为静态元数据)

提示词优化(routes/optimize.py):NSFW 题材专门规则——不拒绝不阉割,negative 只补解剖/画质瑕疵;启发式兜底含 nsfw/性感/裸关键词 → 解剖负面词

## 四、缺口清单(按严重度)

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **门控绕过:drama_studio `nsfw: bool` 请求参数无任何 X-NSFW 校验** | `drama_studio.py:242,1418,1583`(全文无 nsfw_allowed/gate 引用) | 任何登录用户在主站短剧工作室传 nsfw=true 即可用 10Eros 成人底模,破坏"主站零 R18" |
| G2 | **R18 作品管理缺失** | jobs.py 主站过滤 Job.nsfw;NsfwView 只有 GenerateView(会话历史不落库) | R18 作品刷新页面后**永久不可见、不可删、不可复用**,创作→管理闭环断裂 |
| G3 | **is_nsfw hints 过宽误伤 SFW 预设** | hints 含 wai/hassaku/pony/illustrious/animagine;SFW 预设 anime/anime_soft/fantasy/campus/history_war 的 ckpt(waiIllustrious/hassakuXL/ponyDiffusion)被标 nsfw,主站风格预设被连带隐藏 | 主站二次元类预设几乎全军覆没 |
| G4 | H3 / LongCat 无 NSFW 变体 | `services/h3.py:187`、`services/longcat.py:205` 硬编码 nsfw=False,engine_registry 中均 nsfw:False | R18 视频只有 LTX-10Eros 一条线,无长视频/音画同发能力 |
| G5 | 两套 R18 概念并存 | nsfw_enabled 仅 marketplace 在用,nsfw_allowed 完全不看它;前端无开关 UI | 语义混乱,marketplace 的 NSFW 搜索实际无法开启(无 UI) |
| G6 | 数字人/TTS/音频无 NSFW 概念 | avatartalk/opentalking/tts 路由无 nsfw 触点 | 私有化成人向数字人/配音是空白 |
| G7 | 未成年防护依赖 admin 手填 birthdate,无自助年龄确认 | account.py 无 birthdate 端点;/nsfw 进入无年龄确认弹窗 | 私密化单用户场景风险低,但多用户时防护形同虚设 |
| G8 | 无 R18 访问审计日志 | 全仓无 audit 设施 | 多用户私有化下无法追溯 |

## 五、推进方案(分阶段)

### P0(堵洞 + 闭环,1-2 天)

1. **堵 drama_studio 绕过**:`nsfw=True` 时调 `_gate_ltx_nsfw(user)`(与 ltx_studio 同款),generate-video / batch / continue 各入口统一校验
2. **/nsfw 增加「作品库」tab**:复用 LibraryView 或轻量网格,专区内 X-NSFW 已生效,listJobs 自动含 R18;支持查看/删除/重新生成
3. **修 hints 误伤**:给 StylePreset 加显式 `sfw_intent` 标记(或把 wai/hassaku 移出默认 hints 改用 EXTRA 注入),恢复主站二次元预设可见;同时确认 Pony/Illustrious 系在主站的定位策略

### P1(能力扩展,1-2 周)

4. **H3/LongCat NSFW 路径**:R18 上下文中对 h3/longcat 引擎解禁成人提示词(提示词层本就无审查),Job 按 X-NSFW 打标;或注册 `h3-nsfw`/`longcat-nsfw` 引擎变体
5. **统一 R18 语义**:marketplace 改为读 X-NSFW(与全站一致),nsfw_enabled 字段下线或仅作"曾经开启过"记录;前端如需开关,在 /nsfw 内做年龄确认弹窗
6. **NSFW 智能体扩充**:视频运镜向(10Eros 提示词方言)、短剧剧情向(接 drama NSFW)、LongCat 长镜头向
7. **NSFW 预设/LoRA 补齐**:WAI-NSFW、NoobAI vpred、URPM(SD1.5)预设;10Eros 配套 LoRA 进推荐清单与 NAS 下载链

### P2(体系化,按业务节奏)

8. **数字人/TTS NSFW 边界定义**:私有化下明确做不做;做则接同一 X-NSFW 门控 + L4 LLM
9. **审计日志**:R18 生成/下载行为落库(用户/时间/引擎/模型),admin 可查
10. **租户级总开关**:Tenant.nsfw_allowed,多租户部署时租户可整体关闭 R18
11. **年龄确认 UX**:/nsfw 首次进入的年龄确认弹窗(本地记录),多用户场景的合规兜底

### 私有化合规边界建议

- 访问控制保持**用户级**(header + birthdate 已有),补**租户级**总开关即可,无需更复杂的角色矩阵
- 审计日志是私有化下唯一建议新增的合规设施(自用追溯,非审查)
- NSFW 产物建议落独立 output 前缀/目录,便于隔离与清理(部分链路已有 filename_prefix 约定)
