# ToIV 本地视频 Comfy (toiv-comfy-video)

BeefTV 声明式 provider：统一视频请求 → ToIV → Workstation Comfy **:8197**。

- 凭据：ToIV 用户 JWT（Authorization: Bearer）。
- 轮询：`GET /api/jobs/lookup?prompt_id=`（亦支持 `job_id~prompt_id` 任务键）。
- 取消：`POST /api/jobs/{id}/cancel`。
- 路由（prepare → pathTemplate）：
  - **Wan** `local-wan` / 默认 → `POST /api/generate/txt2video`
  - **LongCat** `local-longcat` 或模型名含 `longcat`（或 `providerOptions.engine=longcat`）→ `POST /api/longcat/t2v`；有参考图 → `POST /api/longcat/i2v`
  - **VACE** `local-vace` 或模型名含 `vace`（或 `engine=vace`）→ `POST /api/wan/vace`（需 ≥1 张参考图；upload kind=`wan_vace`）
- 私网 baseUrl 需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 含 `127.0.0.1`。
- 延后：LongCat continue / Avatar / Wan Animate 动作迁移。
