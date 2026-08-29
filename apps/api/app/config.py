"""应用配置 —— 通过环境变量 / .env 读取（前缀 TOIV_）。"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="TOIV_", extra="ignore"
    )

    # 逗号分隔的 ComfyUI worker 列表（P0 单实例，P2 起对应多 GPU 多进程）
    comfy_workers: str = "http://192.168.71.127:8189"
    # 默认出图底模(A 期收官):FLUX.2 dev(FLUX.2 家族画质天花板,33GB fp8mixed,已下 NAS +
    # 真机出图验证)。首次载模型 ~2.5min、更吃显存,但开箱即最强画质。Klein(快)/ Z-Image(极速)/
    # Qwen-Image / SD1.5 均保留作可显式选用的其它档。dev 编码器 = mistral_3_small_flux2_fp8(见 model_profiles)。
    default_ckpt: str = "flux2_dev_fp8mixed.safetensors"
    # PuLID-Flux 角色一致性首帧底模(次世代底模场景下短剧分镜角色首帧用)。
    # PuLID-Flux v0.9.1 仅适配 FLUX.1 dev/schnell,不适用 FLUX.2;故用 FLUX.1 fp8
    # 全量包(CheckpointLoaderSimple 单节点全量加载,worker :8189-8191 实测可见)。
    pulid_flux_ckpt: str = "flux1-dev-fp8.safetensors"
    # SFW 视频默认底模:LTX-2.3 22B distilled 1.1(短剧/通用视频生成默认;仅 nsfw=True 才切 10Eros)。
    # 注:旧默认 ltx-2.3-distilled.safetensors 是 fp8 版符号链接,2026-08-09 模型清理后失效,
    # 直接引用真机实存的 22B distilled 1.1(diffusion_models/,22B bf16,worker 实测可见)。
    default_video_ckpt: str = "ltx-2.3-22b-distilled-1.1.safetensors"
    # NSFW 专区视频默认模型(LTX2.3 All in one v4.0 工作流推荐)
    # 10Eros v1.4 fp8mixed_learned:NSFW 内容专用底模(LTX2.3-10Eros 仓库最新版,29GB)
    # 模型路径:diffusion_models/10eros_v14.safetensors(NAS)
    nsfw_default_video_ckpt: str = "10eros_v14.safetensors"
    # Gemma 3 12B IT 文本编码器:LTXVGemmaCLIPModelLoader 要求 HF 目录结构
    # (model.safetensors + tokenizer.json + config.json + preprocessor_config.json 等)。
    # 使用 gemma3_12b_it_bf16/(反量化 + HF 键名重映射);旧 gemma3_12b_it/ fp8_scaled
    # 权重会导致文本编码器随机初始化、提示词失效,已禁用(model.safetensors.disabled)。
    nsfw_default_gemma: str = "gemma3_12b_it_bf16/model.safetensors"
    nsfw_default_vae: str = "LTX23_video_vae_bf16.safetensors"
    # Forge(reForge SD WebUI)第二出图引擎(sdapi 同步出图);空 = 未部署,前端引擎切换隐藏 Forge
    # 默认空:Workstation 当前未部署 Forge,需要时在 .env 显式配置
    forge_url: str = ""
    # 配音 TTS 独立服务（IndexTTS2 / edge-tts 封装,自部署 @ Workstation GPU0,隔离 venv）
    tts_url: str = "http://192.168.71.127:9200"
    # 多语言 TTS 服务（日语/韩语/粤语等）。空 = 未部署，相关语言请求返回 503。
    tts_multilingual_url: str = ""
    # 译制参考音人声分离服务(workstation Demucs htdemucs,toiv-audio-sep.service :9220)。
    # 契约:POST {audio_sep_url}/separate multipart(file=音频) → vocals wav 二进制(audio/wav)。
    # 非空 = 参考音先分离干净人声再克隆音色;空 = 直接用原始抽取音。服务失败自动回退原始参考音。
    audio_sep_url: str = ""
    # 译制听写 Whisper(ASR)。whisper_url 非空 = 调外部 GPU 服务(契约:POST {whisper_url}/asr
    # multipart(file)→ {segments:[{start,end,text}]});空 = 用 api 容器内置 faster-whisper(CPU)。
    whisper_url: str = ""
    whisper_model: str = "base"  # tiny/base/small/medium(base 平衡速度/质量)
    whisper_compute: str = "int8"  # int8 最快;float16 适配 GPU;auto 自动
    # 听写设备:auto=自动探测(Apple Silicon 上 CPU int8 最快且稳定;CUDA 机自动 GPU)
    # 实际部署可显式设 cpu/cuda/metal;空=auto
    whisper_device: str = "auto"
    # NAS(绿联 DXP8800 Pro)—— 模型/生成内容集中存储。走 SFTP,凭据经环境变量不入仓库。
    #   TOIV_NAS_HOST / TOIV_NAS_PASSWORD 在部署 .env 里配;空 host = 未启用(下载走旧路径)。
    nas_host: str = ""  # 如 192.168.71.7(LAN)或 100.80.237.96(Tailscale)
    nas_port: int = 22
    nas_user: str = "dgmt-nas"
    nas_password: str = ""
    # SFTP 视角的 ComfyUI 模型根(chroot 后根=/NAS = shell 的 /volume1/NAS);worker 从此读模型
    nas_model_root: str = "/NAS/Windows/ComfyUI/ComfyUIModel/models"
    # cifs 挂载视角的 models 目录(/data/nas 挂 NAS 根)——大模型直接流式写这里,免 SFTP 慢+免临时
    nas_models_mount: str = "/data/nas/Windows/ComfyUI/ComfyUIModel/models"
    # 生成内容存储根(译制视频/配音/forge/cad)。默认 /data(容器本地卷);
    # 设 /data/nas/toiv(cifs 卷挂 NAS)则生成内容集中落 NAS。
    content_dir: str = "/data"
    # 音频产物根目录(人声分离等独立音频工具产物,AGENTS.md 第六节 outputs/audio)。
    # 生产 core 指向 NAS 挂载点 /mnt/toiv-nas/toiv/outputs/audio;空 = 用本地候选目录。
    # NAS 不可达/不可写时自动降级本地回退目录并记 warning,不 500
    # (解析与降级见 app/storage.audio_output_root,模式同 TOIV_DRAMA_VIDEO_DIR)。
    audio_dir: str = ""

    # 后端 API 自身基址(供内部 HTTP 自调下载 /api/... 产物使用)。
    # 开发 :3102, 生产真机 :8090;必须与 uvicorn/systemd 实际监听端口一致。
    api_base_url: str = "http://127.0.0.1:8090"

    # CORS 允许的前端来源（分号或逗号分隔）。默认仅生产域名，开发环境经 .env 追加 localhost。
    # 不能用 "*" —— allow_credentials=True 时 CORS 规范禁止通配符 origin，否则浏览器会拒绝带凭据的跨域请求。
    cors_origins: str = "https://toiv.dgmt.top,http://192.168.71.47:3100,http://192.168.71.47:3101,http://127.0.0.1:3100,http://localhost:3100,http://127.0.0.1:3101,http://localhost:3101"
    request_timeout: float = 30.0

    # 作业追踪(tracker)单作业轮询 /history 上限(秒):超时标记 error 终态回收,
    # 不再让作业永留 queued。默认 2h,覆盖 LongCat 65min 长视频作业;
    # reconcile 超龄回收阈值 = 本值 + 1800s 宽限(见 comfy/tracker.reconcile_pending)。
    job_track_timeout: float = 7200.0

    # Agent 主循环(Harness 化 M1,2026-08-19;参照 DeepSeek Harness 思想):
    # agent_max_rounds 单 Turn 最大模型请求轮数(每轮可含多个工具调用),默认 12;
    # agent_context_budget 非 system 消息总字符预算,超出经 agent/context.compress_history
    #   折叠中间历史(首任务锚点+最近上下文保留,tool 配对不变量保证协议合法),默认 24k 字符;
    # agent_skills_topk 每轮按需注入的 Skill 市场技能数(0=关闭注入),默认 3。
    agent_max_rounds: int = 12
    agent_context_budget: int = 24000
    agent_skills_topk: int = 3
    # 联网搜索工具开关(DuckDuckGo 免 key;false 时 web_search 返回未启用文本)
    web_search_enabled: bool = True
    # 联网搜索出站代理(国内直连 DDG 不可达时配,如 http://127.0.0.1:7897;空=直连)
    web_search_proxy: str = ""

    # Redis(限流/画布事件/worker 健康缓存共享状态)。生产 core 与 toiv-api 同机,
    # 仅监听 localhost 无密码。不可达时各调用方自动降级进程内存(见 services/redis_client.py)。
    redis_url: str = "redis://127.0.0.1:6379/0"

    # 鉴权 / 账号。开发期用 SQLite，生产切 Postgres：
    #   TOIV_DATABASE_URL=postgresql+psycopg://user:pass@host/db
    database_url: str = "sqlite:///./toiv.db"
    jwt_secret: str = "dev-insecure-change-me-in-production-please-set-TOIV_JWT_SECRET"
    jwt_expire_minutes: int = 10080  # 7 天

    # 可信反向代理网段(逗号分隔 CIDR 或单 IP):仅当请求的直连对端(request.client.host)
    # 属于该清单时,登录限流才采纳 X-Forwarded-For 首跳作为真实客户端 IP。
    # 默认空 = 不信任任何 XFF,直接用直连 IP——防攻击者伪造 XFF 换 IP 绕过登录限流。
    # 生产 core 前置 OpenResty/frp 反代,必须把反代出口 IP 配进来(如 127.0.0.1,::1
    # 或 LAN 反代 IP),否则限流主体退化为反代 IP(同反代后所有用户共享配额)。
    trusted_proxy_ips: str = ""

    # 启动时引导管理员账号(密码经环境变量/.env 提供，不入仓库)。
    # 二者皆非空时：不存在则创建该 admin；存在则提升为 admin。
    admin_email: str = ""
    admin_password: str = ""

    # 微信小程序登录(POST /api/auth/wechat)。
    # wechat_appid 为小程序 AppID;wechat_secret 为 AppSecret,仅服务端持有,
    # 经环境变量/.env 提供,不入仓库。空 + bypass 关 = 微信登录不可用(503)。
    wechat_appid: str = ""
    wechat_secret: str = ""
    # 开发过渡开关:True 时不调腾讯 code2session,直接把 code 映射为 deterministic
    # openid(格式 "dev-{code}")便于本地/真机联调;生产必须 False。
    wechat_dev_bypass: bool = False

    # AI 测试通道密钥(TOIV_TEST_KEY,走 .env 不入仓库)。非空时开启:
    #   POST /api/auth/test-login {key} 用密钥换 admin token;前端 /?testkey=<key> 一跳进 app,
    #   免登录表单,方便自动化/AI 测试。空 = 关闭(可随时清空停用)。
    test_key: str = ""

    # AI 智能体的 LLM 大脑(OpenAI 兼容端点)
    # 默认:spark02 vLLM qwen3.6-uncensored(Qwen3.8-27B-Uncensored FP8,:8000;原 workstation sglang 已停用)
    llm_base_url: str = "http://192.168.71.84:8000/v1"  # spark02 vLLM(2026-08-07 修正:原 workstation Nemotron 已停用)
    llm_api_key: str = "lm-studio"
    llm_model: str = "qwen3.6-uncensored"
    # 顶栏展示用真实模型名（llm_model 为 served-model-name 别名，展示不够直观）
    # 2026-08-23 spark02 已换 Qwen3.8-27B-Uncensored-FP8(别名 qwen3.6-uncensored 未变)
    llm_display_name: str = "Qwen3.8-27B-Uncensored (spark02 FP8)"
    # 备用 LLM 大脑(主模型重试失败后自动切换;EXO 单端点多模型场景下 base_url/api_key 留空即复用主)。
    # 典型:主=GLM-5.2-fp8(思考型,长 ctx),备=Kimi-K2.7-Code-4bit(代码型,主掉线时兜底)。
    llm_fallback_base_url: str = ""
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = ""
    # NSFW 模式专用 LLM(X-NSFW: 1 时启用);空 model = NSFW 模式复用主 LLM。
    # 生产:L4 与 L1 同模型(spark02 qwen3.6-uncensored;2026-08-08 llama-70b 退役后统一切换)。
    llm_nsfw_base_url: str = ""
    llm_nsfw_api_key: str = ""
    llm_nsfw_model: str = ""

    # —— AICG 四层模型流水线（2026-07-24 项目管家确认）——
    # L1 初稿 = llm_base_url/llm_model（上面已配，qwen3.6-uncensored @ spark02:8000）
    # L4 NSFW = llm_nsfw_base_url/llm_nsfw_model（生产同上 spark02,.env 覆盖）
    # L2 主力润色 / L3 终稿精修:2026-08-29 Studio01-04(EXO RDMA :52415)全线下线,
    # 两层收拢到 spark02 主模型(同 L1;qwen3.6-uncensored = Qwen3.8-27B-Uncensored FP8)。
    # 层间差异只剩超时/预算语义,模型同一——Studio 恢复上架后再分开指。
    llm_l2_base_url: str = "http://192.168.71.84:8000/v1"
    llm_l2_model: str = "qwen3.6-uncensored"
    llm_l2_timeout: float = 120.0
    llm_l3_base_url: str = "http://192.168.71.84:8000/v1"
    llm_l3_model: str = "qwen3.6-uncensored"
    llm_l3_timeout: float = 300.0

    # 向量 RAG 的 embedding 模型(同一 OpenAI 兼容端点;留空则复用 llm_base_url)
    # 生产:workstation 真机 Qwen3-Embedding-4B(:9302, GPU1, systemd qwen3-embedding.service)
    embed_base_url: str = ""
    embed_model: str = "Qwen3-Embedding-4B"

    # LoRA 训练 agent(部署在 GPU 机 .100，独立 HTTP 服务 :9100)。
    # API 通过 HTTP 调它(同 ComfyUI/TTS/LLM 的访问模式)，不走 SSH。
    # 空 = 未部署，训练相关端点返回 503。
    trainer_url: str = ""

    # i2L 风格 LoRA agent(DiffSynth ZImage-i2L-v2,workstation 常驻 :9101):
    # 1-8 张风格参考图 → 单次前向导出 Z-Image 族风格 LoRA(非训练作业)。
    # 空 = 未部署,端点 503;生产 http://192.168.71.127:9101。
    i2l_url: str = ""

    # 通用对口型 agent(LatentSync,workstation systemd toiv-lipsync :9103):
    # 视频 + 音频 → 口型同步成片(上传/submit/轮询/取结果四步契约,见 routes/video_lipsync.py)。
    # 空 = 未部署,端点 503;生产 http://192.168.71.127:9103。
    lipsync_url: str = ""

    # ComfyUI MCP 桥接(artokun/comfyui-mcp,workstation systemd toiv-comfy-mcp :9100):
    # 让助手通过 MCP 协议调用 ComfyUI 细粒度操作(工作流创建/节点管理/队列控制等)。
    # 空 = 未部署,MCP 工具不注册;生产 http://192.168.71.127:9100。
    mcp_url: str = ""
    mcp_token: str = ""

    # 可观测性 —— Sentry 错误追踪 DSN。空 = 不启用(本地开发默认关);
    # 配置真实 DSN 后,app 启动时初始化 sentry-sdk 自动上报未捕获异常 + 10% 性能采样。
    sentry_dsn: str = ""
    # 运行环境(传给 Sentry 的 environment 字段;development / production)。
    # 也便于后续按环境分支(如生产才采样)。
    environment: str = "development"
    # 是否暴露 API 文档(/docs /redoc /openapi.json)。默认关:生产暴露完整 schema
    # 等于公开攻击面地图(QA-FULL-2026-08-11 P2);本地开发在 .env 置 true 开启。
    expose_api_docs: bool = False
    # 应用日志级别(2026-08-12 统一日志配置,见 app/logging_config.py):
    # DEBUG 排障 / INFO 生产默认 / WARNING 降噪。
    log_level: str = "INFO"

    # —— 视频质量评估 VLM(video scorer)——
    # ⚠️ 默认值是历史遗留:workstation Nemotron-3-Nano-Omni-30B-A3R vLLM(:8000, GPU3)
    # 已于 2026-08-05 停用;生产必须由 .env 的 TOIV_VLM_SERVER_URL 指向当前可用 VLM
    # (OpenAI 兼容端点,支持视频/图像/音频输入)。
    # 启用后:视频作业完成时(done 之前)异步评估,低分则推 SSE quality_warning 事件。
    # 评估失败/超时/全 0 一律降级(degraded=True),不阻塞主流程、不推 warning。
    vlm_server_url: str = "http://192.168.71.127:8000"
    vlm_model_id: str = "qwen3.6-uncensored"
    # 默认关:灰度上线开关,VLM Server 不可达时立即关回退,零影响主流程。
    # .env.example / 部署 .env 显式置 true 启用(VLM 已就位并验证)。
    video_scorer_enabled: bool = False
    # 综合分(total)低于此阈值才推 quality_warning;0.65 ≈ 视频质量明显可改进的临界。
    video_scorer_threshold: float = 0.65
    # 评分调用超时(秒):32B VLM 视频评分实测 10-60s,长视频更久;30s 旧值会系统性降级。
    # VideoScorer 内部 httpx 与 jobs.py 外层 wait_for(+10s 兜底)同读此值。
    video_scorer_timeout: float = 120.0

    # —— 反推提示词(reverse prompt):上传图/视频/音频 → 反推出可复用提示词 ——
    # 生产 SFW 反推(图+全部视频)= studio04 mlx-vlm Qwen2.5-VL-72B-Instruct-4bit
    # (192.168.71.113:9303,2026-08-09 起,.env TOIV_REVERSE_VLM_BASE_URL 覆盖);
    # 默认值 :9303 为 workstation GPU3 toiv-vlm 停而不删的热回退实例。
    # 图像走 image_url、视频走 video_url(base64 data URL 或 NAS 中转本地路径)。
    reverse_vlm_base_url: str = "http://192.168.71.127:9303/v1"
    # NSFW 图像反推专线:JoyCaption Beta One bf16(toiv-joycaption.service, GPU3, :9304)。
    # 仅 X-NSFW 上下文的图像反推路由到这里(它是纯图像模型,视频仍走 Qwen3-VL);
    # 官方 bf16 ~17GB,无审查设计,R18 不拒答。空串 = 未部署,NSFW 图像也走 Qwen3-VL。
    joycaption_base_url: str = "http://192.168.71.127:9304/v1"
    # 视频反推路径模式:空串 = base64 内联(GPU3 vLLM);非空 = studio04 MLX 模式
    # (其 video_url 只认本地路径)→ 视频先 SFTP 中转 NAS reverse_video_nas_subdir,
    # 再把「Mac 挂载路径(本前缀 + subdir + 文件名)」传给 MLX。清理在请求结束后自动做。
    reverse_video_mac_prefix: str = ""
    reverse_video_nas_subdir: str = "toiv/reverse_tmp"
    # 音频反推走 SenseVoice 服务(toiv-sensevoice.service, GPU2, :9211):
    # 契约 POST {sensevoice_url}/analyze multipart(file=音频) → {text, emotion, events, language}。
    sensevoice_url: str = "http://192.168.71.127:9211"
    # 音乐反推(二期,2026-08-08):Qwen3-Omni-30B-A3B-Captioner bf16 @ spark01 vLLM :8000。
    # 链路:音频 → demucs 伴奏(/separate_accompaniment)→ Omni 音频描述,与人声
    # (SenseVoice)结果合并成完整音频提示词。空串 = 未部署,音频反推只出人声部分。
    omni_captioner_base_url: str = ""
    # 反推上传上限(MB):视频 base64 内联体积 ~1.33 倍,过大易超时。
    reverse_max_image_mb: int = 20
    reverse_max_video_mb: int = 50
    reverse_max_audio_mb: int = 30

    # —— GPU 生成链路每日冒烟(txt2img 小图 + LTX 短视频)——
    # 每日定点自动执行,报告落 {content_dir}/smoke/;失败 POST 报警到 webhook(空=只记日志)。
    gpu_smoke_enabled: bool = True
    gpu_smoke_hour: int = 4  # 每日定点(容器本地时区,0-23)
    smoke_alert_webhook: str = ""

    # 短剧工作室剧本拆解默认 LLM 层(L1/L2/L3/L4)。
    # L2/L3 当前依赖 Mac Studio EXO,模型实例未就绪时回退慢且易 502;
    # 默认 L1(workstation vLLM)保证功能可用,EXO 恢复后可改回 L3。
    drama_storyboard_layer: str = "L1"

    # 短剧工作室润色(refine)默认 LLM 层(L1/L2/L3/L4),与精修(polish)分开配置。
    # 默认 L2(Kimi-K3 @ EXO);EXO 实例未就绪时 chat_layered 自动降级 L1,功能不受影响。
    drama_refine_layer: str = "L2"

    # 短剧工作室精修(polish,含批量)默认 LLM 层。
    # 默认保持 L1 不变以免行为突变;EXO 恢复后可切 L3(GLM-5.2-DQ4plus-q8)。
    drama_polish_layer: str = "L1"

    # 宫格分镜「阶段B 纪律」(P2,治 LLM 纯想象导致的动漫偏置):
    # 宫格图生成后先经 VLM(reverse_vlm_base_url)逐格观察实际画面,再由 LLM 据实
    # 改写各镜 prompt(人物/服装/姿态以实际成图为准)。VLM/二次 LLM 任一失败自动
    # 回落 LLM 原始 prompt,分镜 detected_colors 标记 grounding_status=fallback。
    grid_grounding_enabled: bool = True

    # —— 短剧 from-image 自动管线(autorun)并发度 ——
    # 视频阶段:ComfyUI WorkerPool 可按队列把并发任务摊到多个 worker,默认 3。
    drama_autorun_video_concurrency: int = 3
    # 配音阶段:IndexTTS2 单卡,并发太高只会排队,默认 2。
    drama_autorun_voice_concurrency: int = 2

    # —— 画布(ComfyUI)同源反向代理(2026-08-30 画布公网不可用根治) ——
    # /api/canvas/proxy 的反代目标:与前端 CanvasView 直连回退地址同机(LAN :8188)。
    # SSRF 防线:目标地址只允许取本配置,路由不接受任何请求传入的地址。
    canvas_comfy_url: str = "http://192.168.71.127:8188"

    # —— OpenTalking 数字人引擎(unified 模式, 单进程) ——
    # 本地 dev: http://127.0.0.1:4403 (兄弟目录运行的 opentalking-unified 进程)
    # Docker prod: http://opentalking:8000 (容器服务名, HTTP 不暴露到 host)
    # 空 = 未启用, /api/opentalking/* 全部 503, 前端"数字人"页降级提示。
    opentalking_base_url: str = "http://127.0.0.1:4403"
    opentalking_enabled: bool = True

    # —— SoulX LiveAct 全身数字人生成引擎(workstation 真机 :9400) ——
    # 输入角色参考图 + 配音音频,生成时长 = 音频时长,分镜需先完成配音。
    # 空 = 未部署,选择该模型提交时返回固定错误。
    liveact_base_url: str = ""

    # —— SCoPE 相机运镜视频引擎(TencentARC,Wan2.2-A14B 双专家,workstation :9401) ——
    # 首帧图 + prompt + 轨迹预设 → 81 帧运镜视频;服务常驻 GPU3(vram_limit offload),
    # 串行队列,单次 40 步实测 ~11min。空 = 未部署,/api/scope/* 503。
    scope_base_url: str = "http://192.168.71.127:9401"
    # 单次生成超时(秒):含服务侧排队;40 步 ~11min,默认 3600 给足余量。
    scope_timeout_sec: float = 3600.0

    # —— 3D 调整服务(trimesh+pyrender EGL,workstation :9402,toiv-3dops.service) ——
    # GLB 材质改写(PBR 参数)/材质预设渲染(快照 PNG / 360° turntable MP4)。
    # 空 = 未部署,/api/3d/ops 503。
    threed_ops_url: str = "http://192.168.71.127:9402"
    # 单请求超时(秒):turntable 36 帧 1080p 实测秒级,默认 300 给足大网格余量。
    threed_ops_timeout_sec: float = 300.0

    # —— Hunyuan3D 2.1 纹理服务(hy3dpaint 管线,workstation :9404,toiv-hy3dtex.service) ——
    # 输入白模 GLB(+可选参考图/风格文本),多视图扩散 + 烘焙产出带 PBR 贴图的新 GLB。
    # 空 = 未部署,/api/3d/texture 503。
    hy3d_tex_url: str = "http://192.168.71.127:9404"
    # 单请求超时(秒):纹理生成是分钟级(多视图扩散 + 4K 烘焙),默认 900。
    hy3d_tex_timeout_sec: float = 900.0

    # —— MiniMax H3 视频生成引擎(专用 ComfyUI ≥ 0.30 实例,workstation :8195) ——
    # 独立于 ComfyUI-LB 集群/WorkerPool(生产 ComfyUI 0.27/0.28 无 H3 节点);
    # 实例由 systemd 托管,权重经 extra_model_paths 挂 NAS h3/。
    h3_enabled: bool = True
    h3_base_url: str = "http://192.168.71.127:8195"
    # H3 多实例(2026-08-25):逗号分隔的实例基址,提交时 least-loaded 调度(队列最短者优先,
    # 全不可达回退首实例由 ensure_h3_ready 报 503)。空 = 单实例(h3_base_url)零行为变化。
    # 注意:每实例常驻 RAM ~30G(匿名内存,不可回收)+ 显存 30-33G,扩实例前先核
    # workstation free -h 与 nvidia-smi(H-3/H-2 纪律)。
    h3_base_urls: str = ""
    # H3 int8 档增量峰值 ~30-33GiB(评测实测);提交前要求实例卡空闲显存 ≥ 此阈值(GiB)。
    # 不足时先尝试驱逐 h3_co_workers(同卡 pool worker,空闲队列才动)的模型缓存,
    # 仍不足 → 503 错峰提示,不让 ComfyUI 以 "VRAM grow failed" 裸崩(2026-08-04 实发)。
    h3_min_free_vram_gb: float = 36.0
    # 宿主机 RAM 预检阈值(GiB):2026-08-21 多引擎并跑耗尽 workstation 183G、
    # OOM killer 杀 H3(14 作业 error)的防线。同一宿主机所有 ComfyUI 实例
    # /system_stats 的 system.ram_free 是整机水位;不足时先驱逐自身模型缓存,
    # 仍不足 → 503(见 services/resource_budget.ensure_host_ram)。
    h3_min_free_ram_gb: float = 25.0
    # 与 H3 实例同卡的 ComfyUI 实例(逗号分隔,用于显存不足时的协调驱逐);空串=禁用自动驱逐。
    # 2026-08-25 换卡后 H3 在 GPU2 的同卡实例仅 M6 超分 :8262(LongCat :8197 已迁 GPU0,
    # 跨卡驱逐无意义);空闲队列才驱逐,在跑作业绝不动。
    h3_co_workers: str = "http://192.168.71.127:8262"
    # H3 NSFW 场景默认 UNET:10Eros-Max H3 嫁接版 TURBO(NAS toiv/comfyui-models/h3/
    # diffusion_models/,经 extra_model_paths 对 H3 实例可见;2026-08-23 真机实测 R18+音画
    # 直出完好)。仅 nsfw=True(X-NSFW 专区)提交时替换模板节点 "6" 的 unet_name;
    # SFW 保持模板 minimax_h3_fl2va_pruned_int8_convrot 不变。
    h3_nsfw_unet: str = "10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors"

    # —— LongCat-Video 长视频引擎(专用 ComfyUI 实例,workstation GPU0 :8197) ——
    # 独立于 WorkerPool(WanVideo 系节点仅该实例装有);systemd comfyui-longcat.service 托管,
    # 2026-08-25 自 GPU2 迁 GPU0 并加 --cache-lru 3(作业完自动驱逐,空闲不占显存)。
    longcat_enabled: bool = True
    longcat_base_url: str = "http://192.168.71.127:8197"
    # LongCat 与 ComfyUI 池/JoyCaption 共 GPU0、同宿主机 RAM:提交前显存 + RAM 双预检
    # (services/resource_budget;阈值语义同 h3_min_free_vram/ram_gb)。
    # 480p49f 实测峰值 ~21GB,显存阈值取 26 与 Wan 对齐。
    longcat_min_free_vram_gb: float = 26.0
    longcat_min_free_ram_gb: float = 15.0

    # —— Qwen-Image-Edit-2509 语义图像编辑引擎(专用 ComfyUI 实例,pc02 RTX 5090 :8194) ——
    # 独立于 ComfyUI-LB/WorkerPool(与同机池实例 :8193 隔离);TextEncodeQwenImageEdit
    # 节点仅该实例装有,权重经 NAS 共享(清单见 workflows/qwen_edit.py)。
    qwen_edit_base_url: str = "http://192.168.71.114:8194"

    # —— R3.2 Agent Team LangGraph 编排(2026-08-14) ——
    # checkpointer 选型:True 且 database_url 为 postgresql 时用 PostgresSaver(复用 core
    # PG18,跨进程断点续跑);SQLite(测试/开发)或 PG 不可达时自动回退 MemorySaver
    # (进程内存,重启即丢,由幂等重放兜底,见 services/agent_team_graph.py)。
    agent_pg_checkpointer: bool = True
    # Director Gate LLM 分级超时(秒);超时/解析失败/LLM 不可达一律回退启发式规则,
    # 不阻塞 run 创建(见 routes/agent_team.py classify_goal_llm)。
    agent_classify_llm_timeout: float = 8.0

    # —— H3 Harness profile 组合(2026-08-14) ——
    # 插件裁剪:full=全部内建插件;llm+引擎+质量门;minimal=llm+基础引擎,无质量门;
    # headless=llm+引擎,无质量门无人格。见 harness/profile.py PROFILES。
    harness_profile: str = "full"

    # —— 视频超分 fleet(M6,workstation GPU1/2/3 超分专用 ComfyUI 实例) ——
    # 仅跑 4x-UltraSharp 帧超分(--cache-lru 2),不入 ComfyUI-LB/WorkerPool;
    # 经标准 HTTP API 访问,产物由 api 取回字节落 core 本地(不经 worker 输出目录)。
    upscale_workers: str = "http://192.168.71.127:8261,http://192.168.71.127:8262,http://192.168.71.127:8263"

    # —— Wan2.2-Animate / Wan2.1-VACE(GPU0 :8197,与 LongCat 同实例) ——
    # Animate fp8 运行时量化峰值 ~20-24GiB;提交前要求实例卡(GPU0)空闲显存 ≥ 此阈值(GiB)。
    # 不足时先驱逐 :8197 自身模型缓存(队列空闲才动),仍不足 → 503 错峰提示。
    # 绝不驱逐 H3(硬规则:H3 必须可用);H3 突发 48GB 时本预检天然拦截并发。
    wan_min_free_vram_gb: float = 26.0
    # 宿主机 RAM 预检阈值(GiB,语义同 h3_min_free_ram_gb;与 H3/LongCat 同宿主机)。
    wan_min_free_ram_gb: float = 15.0

    # —— Wan-Animate-2 动作迁移/视频换人(专用 ComfyUI 实例,workstation GPU3 :8199) ——
    # ComfyUI master 原生 WanAnimate2ToVideo 节点(与 v1 wrapper 路线 :8197 完全独立);
    # systemd comfyui-animate2.service 托管,权重经 extra_model_paths 挂 NAS。
    # int8 蒸馏 DiT ~16.6G(动态加载实测 staged ~15.9G)+ umt5 fp8 + CLIP-ViT-H,
    # GPU3 与 FlashTalk 共卡(满载后空闲 ~33.7G),ComfyUI 原生自动 offload;10 步无 CFG。
    wan_animate2_enabled: bool = True
    wan_animate2_base_url: str = "http://192.168.71.127:8199"
    # 提交前要求实例卡(GPU3)空闲显存 ≥ 此阈值(GiB);不足先驱逐 :8199 自身模型缓存
    # (队列空闲才动),仍不足 → 503/hold 错峰。绝不驱逐 FlashTalk。
    # 阈值 30:GPU3 驱逐自身缓存后实测空闲 ~33.7G(2026-08-24),34 会永远差 0.3G 卡死。
    wan_animate2_min_free_vram_gb: float = 30.0
    # 宿主机 RAM 预检阈值(GiB,语义同 h3_min_free_ram_gb;offload 权重驻留 RAM)。
    wan_animate2_min_free_ram_gb: float = 25.0

    # —— LTX-2.5 Multishot 一键多镜头(2026-08-28 重新引入,与退役 :8198 旧链无关) ——
    # 落点 pc01(RTX 5090 32G,ComfyUI 0.33.0 原生 LTX-2.5 节点,NVFP4 FP4 加速):
    # 复用 LB 池 worker :8188——同进程显存统一调度,22B 加载时自动驱逐池模型缓存,
    # 避免双实例显存争抢;权重经 extra_model_paths toiv: 段挂 NAS(平铺)。
    ltx25_worker_url: str = "http://192.168.71.116:8188"

    # —— 资源预算二期:hold 排队(预检不足不直接 503,作业 held 入库等资源释放) ——
    # 预检(RAM/VRAM)仍不足时作业置 held + HeldJob 票(graph/原因/需求快照入库),
    # 调度循环周期性复查,资源够按提交时间 FIFO 自动放行(见 services/hold_queue)。
    hold_queue_enabled: bool = True
    # 调度复查间隔(秒)。保守 30s:预检本身可能触发缓存驱逐+5s 落定,不宜过密。
    hold_check_interval_sec: float = 30.0
    # 单轮最多放行数量(防雪崩:资源刚回升时一次性放行过多会立刻又打爆 GPU2)。
    hold_release_max_per_round: int = 2
    # hold 超时上限(秒):超过仍未放行标 error(hold_reason 写超时说明),不无限等。
    hold_timeout_sec: float = 3600.0

    # —— B 评测管线(best-of-n + 自动评分,2026-08-23) ——
    # eval_scorer: 默认评分器。auto=配了 eval_vlm_base_url 走 VLM、否则启发式;
    # heuristic=零外部依赖基线(分辨率/时长/完整性/音轨,经 ffprobe 探测,探测不到
    # 自动跳过对应维度);vlm=强制 VLM(不可达时逐变体降级启发式,不炸链路)。
    eval_scorer: str = "auto"
    # VLM/LLM 评分端点(OpenAI 兼容;生产可指 studio04 mlx-vlm :9303 或 spark02 :8000)。
    # 空 = 未配置,auto 档直接用启发式。
    eval_vlm_base_url: str = ""
    eval_vlm_model: str = "qwen3.6-uncensored"
    eval_vlm_timeout: float = 60.0
    # 批次 watcher 轮询 Job 终态间隔(秒)。
    eval_watch_poll_sec: float = 5.0

    # —— E 数据飞轮:评测评分 → 偏好数据集导出(2026-08-23) ——
    # pref_export_auto: 批次 finalize 完成后自动尝试导出该批次(不合格批次落 0 对
    # 幂等票记原因,不重复处理);关掉则只靠手动 POST /api/eval/dataset/export。
    pref_export_auto: bool = True
    # chosen/rejected 最低分差(严格大于才入集):分差太小 = 变体无区分度,训练噪声。
    pref_pair_min_gap: float = 0.15
    # JSONL 输出目录(core 本地);按导出日期滚动 + SFW/NSFW 分文件
    # (pref_sfw_YYYY-MM-DD.jsonl / pref_nsfw_YYYY-MM-DD.jsonl)。
    pref_dataset_dir: str = "data/preference_dataset"

    @property
    def embed_url(self) -> str:
        return (self.embed_base_url or self.llm_base_url).rstrip("/")

    @property
    def nas_enabled(self) -> bool:
        """配了 host + password 才算启用 NAS 存储。"""
        return bool(self.nas_host.strip() and self.nas_password)

    @property
    def worker_urls(self) -> list[str]:
        # 兼容逗号和空格两种分隔(.env 历史上两种都出现过;逗号优先,空格兜底)
        raw = self.comfy_workers.replace(" ", ",").replace(",,", ",")
        return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]

    @property
    def forge_base(self) -> str:
        """Forge sdapi 基址(已去尾斜杠);空串表示未部署。"""
        return self.forge_url.strip().rstrip("/")

    @property
    def liveact_base(self) -> str:
        """LiveAct worker 基址(已去尾斜杠);空串表示未部署。"""
        return self.liveact_base_url.strip().rstrip("/")

    @property
    def h3_base(self) -> str:
        """H3 专用实例基址(已去尾斜杠)。"""
        return self.h3_base_url.strip().rstrip("/")

    @property
    def longcat_base(self) -> str:
        """LongCat 专用实例基址(已去尾斜杠)。"""
        return self.longcat_base_url.strip().rstrip("/")

    @property
    def qwen_edit_base(self) -> str:
        """Qwen-Image-Edit 专用实例基址(已去尾斜杠)。"""
        return self.qwen_edit_base_url.strip().rstrip("/")

    @property
    def wan_animate2_base(self) -> str:
        """Wan-Animate-2 专用实例基址(已去尾斜杠)。"""
        return self.wan_animate2_base_url.strip().rstrip("/")

    @property
    def ltx25_worker(self) -> str:
        """LTX-2.5 Multishot 默认 worker 基址(已去尾斜杠)。"""
        return self.ltx25_worker_url.strip().rstrip("/")

    @property
    def h3_co_worker_urls(self) -> list[str]:
        """与 H3 同卡的 pool worker 列表(逗号分隔;空串 → 空列表,禁用自动驱逐)。"""
        return [u.strip().rstrip("/") for u in self.h3_co_workers.split(",") if u.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        # 兼容分号/逗号两种分隔(.env 用分号更直观，避免与 URL 内可能出现的逗号冲突)
        return [o.strip() for o in self.cors_origins.replace(";", ",").split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
