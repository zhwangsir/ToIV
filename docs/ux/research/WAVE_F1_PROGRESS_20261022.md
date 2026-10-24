> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# Wave F1 进度（关键帧默认 · 失败码/质检 · 控片就绪灯）

> 时间：2026-10-22 05:57 Asia/Shanghai · tip 起点 `f915b665` · **无 push / 无 deploy / 无 restart**

## 范围（已完成）

1. **关键帧驱动为分镜默认**
   - FE：`storyboard-drive.ts`（默认 `keyframe`；`videoRenderGate`；流水线视图默认）
   - UI：工作区「分镜驱动」选择器；配景图可一点采用关键帧；单镜/整批开拍软闸
   - BE：`preferred_drive_mode`（模型 + 幂等迁移 + ProjectPatch）；`POST .../adopt-keyframe`；`render` 422+`KEYFRAME_REQUIRED`（`force_direct` 旁路）

2. **失败码表 + 质检提示**
   - 扩展 `studio-qa-failure.ts`：`StudioFailureCode` / `STUDIO_FAILURE_TABLE` / `resolveStudioFailure` / `studioQaMessageWithHint`
   - 含 `KEYFRAME_REQUIRED` 等人话 + 下一步质检提示

3. **控片台就绪灯**
   - `control-readiness.ts` + `ControlReadinessLamps`：定妆→关键帧→视频→配音→口型→合成
   - 挂在短剧工作区 `ComputeStatusStrip` 下方

## 测试

- bun：`storyboard-drive` · `control-readiness` · `studio-qa-failure`（13 pass）
- pytest：`tests/test_keyframe_drive.py`（6 pass）

## OUT（本波未做）

F2 剧组一键 · F3 BGM/KPI · F4 剪映 · F0b 部署 · Acc · 安全 Dly
