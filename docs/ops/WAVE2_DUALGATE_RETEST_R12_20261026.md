# 第12轮·双闸复验 — 一页风险表
交 TL · 逆向安全 · 2026-10-26 ~15:00 Asia/Shanghai  
范围：images/studio_files 部分闸 · redline 硬依赖 · Strangler 是否绕 NSFW  
对照 tip：`45ebdab4`（active/boards/timeline-preview 已闸；images/studio_files 仅 Job.result 路径）  
**本轮不改码**（未发现须当场热修的阻断级；下列为复验结论与排期建议）

## 结论摘要
| 项 | 结论 |
|----|------|
| images / studio_files | **部分闸成立**：有闸，但判据过窄（仅 `Job.nsfw=True` ∩ result LIKE） |
| redline 硬依赖 | **仍硬依赖**：缺文件会炸主路径；soft-optional 未做（R1 已记后续） |
| Strangler → NSFW | **未发现绕过**：孤面 308 进 canvas 创作台，成人仍走 redline；经典壳不再恢复 R18 头 |

## 风险表

| ID | 面 | 严重度 | 现状 | 风险 | 建议（下轮，本轮不动） |
|----|-----|--------|------|------|------------------------|
| R12-1 | `/api/images` + `/thumb` | **中** | `assert_image_content_mode_allows` 在 sig/归属之后；成人放行，普通态仅当存在 `Job.nsfw`+`filename=` LIKE 命中才 404 | **漏**：无 Job 行 / Job.nsfw 漏标 / result 未含 `filename=` 字面 → 普通态可取 NSFW 字节；sig **不**绕 content_mode（好） | 扩判据：StudioShot/资产 nsfw 标、写入时强制 Job.nsfw、或产物侧 nsfw 索引表 |
| R12-2 | `/api/studio/files/{name}` | **中** | `assert_studio_file_content_mode_allows`：仅当 Job.result 含 `/api/studio/files/{name}` 且 nsfw | **漏**：纯 Studio 落盘、未回写 Job.result 的 NSFW 片 → 普通态可读（持合法 sig/归属即可） | 与 R12-1 同：文件元数据 nsfw 或 shot 关联闸 |
| R12-3 | `/api/drama/output/{name}` | **高** | 仅 `get_current_user`；**无**属主校验、**无** content_mode/nsfw 闸；`Cache-Control: public` | 知文件名即可拉成片（含潜在成人成片）；双闸在此面**缺席** | P0 候选：属主 + `nsfw_allowed`/项目成人快照；改 private cache |
| R12-4 | `/api/entities/.../images/{slot}` | **中高** | 属主有；句柄则 **直读 worker input**，不经 `media_nsfw_gate`；纯 URL 302 到原地址 | 绕过 `/api/images` 双闸读字节；主体 NSFW 无独立标时更易漏 | 读前走同一 gate 或实体 nsfw 标 + `nsfw_allowed` |
| R12-5 | redline.ts / redline.py | **低·已知** | api≈39 / canvas≈28 处硬 import；无 soft ImportError | 文件缺失 → 打包/ImportError，SFW 主功能挂；非「缺文件仍跑」 | 后续 soft-optional/shim（R1 已挂账） |
| R12-6 | Strangler R11 | **低·通过** | web→`/studio/create`；`page.tsx` 钉死成人只走 canvas；创作坞 import redline | **不构成** NSFW 绕过；残余：工具页源码仍在仓、书签依赖 canvas Navigate | 保持；删死页另排 |

## 已确认好转（tip 45ebdab4）
- `/jobs/active` 等列表：`Job.nsfw` + `nsfw_allowed` 过滤  
- boards 条目：nsfw job 对普通态隐藏  
- `timeline-preview`：`shot_urls_nsfw` → 普通态滤 NSFW 分镜 URL  
- images/studio_files：**已挂闸**，但是 Job.result 部分覆盖（上表 R12-1/2）

## 阻断级判定
- **本轮不改码**：无「删文件/改一行即可恢复生产」类热阻断；R12-3 为最高优先补洞，建议后端下轮 P0，非本轮逆向热修范围。  
- 本地自用口径下 API 可绕仍成立；若对外/多用户，R12-3/4 应按 P0。

## 路径
MateBook：`/Users/wangzhenyu/Desktop/ALLProject/ToIV/docs/ops/WAVE2_DUALGATE_RETEST_R12_20261026.md`

## 口径变更（用户 2026-10-27）
限制/红线**只前端**，**禁止后端加闸**。  
- R12-3 及表内「扩 BE gate / 后端 403 / nsfw_allowed 热修」建议 **全部作废**，不再推后端补洞。  
- 后续审计改看：**前端 redline（路由守卫 / UX 闸）是否覆盖对应面**；API 可绕视为本地自用已接受前提，不作 BE P0。  
- R12-5 soft-optional 仍属前端/打包韧性，与本变更无关，挂账不变。  
- R12-6 Strangler 结论不变。
