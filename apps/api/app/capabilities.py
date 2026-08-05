"""任务种类 → 所需模型文件名集合。

用于多机异构调度:上传/生成时据此只选具备对应模型的 worker。
"""
from __future__ import annotations

from app.workflows.ace_step import AceStepParams
from app.workflows.hunyuan3d import Hunyuan3DParams
from app.workflows.hunyuan_i2v import HunyuanI2VParams
from app.workflows.ltx_video import LtxI2VParams, LtxLipdubParams, LtxLipsyncParams, LtxT2VParams
from app.workflows.txt2img import Txt2ImgParams
from app.workflows.wan_i2v import WanI2VParams


def required_models(kind: str) -> set[str]:
    if kind == "video":
        p = WanI2VParams(positive="", image="")
        return {p.high_unet, p.low_unet, p.high_lora, p.low_lora, p.clip_name, p.vae_name}
    if kind == "hunyuan_video":
        p = HunyuanI2VParams(positive="", image="")
        return {p._model_name, p._vae_name, p._lora_name}
    if kind == "threed":
        return {Hunyuan3DParams(image="").ckpt_name}
    if kind == "img2img":
        return {Txt2ImgParams(positive="").ckpt_name}
    if kind == "audio":
        return {AceStepParams(tags="").ckpt_name}
    if kind in ("ltx_video", "ltx_t2v", "ltx_i2v"):
        p = LtxT2VParams(positive="")
        models = {p.unet_name, p.gemma_name, p.vae_name}
        if p.use_upscale:
            models.add(p.upscale_model)
        return models
    # H3 图生视频参考图先落到 pool worker,再由后端转运到 H3 专用实例;
    # 上传阶段不要求 worker 持有 H3 模型(避免必须路由到 LTX worker)。
    if kind == "h3_i2v":
        return set()
    if kind == "ltx_lipsync":
        p = LtxLipsyncParams(positive="", image="", audio="")
        models = {p.unet_name, p.gemma_name, p.vae_name, p.audio_vae_name}
        if p.use_upscale:
            models.add(p.upscale_model)
        if p.id_lora:
            models.add(p.id_lora)
        return models
    if kind == "ltx_lipdub":
        p = LtxLipdubParams(positive="", video="")
        models = {p.ckpt_name, p.gemma_name, p.lipdub_lora}
        if p.two_stage:
            models.add(p.upscale_model)
        return models
    return set()


def required_nodes(kind: str) -> set[str]:
    """任务所需的自定义节点 class_type。worker 可能有模型却缺节点(如 PC01 有 Wan 权重
    但没装 VideoHelperSuite → 视频图的 VHS_VideoCombine 缺失 → /prompt 400),
    故视频路由须同时校验节点存在。

    注意:默认关闭的 2 阶段采样/RIFE 等可选节点不列入,避免缺可选节点的 worker 被误淘汰;
    用户手动开启这些选项时,由 ComfyUI 执行期返回明确错误。"""
    if kind == "video":
        # Wan 2.2 i2v 完整节点链(默认挂加速 LoRA)
        return {
            "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "LoadImage",
            "WanImageToVideo", "ModelSamplingSD3", "KSamplerAdvanced", "VAEDecode",
            "VHS_VideoCombine", "LoraLoaderModelOnly",
        }
    if kind == "hunyuan_video":
        return {"DownloadAndLoadHyVideoTextEncoder", "HyVideoModelLoader", "HyVideoVAELoader", "HyVideoI2VEncode", "HyVideoSampler", "HyVideoDecode", "VHS_VideoCombine"}
    if kind == "frame_interpolate":
        return {"FrameInterpolationModelLoader", "FrameInterpolate", "VHS_LoadVideo", "VHS_VideoCombine"}
    # LTX2.3 文生视频
    if kind in ("ltx_video", "ltx_t2v"):
        return {"UNETLoader", "LTXVGemmaCLIPModelLoader", "VAELoader", "CLIPTextEncode",
                "LTXVConditioning", "EmptyLTXVLatentVideo", "KSampler", "VAEDecode", "VHS_VideoCombine"}
    # LTX2.3 图生视频
    if kind == "ltx_i2v":
        return {"UNETLoader", "LTXVGemmaCLIPModelLoader", "VAELoader", "CLIPTextEncode",
                "LoadImage", "LTXVImgToVideo", "KSampler", "VAEDecode", "VHS_VideoCombine"}
    # H3 图生视频参考图上传:pool worker 只需能存图,不依赖 H3 节点。
    if kind == "h3_i2v":
        return set()
    if kind == "ltx_lipsync":
        # LTX2.3 + 口型同步(LTXV 音频驱动节点 + LoadAudio + ID LoRA)
        return {"UNETLoader", "LTXVGemmaCLIPModelLoader", "VAELoader", "CLIPTextEncode",
                "LoadImage", "LTXVImgToVideo", "LTXVAudioVAELoader", "LTXVReferenceAudio",
                "LoadAudio", "LoraLoaderModelOnly", "KSampler", "VAEDecode", "VHS_VideoCombine"}
    if kind == "ltx_lipdub":
        # LTX-2.3 LipDub(IC-LoRA 重配音对口型,单阶段全量节点;
        # two_stage 追加的 LatentUpscaleModelLoader/LTXVLatentUpsampler 由路由按需并入)
        return {"CheckpointLoaderSimple", "LTXAVTextEncoderLoader", "LTXVAudioVAELoader",
                "LTXICLoRALoaderModelOnly", "LoadVideo", "GetVideoComponents", "LoadAudio",
                "LTXVAudioVAEEncode", "LTXVAudioVAEDecode", "LTXVSetAudioRefTokens",
                "LTXAddVideoICLoRAGuide", "LTXVCropGuides", "LTXVConcatAVLatent",
                "LTXVSeparateAVLatent", "LTXVEmptyLatentAudio", "LTXFloatToInt",
                "EmptyLTXVLatentVideo", "LTXVConditioning", "CLIPTextEncode",
                "ResizeImageMaskNode", "RandomNoise", "KSamplerSelect", "ManualSigmas",
                "CFGGuider", "SamplerCustomAdvanced", "LTXVTiledVAEDecode",
                "CreateVideo", "SaveVideo"}
    return set()
