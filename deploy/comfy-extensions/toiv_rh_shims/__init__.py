"""ToIV RH shims — RunningHub 平台私有节点的本地等价实现。

**签名不是猜的**:全部来自生产库 8142 张 rh-acc 图的 jsonb 聚合实证(2026-10-13),
包括每个输入键的出现次数与 jsonb 类型(array=连线 / string|number|boolean=字面量 /
object=RH 私有 widget blob),以及输出槽 0 被哪些下游节点的哪个字段消费——后者用来定
RETURN_TYPES(例:RH_Captioner 槽 0 全部流向 CLIPTextEncode.text / ShowText.text /
Text Concatenate.text_b,故确定为单个 STRING 输出)。

后端映射(节点跑在 workstation 的 ComfyUI 里,故一律走内网):
- 图生文 → 本地 Qwen3-VL(served id `toiv-vlm`,:9311,OpenAI 兼容)
- 纯文本 → 本地 DSv4(served id `deepseek-v4-flash-dspark`,spark02:8000,OpenAI 兼容)
- RH 图里的 `model` 字段是 RH 云端模型名(gpt-4o 一类),本地没有 → **一律改写成上述
  served id**,这正是 shim 的核心语义:换后端不换图。

**RHHiddenNodes 刻意不做通用 shim**(实测不可为):其输入名随图而变
(`face_images_5`/`var_4_4`/`string_1_1`/`clip_0`/`pixels_3`… 全为连线),输出槽 0 在
不同图里分别喂给 INT(`easy mathInt.a`,52 次)、STRING、IMAGE——静态 INPUT_TYPES 与
RETURN_TYPES 无法同时满足。09-15 版把 `image_1` 声明为 required,结果真实图从不传
`image_1`,smoke 一律报「Required input is missing image_1」;更糟的是它让 object_info
里出现 RHHiddenNodes,能力扫描因此把 78/283 个应用误判为 ok。现改为:全部输入 optional
+ 运行时抛明确错误,并由 scan_capability_gap 的 KNOWN_RISKY_NODES 标注、以 smoke 为裁判。
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import urllib.error
import urllib.request

LOG = logging.getLogger("toiv.rh_shims")

_DEFAULTS = {
    # 图生文:workstation 本机 Qwen3-VL(served id 实测为 toiv-vlm)
    "VLM_BASE": "http://127.0.0.1:9311/v1",
    "VLM_MODEL": "toiv-vlm",
    # 纯文本:spark02 DSv4(served id 实测为 deepseek-v4-flash-dspark)
    "LLM_BASE": "http://192.168.71.84:8000/v1",
    "LLM_MODEL": "deepseek-v4-flash-dspark",
    "TIMEOUT": "300",
    "RETRIES": "2",
}


def cfg(key: str) -> str:
    """环境变量优先,便于按实例覆盖(例:H3 专用实例指到自己的 LLM)。"""
    return os.environ.get(f"TOIV_SHIM_{key}", _DEFAULTS[key])


def _num(key: str, default: float) -> float:
    try:
        return float(cfg(key))
    except ValueError:
        return default


def build_chat_payload(model: str, system: str, user: str, images: list[str] | None = None,
                       *, temperature: float | None = None, top_p: float | None = None,
                       max_tokens: int | None = None, seed: int | None = None) -> dict:
    """拼 OpenAI 兼容 chat 请求体。images 为 data URL 列表,走 image_url 多模态内容块。

    采样参数只在调用方显式给了才写进去:RH 图里的 temperature=0 一类值直接透传会把
    本地模型压成贪心解码,而 RH 云端模型的 0 与本地模型的 0 语义并不等价。
    """
    content: list[dict] | str
    if images:
        content = [{"type": "text", "text": user}]
        for url in images:
            content.append({"type": "image_url", "image_url": {"url": url}})
    else:
        content = user
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": content})
    payload: dict = {"model": model, "messages": messages, "stream": False}
    if temperature is not None:
        payload["temperature"] = temperature
    if top_p is not None:
        payload["top_p"] = top_p
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    if seed is not None:
        payload["seed"] = int(seed)
    return payload


def extract_text(body: dict) -> str:
    """从 chat.completion 响应取文本;取不到就抛,别返回空串让下游静默生成空提示词。"""
    try:
        out = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"LLM 响应无 choices[0].message.content:{str(body)[:300]}") from e
    if isinstance(out, list):  # 少数后端把 content 拆成分块
        out = "".join(p.get("text", "") for p in out if isinstance(p, dict))
    if not isinstance(out, str) or not out.strip():
        raise RuntimeError(f"LLM 返回空文本:{str(body)[:300]}")
    return out


def post_chat(base: str, payload: dict) -> str:
    """POST /chat/completions,带重试;失败抛 RuntimeError 并带上游原文(smoke 归因要用)。"""
    url = base.rstrip("/") + "/chat/completions"
    data = json.dumps(payload).encode()
    retries = int(_num("RETRIES", 2))
    timeout = _num("TIMEOUT", 300)
    last = ""
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "ToIV-RH-Shim/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return extract_text(json.loads(r.read().decode()))
        except urllib.error.HTTPError as e:
            # 4xx 是请求本身的问题(模型名/多模态不支持),重试只是浪费时间
            detail = ""
            try:
                detail = e.read().decode()[:400]
            except OSError:
                pass
            last = f"HTTP {e.code}: {detail}"
            if 400 <= e.code < 500:
                break
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            last = f"{type(e).__name__}: {e}"
        except RuntimeError as e:  # extract_text 抛的
            last = str(e)
        if attempt < retries:
            LOG.warning("RH shim LLM 调用失败(第 %d 次),重试:%s", attempt + 1, last)
    raise RuntimeError(f"RH shim 调本地 LLM 失败({url}):{last}")


def image_to_data_url(image) -> str:
    """ComfyUI IMAGE 张量 [B,H,W,C] float 0..1 → PNG data URL(取首帧)。

    torch/PIL 延迟导入:让本模块在只有 stdlib 的环境里也能被导入做单测。
    """
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415
    import torch  # noqa: PLC0415

    t = image[0] if isinstance(image, (list, tuple)) else image
    if torch.is_tensor(t):
        t = t.detach().cpu().numpy()
    arr = np.asarray(t, dtype="float32")
    if arr.ndim == 4:  # 万一收到未取首帧的 batch
        arr = arr[0]
    if arr.ndim != 3 or arr.shape[-1] not in (1, 3, 4):
        raise RuntimeError(f"RH shim 无法解释的 IMAGE 形状:{arr.shape}")
    arr = np.clip(arr, 0.0, 1.0)
    if arr.max() <= 1.0:
        arr = (arr * 255.0).round()
    img = Image.fromarray(arr.astype("uint8"))
    if img.mode == "RGBA":  # JPEG 不支持 alpha,PNG 支持但统一转 RGB 更省字节
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _text_or_none(v) -> str:
    """RH 图里同一字段既可能是字面量字符串也可能是上游连线传来的值,统一成 str。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return str(v)


def _fail_or_fallback(skip_error, text: str, err: Exception) -> str:
    if skip_error:
        LOG.warning("RH shim 失败但 skip_error=true,原样透传输入文本:%s", err)
        return text
    raise err


# ── RH_Captioner:ref_image(IMAGE) + prompt(STRING) → STRING;实测 195 张图 ──
class _RHCaptioner:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ref_image": ("IMAGE",),
                "prompt": ("STRING", {"default": "Describe this image in detail.", "multiline": True}),
            },
            "optional": {
                # 实测 object 类型(RH 私有 widget blob),用通配 "*" 收而不解析
                "speak_and_recognation": ("*",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "caption"
    CATEGORY = "RH"

    def caption(self, ref_image, prompt="", speak_and_recognation=None):
        payload = build_chat_payload(
            cfg("VLM_MODEL"), "", _text_or_none(prompt), images=[image_to_data_url(ref_image)],
        )
        return (post_chat(cfg("VLM_BASE"), payload),)


# ── RH_Translator:prompt(STRING) + seed + advanced_options → STRING;实测 119 张图 ──
class _RHTranslator:
    SYSTEM = (
        "You are a translation engine for image-generation prompts. Translate the user's text "
        "into English. Output ONLY the translation, with no quotes, no notes, no explanations."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            # prompt 实测两种形态:连线 62 次 / 字面量 56 次 —— 声明为 STRING 两者都收
            "required": {"prompt": ("STRING", {"default": "", "multiline": True})},
            "optional": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "advanced_options": ("STRING", {"default": "auto"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "translate"
    CATEGORY = "RH"

    def translate(self, prompt="", seed=0, advanced_options="auto"):
        text = _text_or_none(prompt)
        if not text.strip():
            return ("",)  # 空输入不花 LLM 调用,直接回空(实测有图把 prompt 留空当表单入口)
        try:
            out = post_chat(cfg("LLM_BASE"), build_chat_payload(
                cfg("LLM_MODEL"), self.SYSTEM, text, seed=seed or None,
            ))
        except RuntimeError as e:
            return (_fail_or_fallback(False, text, e),)
        return (out.strip(),)


# ── RH_Prompter:prompt(STRING) + seed → STRING;实测 31 张图 ──
class _RHPrompter:
    SYSTEM = (
        "You rewrite the user's rough idea into a detailed text-to-image prompt. "
        "Keep the user's language unless the idea is Chinese, in which case output English. "
        "Output ONLY the prompt."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"prompt": ("STRING", {"default": "", "multiline": True})},
            "optional": {"seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF})},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "RH"

    def run(self, prompt="", seed=0):
        text = _text_or_none(prompt)
        if not text.strip():
            return ("",)
        try:
            return (post_chat(cfg("LLM_BASE"), build_chat_payload(
                cfg("LLM_MODEL"), self.SYSTEM, text, seed=seed or None,
            )).strip(),)
        except RuntimeError as e:
            return (_fail_or_fallback(False, text, e),)


# ── RH_LLMAPI_Pro_Node:通用 LLM 调用;实测 49 张图,输入键最多 ──
class _RHLLMAPIPro:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # RH 云端模型名,本地不存在 → 运行时一律改写成 TOIV_SHIM_LLM_MODEL
                "model": ("STRING", {"default": ""}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                # role 实测 string 30 次 / array 19 次(连线),故不收进 required
                "role": ("STRING", {"default": "user"}),
                "temperature": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "top_p": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "max_tokens": ("INT", {"default": 0, "min": 0, "max": 1048576}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "frequency_penalty": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01}),
                "presence_penalty": ("FLOAT", {"default": 0.0, "min": -2.0, "max": 2.0, "step": 0.01}),
                "reasoning_effort": ("STRING", {"default": ""}),
                "skip_error": ("BOOLEAN", {"default": False}),
                "image1": ("IMAGE",),
                "image2": ("IMAGE",),
                "image3": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "RH"

    def run(self, model="", prompt="", role="user", temperature=None, top_p=None,
            max_tokens=0, seed=0, frequency_penalty=None, presence_penalty=None,
            reasoning_effort="", skip_error=False, image1=None, image2=None, image3=None):
        text = _text_or_none(prompt)
        images = [image_to_data_url(im) for im in (image1, image2, image3) if im is not None]
        base, served = (cfg("VLM_BASE"), cfg("VLM_MODEL")) if images else (cfg("LLM_BASE"), cfg("LLM_MODEL"))
        if model and model != served:
            LOG.info("RH shim 改写模型名 %r → %r(本地无 RH 云端模型)", model, served)
        payload = build_chat_payload(
            served, "", text, images=images or None,
            temperature=temperature, top_p=top_p,
            max_tokens=max_tokens or None, seed=seed or None,
        )
        try:
            return (post_chat(base, payload).strip(),)
        except RuntimeError as e:
            return (_fail_or_fallback(skip_error, text, e),)


# ── RunningHub Deepcleaner:bridge_input(任意) + model_action(STRING) → STRING;实测 92 张图 ──
class _RHDeepcleaner:
    SYSTEM = (
        "You clean and normalize the given text: fix typos, remove filler and duplicated "
        "segments, keep the original language and meaning. Output ONLY the cleaned text."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # bridge_input 实测全为连线且承载类型随图而变 → 通配收
                "bridge_input": ("*",),
                "model_action": ("STRING", {"default": "clean"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "RH"

    def run(self, bridge_input=None, model_action="clean"):
        text = _text_or_none(bridge_input)
        if not text.strip():
            return ("",)
        try:
            return (post_chat(cfg("LLM_BASE"), build_chat_payload(
                cfg("LLM_MODEL"), self.SYSTEM, text,
            )).strip(),)
        except RuntimeError as e:
            return (_fail_or_fallback(False, text, e),)


# ── RH_GetAudioDuration:AUDIO → FLOAT 秒;本地可算,不需要任何外部服务(实测 9 张图) ──
class _RHGetAudioDuration:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("seconds",)
    FUNCTION = "run"
    CATEGORY = "RH"

    def run(self, audio):
        # ComfyUI AUDIO = {"waveform": Tensor[B,C,N], "sample_rate": int}
        if not isinstance(audio, dict):
            raise RuntimeError(f"RH shim 期望 AUDIO dict,实得 {type(audio).__name__}")
        waveform, sr = audio.get("waveform"), int(audio.get("sample_rate") or 0)
        if waveform is None or sr <= 0:
            raise RuntimeError("RH shim 无法从 AUDIO 取 waveform/sample_rate")
        frames = int(waveform.shape[-1])
        return (frames / float(sr),)


def _looks_like_image(value) -> bool:
    """鸭子类型判 IMAGE:ComfyUI 的 IMAGE 是 [B,H,W,C] 四维张量。

    只认 4 维,不认 3 维——MASK 是 [B,H,W],把 MASK 当 IMAGE 透传会静默产出错图。
    不在模块层导入 torch(保持纯 stdlib 可导入,以便单测)。
    """
    shape = getattr(value, "shape", None)
    if shape is None:
        return False
    try:
        return len(shape) == 4
    except TypeError:
        return False


# ── RHHiddenNodes:不可通用 shim(见模块 docstring),但要做到「能透传就透传,不能就诚实报错」 ──
class _RHHiddenNodes:
    @classmethod
    def INPUT_TYPES(cls):
        # 09-15 版把 image_1 设为 required,而真实图从不传该键(传的是 images_1/
        # face_images_5/var_4_4 等随图而变的名字)→ 一律「Required input is missing image_1」。
        # 现全部 optional:至少让「只有 pwd」那类图通过校验,把失败推迟到运行时并给出真因。
        return {
            "optional": {
                "image_1": ("IMAGE",),
                "image_2": ("IMAGE",),
                "image_3": ("IMAGE",),
                "image_4": ("IMAGE",),
                "pwd": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "passthrough"
    CATEGORY = "RH"

    def passthrough(self, image_1=None, image_2=None, image_3=None, image_4=None, pwd="", **kwargs):
        """**kwargs 是必需的,不是保险:ComfyUI 会把图里每个输入按名字当关键字参数传进来,
        而 RHHiddenNodes 的输入名随图而变。生产实证 rh-acc-8847936513-e3edd5 报
        `_RHHiddenNodes.passthrough() got an unexpected keyword argument 'images_1'`——
        只声明固定几个 optional 名根本接不住,而且抛的是 Python TypeError,
        比我要给的那句「此应用不可本地部署」难查得多。
        """
        for value in (image_1, image_2, image_3, image_4, *kwargs.values()):
            if _looks_like_image(value):
                return (value,)
        raise RuntimeError(
            "RHHiddenNodes 是 RunningHub 平台内部折叠子图的黑盒占位:实测其输入名随图而变"
            "(face_images_5/var_4_4/string_1_1/clip_0…),且本次未收到任何可透传的 IMAGE。"
            "它的输出槽在不同图里分别喂给 INT/STRING/IMAGE,本地无法忠实等价"
            "(生产实证 easy mathInt: Return type mismatch … received_type(IMAGE))。"
            "此应用不可本地部署,请勿上架(能力扫描已用 risk_nodes 标注)。"
        )


# ── RH_LLMAPI_NODE:RH 云 LLM 的**主力**入口(实测 662 张图,远多于 Pro 版的 148) ──
class _RHLLMAPINode:
    """与 Pro 版的差别:多了 api_baseurl / api_key(RH 云端点与密钥)与 ref_image(单数)。

    api_baseurl / api_key **一律忽略**——shim 的全部意义就是换后端不换图:图里指向 RH 云,
    本地改指 DSv4 / Qwen3-VL。api_key 是密钥,不写进日志。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("STRING", {"default": ""}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "api_baseurl": ("STRING", {"default": ""}),
                "api_key": ("STRING", {"default": ""}),
                "role": ("STRING", {"default": "user"}),
                "temperature": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "ref_image": ("IMAGE",),
                "ref_image1": ("IMAGE",),
                "ref_image2": ("IMAGE",),
                "ref_image3": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "RH"

    def run(self, model="", prompt="", api_baseurl="", api_key="", role="user",
            temperature=None, seed=0, ref_image=None, ref_image1=None,
            ref_image2=None, ref_image3=None):
        text = _text_or_none(prompt)
        images = [image_to_data_url(im)
                  for im in (ref_image, ref_image1, ref_image2, ref_image3) if im is not None]
        base, served = ((cfg("VLM_BASE"), cfg("VLM_MODEL")) if images
                        else (cfg("LLM_BASE"), cfg("LLM_MODEL")))
        if api_baseurl or api_key:
            # 只记「忽略了云端点」,不把 api_key 落日志
            LOG.info("RH shim 忽略图内 RH 云端点/密钥,改用本地后端 %s", served)
        if model and model != served:
            LOG.info("RH shim 改写模型名 %r → %r(本地无 RH 云端模型)", model, served)
        payload = build_chat_payload(served, "", text, images=images or None,
                                     temperature=temperature, seed=seed or None)
        try:
            return (post_chat(base, payload).strip(),)
        except RuntimeError as e:
            # 本类无 skip_error 字段:失败必须抛,否则用户拿到原文当译文/描述却看不到任何错误
            return (_fail_or_fallback(False, text, e),)


NODE_CLASS_MAPPINGS = {
    "RH_Captioner": _RHCaptioner,
    "RH_Translator": _RHTranslator,
    "RH_Prompter": _RHPrompter,
    "RH_LLMAPI_Pro_Node": _RHLLMAPIPro,
    "RH_LLMAPI_NODE": _RHLLMAPINode,
    # 实测同一语义在不同图里有多种拼写:RH_Captioner_Pro 的字段是 Pro 版的子集(只多 image1,
    # 而 Pro 版本就有 image1/2/3),故直接复用;"Runninghub Captioner" 是 RH_Captioner 的另一种写法
    # (真机烟测报 "Node 'Runninghub Captioner' not found" 才发现,光看 RH_Captioner 的聚合会漏)。
    "RH_Captioner_Pro": _RHLLMAPIPro,
    "Runninghub Captioner": _RHCaptioner,
    "RunningHub Deepcleaner": _RHDeepcleaner,
    "RH_GetAudioDuration": _RHGetAudioDuration,
    "RHHiddenNodes": _RHHiddenNodes,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RH_Captioner": "RH Captioner (ToIV → Qwen3-VL)",
    "RH_Translator": "RH Translator (ToIV → DSv4)",
    "RH_Prompter": "RH Prompter (ToIV → DSv4)",
    "RH_LLMAPI_Pro_Node": "RH LLMAPI Pro (ToIV → DSv4/VLM)",
    "RH_LLMAPI_NODE": "RH LLMAPI (ToIV → DSv4/VLM)",
    "RH_Captioner_Pro": "RH Captioner Pro (ToIV → DSv4/VLM)",
    "Runninghub Captioner": "Runninghub Captioner (ToIV → Qwen3-VL)",
    "RunningHub Deepcleaner": "RH Deepcleaner (ToIV → DSv4)",
    "RH_GetAudioDuration": "RH Get Audio Duration (ToIV local)",
    "RHHiddenNodes": "RH Hidden Nodes (ToIV shim — 不可本地部署)",
}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
