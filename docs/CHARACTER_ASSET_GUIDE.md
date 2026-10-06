# 角色资产功能说明（Character Asset Guide）

> 日期：2026-10-06 · 状态：**已上线 core 生产并真机验证**
> 协议正文：`docs/ops/CHARACTER_ASSET_PROTOCOL.md`（评估+拍板+分期）
> 本文面向使用与运维：这功能是什么、怎么用、数据长什么样、怎么排障、边界在哪。

---

## 一句话

把「角色卡」从一张排版图升级为**三层资产管理**：结构化资产定义（L2 JSON）+ 视觉面板资产（L1 文件）+ 生成参考（L3），让同一个角色在跨镜头、跨场景、跨画风的生成中保持**同一身份**；需要对外展示时再一键渲染「一张图全家桶」设定卡。

## 核心概念（三个词）

| 概念 | 含义 | 落地 |
|---|---|---|
| **Canonical** | 角色唯一的权威视觉基准，确认后所有生成默认遵循 | 资产 JSON `version` + `derived_from` 溯源；底图/面板重生成自动 version+1（级联记录，不阻塞主链） |
| **Identity Anchor** | 换装/换画风也不变的身份特征（发型/瞳色/核心服装…），3–10 条 | 资产 JSON `identity_anchors[]`，每条带 enforce（正向/正负/门禁）；跨风格变体与补拍计划的提示词都从这里拼 |
| **Variant** | 锚点不动、画风重绘的派生形态（水墨/赛博/3D…） | 资产 JSON `style_variants{}`，登记 url/seed/ckpt/denoise 全溯源 |

## 怎么用

### Web（创作工作室 → 项目 → 角色页）

设定卡操作区新增「**资产**」按钮，打开资产面板：

- **识别锚点**：逐行编辑（类型/描述/约束方式），与身份档案（身份/性格/口吻/背景）一起保存（PUT）；
- **覆盖登记**：角度/景别/光照三行 chip；点「补拍计划」→ 缺口高亮为「·缺」并给出每个补拍 job 的正负提示词（可直接抄给生成链）；
- **跨风格变体**：登记过的变体以卡片展示（点开大图，附 seed/底模）；
- **展示卡**：点「渲染展示卡」→ 用当前面板资产+资产 JSON 模板渲染 1600×2240 对外传播卡（主视觉/锚点/三视图/表情/色板/服化道/档案）；
- 首次打开自动从存量设定卡面板回填 v1 资产（**存量角色零人工**），并提示「已从存量面板回填」。

### API（5 端点，前缀 `/api/studio/characters/{cid}`）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/character-asset?style=anime\|ancient_realistic` | GET | 读 L2 资产；JSON 不存在时**自动物化 v1**（D3 回填引擎） |
| `/character-asset` | PUT | 白名单补丁：identity_anchors / profile / canonical_prompt / lock / color_palette / coverage / qa / variants_allowed / style_variants；校验失败 422 |
| `/character-asset/refresh` | POST | 面板重生成后的版本级联（coverage/panels 刷新 + version+1 + derived_from；body 带 reason） |
| `/character-asset/card` | POST | 渲染展示卡 → `{card_url, asset_version}` |
| `/character-asset/coverage-plan` | POST | 短剧覆盖缺口 + 补拍计划（只出计划不执行） |

示例（admin）：
```bash
TOKEN=$(curl -s -X POST https://toiv.wineryz.top/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin","password":"***"}' | jq -r .token)
# 读资产（存量自动回填）
curl -H "Authorization: Bearer $TOKEN" \
  "https://toiv.wineryz.top/api/studio/characters/{cid}/character-asset?style=anime"
# 补锚点与负向约束
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"style":"anime","identity_anchors":[{"kind":"hair","desc":"short black bob hair, chin-length","enforce":"prompt+negative"}],"canonical_prompt":{"positive":"…","negative_constraints":["long hair"]}}' \
  "https://toiv.wineryz.top/api/studio/characters/{cid}/character-asset"
```

## 数据与文件

- **L2 JSON**：`{drama_output_root}/studio/char_asset_{cid8}_{style}.json`（原子写；schema_version=1）
- **展示卡**：`…/studio/char_card_{cid8}_{style}_{uuid}.png`（只增不改）
- **L1 面板**：沿用设定卡既有 `char_panel_{cid8}_{style}_{key}_*.png`（资产只登记、不搬运）
- 关键字段：`identity_anchors`（≤10）、`color_palette`（HEX 色板）、`expressions.mouth_series`（closed/O_small/wide_open，配音口型用）、`coverage`（angles/framings/lightings/two_shot）、`provenance`（base 来源+regenerations 流水）、`lock`（base/layout 布尔+panels 键列表）、`style_variants`（变体登记，url 带 sig **长期有效**）

## 生成关系（谁消费资产）

- 补拍计划 / 跨风格变体的提示词从 `identity_anchors + negative_constraints` 拼装——**锚点是唯一拼词真源**，改锚点即改所有下游派生提示词；
- 生成链钩子：整卡生成 / 面板重生成成功 → `note_sheet_generated` → 已物化资产自动 version+1（try/except，绝不阻塞生成主链）；
- 冲突优先级（协议）：身份一致性 > 锚点 > 脸/身体 > 核心服装 > 核心色 > 配饰 > 多视图 > 材质 > 表情 > 姿态 > 背景。

## 当前生产实绩（2026-10-06）

- 林夏（803fb69b…，1224 案主角）：资产 v1，5 条正典锚点（齐下巴黑短发/暗色眼/石板灰无徽章雨衣(enforce=gate)/湿发贴额/身份）+ 负向约束（long hair / chest emblem / hood up）+ 覆盖登记 + 采样色板；
- 展示卡：`char_card_803fb69b_anime_b6f61fa4d4fa.png`（三迭代视觉验收过）；
- 跨风格变体两枚已登记：**写实**（majicMIX 麦橘写实 v7，denoise 0.68，seed 24680，五锚点全保）与**水墨**（flux2_dev，denoise 0.72，seed 97531，水墨形态锚点可辨）；
- coverage-plan：medium_closeup / day / night 三个缺口 job。

## 排障与口径（踩过的坑）

1. `/api/images?...&sig=` 的 sig **只免归属校验，认证 token 仍必需**——纯 URL 直访 401 是预期；前端 `imageUrl()` 的 withToken 已覆盖。
2. worker 模型差异：:8196（gpu0-alt）**没有 WAI Illustrious**——水墨类 2D 风格变体走 flux2_dev；写实走 majicMIX。提交 img2img 前先 `/api/models` 核对 ckpt 在目标 worker。
3. img2img 是**异步 prompt_id 模式**：提交即返回，结果轮询 `GET /api/jobs/lookup?prompt_id=`，产物 URL 在 **`results`** 字段（不是 result）。
4. 变体 URL 存的是带 sig 的长期 URL（HMAC 无时间戳），jwt_secret 不变则永久有效。
5. 展示卡渲染需要 core 侧 CJK 字体（PingFang/Noto 系，与设定卡拼版同一依赖）；缺面板自动占位不抛错。
6. 本地 dev 有 53/104 个**预存环境性失败**（FastAPI 错误路径序列化漂移），与资产线无关——对照 HEAD 基线甄别过，勿记新账。

## 边界与后续

- **M3 per-character LoRA/embedding**：按协议后置到底模/参考链路成熟期（L3 资产预留位已留）。
- **D4 编辑底图重做**（1224 遗留 base_expr_2/3）：归并行会话持有，完成后经 `refresh` 端点记版本级联。
- 变体生成的 UI 化（面板内直接下单变体）未做——当前经批次脚本/接口（参考 `tmp/run_asset_variants_linxa.py` 的产品路模式：upload → img2img → lookup → PUT 登记）。
- 多角色 two-shot 一致性：登记字段 `coverage.two_shot` 已留，生成侧待 M2 后续。

## 变更记录

| 波 | 内容 | 提交 |
|---|---|---|
| api 基座 | L2 schema/5 端点/版本级联/展示卡/生成钩子 + 林夏回填 | `a3fde180` |
| web 面板 | 资产面板（锚点编辑/覆盖/展示卡） | `c32baff8` |
| M2 实跑 | style_variants + 写实/水墨变体生产生成登记 | `946e840b` |
| 变体展示 | 面板变体卡网格 | `2e020824` |
| 收尾 | 本说明 + AGENTS/STATE 终态 | （本提交） |
