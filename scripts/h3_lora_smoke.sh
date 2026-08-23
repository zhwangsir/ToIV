#!/usr/bin/env bash
# H3 LoRA 冒烟训练 runner(workstation 上执行,分钟级)
#
# 前置:
#   1. /home/merlin/ai-toolkit 已 clone 且 .venv 依赖装好(torch 2.13 + requirements)
#   2. tokenizer/processor 已预取(HF_ENDPOINT=https://hf-mirror.com snapshot_download
#      MiniMaxAI/MiniMax-H3 allow FL2VA/tokenizer|processor|text_encoder/config.json)
#   3. 冒烟数据集就绪(默认 /home/merlin/datasets/h3_lora_smoke,媒体+同名 .txt)
#
# 做的事:
#   - nvidia-smi 看目标卡余量
#   - 释放 H3 ComfyUI 实例(:8195)模型缓存(不动服务本身)
#   - 跑 ai-toolkit 训练 config/toiv_h3_smoke.yaml(几十步,产出 .safetensors)
#
# 用法: bash scripts/h3_lora_smoke.sh [gpu_index]   默认 GPU2
set -euo pipefail

GPU_INDEX="${1:-2}"
TOOLKIT=/home/merlin/ai-toolkit
SMOKE_CONFIG="$TOOLKIT/config/toiv_h3_smoke.yaml"

echo "== 目标卡 GPU$GPU_INDEX 当前占用 =="
nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU_INDEX"

if [ "$GPU_INDEX" = "2" ]; then
  echo "== 释放 H3 实例 :8195 模型缓存(服务不动) =="
  curl -s -X POST http://localhost:8195/free \
    -H 'Content-Type: application/json' \
    -d '{"unload_models":true,"free_memory":true}' || true
  sleep 3
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU_INDEX"
fi

# 注意:不要设 HF_HUB_OFFLINE=1 —— AutoTokenizer 会探一个子目录里不存在的
# config.json,离线时缓存缺失直接 OSError;走 hf-mirror 在线让小文件 404
# 正常回落(大权重全在本地 MODELS_PATH,不会触发下载)。
export MODELS_PATH=/home/merlin/nas_mount/toiv/comfyui-models/h3
export HF_ENDPOINT=https://hf-mirror.com
cd "$TOOLKIT"
echo "== 启动冒烟训练 =="
CUDA_VISIBLE_DEVICES="$GPU_INDEX" .venv/bin/python run.py "$SMOKE_CONFIG"
