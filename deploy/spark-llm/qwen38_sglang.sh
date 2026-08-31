#!/bin/bash
# qwen38-flash-next TP=2 SGLang 双机编排 (spark01=node0 192.168.201.13 / spark02=node1 192.168.201.12)
# 用法: bash qwen38_sglang.sh <node0|node1|stop|status> [context_len]
set -uo pipefail

IMG=docker.1ms.run/lmsysorg/sglang:qwen38flashnext
MODEL_DIR=/models/qwen38-flash-next-nvfp4
HEAD_IP=192.168.201.13
NAME=qwen38sg
CTX=${2:-262144}

OVERRIDE=''
if [ "$CTX" -gt 262144 ]; then
  OVERRIDE="--json-model-override-args {\"text_config\":{\"rope_parameters\":{\"mrope_interleaved\":true,\"mrope_section\":[11,11,10],\"rope_type\":\"yarn\",\"rope_theta\":10000000,\"partial_rotary_factor\":0.25,\"factor\":4.0,\"original_max_position_embeddings\":262144}}}"
fi

COMMON_ARGS="--model-path $MODEL_DIR \
  --tp 2 --nnodes 2 \
  --quantization modelopt_fp4 --fp4-gemm-backend flashinfer_cutlass \
  --page-size 64 --mamba-scheduler-strategy extra_buffer --mamba-track-interval 64 \
  --context-length $CTX --mem-fraction-static 0.92 --ple-offload-embedding \
  --chunked-prefill-size 16384 --watchdog-timeout 1800 \
  --max-mamba-cache-size 96 --max-running-requests 12 \
  --reasoning-parser qwen3 --tool-call-parser qwen3_coder \
  --served-model-name qwen3.8-flash-next"

MOUNTS="-v /models:/models:ro \
  -v /tmp/qwen_sparse_attn_backend.py:/sgl-workspace/sglang/python/sglang/srt/layers/attention/qwen_sparse_attn_backend.py:ro \
  -v /tmp/flash_fwd_sm120.py:/usr/local/lib/python3.12/dist-packages/flash_attn/cute/flash_fwd_sm120.py:ro"

ENVS="-e NCCL_SOCKET_IFNAME=enP2p1s0f0np0 \
  -e GLOO_SOCKET_IFNAME=enP2p1s0f0np0 \
  -e SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN=1 \
  -e HF_HUB_OFFLINE=1"

case "${1:-}" in
node0)
  docker rm -f $NAME 2>/dev/null
  docker run -d --name $NAME --network host --shm-size 32g --gpus all --privileged \
    $MOUNTS $ENVS \
    $IMG python3 -m sglang.launch_server $COMMON_ARGS \
      --node-rank 0 --dist-init-addr $HEAD_IP:5000 \
      --host 0.0.0.0 --port 8000 $OVERRIDE
  ;;
node1)
  docker rm -f $NAME 2>/dev/null
  docker run -d --name $NAME --network host --shm-size 32g --gpus all --privileged \
    $MOUNTS $ENVS \
    $IMG python3 -m sglang.launch_server $COMMON_ARGS \
      --node-rank 1 --dist-init-addr $HEAD_IP:5000 $OVERRIDE
  ;;
stop)
  docker rm -f $NAME 2>/dev/null
  ;;
status)
  docker ps --filter name=$NAME --format '{{.Names}} {{.Status}}'
  docker logs --tail 12 $NAME 2>&1
  ;;
*) echo "usage: $0 <node0|node1|stop|status> [context_len]"; exit 1;;
esac
