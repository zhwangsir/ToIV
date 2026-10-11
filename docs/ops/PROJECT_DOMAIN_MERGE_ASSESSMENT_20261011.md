# 双项目域合并评估（S3-c · 2026-10-11）

> 背景：v2 重构实测中确认 canvas 工作台（`StudioProject` 域，`/studio/projects`）与经典短剧线（`DramaProject` 域，`/drama/projects`）两套 Project/Character/Shot 平行存在——「两个项目」体感的深层来源。本文件给出合并方向与分期，供拍板。

## 1. 现状盘点

| 维度 | StudioProject 域（studio.py） | DramaProject 域（drama_studio.py） |
|---|---|---|
| 现役负载 | canvas 工作台 + v2 工作区 + 管线B/C/c-chains + 设定卡 + 任务中心 | 经典 web 短剧视图 + /drama 播放 + 对话式创作 |
| 角色 | 参考图(扁平+by_style 分桶)、设定卡(分格/VLM 门禁)、音色 | **三视图字段**(M1)、参考图、音色 |
| 分镜 | render_mode 混排(video/image_motion)、c-chains segments | **seam 衔接策略**(continue/overlap/matchcut)、宫格图、色彩在场校验、mood/beat |
| 候选 | 单候选为主(pick 端点已有) | **DramaShotCandidate 多候选+is_picked** |
| 资产库 | 无 | **DramaAsset 跨项目资产库**(character/scene/prop/style) |
| 项目规格 | width/height/fps/ckpt/render_mode_default | 同类字段齐全 |

## 2. 评估结论

**方向：以 StudioProject 域为唯一宿主，DramaProject 独有能力按需下沉，不做数据大搬迁。**

理由：①现役生产链路（出片/任务/工作区）全在 Studio 域，动它风险大、动 Drama 域风险小；②两域 80% 字段同构，差异是「能力」而非「模型」，补齐成本低；③DramaAsset 是真跨域件，应保留为共享资产库供两侧引用。

## 3. 能力下沉清单（S4+ 按需）

| Drama 能力 | 下沉方式 | 批次 |
|---|---|---|
| 多候选选优 | 新表 `StudioShotCandidate`（镜像 DramaShotCandidate；pick 端点已有雏形） | S4 |
| seam 衔接策略 | `StudioShot` 加 `seam_to_next/seam_anchor` 两字段（管线 C 已有衔接实现，仅缺持久化） | S4 |
| 三视图 | 已被「设定卡分格 + by_style 分桶」实质替代，不再下沉 | — |
| 跨项目资产库 | DramaAsset 保留；Studio 域加只读引用 | S6 |
| 宫格图/色彩校验 | 随管线 v2 QC 门禁统一实现（契约 §5） | S8 |

## 4. 迁移与退役

1. **冻结**：DramaProject 域不再接新功能（bug 照修）。
2. **经典视图**：经典 web 的 drama 视图 P4 处置时改只读（数据保留可查），不迁移历史项目数据。
3. **决策点（P4 前）**：历史 DramaProject 项目是否需要导出为 Studio 格式（一次性脚本可做，量少则不值得）。

## 5. 变更记录

- 2026-10-11 v1：初版（依据：本轮 v2 工作区实测 + 两域路由/模型代码盘点）。
