#!/bin/zsh
# Start script for com.dgmt.toiv-demucs-mlx
set -euo pipefail

export PATH="/Users/dgmt-studio01/miniconda3/bin:$PATH"
source /Users/dgmt-studio01/miniconda3/bin/activate toiv-demucs-mlx

cd /Users/dgmt-studio01/toiv-demucs-mlx
mkdir -p outputs logs

export TOIV_DEMUX_HOST=0.0.0.0
export TOIV_DEMUX_PORT=9221
export TOIV_DEMUX_MODEL=htdemucs
export TOIV_DEMUX_OUTPUT_DIR=/Users/dgmt-studio01/toiv-demucs-mlx/outputs
export TOIV_DEMUX_BASE_URL=http://192.168.71.109:9221
export TOIV_DEMUX_MAX_AGE_SECONDS=86400
export TOIV_DEMUX_REQUEST_TIMEOUT=600

exec python server.py
