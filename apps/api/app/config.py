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
    # SFW 视频默认底模:LTX-2.3 distilled(短剧/通用视频生成默认;仅 nsfw=True 才切 10Eros)
    default_video_ckpt: str = "ltx-2.3-distilled.safetensors"
    # NSFW 专区视频默认模型(LTX2.3 All in one v4.0 工作流推荐)
    # 10Eros v1.4 fp8mixed_learned:NSFW 内容专用底模(LTX2.3-10Eros 仓库最新版,29GB)
    # LTX-2.3 distilled:SFW 视频生成(走 ltx-2.3-distilled 符号链接)
    # 模型路径:diffusion_models/10eros_v14.safetensors(NAS)+ 符号链接对齐
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

    # Redis(限流/画布事件/worker 健康缓存共享状态)。生产 core 与 toiv-api 同机,
    # 仅监听 localhost 无密码。不可达时各调用方自动降级进程内存(见 services/redis_client.py)。
    redis_url: str = "redis://127.0.0.1:6379/0"

    # 鉴权 / 账号。开发期用 SQLite，生产切 Postgres：
    #   TOIV_DATABASE_URL=postgresql+psycopg://user:pass@host/db
    database_url: str = "sqlite:///./toiv.db"
    jwt_secret: str = "dev-insecure-change-me-in-production-please-set-TOIV_JWT_SECRET"
    jwt_expire_minutes: int = 10080  # 7 天

    # 启动时引导管理员账号(密码经环境变量/.env 提供，不入仓库)。
    # 二者皆非空时：不存在则创建该 admin；存在则提升为 admin。
    admin_email: str = ""
    admin_password: str = ""

    # AI 测试通道密钥(TOIV_TEST_KEY,走 .env 不入仓库)。非空时开启:
    #   POST /api/auth/test-login {key} 用密钥换 admin token;前端 /?testkey=<key> 一跳进 app,
    #   免登录表单,方便自动化/AI 测试。空 = 关闭(可随时清空停用)。
    test_key: str = ""

    # AI 智能体的 LLM 大脑(OpenAI 兼容端点)
    # 默认:spark02 vLLM qwen3.6-uncensored(Qwen3.5-MoE-35B-A3B FP8,:8000;原 workstation sglang 已停用)
    llm_base_url: str = "http://192.168.71.84:8000/v1"  # spark02 vLLM(2026-08-07 修正:原 workstation Nemotron 已停用)
    llm_api_key: str = "lm-studio"
    llm_model: str = "qwen3.6-uncensored"
    # 顶栏展示用真实模型名（llm_model 为 served-model-name 别名，展示不够直观）
    llm_display_name: str = "Qwen3.5-MoE-35B-A3B (spark02 FP8)"
    # 备用 LLM 大脑(主模型重试失败后自动切换;EXO 单端点多模型场景下 base_url/api_key 留空即复用主)。
    # 典型:主=GLM-5.2-fp8(思考型,长 ctx),备=Kimi-K2.7-Code-4bit(代码型,主掉线时兜底)。
    llm_fallback_base_url: str = ""
    llm_fallback_api_key: str = ""
    llm_fallback_model: str = ""
    # NSFW 模式专用 LLM(X-NSFW: 1 时启用);空 model = NSFW 模式复用主 LLM。
    # 典型:默认 qwen3.6-uncensored(workstation),NSFW llama-3.3-70b-abliterated(spark01 vLLM)
    llm_nsfw_base_url: str = ""
    llm_nsfw_api_key: str = ""
    llm_nsfw_model: str = ""

    # —— AICG 四层模型流水线（2026-07-24 项目管家确认）——
    # L1 初稿 = llm_base_url/llm_model（上面已配，qwen3.6-uncensored @ workstation:8000）
    # L4 NSFW = llm_nsfw_base_url/llm_nsfw_model（上面已配，llama-3.3-70b-abliterated @ spark01:8000）
    # L2 主力润色: Mac Studio EXO RDMA, Kimi-K3(EXO 已上架;2026-07-30 实测无运行实例时自动降级 L1)
    llm_l2_base_url: str = "http://192.168.71.109:52415/v1"
    llm_l2_model: str = "moonshotai/Kimi-K3"
    llm_l2_timeout: float = 120.0
    # L3 终稿精修: Mac Studio EXO, GLM-5.2-DQ4plus-q8(同上的实例状态边界)
    llm_l3_base_url: str = "http://192.168.71.109:52415/v1"
    llm_l3_model: str = "mlx-community/GLM-5.2-DQ4plus-q8"
    llm_l3_timeout: float = 300.0

    # 向量 RAG 的 embedding 模型(同一 OpenAI 兼容端点;留空则复用 llm_base_url)
    # 生产:workstation 真机 Qwen3-Embedding-4B(:9302, GPU1, systemd qwen3-embedding.service)
    embed_base_url: str = ""
    embed_model: str = "Qwen3-Embedding-4B"

    # LoRA 训练 agent(部署在 GPU 机 .100，独立 HTTP 服务 :9100)。
    # API 通过 HTTP 调它(同 ComfyUI/TTS/LLM 的访问模式)，不走 SSH。
    # 空 = 未部署，训练相关端点返回 503。
    trainer_url: str = ""

    # 可观测性 —— Sentry 错误追踪 DSN。空 = 不启用(本地开发默认关);
    # 配置真实 DSN 后,app 启动时初始化 sentry-sdk 自动上报未捕获异常 + 10% 性能采样。
    sentry_dsn: str = ""
    # 运行环境(传给 Sentry 的 environment 字段;development / production)。
    # 也便于后续按环境分支(如生产才采样)。
    environment: str = "development"

    # —— 视频质量评估 VLM(video scorer)——
    # workstation(192.168.71.127:8000, GPU3)上 Nemotron-3-Nano-Omni-30B-A3R 全模态 VLM,
    # served-model-name=qwen3.6-uncensored(向后兼容别名),OpenAI 兼容 API,支持视频/图像/音频输入。
    # 启用后:视频作业完成时(done 之前)异步评估,低分则推 SSE quality_warning 事件。
    # 评估失败/超时/全 0 一律降级(degraded=True),不阻塞主流程、不推 warning。
    vlm_server_url: str = "http://192.168.71.127:8000"
    vlm_model_id: str = "qwen3.6-uncensored"
    # 默认关:灰度上线开关,VLM Server 不可达时立即关回退,零影响主流程。
    # .env.example / 部署 .env 显式置 true 启用(VLM 已就位并验证)。
    video_scorer_enabled: bool = False
    # 综合分(total)低于此阈值才推 quality_warning;0.65 ≈ 视频质量明显可改进的临界。
    video_scorer_threshold: float = 0.65

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

    # —— 短剧 from-image 自动管线(autorun)并发度 ——
    # 视频阶段:ComfyUI WorkerPool 可按队列把并发任务摊到多个 worker,默认 3。
    drama_autorun_video_concurrency: int = 3
    # 配音阶段:IndexTTS2 单卡,并发太高只会排队,默认 2。
    drama_autorun_voice_concurrency: int = 2

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

    # —— MiniMax H3 视频生成引擎(专用 ComfyUI ≥ 0.30 实例,workstation :8195) ——
    # 独立于 ComfyUI-LB 集群/WorkerPool(生产 ComfyUI 0.27/0.28 无 H3 节点);
    # 实例由 systemd 托管,权重经 extra_model_paths 挂 NAS h3/(见 docs/2026-08-03-minimax-h3-eval.md)。
    h3_enabled: bool = True
    h3_base_url: str = "http://192.168.71.127:8195"
    # H3 int8 档增量峰值 ~30-33GiB(评测实测);提交前要求实例卡空闲显存 ≥ 此阈值(GiB)。
    # 不足时先尝试驱逐 h3_co_workers(同卡 pool worker,空闲队列才动)的模型缓存,
    # 仍不足 → 503 错峰提示,不让 ComfyUI 以 "VRAM grow failed" 裸崩(2026-08-04 实发)。
    h3_min_free_vram_gb: float = 36.0
    # 与 H3 实例同卡的 pool worker(逗号分隔,用于显存不足时的协调驱逐);空串=禁用自动驱逐。
    # 2026-08-04 起 H3 实例迁移至 GPU0(原 GPU1 被 embedding+liveact+H3 挤爆),
    # 同卡 pool worker 为 gpu0 :8189。
    h3_co_workers: str = "http://192.168.71.127:8189"

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
