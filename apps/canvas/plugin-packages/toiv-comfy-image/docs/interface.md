# ToIV 本地生图 Comfy 接口

## 创建

`POST /api/generate/txt2img`（相对 ToIV API baseUrl，默认 `http://127.0.0.1:8090`）。

## 轮询

`GET /api/jobs/lookup`（`prompt_id` 或 `job_id` 二选一）。

## Worker

出图默认 Comfy **:8196**（由 ToIV WorkerPool + NAS 绑定模型可达性选机；禁试验口 :8195/:8205/:8261）。
