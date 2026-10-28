# pose-catalog

仓内只留 JSON 索引（`pose-zh.json` / `meta-zh.json`）。

**勿**把 `thumbs/` / `img/`（约 637MB）提交进 git。运行时 URL：

- `/api/pose-gallery/thumbs/{file}`（`POSE_GALLERY_THUMB_PATH`）
- `/api/pose-gallery/img/{file}`（`POSE_GALLERY_IMG_PATH`）

源资产在 Windows `ai-pose-gallery-zh`；运维 rsync thumbs→core、img→NAS。

路径选在 `lib/pose-catalog/`（非 `**/data/`），避免被 `apps/canvas/.gitignore` 的 `data/` 规则忽略。
