#!/bin/bash
set -euo pipefail

export HOME="/Users/dgmt-studio04"
export PATH="$HOME/miniconda3/bin:$PATH"

# Activate conda environment for mlx-vlm
source "$HOME/miniconda3/etc/profile.d/conda.sh"
conda activate toiv-vlm

export TOIV_VLM_MODEL_PATH="${TOIV_VLM_MODEL_PATH:-$HOME/toiv-vlm-mlx/models/Qwen2.5-VL-72B-Instruct-4bit}"
export TOIV_VLM_HOST="${TOIV_VLM_HOST:-0.0.0.0}"
export TOIV_VLM_PORT="${TOIV_VLM_PORT:-9303}"
export TOIV_VLM_MAX_TOKENS="${TOIV_VLM_MAX_TOKENS:-300}"
export TOIV_VLM_TEMPERATURE="${TOIV_VLM_TEMPERATURE:-0.2}"

cd "$HOME/toiv-vlm-mlx"
exec python server.py
