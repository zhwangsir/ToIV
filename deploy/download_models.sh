#!/usr/bin/env bash
# ToIV 模型/LoRA/工具全量下载脚本 (P0/P1/P2)
#
# 使用方式:
#   1) 在能访问 ComfyUI models 目录的机器上执行
#   2) export COMFY_MODELS=/path/to/ComfyUI/models
#   3) pip install -U "huggingface_hub[cli]"
#   4) huggingface-cli login            # 拉 gated 模型需 HF token
#   5) bash download_models.sh [p0|p1|p2|all]
#
# 说明:
#   - P0: 质量提升最明显(Qwen-Image 2.0 满血编码器、PuLID、ACE-Step 1.5)
#   - P1: 短剧全场景 LoRA + 音频分离工具
#   - P2: 体验增强(LivePortrait、Stable Audio Open、训练相关)
#   - 没有量化包时优先跑 7B 满血;30B/72B 需单独调度到 Spark/HBM 设备
set -uo pipefail

COMFY_MODELS="${COMFY_MODELS:?请先 export COMFY_MODELS=.100 上 ComfyUI 的 models 目录}"
STAGE="${STAGE:-$COMFY_MODELS/.staging}"
mkdir -p "$STAGE" \
  "$COMFY_MODELS"/{checkpoints,diffusion_models,text_encoders,vae,loras,controlnet,upscale_models,ipadapter,clip_vision,pulid,unet}

hf () { huggingface-cli download "$@"; }

echo "==============================================="
echo "COMFY_MODELS = $COMFY_MODELS"
echo "STAGE        = $STAGE"
echo "==============================================="

# $1=repo  $2=optional file pattern
download_repo () {
  local repo="$1" file="${2:-}"
  local out="$STAGE/${repo//\//_}"
  echo ">>> [HF] $repo"
  if [[ -n "$file" ]]; then
    hf "$repo" "$file" --local-dir "$out" || echo "!!! 失败: $repo :: $file"
  else
    hf "$repo" --local-dir "$out" || echo "!!! 失败: $repo"
  fi
}

# $1=repo  $2=file_in_repo  $3=dest_subdir
copy_to_models () {
  local repo="$1" file="$2" dest="$COMFY_MODELS/$3"
  local out="$STAGE/${repo//\//_}"
  mkdir -p "$dest"
  if [[ -f "$out/$file" ]]; then
    cp -f "$out/$file" "$dest/$(basename "$file")" && echo "    -> $dest/$(basename "$file")"
  else
    echo "!!! 源文件不存在: $out/$file"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# P0: 质量提升最明显
# ═══════════════════════════════════════════════════════════════════════════
download_p0 () {
  echo ""
  echo "==================== P0: 质量核心 ===================="

  # ── ① Qwen-Image 2.0 满血文本编码器 ──────────────────────────────────────
  # 当前(worker 实测): qwen_2.5_vl_7b_fp8_scaled.safetensors 已存在
  # Qwen-Image 2.0 官方使用 Qwen3-VL 做文本编码器。
  # 由于 Comfy-Org 尚未发布 Qwen3-VL 的量化单文件，这里直接下载 Qwen3-VL-7B-Instruct
  # 满血版(~14GB fp16)，由 ComfyUI 原生 Qwen3-VL 节点或后续转换脚本使用。
  echo ">>> [P0] Qwen-Image 2.0 文本编码器: Qwen3-VL-7B-Instruct 满血"
  download_repo "Qwen/Qwen3-VL-7B-Instruct"
  # 如需单文件 safetensors 供现有 ComfyUI 节点加载，可在此目录运行转换:
  #   python scripts/convert_qwen3vl_to_safetensors.py \
  #     --input "$STAGE/Qwen_Qwen3-VL-7B-Instruct" \
  #     --output "$COMFY_MODELS/text_encoders/qwen_3_vl_7b.safetensors"
  # 若 ComfyUI 节点已支持目录加载，直接软链即可:
  ln -sfn "$STAGE/Qwen_Qwen3-VL-7B-Instruct" "$COMFY_MODELS/text_encoders/qwen_3_vl_7b_instruct" 2>/dev/null || true

  # ── ② Qwen-Image 2.0 扩散模型(如本地尚未部署) ───────────────────────────
  # Qwen-Image 2.0 主权重在 Qwen/Qwen-Image 仓库，包含 transformer/diffusion_model 等
  echo ">>> [P0] Qwen-Image 2.0 扩散模型权重"
  download_repo "Qwen/Qwen-Image"
  # 当前 ComfyUI 节点通常期望 diffusion_models/*.safetensors。
  # 若官方已提供转换后的单文件，取消下面注释:
  # copy_to_models "Qwen/Qwen-Image" "diffusion_model/model.safetensors" "diffusion_models"

  # ── ③ PuLID Flux v0.9.0 ─────────────────────────────────────────────────
  echo ">>> [P0] PuLID Flux v0.9.0"
  # 主 repo 与模型文件
  download_repo "guozinan/PuLID" "pulid_flux_v0.9.0.safetensors"
  copy_to_models "guozinan/PuLID" "pulid_flux_v0.9.0.safetensors" "pulid"

  # PuLID 依赖 CLIP 模型(如本地没有则补)
  echo ">>> [P0] PuLID 依赖: EVA02-CLIP-L"
  download_repo "QuanSun/EVA-CLIP" "EVA02_CLIP_L_336_psz14_s6B.pt"
  copy_to_models "QuanSun/EVA-CLIP" "EVA02_CLIP_L_336_psz14_s6B.pt" "clip_vision"

  # ── ④ ACE-Step 1.5 音乐生成 ─────────────────────────────────────────────
  echo ">>> [P0] ACE-Step 1.5"
  # 官方 base 仓库;如 1.5 发布在新 repo，请替换
  download_repo "ace-studio/ace-step-base"
  # 部署说明：建议独立 conda 环境运行，模型路径通过环境变量 ACE_STEP_MODEL_DIR 指定
  echo "    ACE-Step 模型已下载到 $STAGE/ace-studio_ace-step-base"
  echo "    服务化部署参考: deploy/audio-services/ace-step-service/README.md"

  echo "P0 完成。"
}

# ═══════════════════════════════════════════════════════════════════════════
# P1: 短剧全场景 LoRA + 音频工具
# ═══════════════════════════════════════════════════════════════════════════
download_p1 () {
  echo ""
  echo "==================== P1: 短剧全场景 ===================="

  # ── 场景 LoRA ────────────────────────────────────────────────────────────
  # Civitai 模型需 API token + versionId，下面给出推荐搜索关键词与目标目录。
  # 管家/用户拿到 versionId 后填入 CIVITAI_VERSION_IDS 并重新运行本函数。
  CIVITAI_API_TOKEN="${CIVITAI_API_TOKEN:-}"
  CIVITAI_VERSION_IDS="${CIVITAI_VERSION_IDS:-}"

  download_civitai_lora () {
    local version_id="$1" filename="$2"
    if [[ -z "$CIVITAI_API_TOKEN" ]]; then
      echo "!!! 跳过 Civitai 下载: 未设置 CIVITAI_API_TOKEN"
      return
    fi
    local url="https://civitai.com/api/download/models/$version_id?token=$CIVITAI_API_TOKEN"
    echo ">>> [Civitai] $filename (version=$version_id)"
    curl -L -o "$COMFY_MODELS/loras/$filename" "$url" || echo "!!! 下载失败: $filename"
  }

  if [[ -n "$CIVITAI_VERSION_IDS" ]]; then
    echo ">>> [P1] 按 CIVITAI_VERSION_IDS 下载场景 LoRA"
    # 示例格式: "古风室内:123456,现代办公室:234567"
    IFS=',' read -ra LORA_PAIRS <<< "$CIVITAI_VERSION_IDS"
    for pair in "${LORA_PAIRS[@]}"; do
      name="${pair%%:*}"
      vid="${pair##*:}"
      download_civitai_lora "$vid" "${name}.safetensors"
    done
  else
    echo "!!! [P1] 未设置 CIVITAI_VERSION_IDS，跳过 Civitai LoRA 下载"
    echo "    推荐清单(请自行到 Civitai 搜索 versionId 后填入环境变量):"
    echo "      ancient_chinese_room, hanfu, palace, wuxia, xianxia"
    echo "      modern_office, luxury_apartment, cafe, city_night, corporate"
    echo "      classroom, school_uniform, campus, playground, youth"
    echo "      luxury_car, sports_car, mansion, banquet, business_meeting"
    echo "      magic_spell, explosion, sci_fi_glow, ink_wash, lightning"
  fi

  # ── 音频分离工具(UVR5 + Demucs) ─────────────────────────────────────────
  echo ">>> [P1] 音频分离工具"
  echo "    UVR5: 建议从 https://github.com/Anjok07/ultimatevocalremovergui 下载 Release"
  echo "    Demucs: pip install -U demucs"
  echo "    两者模型首次运行时会自动下载到 ~/.cache/..."
  echo "    部署脚本: deploy/audio-services/uvr5-demucs-service/install.sh"

  echo "P1 完成。"
}

# ═══════════════════════════════════════════════════════════════════════════
# P2: 体验增强
# ═══════════════════════════════════════════════════════════════════════════
download_p2 () {
  echo ""
  echo "==================== P2: 体验增强 ===================="

  # ── LivePortrait ─────────────────────────────────────────────────────────
  echo ">>> [P2] LivePortrait"
  download_repo "KwaiVGI/LivePortrait"
  echo "    模型已下载到 $STAGE/KwaiVGI_LivePortrait"
  echo "    服务化部署参考: deploy/video-services/liveportrait-service/README.md"

  # ── Stable Audio Open ────────────────────────────────────────────────────
  echo ">>> [P2] Stable Audio Open"
  download_repo "stabilityai/stable-audio-open-1.0"
  echo "    模型已下载到 $STAGE/stabilityai_stable-audio-open-1.0"
  echo "    服务化部署参考: deploy/audio-services/stable-audio-service/README.md"

  # ── IC-LoRA / LTX Director LoRA 训练数据集/基线 ──────────────────────────
  echo ">>> [P2] 自训 LoRA 基线"
  echo "    IC-LoRA: 需准备角色多角度图数据集，使用 toiv-trainer/ai-toolkit 训练"
  echo "    LTX Director LoRA: 需准备镜头运动视频数据集，使用 ai-toolkit 或 kohya-ss 训练"
  echo "    训练脚本: deploy/training-lora/README.md"

  echo "P2 完成。"
}

# ═══════════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════════
case "${1:-all}" in
  p0) download_p0 ;;
  p1) download_p1 ;;
  p2) download_p2 ;;
  all)
    download_p0
    download_p1
    download_p2
    ;;
  *)
    echo "用法: bash download_models.sh [p0|p1|p2|all]"
    echo "环境变量:"
    echo "  COMFY_MODELS        (必需) ComfyUI models 目录"
    echo "  CIVITAI_API_TOKEN   (P1 需要) Civitai API token"
    echo "  CIVITAI_VERSION_IDS (P1 可选) 逗号分隔的 name:versionId"
    exit 1
    ;;
esac

echo ""
echo "结束。临时区 $STAGE 确认无误后可删。"
