#!/usr/bin/env bash
# DRAFT ONLY — reconstructed from live docker inspect on spark01 (2026-11-02).
# Host: spark01 / 192.168.71.82 / dgmt-spark
# Container: dsv41-1017-exl3-tf (TensorFold rank1 worker; NOT dsv4_60 / dsv4-serve.sh)
# Do NOT enable/install from this draft without a change window.
set -euo pipefail

NAME="${CONTAINER_NAME:-dsv41-1017-exl3-tf}"
IMAGE="${IMAGE:-tensorfold-dsv41:exl3-tp2-928adbd0e57d}"
HF_CACHE="${HF_CACHE:-/home/dgmt-spark/.cache/huggingface}"
ENGRAM="${ENGRAM_DIR:-/home/dgmt-spark/.cache/huggingface/toiv-v41-engram-1bae0e10}"
RANK_CACHE="${RANK_CACHE_DIR:-/home/dgmt-spark/.cache/dsv41-tensorfold/rank-cache-45ee5d0f-ablit-0bdc2036}"
SPILL="${SPILL_DIR:-/home/dgmt-spark/.cache/dsv41-tensorfold-spill}"
MASTER="${TF_TP_MASTER:-192.168.200.12}"
PORT="${TF_TP_PORT:-29620}"

mkdir -p "$SPILL" "$(dirname "$RANK_CACHE")"

# Replace any prior instance (live RestartPolicy=no; unit owns lifecycle).
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Foreground run so systemd Type=simple tracks the engine.
# Flags/Binds/Cmd mirrored from: docker inspect dsv41-1017-exl3-tf (spark01)
exec docker run --rm --name "$NAME" \
  --gpus all --runtime=nvidia \
  --ipc=host --network host \
  --ulimit memlock=-1 --ulimit stack=67108864 \
  --cap-add IPC_LOCK \
  --device /dev/infiniband \
  --security-opt label=disable \
  -e HF_HUB_OFFLINE=1 \
  -e NCCL_SOCKET_IFNAME=enp1s0f0np0 \
  -e NCCL_IB_HCA=rocep1s0f0,roceP2p1s0f0 \
  -e NCCL_IB_GID_INDEX=3 \
  -e NCCL_NET_PLUGIN=spcx \
  -e TF_RDMA_GID_INDEX=3 \
  -e TF_DS_SPILL_DIR=/spill \
  -e TF_DS_SPILL_GIB=64 \
  -e TF_DS_SPILL_MIN_FREE_GIB=50 \
  -e TF_DS_SPILL_MIN_TOKENS=8192 \
  -e TF_DS_SPILL_STAGING_MIB=128 \
  -e TF_DS_SPILL_QUOTA=0 \
  -e TF_SPILL_TURNS=4 \
  -e TF_SPILL_FLUSH_MS=60000 \
  -e TF_DS_POOL=2101248 \
  -e TF_DS_WINDOW=1048576 \
  -e TF_DS_STREAMS=4 \
  -e TF_DS_REPLAY_FLOOR=1 \
  -e TF_DS_PREFILL_INTERLEAVE_MS=250 \
  -e TF_DS_KV_SHARD=1 \
  -e TF_DS_KV_SHARD_TWINS=1 \
  -e TF_DS_KV_SHARD_CARRY=1 \
  -e TF_DS_KV_SHARD_CHECK=1024 \
  -e TF_RDMA_IDLE_S=2 \
  -e TF_RDMA_NAP_US=500 \
  -e TF_DS_ENGINE_ID=tensorfold@629c524a0ea5+928adbd0e57d \
  -e TF_DS_RECIPE_PATCHES=928adbd0e57d \
  -e TF_DS_MODEL_REVISION='Mia-AiLab/DeepSeek-V4.1-Flash-1017-EXL3-EAQ-v1-2.9-bpw@45ee5d0fd106c94a3d77f721e09cbb2f50e5a16b,quant=exl3-2.9bpw,ablit=1@0bdc2036113c4fdda38ef6005b3cbc0bc0dfa0f0' \
  -e TF_DS_ENGRAM_REVISION='deepseek-ai/DeepSeek-V4.1-Flash-1017@1bae0e1088993b9b82de08f59de5be5a34e42170' \
  -e TF_DS_RANK_CACHE_SHA='sha256:88ad5503567937fe0f602f1e63c850022082a7633a7a7dd8e51af6e63e2d109e' \
  -v "$HF_CACHE:/hf:ro" \
  -v "$ENGRAM:/engram:ro" \
  -v "$RANK_CACHE:/rank-cache:ro" \
  -v "$SPILL:/spill" \
  "$IMAGE" \
  tf-dsv41-lanes \
    /hf/tensorfold-dsv41/45ee5d0f-ablit-0bdc2036/checkpoint \
    /rank-cache \
    1 2 "$MASTER" "$PORT" \
    /hf/tensorfold-dsv41/kit-abe07c7d/kit \
    --engram /engram \
    --token-map /hf/tensorfold-dsv41/45ee5d0f-ablit-0bdc2036/dsv41_token_map.json \
    --pool 2101248 --streams 4 --drafts 1 --graphs 1 --side 1 \
    --prefetch 1 --aio 1 \
    --rdma rocep1s0f0,roceP2p1s0f0
