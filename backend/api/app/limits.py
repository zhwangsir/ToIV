"""引擎提交上限的纯常量源(零依赖,registry 与 routes 共同 import,避免 services↔routes 循环)。

同源约定:
- 字节上限:/api/upload 按文件真实类型分流——图/音频 20MB、视频 200MB;
  routes/upload.py 与 engine_registry 的 limits 声明共用本模块。
- H3 提示词/参考/LoRA 上限:routes/h3_studio.py 的 Pydantic 约束与
  engine_registry spec 的 limits/params 声明共用本模块。
- 普通 generate 链路(routes/generate.py)positive/negative 2000 已收敛为
  DEFAULT_* 常量(同值,行为不变);其 LoRA 上限 8 单独为 GENERATE_MAX_LORAS
  (不与市场/H3 的 3 混用)。
- LoRA 上限按真实作用域分三个常量,不强行统一:普通 generate=8、
  市场 app_deep_knobs.parse=3、H3 提交=3。H3 与市场同值但作用域不同,
  改动任一须同步决策(test_h3_market_lora_cap_no_drift 防漂移)。
"""
from __future__ import annotations

# 媒体字节上限(/api/upload 真实约束,按文件类型分流)
IMAGE_MAX_BYTES = 20 * 1024 * 1024   # 20MB(图)
AUDIO_MAX_BYTES = 20 * 1024 * 1024   # 20MB(音频)
VIDEO_MAX_BYTES = 200 * 1024 * 1024  # 200MB(驱动/参考视频)

# 提示词长度上限(字符)
DEFAULT_PROMPT_MAX_CHARS = 2000      # 普通 generate 链路既有语义(routes/generate.py 同源)
DEFAULT_NEGATIVE_MAX_CHARS = 2000
H3_PROMPT_MAX_CHARS = 4000           # H3 链路(routes/h3_studio.H3T2VRequest 同源)
H3_NEGATIVE_MAX_CHARS = 2000

# H3 Ref2VA 媒体槽(routes/h3_studio.H3R2VRequest 与注册表 params max 同源)
H3_MAX_REF_IMAGES = 9
H3_MAX_REF_VIDEOS = 3
H3_MAX_REF_AUDIOS = 3

# LoRA 叠加数量上限(按真实作用域,不强行统一):
H3_MAX_LORAS = 3              # H3 提交链路(routes/h3_studio._MAX_LORAS 同源)
MARKET_MAX_LORAS = 3          # 市场 /api/apps run(app_deep_knobs.parse_loras_value 同源)
GENERATE_MAX_LORAS = 8        # 普通 generate 图片链路(routes/generate._MAX_LORAS 同源)
