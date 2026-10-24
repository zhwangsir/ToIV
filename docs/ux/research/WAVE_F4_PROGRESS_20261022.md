> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# Wave F4 进度（剪映草稿导出）

> 时间：2026-10-22 Asia/Shanghai · tip 起点 `180134ce` / feat `9bbc8914` · **无 push / 无 deploy / 无 restart**

## 范围（已完成）

1. **原创导出器** `apps/api/app/services/studio/jianying_draft.py`
   - 格式声明：`toiv_jianying_draft_v1`
   - 按公开协议形状拼装：`draft_content.json` + `draft_info.json`（双写）+ `draft_meta_info.json`
   - 视频轨顺序拼接；配音按镜头起点；BGM 从 0 铺满
   - ZIP 含 `assets/`（尽力复制）、`IMPORT.md`、`toiv_manifest.json`
   - **不拷贝** AGPL/GPL/NC 草稿库代码（ArcReel / pyJianYingDraft / Koma 等）

2. **API** `GET /api/studio/projects/{pid}/export/jianying?include_media=`
   - 鉴权项目归属；无成片 → 422
   - 返回 `application/zip` + `X-Toiv-Draft-Format` / `Draft-Id` / `Video-Segments`

3. **UI**
   - `JianyingExportButton` 挂合成段（有成片 / 暂无成片均可发现；无 final_clip 时禁用）
   - 替换「剪映/FCPXML 放后续波次」文案
   - FE 契约：`jianying-draft.ts` + `exportStudioJianyingDraft`

## 测试

- bun：`jianying-draft.test.ts`（4 pass）
- pytest：`test_jianying_draft_f4.py`（7 pass）

## 导入说明（用户）

解压 ZIP → 将草稿文件夹放入本机  
`JianyingPro/User Data/Projects/com.lveditor.draft/`（或 CapCut 同级目录）→ 重启剪映打开。  
详见包内 `IMPORT.md`。明文 best-effort；6.0+ 可能加密改写。

## OUT（本波未做）

FCPXML/EDL · F0b 部署 · Acc/Mega · 安全 Dly · 雨夜一镜 · 拷第三方草稿库
