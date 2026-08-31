# spark-llm: 双 Spark TP=2 主脑(Qwen3.8-Flash-Next-Uncensored NVFP4)

> 2026-08-31 上线。模型:dealignai/Qwen3.8-Flash-Next-UNCENSORED-NVFP4(125B+51B N-gram,MoE 6B 激活,无审查 abliterated,Apache/Qwen Community License 自用)
> 拓扑:spark01(192.168.201.13, node0)+ spark02(192.168.201.12, node1),QSFP 200Gb 直连,NCCL 走 enP2p1s0f0np0
> 镜像:lmsysorg/sglang:qwen38flashnext(arm64,经 docker.1ms.run 镜像站拉取)

## 启停

```bash
# 两台机器 /tmp 下需有:qwen38_sglang.sh + qwen_sparse_attn_backend.py + flash_fwd_sm120.py
ssh sk01-l 'bash /tmp/qwen38_sglang.sh node0 262144'   # API :8000 在 spark01
ssh sk02-l 'bash /tmp/qwen38_sglang.sh node1 262144'
# 停止: bash qwen38_sglang.sh stop(两台分别执行)
```

## 两个必须的上游补丁(挂载覆盖进容器)

1. `qwen_sparse_attn_backend.py`:`_resolve_trtllm_sparse_decode()` 的 `is_sm100_supported()` 把 sm_121(GB10)排除在外,导致 QSA decode 回退到有 bug 的 FA4 cute 路径。补丁改为跳过该检查直接尝试 trtllm-gen。
2. `flash_fwd_sm120.py`:flash-attn-4 在 sm_120/121 的已知崩溃(GitHub Dao-AILab/flash-attention #2453,修复 PR #2484 未合并),补丁手动应用 PR:`__init__` 覆写恢复 `arch=sm_80` + `is_split_kv=False` + `pack_gqa=False`。

## 关键参数与实测

- 生产配置:原生 262144 上下文(不开 YaRN)、mem-fraction 0.92、mamba cache 96、max-running 12、bf16 KV
- **KV cache 不能用 fp8_e4m3**:QSA chunk-prefill triton kernel `tl.dot` 不支持 fp8e4nv rhs,直接 CompilationError 崩调度器
- **YaRN 1M 不可用**:factor 4.0 下 42K/141K token 中段输入输出全 `!!!` 乱码(QSA 索引损坏),957K 长文反而过——质量回归不通过,已否决。1M 待上游修复
- 实测:957,811 token needle 全对(21.6min prefill @738tok/s);141K needle 30s;decode ~23tok/s;工具调用/视觉/并发 8 路全过
- 验收脚本:`qwen38_acceptance.py`(9 项)、`qwen38_1m_needle.py`

## 回滚

spark02 的 27B 旧脑:`docker start vllm_node-v2`(容器保留未删);spark01 VLM:`docker start qwen3vl32b-v2`;core 配置备份 `/home/merlin/toiv/deploy/.env.bak-20260831-qwen38`。

## 注意

- 容器未加 --restart 策略,机器重启后需手动执行上面两条启动命令(权重已在两台 /models/qwen38-flash-next-nvfp4,镜像已拉)
- spark02 上 drt-livekit 三容器仍在(待迁 core,与本服务无资源冲突)
