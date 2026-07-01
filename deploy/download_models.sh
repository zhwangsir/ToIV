#!/usr/bin/env bash
# ToIV A 期模型下载(配合 docs/TOIV_MASTER.md 第二部分选型目录)
#
# 现状(2026-07-02,worker :8002 /object_info 实测):次世代权重大半已在 .100:
#   ✅ Z-Image Turbo 三件套齐(z_image_turbo_bf16 + qwen_3_4b + ae)—— 端到端已跑通
#   ✅ Qwen-Image UNET+VAE 在(qwen_image_fp8_e4m3fn + qwen_image_vae)—— 仅缺文本编码器
#   ✅ FLUX.2 Klein UNET+VAE 在(flux-2-klein-4b + flux2-vae)—— 缺「正确」文本编码器
#
# 故 A 期**核心只需**补两个文本编码器(见 download_core)。完整选型目录见 download_full。
#
# 运行前:
#   1) pip install -U "huggingface_hub[cli]"
#   2) huggingface-cli login            # 拉 gated 模型需 HF token
#   3) 在能访问 .100 ComfyUI models 目录的机器上跑(Windows 用 Git-Bash / WSL)
# 用法:
#   export COMFY_MODELS=/path/to/ComfyUI/models      # .100 上 ComfyUI 的 models 目录
#   bash download_models.sh [core|full]              # 默认 core
set -uo pipefail

COMFY_MODELS="${COMFY_MODELS:?请先 export COMFY_MODELS=.100 上 ComfyUI 的 models 目录}"
STAGE="${STAGE:-$COMFY_MODELS/.staging}"
mkdir -p "$STAGE" \
  "$COMFY_MODELS"/{checkpoints,diffusion_models,text_encoders,vae,loras,controlnet,upscale_models,ipadapter,clip_vision}

hf () { huggingface-cli download "$@"; }

getf () {   # $1=repo  $2=file_in_repo  $3=dest_subdir
  local repo="$1" file="$2" dest="$COMFY_MODELS/$3" out="$STAGE/${1//\//_}"
  echo ">>> [HF] $repo :: $file"
  hf "$repo" "$file" --local-dir "$out" || { echo "!!! 失败: $repo :: $file（确认 repo/文件名 或需登录）"; return; }
  mkdir -p "$dest"; cp -f "$out/$file" "$dest/$(basename "$file")" && echo "    -> $dest/$(basename "$file")"
}

# ── A 期核心:补齐次世代文本编码器 ────────────────────────────────────────
download_core () {
  echo "==================== A 期核心(次世代编码器)===================="
  # Qwen-Image 文本编码器(worker 现无 → 装后 Qwen-Image 即可用;图已实测结构正确)
  getf Comfy-Org/Qwen-Image_ComfyUI  split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors  text_encoders
  # FLUX.2 Klein 文本编码器:官方用 Mistral3;ComfyUI 打包名以实际 repo 为准。
  # ⚠️ gemma_3_12B 经 worker smoke 实测**不对**(KSampler 张量维度错),需下正确件后由后端校准 recipe。
  #    先确认 Comfy-Org 的 FLUX.2 repo 与编码器文件名,再取消下一行注释填入:
  # getf Comfy-Org/FLUX.2-klein_ComfyUI  split_files/text_encoders/<flux2_text_encoder>.safetensors  text_encoders
  echo "core 完成。装好 qwen_2.5_vl 后:把 config default_ckpt 切 Qwen-Image 或前端选它即可。"
}

# ── 完整选型目录(按需;多数已在 worker,失败/已存在属正常)───────────────
download_full () {
  echo "==================== 完整目录(可选)===================="
  # 共用文本编码器 & VAE(Flux/SD3.5 系)
  getf comfyanonymous/flux_text_encoders  t5xxl_fp16.safetensors  text_encoders
  getf comfyanonymous/flux_text_encoders  clip_l.safetensors      text_encoders
  # 次世代(UNET 多已在;如需原版/其它量化档在此补)
  # getf Comfy-Org/z_image_turbo  split_files/diffusion_models/z_image_turbo_bf16.safetensors  diffusion_models
  # getf Comfy-Org/z_image_turbo  split_files/text_encoders/qwen_3_4b.safetensors              text_encoders
  echo "full 完成(SDXL/写实/二次元底模走 Civitai,需 token + versionId,见 docs/TOIV_MASTER.md 附录)。"
}

case "${1:-core}" in
  core) download_core ;;
  full) download_core; download_full ;;
  *) echo "用法: bash download_models.sh [core|full]"; exit 1 ;;
esac
echo "结束。临时区 $STAGE 确认无误后可删。"
