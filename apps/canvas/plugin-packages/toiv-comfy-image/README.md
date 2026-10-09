# ToIV 本地生图 Comfy (toiv-comfy-image)

BeefTV 声明式 provider：统一生图请求 → ToIV `/api/generate/txt2img` → Workstation Comfy **:8196**。

- 凭据：ToIV 用户 JWT（Authorization: Bearer）。
- 轮询：`GET /api/jobs/lookup?prompt_id=`（亦支持 `job_id~prompt_id` 任务键）。
- 取消：`POST /api/jobs/{id}/cancel`。
- 本版：纯 txt2img（参考图暂忽略）。
- 私网 baseUrl 需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 含 `127.0.0.1`。
