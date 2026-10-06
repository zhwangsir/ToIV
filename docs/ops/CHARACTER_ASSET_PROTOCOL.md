# 角色资产协议（Character Asset Protocol）— 外部规范稿评估与 ToIV 落地版 v1

> 日期：2026-10-06 · 状态：**已拍板，M1 已实现**（同日用户拍板「按方案执行」；D1–D3 落地，D4 分开执行）
> 来源：用户提供《Universal Character Asset Sheet / 通用角色资产卡生成规范》（外部建议稿，下称「外部稿」）
> 对照基线：`apps/api/app/services/studio/character_sheet.py`（14450 行，面板式生成已上线）+ 设定卡 1224 结案经验（嘴部放大复判 `c78f4542`、参考门禁 face 0.949/0.951、cfix collar/cuff/hem/boots 服化道修复系列）

## 实现落点（2026-10-06 M1）

- **服务层**：`apps/api/app/services/studio/character_asset.py`（L2 schema/锚点/覆盖/版本级联/展示卡渲染/M2 variant+补拍 builder，文件态存储 `char_asset_{cid8}_{style}.json` + `char_card_*.png`）。
- **路由**（`apps/api/app/routes/studio.py`）：
  - `GET /studio/characters/{cid}/character-asset?style=` — 读取 L2；JSON 不存在时从存量面板自动物化 v1（D3 回填引擎）
  - `PUT /studio/characters/{cid}/character-asset` — 白名单字段补丁（锚点/档案/负向约束/锁定/色板/覆盖/QA），校验失败 422
  - `POST …/character-asset/refresh` — 面板重生成后的版本级联（coverage/panels 刷新 + version+1 + derived_from）
  - `POST …/character-asset/card` — D2 展示卡渲染（1600×2240，主视觉/锚点/三视图/表情/色板/服化道/档案；缺面板占位不抛错）
  - `POST …/character-asset/coverage-plan` — M2 覆盖缺口 + 补拍计划（只出计划不执行）
  - 生成链钩子：整卡生成 / 面板重生成成功后 `note_sheet_generated` 版本级联（try/except 不阻塞主链）
- **词表单一真源**：锚点 kind/enforce、覆盖 angles/framings/lightings、口型系列、六表情、跨风格 STYLE_VARIANTS 六档（古风写实/二次元/写实/水墨/赛博/3D）。
- **测试**：`apps/api/tests/test_character_asset_protocol.py`（12 例：锚点抽取/校验规则/版本级联/回填/渲染/路由全链）；全量回归对照 HEAD 基线失败集完全一致（预存环境性失败 53/104，零新增）。
- **生产交付（2026-10-06）**：api 经 `deploy.sh --skip-web core-jump` 上 core，健康 200；**D3 真实回填已执行**——林夏（803fb69b…，设定卡 1224 案主角）GET 即物化 v1（六面板/锚点/采样色板/覆盖登记），PUT 已补 5 条正典锚点+负向约束；展示卡三迭代（标签底衬→hex 间距→底部空带 345px→~150px 页底边距）经视觉验收；coverage-plan 出 3 个补拍 job（medium_closeup/day/night）且负向约束正确注入。生产卡样例：`char_card_803fb69b_anime_b6f61fa4d4fa.png`。
- **web 波（2026-10-06 同日第二波，已上 core）**：lib/api +4 客户端方法与类型；`components/studio/CharacterAssetPanel.tsx`（锚点行编辑/色板 swatch/覆盖+缺口 chip/补拍计划列表/展示卡渲染预览/版本溯源展示，materialized_now 回填提示）；CastStage 设定卡操作区挂「资产」入口；studio.css 追加 `.studio-asset-*` 前缀样式。测试 `tests/characterAssetPanel.test.ts` 4 例绿；web 全量失败集与 HEAD 基线差集为空（5 例预存失败与本波无关）。部署=5 文件精确 scp（避让 BeefTV 在途未提交改动，三跟踪文件 md5 先与 core 核对一致）+ core 本机 `rm -rf .next && pnpm build`，BUILD_ID `20261006-104220-nogit`，产物 grep 三重确认（testid/API 路径/CSS）。
- **M2 实际生成执行（2026-10-06 第三波，已完成）**：`style_variants` 入 L2 schema+PUT 白名单；驱动脚本 `tmp/run_asset_variants_linxa.py`（生产产品路：/api/upload → /api/generate/img2img → /api/jobs/lookup 轮询 → PUT 登记）。**林夏（anime）两变体已生成并登记生产资产**：realistic（majicMIX 麦橘写实 v7，denoise 0.68，seed 24680——五锚点全保，人像质感完整切换）与 ink_wash（flux2_dev，denoise 0.72，seed 97531——宣纸留白/皴染/题字印章形态，短发+雨衣+雨夜便利店构图锚点可辨）。引擎选型记录：:8196 无 WAI Illustrious，水墨走 flux2 通用底模；img2img 为异步 prompt_id 模式，结果取回走 jobs lookup `results` 字段。产物在 `tmp/asset_variants/`。
- **未做（按分期）**：per-character LoRA/embedding（M3）、D4 编辑底图重做（**并行会话在打**——base_expr_* 产物 mtime 2026-10-06 16:51 + BeefTV 未提交改动可证，本线不碰防撞车，P-5）、变体图的 web 面板展示（style_variants 展示区，下轮小改）。

---

## 一、总结论

外部稿的**资产观是对的，生成观是错的**。

- **对**：角色卡不是插画，是 Canonical Character Reference；三层资产模型（视觉/结构化/生成资产）；Canonical / Identity Anchor / Variant 三个概念入产品协议；风格与身份解耦；冲突优先级梯子。这些全部采纳。
- **错**：外部稿整体仍是「一条 prompt 生成一张全家桶大图，靠措辞要求多视图同人」的心智。真机上扩散模型兑现不了「禁止换脸」这类 prompt 级承诺——一致性是**管线机制**产出物，不是提示词产出物。ToIV 已用「锁定底图 → 分面板派生 → insightface 打分门禁 → 拒绝重试 → 锁定几何拼版」验证过这条路的必要性；1224 案（编辑底图缺陷导致表情 fallback 失败）反向证明：底图资产级缺陷，任何 prompt 措辞都救不回来。

因此落地版协议**反转生成次序**：先建 canonical 底图资产，门禁化派生各面板，最后才把设定卡当作资产集的**渲染视图**（一张排版图）。外部稿的「生成大图再抽取 JSON」倒过来做：**JSON 先行，大图殿后**。

---

## 二、外部稿逐节裁定

| 外部稿章节 | 裁定 | 理由 / ToIV 现状 |
|---|---|---|
| 角色卡=视觉固定资产/Canonical Reference | ✅ 采纳 | 与现有「锁定帧/锁定格」实践一致，升格为协议条文 |
| 一、构图模块 A–S 清单 | ✅ 采纳为**可选模块注册表** | 现有六面板（portrait/front/side/back/faces/costume）是其中子集；武器/变体服装/特殊形态等按角色类型挂载 |
| 二、主视觉规范 | ✅ 采纳 | 与 portrait 面板规范一致 |
| 三、多视图一致性「禁止换脸」 | ⚠️ **机制替换** | prompt 承诺→管线机制：同底图派生 + face gate 打分 + 拒绝重试。条文保留作为意图说明，不作为一致性手段 |
| 四、表情规范 | ⚠️ **扩展** | 补口型开闭系列（视频配音必需，IndexTTS 链路）；「侧颜」从表情类目移入视角类目（外部稿自己犯了「美术导向」分类错误） |
| 五、细节展示=设计证据 | ✅ 采纳 | 已实践：costume 平铺图带专用 negative（no person/no face）；cfix 四区修复即消费此模块 |
| 六、Identity Anchors | ✅ **重点采纳** | ToIV 目前锚点是隐式的（散在 prompt 锁定条款里）；升格为**显式数据字段**，并绑 QA 检查项 |
| 七、服装资产描述 | ✅ 采纳 | 「黑色长裙」→结构化材质描述，写入 JSON；平铺图 + 文字双形态 |
| 八、色彩系统（HEX） | ✅ 采纳 | 新增，现 sheet 无色卡面板 |
| 九、文字信息 | ✅ 采纳 | 结构化字段进 JSON；卡面上文字只做展示糖 |
| 十、风格无关 | ✅ 采纳 | 同一 canonical 身份跨风格 variant（水墨/赛博/3D/写实），锚点不动、画风重绘 |
| 十一、Canonical Character Rule | ✅ 采纳为系统级规则 | 与锁定帧实践一致；补一条：**变更必须走版本化重派生级联**（外部稿缺失，见下） |
| 十二、冲突优先级 | ✅ 采纳 | 直接映射为 QA 门禁的检查顺序 |
| 十三、结构化输出 | ✅ 采纳 | 即 L2 资产；schema 见第四节 |
| 十四、母 Prompt | ⚠️ 拆用 | 各节条款并入面板 prompt 库；不作为单条母 prompt 使用 |
| 十五、三层资产 | ✅ 采纳 | 即本协议核心模型，见第三节 |

外部稿**缺失**、落地版必须补的四件事：

1. **验证层**：外部稿没有任何 face 打分/人工复审/拒绝重试机制，却要求「证明所有视图是同一角色」——无机制则无证明。ToIV 门禁（insightface 脸面积/嘴部几何/复判）全部沿用并纳入协议。
2. **版本与溯源**：canonical 资产必须有 version / provenance（模型+seed+workflow）/ lock 状态 / derived-from 关系。底图重做时（1224 的 base_expr_2/3 正是此况），下游派生表情须级联重生成——没有溯源图就是手工地狱。
3. **覆盖登记**：短剧真正吃的是角度×景别×光照覆盖（过肩/仰俯/中近特/夜戏雨戏），不是多一个 3/4 back view。资产须登记「已有哪些覆盖、缺哪些」，镜头侧才能按需补拍。
4. **双人同框**：多角色 two-shot 一致性外部稿只字未提，短剧刚需，列为 M2 议题。

---

## 三、三层资产模型（协议核心）

```
CharacterAsset (CHR_id)
│
├── L1 视觉资产 —— 给人和 AI「看」
│   ├── canonical_base        锁定底图（唯一权威基准，改它=开新版本）
│   ├── panels                portrait/front/side/back/faces/costume…
│   ├── expression_set        六表情 + 口型系列（closed/O/宽开）
│   ├── detail_callouts       服化道四区等对版图
│   └── sheet_render          设定卡排版图 = 上述资产的模板渲染视图（非生成物）
│
├── L2 结构化资产 —— 给系统「理解」
│   └── Character Asset Definition JSON（schema 见第四节）
│
└── L3 生成资产 —— 给模型「复现」
    ├── reference_images      按用途索引（i2v 首帧 9:16 / face ref / region ref）
    ├── canonical_prompt      正负提示词对（现每表情双栏 prompt 库平移入此）
    └── (预留) embedding/LoRA per character —— M3，依托现有 GPU 舰队
```

### 生成次序（与外部稿的根本分歧点）

```
canonical_base（人工定稿/锁定）
   → 分面板派生（每面板独立 prompt+negative）
   → 门禁（face 打分 / 嘴部几何 / 脸面积 / 锚点清单）
   → 通过入库，失败重试或停
   → sheet_render 模板渲染（展示/宣发/toC 分享用）
```

**sheet_render 永远是渲染结果，不是一致性来源。**

---

## 四、Character Asset Definition JSON（L2 schema 草案）

```jsonc
{
  "character_id": "CHR_1224",
  "version": 3,                          // canonical 底图版本，底图变更+1
  "provenance": {                        // 溯源：可复现、可回滚
    "base": {"workflow": "…", "model": "…", "seed": 0, "created_at": "…"},
    "derived_from": {"base_version": 2, "regen_reason": "编辑底图缺陷"}
  },
  "lock": {"base": true, "panels": ["faces"], "layout": true},
  "identity_anchors": [                  // 3–10 条，显式数据化，QA 逐条检查
    {"kind": "hair", "desc": "齐下巴短发", "enforce": "prompt+gate"},
    {"kind": "costume", "desc": "连帽雨衣无徽章", "enforce": "prompt+negative"}
  ],
  "face": {}, "body": {}, "hair": {}, "eyes": {}, "skin": {},
  "costume": {                           // 结构化服装资产，禁「华丽的衣服」式描述
    "base_garment": {"desc": "…", "material": "…", "color_hex": "…"},
    "detail_regions": ["collar", "cuff", "hem", "boots"]
  },
  "accessories": [], "weapon": [],
  "color_palette": {"primary": "#…", "secondary": "#…", "accent": "#…", "variants": {}},
  "expressions": {"emotions": ["威严","冷酷","沉思","温柔","惊恐","果断"],
                   "mouth_series": ["closed", "O_small", "wide_open"]},
  "coverage": {                          // 覆盖登记：镜头侧按需补拍
    "angles": ["front", "side", "back"],
    "framings": [], "lightings": [], "two_shot": false
  },
  "style": {"current": "anime", "variants_allowed": true},
  "profile": {"name": "…", "role": "…", "speech_style": "…", "lore": "…"},
  "canonical_prompt": {"positive": "…", "negative_constraints": ["…"]},
  "qa": {"face_gate": {"threshold": 0.94, "last": 0.951}, "human_review": "pass"}
}
```

要点：`identity_anchors` + `provenance` + `coverage` + `mouth_series` 是相对外部稿新增的四个承重字段；`negative_constraints` 直接平移现有六表情 negative 库。

### Canonical Character Rule（系统级条文）

1. 资产卡确认后即为该角色所有生成任务的默认视觉基准；未明确要求改角色，不得擅改锚点清单内一切特征（脸/比例/发型/瞳色/肤/核心服装结构/核心配饰/主色板）。
2. 允许变化：姿态/表情/机位/光照/环境/构图/画风/服装变体——但变体必须从 canonical 出发派生，不是重造角色。
3. **底图变更 = 开新版本 + 下游派生级联重生成**（门禁全部重跑）；任何面板锁定状态变更须记录原因。

### 冲突优先级（映射为 QA 门禁检查顺序）

身份一致性 > 锚点 > 脸部结构/身体比例 > 核心服装结构 > 核心色 > 配饰武器 > 多视图一致 > 材质 > 表情 > 姿态 > 背景 > 装饰 > 文字。宁可牺牲背景装饰，不牺牲身份——与现行「脸面积不足先 zoom 一次，仍不足直接停」同一哲学。

---

## 五、分期建议

- **M1（低成本高感知）**：L2 schema 落库 + identity_anchors 数据化（从现 prompt 锁定条款抽取）+ coverage 登记 + sheet_render 模板渲染（对外吐「一张图全家桶」设定卡，toC 传播形态，即微信传播的那种卡）。
- **M2**：跨风格 variant（锚点不动重绘）；光照/景别覆盖补拍流程；双人同框一致性议题。
- **M3**：L3 per-character embedding/LoRA（舰队已有算力，IndexTTS/参考链路成熟后再上）。

## 六、拍板记录（2026-10-06 用户拍板「按方案执行，完成所有任务」）

1. **D1 ✅ 协议升格产品级**：L2 schema 落 api 服务层 + 5 端点上线（本文件「实现落点」节）。
2. **D2 ✅ 展示卡模板立项 M1**：双主题（古风纸色/二次元冷灰）通用底模板先行；`POST …/character-asset/card` 渲染。
3. **D3 ✅ 存量回填**：不做一次性脚本——`ensure_asset` 读取侧物化（首次 GET 即从存量面板+角色行回填 v1），1224 等存量角色零人工。
4. **D4 拍板：分开执行**：编辑底图重做（base_expr_2 嘴微张小 O / base_expr_3 底部灰带+构图 top=0.117）走舰队生成批次，不并入本协议代码波次；重做完成后经 `refresh` 端点记版本级联。
