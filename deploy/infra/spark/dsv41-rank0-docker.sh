#!/usr/bin/env bash
# DRAFT ONLY — reconstructed from live docker inspect on spark02 (2026-11-02).
# Host: spark02 / 192.168.71.84 / dgmt-spark  (API head :8888)
# Container: dsv41-1017-exl3-tf (TensorFold rank0; NOT dsv4_60 / :8000)
# Do NOT enable/install from this draft without a change window.
set -euo pipefail

NAME="${CONTAINER_NAME:-dsv41-1017-exl3-tf}"
IMAGE="${IMAGE:-tensorfold-dsv41:exl3-tp2-928adbd0e57d}"
HF_CACHE="${HF_CACHE:-/home/dgmt-spark/.cache/huggingface}"
ENGRAM="${ENGRAM_DIR:-/home/dgmt-spark/.cache/huggingface/toiv-v41-engram-1bae0e10}"
SPILL="${SPILL_DIR:-/home/dgmt-spark/.cache/dsv41-tensorfold-spill}"

mkdir -p "$SPILL"

docker rm -f "$NAME" >/dev/null 2>&1 || true

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
  -e TF_TP_WORLD=2 \
  -e TF_TP_MASTER=192.168.200.12 \
  -e TF_TP_PORT=29620 \
  -e TF_RDMA_GID_INDEX=3 \
  -e TF_RDMA_DEVICES=rocep1s0f0,roceP2p1s0f0 \
  -e TF_RDMA_IDLE_S=2 \
  -e TF_RDMA_NAP_US=500 \
  -e TF_DS_ENGRAM=/engram \
  -e TF_DS_TOKEN_MAP=/hf/tensorfold-dsv41/45ee5d0f-ablit-0bdc2036/dsv41_token_map.json \
  -e TF_DS_RANK_CACHE=/hf/tensorfold-dsv41/45ee5d0f-ablit-0bdc2036/rank-cache \
  -e TF_DS_KIT=/hf/tensorfold-dsv41/kit-abe07c7d/kit \
  -e TENSORFOLD_CUDA_KERNELS=/hf/tensorfold-dsv41/kit-abe07c7d/kit/aot \
  -e TF_DS_GRAPHS=1 \
  -e TF_DS_HC_SIDE=1 \
  -e TF_DS_L2_PREFETCH=1 \
  -e TF_DS_ENGRAM_AIO=1 \
  -e TF_DS_POOL=2101248 \
  -e TF_DS_WINDOW=1048576 \
  -e TF_DS_STREAMS=4 \
  -e TF_DS_REPLAY_FLOOR=1 \
  -e TF_DS_PREFILL_INTERLEAVE_MS=250 \
  -e TF_DS_KV_SHARD=1 \
  -e TF_DS_KV_SHARD_TWINS=1 \
  -e TF_DS_KV_SHARD_CARRY=1 \
  -e TF_DS_KV_SHARD_CHECK=1024 \
  -e TF_DS_SPILL_DIR=/spill \
  -e TF_DS_SPILL_GIB=64 \
  -e TF_DS_SPILL_MIN_FREE_GIB=50 \
  -e TF_DS_SPILL_MIN_TOKENS=8192 \
  -e TF_DS_SPILL_STAGING_MIB=128 \
  -e TF_DS_SPILL_QUOTA=0 \
  -e TF_SPILL_TURNS=4 \
  -e TF_SPILL_FLUSH_MS=60000 \
  -e TF_DS_ENGINE_ID=tensorfold@629c524a0ea5+928adbd0e57d \
  -e TF_DS_RECIPE_PATCHES=928adbd0e57d \
  -e TF_DS_MODEL_REVISION='Mia-AiLab/DeepSeek-V4.1-Flash-1017-EXL3-EAQ-v1-2.9-bpw@45ee5d0fd106c94a3d77f721e09cbb2f50e5a16b,quant=exl3-2.9bpw,ablit=1@0bdc2036113c4fdda38ef6005b3cbc0bc0dfa0f0' \
  -e TF_DS_ENGRAM_REVISION='deepseek-ai/DeepSeek-V4.1-Flash-1017@1bae0e1088993b9b82de08f59de5be5a34e42170' \
  -e TF_DS_RANK_CACHE_SHA='sha256:813f27dbe5509b7fac433aaac9e8e90159e9b58eeb691911d87f0b10fbdf43df' \
  -v "$HF_CACHE:/hf:ro" \
  -v "$ENGRAM:/engram:ro" \
  -v "$SPILL:/spill" \
  "$IMAGE" \
  tensorfold-native serve \
    /hf/tensorfold-dsv41/45ee5d0f-ablit-0bdc2036/model \
    --backend cuda --host 0.0.0.0 --port 8888 \
    --name DeepSeek-V4.1-Flash-1017 \
    --context 1048576 --parallel 4 --max-tokens 32768 \
    --temperature 1.0 --top-p 0.95 --top-k 20 \
    --thinking \
    --spill-dir /spill --spill-gib 64 \
    --spill-min-free-gib 50 --spill-min-tokens 8192
