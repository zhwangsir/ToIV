"""集群设备静态注册表(纯数据,无 IO)。

事实优先级:现场探针 > 本注册表 > config 默认 > AGENTS/文档注释。
(Wave Naming N1 / 2026-10-23:对齐「一个磁盘权重一个 weight id」;
spark01=DSv4 TP rank1 headless;spark02=ep.llm.primary DSv4;
VLM=ws:9311 toiv-vlm;whisper 探针 /health;离线口 probe=none 不进分母。
既有:H3 :8264;:8265/:9311;摘 :8261/OpenTalking :4403。)

字段约定:
- probe_host:core 侧主动探测用的地址(core→workstation/pc 服务间调用走 LAN,
  共址直连快;cloud/beijing 无 LAN 用公网 IP);
- services[].probe:
  - "http":GET path,任何 HTTP 响应(含 404/405)即算 up,记录状态码+延迟;
    kind="comfyui" 顺带拉 /system_stats 带 VRAM;kind="vllm" 解析模型列表;
  - "tcp" :纯 TCP connect(SMB/PostgreSQL/Redis/SSH/HTTPS 等无 HTTP 语义端口);
  - "none":探测路径不明的声明式占位,状态恒 unknown,不计入 x/y 分母;
- 设备增删/端口变更只改本文件;sysmetrics=True 的设备由 fleet.py 额外聚合
  :9403 系统指标(CPU/RAM/磁盘/NAS 挂载/GPU)。
"""
from __future__ import annotations

_WS = "192.168.71.127"


def _http(name: str, port: int, *, path: str = "/", kind: str | None = None,
          note: str | None = None) -> dict:
    svc: dict = {"name": name, "port": port, "probe": "http", "path": path}
    if kind:
        svc["kind"] = kind
    if note:
        svc["note"] = note
    return svc


def _declared(name: str, port: int, *, note: str | None = None) -> dict:
    """声明式占位:probe=none → status 恒 unknown,不计入 x/y 分母。"""
    svc: dict = {"name": name, "port": port, "probe": "none"}
    if note:
        svc["note"] = note
    return svc


def _tcp(name: str, port: int, *, note: str | None = None) -> dict:
    svc: dict = {"name": name, "port": port, "probe": "tcp"}
    if note:
        svc["note"] = note
    return svc


def _comfy(name: str, port: int, **kw) -> dict:
    return _http(name, port, kind="comfyui", **kw)


DEVICE_REGISTRY: list[dict] = [
    {
        "id": "workstation",
        "name": "Workstation",
        "role": "算力 + 全部 AI 后端服务",
        "lan_ip": _WS,
        "ts_ip": "100.68.100.90",
        "hardware": "Linux · 4×RTX PRO 6000(96G) · RAM 183G",
        "probe_host": _WS,
        "sysmetrics": True,
        "services": [
            # —— 现网热路径(在线率分母核心；2026-10-23 LAN 普查存活) ——
            _comfy("ComfyUI 通用", 8196, note="ep.comfy.image-gate · GPU0 · LB 后端"),
            _comfy("H3 主力视频", 8264, note="ep.h3.prod · GPU1 · MiniMax H3(:8195 已停)"),
            _comfy("LongCat", 8197, note="ep.comfy.video-longcat · GPU0"),
            _comfy("Wan-Animate-2", 8199, note="ep.comfy.video-animate2 · GPU3"),
            # :8261 超分#1 已撤(AGENTS);不再入分母
            _comfy("超分 #2", 8262, note="ep.comfy.upscale-a · GPU2"),
            _comfy("超分 #3", 8263, note="ep.comfy.upscale-b · GPU3 · 亦在 LB 池"),
            _comfy("通用 worker#3", 8265, note="ep.comfy.image-worker-c · GPU2 · LB 池"),
            _http("IndexTTS", 9200, note="ep.tts.primary · GPU0 · IndexTTS2"),
            _http("demucs", 9220, note="ep.demucs.primary · 音频分离"),
            _http("Embedding", 9302, note="ep.embed.primary · GPU1 · Qwen3-Embedding-4B"),
            _http("ToIV VLM", 9311, note="ep.vlm.primary · GPU3 · served=toiv-vlm ← Qwen3-VL-8B"),
            # —— archive/offline(2026-10-23 普查 Connection refused；probe=none 不进分母；勿当热路径) ——
            _declared("offline Hunyuan3D :8200", 8200, note="2026-10-23 Asia/Shanghai · LAN Connection refused · 曾 GPU1 Kijai wrapper"),
            _declared("offline FireRedASR :8300", 8300, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline JoyCaption-WS :9304", 9304, note="2026-10-23 Asia/Shanghai · LAN Connection refused · 勿与 oc:9305 混淆"),
            _declared("offline LiveAct :9400", 9400, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline SCoPE :9401", 9401, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline 3dops :9402", 9402, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline sysmetrics :9403", 9403, note="2026-10-23 Asia/Shanghai · LAN Connection refused · SYSMETRICS_URL 仍指向此口但探测失败时降级"),
            _declared("offline hy3dtex :9404", 9404, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline FlashTalk :9004", 9004, note="2026-10-23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline CosyVoice2 :9201", 9201, note="2026-10-22/23 Asia/Shanghai · LAN Connection refused · 对照 IndexTTS:9200"),
            _declared("offline CosyVoice3 :9202", 9202, note="2026-10-22/23 Asia/Shanghai · LAN Connection refused · 对照 IndexTTS:9200"),
            _declared("offline Qwen3-TTS :9203", 9203, note="2026-10-22/23 Asia/Shanghai · LAN Connection refused · 对照 IndexTTS:9200"),
            _declared("offline ASR :9210", 9210, note="2026-10-22/23 Asia/Shanghai · LAN Connection refused"),
            _declared("offline SenseVoice :9211", 9211, note="2026-10-22/23 Asia/Shanghai · LAN Connection refused"),
            # OpenTalking :4403 已下架(AGENTS+TOIV_OPENTALKING_ENABLED=false),已摘
        ],
    },
    {
        "id": "core",
        "name": "Core",
        "role": "ToIV 生产服务器(web/api/PG/Redis)",
        "lan_ip": "192.168.71.47",
        "ts_ip": "100.77.80.100",
        "hardware": "Ubuntu · 业务网关(非算力)",
        # fleet 就跑在 core 本机:PG/Redis 只 bind 127.0.0.1(2026-08-24 真机核实),
        # 用 LAN IP 会全部误报 down;api/web 0.0.0.0 监听,回环同样可达
        "probe_host": "127.0.0.1",
        "services": [
            _http("toiv-api", 8090, path="/health"),
            _http("toiv-web", 3100),
            _tcp("PostgreSQL", 5432),
            _tcp("Redis", 6379),
        ],
    },
    {
        "id": "pc01",
        "name": "PC01",
        "role": "ComfyUI worker",
        "lan_ip": "192.168.71.116",
        "ts_ip": "100.69.134.27",
        "hardware": "Windows · RTX 5090",
        "probe_host": "192.168.71.116",
        "services": [
            _comfy("ComfyUI worker", 8188),
            _comfy("H3 第二实例", 8198, note="TOIV_H3_BASE_URLS 双池"),
        ],
    },
    # pc02 已于 2026-09-13 下线(LB 池已移除),从舰队注册表摘除;历史规格见 git 历史。
    {
        "id": "nas",
        "name": "NAS",
        "role": "SMB 存储(模型库/产物)",
        "lan_ip": "192.168.71.7",
        "ts_ip": "100.80.237.96",
        "hardware": "Linux · 44T",
        "probe_host": "192.168.71.7",
        # 容量/挂载状态由 workstation sysmetrics 的 nas 段提供(详情页 sys 字段)
        "services": [_tcp("SMB", 445)],
    },
    {
        "id": "spark01",
        "name": "Spark01",
        # 命名规范 N1:不得登记为独立 VLM/LLM；隶属 ep.llm.primary 的 TP2 rank1。
        "role": "DSv4 TP2 rank1 headless worker（dsv4_60；无独立 :8000 服务）",
        "lan_ip": "192.168.71.82",
        "ts_ip": "100.81.235.124",
        "hardware": "Linux GB10",
        "probe_host": "192.168.71.82",
        "services": [
            _declared(
                "dsv4-tp-rank1 (no listen)",
                8000,
                note="2026-10-23 · dsv4_60 --headless --node-rank 1 · 本机 :8000 无监听 · 勿当 VLM/LLM 入口；VLM=ws:9311 toiv-vlm",
            ),
        ],
    },
    {
        "id": "spark02",
        "name": "Spark02",
        # ep.llm.primary · DeepSeek-V4.1-Flash-1017（Mia TensorFold TP2 :8888）。
        # Studio01-04/EXO 已退役,L1-L4 收拢本机(config.llm_* 默认 DeepSeek-V4.1-Flash-1017)。
        "role": "ep.llm.primary · DeepSeek-V4.1-Flash-1017 abliterated (Mia TP2 :8888)",
        "lan_ip": "192.168.71.84",
        "ts_ip": "100.86.42.89",
        "hardware": "Linux GB10",
        "probe_host": "192.168.71.84",
        "services": [
            _http(
                "Mia LLM",
                8888,
                path="/v1/models",
                kind="vllm",
                note="served ONLY=DeepSeek-V4.1-Flash-1017（兼容别名 deepseek-v4-flash-dspark 由代理改写）",
            ),
        ],
    },
    # Studio01-04 已于 2026-08-29 全线下线(四台 EXO :52415 真机 curl 全超时),
    # 从舰队注册表移除;历史规格见 git 历史。
    *[
        {
            "id": f"openclaw0{i}",
            "name": f"OpenClaw0{i}",
            # 2026-09-22 修订:角色更正为 whisper ASR 集群节点(09-21 集群化),
            # 注册 whisper :9310 探针(OpenAI 兼容契约);02-04 tailscaled 僵死但 LAN 全通
            # (「TS 离线」≠「服务掉线」,N-5),故探针一律走 LAN。
            "role": "whisper ASR 集群节点 + JoyCaption",
            "lan_ip": lan,
            "ts_ip": ts,
            "hardware": "Mac mini M4 16GB",
            "probe_host": lan,
            "services": [
                _http("whisper ASR", 9310, path="/health", note="ep.asr.whisper-cluster · 四址故障转移；契约 /health=whisper-mlx"),
                _tcp("JoyCaption", 9305),
            ],
        }
        for i, lan, ts in [
            (1, "192.168.71.86", "100.115.23.67"),
            (2, "192.168.71.75", "100.76.35.7"),
            (3, "192.168.71.81", "100.76.140.121"),
            (4, "192.168.71.85", "100.125.217.11"),
        ]
    ],
    {
        "id": "cloud",
        "name": "Cloud",
        "role": "香港网关 / frps / OpenResty(toiv.dgmt.top)",
        "lan_ip": None,
        "ts_ip": "100.83.78.114",
        "hardware": "Linux · 腾讯云香港",
        "probe_host": "43.119.32.180",
        "services": [_tcp("SSH", 22), _tcp("HTTPS", 443)],
    },
    {
        "id": "beijing",
        "name": "Beijing",
        "role": "北京国内入口 / frpc(toiv.wineryz.top)",
        "lan_ip": None,
        "ts_ip": None,
        "hardware": "Linux · 阿里云",
        "probe_host": "8.140.222.24",
        "services": [_tcp("SSH", 22), _tcp("HTTPS", 443)],
    },
]

DEVICES_BY_ID: dict[str, dict] = {d["id"]: d for d in DEVICE_REGISTRY}

# workstation sysmetrics :9403(core 侧聚合工作站 CPU/RAM/磁盘/NAS/GPU)
SYSMETRICS_URL = f"http://{_WS}:9403/metrics"
