# ToIV 本地视频 Comfy (toiv-comfy-video)

BeefTV 声明式 provider：统一视频请求 → ToIV → Workstation Comfy（Wan/LongCat/VACE/Continue/Avatar **:8197**；Wan Animate2 **:8199**）。

- 凭据：ToIV 用户 JWT（Authorization: Bearer）。
- 轮询：`GET /api/jobs/lookup?prompt_id=`（亦支持 `job_id~prompt_id` 任务键）。
- 取消：`POST /api/jobs/{id}/cancel`。
- 路由（prepare → pathTemplate）：
  - **Wan** `local-wan` / 默认 → `POST /api/generate/txt2video`（:8197）
  - **LongCat** `local-longcat` 或模型名含 `longcat`（或 `providerOptions.engine=longcat`）→ `POST /api/longcat/t2v`；有参考图 → `POST /api/longcat/i2v`（:8197）
  - **VACE** `local-vace` 或模型名含 `vace`（或 `engine=vace`）→ `POST /api/wan/vace`（需 ≥1 张参考图；upload kind=`wan_vace`；:8197）
  - **Wan Animate** `local-wan-animate` 或模型名含 `animate`（或 `engine=animate|animate2`）→ `POST /api/wan/animate2`（参考图+驱动视频；upload kind=`wan_animate2`；专用实例 **:8199**）
  - **LongCat Continue** `local-longcat-continue`（或 `engine=continue`）→ `POST /api/longcat/continue`（源视频=`/api/images?` 产物 URL，不经 upload；**:8197**）
  - **LongCat Avatar** `local-longcat-avatar`（或 `engine=avatar` / 名含 avatar）→ `POST /api/avatar/talk`（人像+驱动音频；upload kind=`avatar`；**:8197**）
- 私网 baseUrl 需 `CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS` 含 `127.0.0.1`。
- 延后：Wan Animate v1 `/api/wan/animate`（:8197）。
