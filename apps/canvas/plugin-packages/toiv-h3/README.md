# ToIV H3 视频 (toiv-h3)

BeefTV 声明式 provider 插件：把 BeefTV 统一视频请求转成 ToIV `POST /api/h3/t2v`，
v0.2 起任务键为 `<job_id>~<prompt_id>`：优先 `GET /api/jobs/lookup?job_id=` 轮询（ToIV main 08554934 起支持），当前部署返回 422 时由宿主 `poll.fallback` 回退到 `?prompt_id=`；后端重启后按持久化的任务键续跑，结果为 ToIV 根相对 URL `/api/images?...&sig=...`
（BeefTV 按 baseUrl 解析并在同源下载时附带 Bearer）。

- 凭据：ToIV 用户 JWT（`POST /api/auth/login` → `token`），作为 Authorization: Bearer。
- 状态：error→failed；canceled→canceled；done 且 post_status≠processing→succeeded；其余→processing。
- 取消：`POST /api/jobs/{job_id}/cancel`（尚未拿到 job_id 时用 prompt_id；ToIV 同时接受二者）。
- 宿主要求：需要 ToIV-canvas 后端的 `ManifestOperation.fallback` 与 poll/cancel 任务键保真补丁（见仓库 CHANGELOG-TOIV.md）。
- v0.4 路由（模型 `h3`；旧的 `h3-t2v` 行为相同）：
  - 无参考图 → `POST /api/h3/t2v`
  - 1 张，或指定了首帧 → `/api/h3/i2v {image, worker}`
  - 首帧 + 尾帧（或 2 张未指定角色）→ `/api/h3/fl2v {image, last_frame, worker}`
  - 全模态参考（`reference_to_video`），或 ≥3 张 → `/api/h3/r2v {images[≤9], worker}`（Ref2VA）
- 参考图通过宿主 `prepare` 步骤先 `POST /api/upload?kind=h3_i2v`（multipart `image`）；第二张起带 `worker=<第一次上传返回的 worker>`，保证同机转运。上传失败直接报错，不会提交 H3 作业。
- 暂不支持参考视频 / 参考音频（r2v 上游支持，后续版本再开）。
- 宿主要求：ToIV-canvas 后端的 `prepare` 补丁（`backend/internal/protocol/manifest_prepare.go`）。
- 部署：base URL 为私网 http 时需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1`。
