# ToIV Embedding 服务替换变更申请（待项目管家审批）

> 申请日期：2026-07-27
> 来源：`docs/2026-07-27-upgrade-and-cleanup-plan.md` P0-D
> 状态：**✅ 已执行完成（2026-07-27，项目管家部分通过并自动调整后执行）**

---

## 执行结果备忘（项目管家回填）

- **GPU 调整**：GPU3 → **GPU2**（GPU3 Nemotron 已占 87GB，仅剩 8GB；GPU2 余量 42GB）
- **vLLM 参数修正**：`--task embed` → `--runner pooling`（vLLM 0.26.0）；删除 `--moe-backend triton`（dense 模型）；`--max-model-len` 32768 → **16384**（KV cache 限制，16K 仍覆盖整集短剧对白）
- **部署形态**：systemd 服务 `qwen3-embed-vllm.service`（enabled，开机自启，GPU2，`--gpu-memory-utilization 0.15`），模型 `/home/merlin/models/Qwen3-Embedding-4B/`（7.6GB）
- **验收**：维度 2560 ✓ / 容器内 200 ✓ / 中文检索命中 ✓ / Agent 冒烟 ✓ / **634 pytest 通过（2026-07-27 本地复验）** ✓
- **关注项**：GPU2 同时承载 ComfyUI `:8191`， embedding 服务与出图高负载并存时需观察显存争抢

---

## 一、变更目的

ToIV 向量 RAG 当前使用 `text-embedding-nomic-embed-text-v1.5`（137M，768 维，8K 上下文，2024 年模型，中文弱），且其承载端点 LM Studio `:1234` 原配置 IP（192.168.71.100）已过期，当前 RAG 嵌入很可能处于降级状态（检索返回空，Agent 照常工作但无知识库增强）。

替换为 **Qwen3-Embedding-4B**（CMTEB 68.09，32K 上下文，2560 维，Apache 2.0），中文与长文本能力翻倍，可一次性嵌入整集短剧对白。

## 二、变更内容（设备侧，Workstation 192.168.71.127）

| 项 | 现状 | 变更后 |
|----|------|--------|
| 嵌入服务 | LM Studio `:1234`（nomic v1.5，可用性存疑） | vLLM `--task embed` `:1234`（Qwen3-Embedding-4B） |
| 模型来源 | — | ModelScope `Qwen/Qwen3-Embedding-4B`（~8GB，国内源） |
| GPU | — | 建议 GPU3（与 Nemotron 同卡共存），`--gpu-memory-utilization 0.15` 限制占用（FP16 约 8-10GB） |
| 端口 | 1234 | 1234 不变（需先停 LM Studio 避免端口冲突） |

### 建议启动命令

```bash
vllm serve Qwen/Qwen3-Embedding-4B \
  --task embed \
  --port 1234 \
  --gpu-memory-utilization 0.15 \
  --max-model-len 32768 \
  --served-model-name Qwen3-Embedding-4B
```

### 可选项（二期，本次可不执行）

Qwen3-Reranker-4B 部署至 `:1235` 形成"召回+精排"两阶段。当前 ToIV 代码未调用 reranker，本次不部署无影响。

## 三、代码侧改动（已在本地核实，零业务代码改动）

RAG 实现 [rag.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/agent/rag.py) 为纯 OpenAI 兼容调用，模型名/端点全部走环境变量，维度无硬编码（纯 Python 点积），缓存按 `embed_model + 语料` 指纹自动失效重建。因此：

- **代码零改动**，仅需部署时在 `deploy/.env` 覆盖两个变量：

```bash
TOIV_EMBED_BASE_URL=http://192.168.71.127:1234/v1
TOIV_EMBED_MODEL=Qwen3-Embedding-4B
```

- `deploy/docker-compose.yml` 第 24-27 行默认值已指向 `:1234`，无需修改。
- 旧缓存 `rag_cache_*.json` 已 gitignore，指纹机制自动隔离新旧索引，无需手动清理。
- embedding 不可用时 RAG 优雅降级（检索返回空），切换过程不阻塞主链路。

## 四、资源影响评估

| 资源 | 影响 |
|------|------|
| GPU 显存 | +8~10GB（建议 GPU3，与 Nemotron 共存；workstation 4×PRO 6000 余量充足） |
| 磁盘 | +8GB（模型权重） |
| 网络 | 仅首次 ModelScope 下载 |
| 端口 | 1234 被 vLLM 接管，LM Studio 需停用（保留不卸载，用于回滚） |
| 其他服务 | 无影响（ComfyUI 8189-8191 / Nemotron 8000 / TTS 9200 均不动） |

## 五、回滚方案

1. LM Studio 保留不卸载；回滚时停 vLLM embedding 容器/进程，重启 LM Studio `:1234`。
2. `deploy/.env` 将 `TOIV_EMBED_MODEL` 改回 `text-embedding-nomic-embed-text-v1.5`，重建 api 容器。
3. RAG 缓存指纹自动切回旧索引（旧缓存文件仍在），无需任何数据迁移。

## 六、验收标准（部署后由我执行验证）

1. `curl http://192.168.71.127:1234/v1/embeddings` 返回 200，向量维度 = 2560。
2. toiv-api 容器内 `POST /embeddings` 200。
3. 中文短剧对白嵌入质量抽查（同类场景对白余弦相似度 > 英文模型基线）。
4. 后端全量回归：634 pytest 通过（本地已验证基线）。
5. Agent 知识库检索冒烟：提问 ComfyUI 参数类问题，确认 RAG 命中相关 chunk。

## 七、执行请求

请项目管家审批后协助：

1. 在 workstation 停用 LM Studio `:1234`（保留程序用于回滚）。
2. 通过 ModelScope 下载 `Qwen/Qwen3-Embedding-4B` 并按上述命令启动 vLLM（建议纳入现有服务守护方式）。
3. 在 `deploy/.env` 写入第二节的两个环境变量，并 `docker compose up -d api` 生效。
4. 完成后通知我执行第六节验收。
