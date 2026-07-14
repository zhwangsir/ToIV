"""任务种类 → 所需模型文件名集合。

用于多机异构调度:上传/生成时据此只选具备对应模型的 worker。
"""
from __future__ import annotations

from app.workflows.ace_step import AceStepParams
from app.workflows.hunyuan3d import Hunyuan3DParams
from app.workflows.hunyuan_i2v import HunyuanI2VParams
from app.workflows.ltx_video import LtxI2VParams, LtxLipsyncParams, LtxT2VParams
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
    if kind == "ltx_video":
        p = LtxT2VParams(positive="")
        models = {p.unet_name, p.gemma_name, p.vae_name}
        if p.use_upscale:
            models.add(p.upscale_model)
        return models
    if kind == "ltx_lipsync":
        p = LtxLipsyncParams(positive="", image="", audio="")
        models = {p.unet_name, p.gemma_name, p.vae_name, p.audio_vae_name}
        if p.use_upscale:
            models.add(p.upscale_model)
        if p.id_lora:
            models.add(p.id_lora)
        return models
    return set()


def required_nodes(kind: str) -> set[str]:
    """任务所需的自定义节点 class_type。worker 可能有模型却缺节点(如 PC01 有 Wan 权重
    但没装 VideoHelperSuite → 视频图的 VHS_VideoCombine/VHS_LoadVideo 缺失 → /prompt 400),
    故视频路由须同时校验节点存在。"""
    if kind == "video":
        return {"VHS_VideoCombine", "VHS_LoadVideo"}
    if kind == "hunyuan_video":
        return {"DownloadAndLoadHyVideoTextEncoder", "HyVideoModelLoader", "HyVideoVAELoader", "HyVideoI2VEncode", "HyVideoSampler", "HyVideoDecode", "VHS_VideoCombine"}
    if kind == "frame_interpolate":
        return {"RIFE VFI", "VHS_LoadVideo", "VHS_VideoCombine"}
    if kind == "ltx_video":
        # LTX2.3(LTXV 前缀节点)+ VHS 输出 + RIFE 插帧 + 上采样
        return {"UNETLoader", "LTXVGemmaCLIPModelLoader", "VAELoader", "CLIPTextEncode",
                "LTXVConditioning", "EmptyLTXVLatentVideo", "VAEDecode", "VHS_VideoCombine",
                "RIFE VFI", "ImageUpscaleWithModel", "UpscaleModelLoader"}
    if kind == "ltx_lipsync":
        # LTX2.3 + 口型同步(LTXV 音频驱动节点 + LoadAudio + ID LoRA)
        return {"UNETLoader", "LTXVGemmaCLIPModelLoader", "VAELoader", "CLIPTextEncode",
                "LTXVImgToVideo", "LTXVAudioVAELoader", "LTXVReferenceAudio", "VAEDecode",
                "VHS_VideoCombine", "RIFE VFI", "ImageUpscaleWithModel", "UpscaleModelLoader",
                "LoadAudio", "LoraLoaderModelOnly"}
    return set()
