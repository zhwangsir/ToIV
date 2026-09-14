# pip-freezes

> **采集时间**：2026-09-13（各主机真实 venv 上 `pip freeze --all`）
> **用途**：迁移手册阶段 0 依赖锁定。新环境按 `<host>--<venv>.txt` 对应重建。
> 命名规则：`<host>--<venv名>.txt`；生成命令 `<venv>/bin/python -m pip freeze --all`（注意 `/opt/ComfyUI/venv` 无 pip 可执行文件，必须用 `python -m pip`）。

| 文件 | 主机 | venv 路径（来源机上） | 服务 |
|---|---|---|---|
| `workstation--ComfyUI.txt` | workstation | `/opt/ComfyUI/venv` | LB/gpu0-alt/超分×3/LongCat 共用的主 ComfyUI venv |
| `workstation--h3-eval.txt` | workstation | `/home/merlin/ComfyUI-h3-eval/venv` | H3 :8195（cu13 特殊环境，unit 内有 CUDA_HOME 指到 venv 内 nvidia/cu13） |
| `workstation--nemotron.txt` | workstation | `/opt/nemotron-venv` | fan_guard（pynvml）+ qwen3-embedding :9302 |
| `workstation--animate2.txt` | workstation | `/home/merlin/ComfyUI-animate2/venv` | Wan-Animate-2 :8199 独立 venv |
| `workstation--audio-sep.txt` | workstation | `/home/merlin/toiv-scripts/audio-sep-venv` | 音频分离 :9220 |
| `workstation--joycaption.txt` | workstation | `/opt/toiv-joycaption/venv` | JoyCaption（现网服务已停，venv 留存） |
| `core--toiv-api.txt` | core | `/home/merlin/toiv/api/.venv` | toiv-api :8090（python 3.14） |

未冻结：pc01 两个 ComfyUI venv（`C:\ComfyUI\venv`、`C:\ComfyUI-h3\venv`，Windows 侧未采集，迁移时到机执行 `venv\Scripts\python -m pip freeze --all`）；spark DSv4（容器镜像自带，按镜像 tag 锁定即可）。
