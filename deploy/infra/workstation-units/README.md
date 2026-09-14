# workstation-units

> **来源主机**：workstation（192.168.71.127，merlin，4×RTX PRO 6000）
> **采集时间**：2026-09-13（`systemctl cat` 全量真机采集）
> **用途**：迁移手册阶段 0 配置入仓（只复制不启用）。对应清单 `docs/SERVICE_INVENTORY.md` ②组。

## 文件清单

| 文件 | 来源路径（workstation 上） | 说明 |
|---|---|---|
| `comfyui-lb.service` | `/etc/systemd/system/` | LB :8188，WorkingDirectory=/opt/ComfyUI |
| `comfyui-gpu0-alt.service` | 同上 | 池成员 :8196，CVD=0，cache-lru 8 |
| `toiv-comfyui-h3.service` + `toiv-comfyui-h3.service.d/*.conf` | 同上 | H3 :8195；drop-in = cu13 环境 + **GPU UUID 钉卡** + MemoryMax=160G（新硬件必须重新核对 UUID，H-6） |
| `comfyui-longcat.service` + `comfyui-longcat.service.d/gpu0.conf` | 同上 | LongCat :8197；drop-in 实际钉 **GPU0**（主文件写 GPU2，漂移见清单第三节-1） |
| `comfyui-animate2.service` | 同上 | :8199，独立 venv（/home/merlin/ComfyUI-animate2/venv） |
| `comfyui-upscale-gpu{1,2,3}.service` | 同上 | :8261/:8262/:8263；⚠️ gpu2 实际 CVD=0（挪 GPU0 未改名，漂移见清单第三节-2） |
| `qwen3-embedding.service` | 同上 | :9302，/opt/nemotron-venv，权重 ~/models/Qwen3-Embedding-4B |
| `toiv-audio-sep.service` | 同上 | :9220，独立 venv /home/merlin/toiv-scripts/audio-sep-venv |
| `toiv-comfy-mcp.service` | 同上 | :9100，⚠️ 内含 `COMFYUI_MCP_HTTP_TOKEN`（SENSITIVE，勿外传）；COMFYUI_URL 指向已退役 :8189 |
| `fan_guard.service` | 同上 | 锁扇，脚本 `/opt/fan_guard.py` |
| `opt/comfyui-lb/backends.json` | `/opt/comfyui-lb/backends.json` | LB 后端池（现网 2 后端：gpu0:8196 + pc01:8188；LB 5s mtime 热重载） |
| `opt/ComfyUI/extra_model_paths.yaml` | `/opt/ComfyUI/extra_model_paths.yaml` | 主 ComfyUI 模型路径（NAS 绝对路径，迁移时按手册改主机名/IP） |
| `home/merlin/ComfyUI-h3-eval/extra_model_paths.yaml` | `/home/merlin/ComfyUI-h3-eval/extra_model_paths.yaml` | H3 实例模型路径 |

## 未入仓说明

- workstation 还有 **20+ 个已 disable 的 legacy unit**（comfyui-gpu0:8189 / ltx25 / hunyuan3d / infinitetalk / toiv-asr / cosyvoice / indextts / liveact / trainer / vlm 等，含 .bak）——已退役不配迁移，未复制；如需审计可在主机上 `ls /etc/systemd/system/ | grep -E 'comfy|toiv|qwen'`。
- venv 依赖锁定见 `../pip-freezes/workstation--*.txt`。
