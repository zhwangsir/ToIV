"""集群设备静态注册表(纯数据,无 IO)。

唯一事实源:AGENTS.md 第一节「集群设备清单」+ 第三节 GPU 分配(2026-08-24 真机
ss -tln 核对:OpenTalking 实际在 :4403,Animate2 :8199 已上线)。

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
            _comfy("ComfyUI 通用", 8189, note="GPU0"),
            _comfy("H3 主力视频", 8195, note="GPU2 · MiniMax H3"),
            _comfy("LongCat", 8197, note="GPU2"),
            _comfy("Wan-Animate-2", 8199, note="GPU3"),
            _comfy("超分 #1", 8261, note="GPU1"),
            _comfy("超分 #2", 8262, note="GPU2"),
            _comfy("超分 #3", 8263, note="GPU3"),
            _http("IndexTTS", 9200, note="GPU0 · 2.5"),
            _http("CosyVoice2", 9201, note="GPU0"),
            _http("CosyVoice3", 9202, note="GPU2"),
            _http("Qwen3-TTS", 9203, note="GPU2"),
            _http("ASR", 9210, note="GPU2"),
            _http("SenseVoice", 9211, note="GPU2"),
            _http("demucs", 9220, note="GPU2"),
            _http("FireRedASR", 8300, note="GPU2"),
            _http("Embedding", 9302, note="GPU1 · Qwen3-Embedding-4B"),
            _http("JoyCaption", 9304, note="GPU2 · transformers 直跑"),
            _http("LiveAct", 9400, note="GPU1"),
            _http("SCoPE", 9401, note="运镜 40 步约 18min"),
            _http("3dops", 9402, note="GLB 材质/渲染"),
            _http("sysmetrics", 9403, note="系统指标小服务"),
            _http("FlashTalk", 9004, note="GPU3"),
            _http("OpenTalking", 4403, note="GPU3 · unified"),
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
        "lan_ip": "192.168.71.115",
        "ts_ip": "100.69.134.27",
        "hardware": "Windows · RTX 5090",
        "probe_host": "192.168.71.115",
        "services": [_comfy("ComfyUI worker", 8188)],
    },
    {
        "id": "pc02",
        "name": "PC02",
        "role": "ComfyUI worker + 编辑专用实例",
        "lan_ip": "192.168.71.114",
        "ts_ip": "100.107.94.26",
        "hardware": "Windows · RTX 5090",
        "probe_host": "192.168.71.114",
        "services": [
            _comfy("ComfyUI worker", 8193, note="LB 池"),
            _comfy("Qwen 编辑专用", 8194, note="Qwen-Image-Edit"),
        ],
    },
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
        "role": "Molmo2-8B 音乐/图像反推 VLM",
        "lan_ip": "192.168.71.82",
        "ts_ip": "100.81.235.124",
        "hardware": "Linux GB10",
        "probe_host": "192.168.71.82",
        "services": [_http("molmo2_captioner", 8000)],
    },
    {
        "id": "spark02",
        "name": "Spark02",
        "role": "LLM L1-L4 主力(Qwen3.8-27B-Uncensored-FP8)",
        "lan_ip": "192.168.71.84",
        "ts_ip": "100.86.42.89",
        "hardware": "Linux GB10",
        "probe_host": "192.168.71.84",
        "services": [_http("vLLM", 8000, path="/v1/models", kind="vllm")],
    },
    *[
        {
            "id": f"studio0{i}",
            "name": f"Studio0{i}",
            "role": "EXO RDMA 推理(MiniMax-M2.7-4bit)"
                    + (" + VLM 反推(mlx-vlm 72B)" if i == 4 else ""),
            "lan_ip": lan,
            "ts_ip": ts,
            "hardware": "Mac Studio M3 Ultra 32核 512GB",
            "probe_host": lan,
            "services": [_http("EXO", 52415)]
                       + ([_http("VLM 反推", 9303)] if i == 4 else []),
        }
        for i, lan, ts in [
            (1, "192.168.71.109", "100.67.43.40"),
            (2, "192.168.71.111", "100.91.0.121"),
            (3, "192.168.71.112", "100.115.27.68"),
            (4, "192.168.71.113", "100.126.182.23"),
        ]
    ],
    *[
        {
            "id": f"openclaw0{i}",
            "name": f"OpenClaw0{i}",
            "role": "OpenClaw 网关",
            "lan_ip": lan,
            "ts_ip": ts,
            "hardware": "Mac mini M2",
            "probe_host": lan,
            "services": [_tcp("SSH", 22)],
        }
        for i, lan, ts in [
            (1, "192.168.71.86", "100.69.0.4"),
            (2, "192.168.71.75", "100.76.35.7"),
            (3, "192.168.71.81", "100.76.140.121"),
            (4, "192.168.71.85", "100.91.128.30"),
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
