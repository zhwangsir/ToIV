# 第1轮·吸收合规闸 — license 粗分 + 红线确认
交 TL · 逆向安全 · 2026-10-26 ~14:10 Asia/Shanghai  
范围：用户点名 13 仓（含 Toonflow / BeefTV / dramaclaw 等）· **本轮不改业务**  
证据：深挖 `SUMMARY.json` + `/workspace/drama-deep/licenses/*`；MateBook ToIV 实盘核路径。

## 闸规则（对齐用户死令）
| 桶 | 许可族 | 进仓/并码 | 本地学习 |
|----|--------|-----------|----------|
| **A 可照抄** | MIT / Apache-2.0 | ✅ 可复制代码，保留版权头 + NOTICE；禁整仓白标 | ✅ |
| **B 仅本地学习** | AGPL / GPL / NC / ELv2 / SAL / ACL(无商用例外) / CC-BY-NC-SA | ❌ 不可商用进仓；只抽模式/交互/token，实现重写 | ✅（成品仍不商用） |

## 13 仓对照表

| # | 仓 | 许可（核实） | 桶 | 本轮吸收建议 |
|---|-----|--------------|----|--------------|
| 1 | glanderness/BeefTV | SAL 1.0 Part A + 历史 MIT Part B | **B**（SAL 区）；Part B 另议 | 只抽壳层 IA / 审核失败→R18 提示模式；**禁并 Part A 源码/白标/对外托管** |
| 2 | ArcReel/ArcReel | AGPL-3.0 | **B** | 只学资产库·可恢复任务链；禁并码 |
| 3 | dramaclaw/dramaclaw | Elastic-2.0 | **B** | 只抽双轨壳 / Freezone token（已重写落地）；禁并码 / 禁 SaaS 同款托管 |
| 4 | gzxx-2025/aid-studio | MIT | **A** | 可标源抽敏感词闸布局→反构 R18；运营后台非本轮 |
| 5 | yi1108/printfilm | MIT | **A** | 可标源抽最小分镜闭环/队列；**软化仅普通模式**，成人禁用 |
| 6 | alibaba/lumenx | MIT | **A** | 可标源抽三视图/R2V；勿照搬通义托管审核 |
| 7 | klaus-2/koma-studio | MIT | **A·错仓** | **不吸收**（扫图 OCR，非短剧）；对照漫剧向 M-JYuan/Koma=GPL→B |
| 8 | shuyu-labs/BigBanana-AI-Director | Community NC 1.0 | **B** | 只抽 Phase 01–04 阶段 IA；禁并码（badge 误标 CC 以 LICENSE 为准） |
| 9 | Heroesjouney/AIMovieStudiov2 | AGPL-3.0 | **B** | 只学 3D/Timeline/Comfy 本地链模式；禁并码 |
| 10 | xhongc/ai_story | CC BY-NC-SA 4.0 | **B** | 只学轻量闭环模式；禁商用并码 |
| 11 | UllrAI/CineGen-ShortDrama | AniKuku ACL v1.0 | **B** | 只抽 Shot/Keyframe 交互；无归因商用例外未买→禁并码 |
| 12 | HBAI-Ltd/Toonflow-app | MIT | **A** | **本轮优先可照抄**：无限画布/助手侧栏；标源+NOTICE |
| 13 | HBAI-Ltd/Toonflow-web | Apache-2.0 | **A·归档** | 许可可抄但 **archived**；不作为主吸收源 |

### 桶汇总
- **A 可照抄进仓（标源）**：Toonflow-app · LumenX · PrintFilm · AID-Studio（+ Toonflow-web 归档备用）
- **B 仅本地学习不可商用进仓**：BeefTV(SAL) · DramaClaw(ELv2) · ArcReel(AGPL) · AIMovieStudioV2(AGPL) · BigBanana(NC) · ai_story(NC-SA) · CineGen(ACL) · （对照）M-JYuan/Koma(GPL)
- **不吸收**：klaus-2/koma-studio

## 本轮吸收建议（合规闸视角，不改业务）
1. **闸输入以本表为准**：跨端/后端抽并前先查桶；A 才允许进仓复制；B 一律重写。
2. **优先可进仓**：Toonflow-app（P0 画布）→ LumenX（三视图）→ PrintFilm（最小闭环，注意软化边界）→ AID-Studio（闸反构，非运营壳）。
3. **已落地重写勿回滚成抄码**：DramaClaw 双轨壳、BeefTV IA —— 保持「模式重写」，勿再贴 SAL/ELv2 源码。
4. **禁**：整仓白标；B 桶商用进仓；把 PrintFilm 软化默认到成人路径。

## 红线单文件确认（MateBook 实盘）

| 面 | 路径 | 行数 | 角色 |
|----|------|------|------|
| 前端 | `apps/canvas/web/src/redline.ts` | ~630 | UX / 路由守卫唯一决策面 `POLICY_ID=D-U1=B-frontend-guard` |
| 后端 | `apps/api/app/redline.py` | ~158 | 403 唯一真源 `POLICY_ID=D-U1=B`；账号 `content_mode`，不信任 X-NSFW 放行 |
| 薄 re-export（无逻辑扩） | canvas `services/toiv/r18-mode.ts`；api `nsfw_ctx.py` / `r18_policy.py` | — | 旧路径兼容，新代码直引 redline |

结论：
- ✅ **红线仍集中在上述两个单文件**；其余为 import / 薄 re-export，未见第二套决策实现。
- ⚠️ **「文件缺失不影响主功能」当前不成立**：canvas/api 大量硬 `import`/`from app.redline import ...`；删文件会导致前端打包失败 / 后端 ImportError，SFW 主路径也会挂。若合规闸验收要「缺文件仍跑主功能」，需另开一轮做 optional/shim（本轮按「不改业务」未动）。
- 软化：`should_apply_softening` 走 redline；成人路径不得进 softening（与 PrintFilm 吸收边界一致）。

## 详参
- 深挖 Page：https://cursor.com/canvas/store-2a7cb835-7fcb-4cd4-b2c8-cb0ee07b899c/9a6e4b46-d3de-4981-bebf-88a9bdd8c5f6
- Wave2 台账（权威 Page 仍 TL 侧）：MateBook `docs/WAVE2_ABSORB_LEDGER.md`；box `/workspace/drama-absorb/WAVE2_ABSORB_LEDGER.md`
