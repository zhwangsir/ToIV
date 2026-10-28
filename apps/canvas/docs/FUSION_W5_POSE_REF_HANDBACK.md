# 融合 W5 · 姿势参考 Handback（工具台 + 创作选图 + library poses）

**日期**：2026-10-28（Asia/Shanghai）  
**执行**：前端开发（跨端 FE）  
**基线 tip**：`b63cebb9`（W4 已入）  
**分支**：`work/p0-fusion-20261016`  
**范围**：只 FE；**禁 commit / push / deploy**（本 handback 等 TL 过审）  
**未宣称**：后端 `apps/api/app/routes/pose_gallery.py` / `main.py` 挂载由后端另派；本 handback 不拥有 BE 改动。

## 目标

姿势参考 = 工具台意图 + 创作选图 + library poses 轨真数据。  
**不是**侧栏第六项、**不是**整站 `index.html` 移植。

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/lib/pose-catalog/index.ts` | **新** catalog 加载器：体系×分类×姿势组×角度；`filterPoseGroups` / URL 拼装 |
| `apps/canvas/web/src/lib/pose-catalog/pose-zh.json` | **新** 索引（1439 条）；自 Windows `ai-pose-gallery-zh/data` 拷入 |
| `apps/canvas/web/src/lib/pose-catalog/meta-zh.json` | **新** 四体系列表 |
| `apps/canvas/web/src/lib/pose-catalog/README.md` | **新** 说明：勿提交 thumbs/img；路径避开 `gitignore data/` |
| `apps/canvas/web/src/components/pose/pose-gallery-surface.tsx` + `.css` | **新** 密台表面（browse/pick） |
| `apps/canvas/web/src/components/pose/pose-browser.tsx` | **新** PoseBrowser（只读浏览 + 大图） |
| `apps/canvas/web/src/components/pose/pose-picker.tsx` | **新** PosePicker（AppModal + pick） |
| `apps/canvas/web/src/redline.ts` | `POSE_ADULT_ONLY_SYSTEMS` / `isPoseSystemAdultOnly` / `isPoseSystemVisible`（单闸） |
| `apps/canvas/web/src/components/toiv/tools-intent-grid.tsx` | 图像组挂「姿势参考」→ PoseBrowser 弹层 |
| `apps/canvas/web/src/pages/library/media-library-page.tsx` | poses 轨：`PosesComingSoonTrack` → `PosesTrack` + PoseBrowser（单壳不变） |
| `apps/canvas/web/src/pages/create/creation-assets.ts` | `creationAttachmentFromPose` → `/api/pose-gallery/img|thumbs` URL |
| `apps/canvas/web/src/pages/create/creation-workspace.tsx` | 「从姿势库选」按钮 + 空态入口 |
| `apps/canvas/web/src/pages/create/index.tsx` | PosePicker 挂载与回填参考槽 |
| `apps/canvas/web/test/pose-catalog-w5.test.ts` | **新** catalog / redline / 三挂载冒烟 |
| `apps/canvas/web/test/toiv-library-assets-unify.test.ts` | poses 轨断言改盯 PoseBrowser |

**未改（刻意）**：SoftGlow / 首页意图墙 / DesktopShell 默认 / 新一级导航 / BE pose-gallery 路由实现（另派）。

## JSON 落点与字段映射

- **落点**：`apps/canvas/web/src/lib/pose-catalog/`（**非** `src/data/`——会被 `apps/canvas/.gitignore` 的 `data/` 忽略）
- **拷贝来源**：Windows `C:\Users\winery\Desktop\ai-pose-gallery-zh\data\{pose-zh,meta-zh}.json`
- **大小**：`pose-zh.json` ≈ 555 KB（1439 条）；`meta-zh.json` 133 B
- **字段**：`id` / `体系` / `姿势编号` / `分类` / `姿势名称` / `角度` / `缩略图` / `原图` / `检索`
- **组键**：`体系::姿势编号`；角度序：正面→斜侧→侧面→俯视→仰视
- **严禁**：thumbs/img（~637MB）进仓

## URL 常量用法

- 常量（W4 已留）：`POSE_GALLERY_THUMB_PATH` = `/api/pose-gallery/thumbs`；`POSE_GALLERY_IMG_PATH` = `/api/pose-gallery/img`
- 拼装：`poseThumbUrl` / `poseImgUrl` 取 basename（剥 `thumbs/` / `img/` 前缀）→ `{PATH}/{file}`
- **禁** `/static`

## 三挂载点

1. `/toiv/market` · `ToolsIntentGrid` 图像组 `data-intent="pose-ref"` → AppModal + **PoseBrowser**
2. `/create` · 参考槽「姿势库」/ 空态「姿势库」→ **PosePicker** → `creationAttachmentFromPose` 回填参考图 URL
3. `/library?source=poses` · `MediaLibraryPage` 单壳内 **PosesTrack** → **PoseBrowser**（可开大图）

## Redline 闸

- 仅前端 `redline.ts`：`POSE_ADULT_ONLY_SYSTEMS = ["全身单人・性感系", "双人缠绵"]`
- `isPoseSystemVisible(system, adultOn=isR18Mode())`：非成人体系始终可见；成人体系需成人态
- `isR18Mode()` 已含未成年硬关 → 未成年看不到成人体系
- 标准系 / 上半身：普通态可看
- UI 经 `filterPoseGroups({ adultOn })` / `visiblePoseSystems` 消费；**无**旁路闸、**未**改后端语义

## 测结果

```
bun test test/pose-catalog-w5.test.ts test/toiv-library-assets-unify.test.ts
→ 16 pass / 0 fail
```

覆盖：catalog 加载与路径、URL 禁 static、adult 过滤、system/category/query、redline 体系闸、三挂载源码冒烟、W4 单壳回归。

## 已知缺口（非本波 FE）

- 后端 FileResponse `/api/pose-gallery/thumbs|img`：另派（工作区可见 `pose_gallery.py` 草稿，**非本 FE 交付**）
- 运维：W5 tip 过审后侧路 rsync thumbs→core、img→NAS；此前缩略图/大图 404 可接受（UI 有「缩略图待上线」占位）
- 创作提交时参考图若走上传链路，需后端能拉取 `/api/pose-gallery/img/...`（或后续改为落地资源）；本波对齐「URL/文件语义回填参考槽」

## 未做项

- 未 commit / push / deploy
- 未夹 SoftGlow / 首页墙 / 新侧栏项 / 整站 pose index.html
- 未把大图目录进仓
- 未改 DesktopShell 默认
- 未拥有 / 未宣称 BE 路由与运维 rsync

## 过审抽查建议

1. `/toiv/market` → 能力入口「姿势参考」弹层；普通态无「全身单人・性感系」「双人缠绵」页签
2. `/library?source=poses` → 真网格（非「即将接入」）；单壳四轨仍在
3. `/create` →「姿势库」选用后参考轨出现 `pose:…` 条目；URL 形如 `/api/pose-gallery/img/…`
4. `git check-ignore -v apps/canvas/web/src/lib/pose-catalog/pose-zh.json` → 无输出（可进仓）
