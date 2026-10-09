# ToIV 本地视频 Comfy (toiv-comfy-video)

BeefTV 声明式 provider：统一视频请求 → ToIV `/api/generate/txt2video` → Workstation Comfy **:8197**。

- 凭据：ToIV 用户 JWT（Authorization: Bearer）。
- 轮询：`GET /api/jobs/lookup?prompt_id=`（亦支持 `job_id~prompt_id` 任务键）。
- 取消：`POST /api/jobs/{id}/cancel`。
- 本版：Wan 文生视频；LongCat/VACE 路由后续刀。
- 私网 baseUrl 需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 含 `127.0.0.1`。
