# ToIV H3 视频 (toiv-h3)

BeefTV 声明式 provider 插件：把 BeefTV 统一视频请求转成 ToIV `POST /api/h3/t2v`，
v0.2 起任务键为 `<job_id>~<prompt_id>`：优先 `GET /api/jobs/lookup?job_id=` 轮询（ToIV main 08554934 起支持），当前部署返回 422 时由宿主 `poll.fallback` 回退到 `?prompt_id=`；后端重启后按持久化的任务键续跑，结果为 ToIV 根相对 URL `/api/images?...&sig=...`
（BeefTV 按 baseUrl 解析并在同源下载时附带 Bearer）。

- 凭据：ToIV 用户 JWT（`POST /api/auth/login` → `token`），作为 Authorization: Bearer。
- 状态：error→failed；canceled→canceled；done 且 post_status≠processing→succeeded；其余→processing。
- 取消：`POST /api/jobs/{job_id}/cancel`（尚未拿到 job_id 时用 prompt_id；ToIV 同时接受二者）。
- 宿主要求：需要 ToIV-canvas 后端的 `ManifestOperation.fallback` 与 poll/cancel 任务键保真补丁（见仓库 CHANGELOG-TOIV.md）。
- 限制：v0.1 仅 t2v；i2v/fl2v/r2v 需要先 `/api/upload` 拿上传句柄（image+worker），声明式插件只有单次 create，无法两步。
- 部署：base URL 为私网 http 时需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS=127.0.0.1`。
