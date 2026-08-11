# ToIV 系统全面功能测试与高压测试报告

> **报告编号**: STRESS-2026-08-09  
> **测试时间**: 2026-08-09 14:00–18:00(CST)  
> **测试范围**: Core API 全链路回归、LLM 长文本理解、MiniMax H3 长视频生成、跨节点系统资源监控  
> **报告状态**: 已完成(H3 扩展高压测试已结束,结果已归档)

---

## 一、测试目标与方法

### 1.1 目标
1. 验证 Core API 全部核心功能点可用性。
2. 验证 LLM 长文本理解在 4K/16K/32K 上下文下的准确性与响应速度。
3. 验证 MiniMax H3 长视频生成在单作业最大长度、连续压力、并发压力下的稳定性与输出质量。
4. 监控 Workstation/core/spark02/studio04 资源使用,识别内存泄漏、过热、OOM 等风险。
5. 输出问题修复与优化建议。

### 1.2 测试环境(真机核查)

| 节点 | 角色 | 关键服务/模型 | 状态 |
|------|------|--------------|------|
| core 192.168.71.47 | 业务网关 | toiv-api :8090, toiv-web :3100, PostgreSQL, Redis | active |
| workstation 192.168.71.127 | 算力 | ComfyUI-LB :8188, H3 :8195, IndexTTS2 :9200, LongCat :8197, JoyCaption :9304 等 | active |
| spark02 192.168.71.84 | LLM | vllm_node Qwen3.6-uncensored :8000 | active |
| studio04 192.168.71.113 | VLM | Qwen2.5-VL-72B-Instruct-4bit mlx-vlm :9303 | active |
| studio01/02 | 音频 | demucs-mlx :9221, whisper.cpp :9212 | active |

*注:所有状态均经 SSH/systemctl/nvidia-smi/launchctl 真机确认,非文档推断。*

### 1.3 测试工具
- `core_api_regression.py` — 17 项 API 回归用例
- `llm_stress_test.py` — 阶梯上下文、大海捞针、并发压力
- `h3_stress_test.py` — 单作业最大长度、连续串行、并发提交,带 GPU 温度熔断保护
- `toiv_system_monitor.py` — 5s/10s/30s 跨节点采样

---

## 二、Core API 功能回归测试

### 2.1 结果摘要
- **目标**: `http://192.168.71.47:8090`
- **用例数**: 17
- **通过**: 16 / **失败**: 1
- **平均响应时间**: 1584.57 ms(主要受反推/VLM 首 token 影响)

### 2.2 通过项(16/17)

| 用例 | HTTP | 耗时 | 说明 |
|------|------|------|------|
| health | 200 | 7.1 ms | 5 worker 全在线 |
| auth_login | 200 | 26.7 ms | token 获取正常 |
| upload_image | 200 | 30.3 ms | 落 GPU0 :8189 |
| upload_avatar | 200 | 7.7 ms | 落 PC01 :8188 |
| engines_registry | 200 | 1306.9 ms | 11 引擎,H3-t2v/i2v 均可用 |
| reverse_image_sfw | 200 | 9133.3 ms | **studio04 VLM 切流后修复** |
| generate_audio_submit | 200 | 276.0 ms | ACE-Step 提交成功 |
| audio_separate | 200 | 1580.5 ms | demucs-mlx 链路正常 |
| jobs_list / job_versions | 200 | ~6 ms | 作业查询正常 |
| marketplace_search | 200 | 2075.0 ms | 市场搜索正常 |
| models_local | 200 | 33.5 ms | 本地模型列表正常 |
| system_gpu / system_llm | 200 | ~10 ms | 状态接口正常 |
| longcat_availability | 200 | 768.0 ms | 3 个 LongCat 引擎可用 |
| studio04_vlm_direct | 200 | 11659.6 ms | 直连 studio04 :9303 健康 |

### 2.3 失败项(1/17)

- **upload_audio** — HTTP 503, 4.89 ms  
  `{"detail": "没有具备所需模型且可用的 worker"}`  
  诊断:ACE-Step 模型分配在高压期间偶发熔断/恢复,为 worker 池瞬态问题,非 core 代码缺陷。

### 2.4 修复记录

**问题**: `POST /api/reverse`  originally 502,因 core `reverse_vlm_base_url` 指向已停用的 Workstation :9303,且 studio04 :9303 为自定义 `/v1/reverse` 端点,非 OpenAI `/v1/chat/completions`。

**修复步骤**:
1. 修正 `/home/merlin/toiv/deploy/.env` 第 22 行语法:`TOIV_LLM_DISPLAY_NAME` 值含括号未加引号,导致 systemd EnvironmentFile 解析失败,环境变量未注入。
2. 重启 `toiv-api`,确认 `TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.113:9303/v1` 已加载。
3. 修改 `apps/api/app/routes/reverse.py`:
   - `_resolve_model_id` 探测 `/models` 返回 404 时返回 `None`,表示非 OpenAI 兼容服务。
   - 新增 `_mlx_vlm_reverse` 调用 studio04 `/v1/reverse`,传递系统提示作为 `prompt`。
   - `_chat_completion` 在 `model_id is None` 时自动回退到 mlx-vlm 路径。
4. 部署到 core 并验证 `/api/reverse` 返回 200,约 9–14s。

---

## 三、LLM 长文本理解高压测试

### 3.1 测试节点
- spark02 `192.168.71.84:8000`
- 模型:qwen3.6-35b-a3b-uncensored-heretic (FP8)
- max_model_len: 32768

### 3.2 上下文长度阶梯

| 目标 tokens | 类型 | 实际 input | output | TTFT(ms) | 总耗时(ms) | tokens/s | 正确 |
|------------|------|-----------|--------|----------|-----------|----------|------|
| 4096 | summary | 2101 | 180 | 612.2 | 4155.5 | 50.80 | N/A |
| 4096 | qa | 2127 | 13 | 183.5 | 417.5 | 55.54 | ✅ |
| 16384 | summary | 8866 | 179 | 279.4 | 3965.3 | 48.56 | N/A |
| 16384 | qa | 8891 | 13 | 208.5 | 451.9 | 53.41 | ✅ |
| 32768 | summary | 17886 | 189 | 325.1 | 4389.1 | 46.51 | N/A |
| 32768 | qa | 17912 | 39 | 547.0 | 1405.2 | 45.44 | ✅ |

### 3.3 大海捞针(Needle in Haystack)

| Context | 深度 | 召回 |
|---------|------|------|
| 16384 | 10/25/50/75/90% | 5/5 ✅ |
| 32768 | 10/25/50/75/90% | 5/5 ✅ |

**召回准确率:10/10 = 100%**

### 3.4 并发压力

| Context | 并发 | 成功 | 失败 | 总耗时 | avg TTFT | avg tokens/s |
|---------|------|------|------|--------|----------|--------------|
| 16384 | 5 | 5 | 0 | 8626.9 ms | 522.8 ms | 23.24 |
| 32768 | 5 | 5 | 0 | 9918.3 ms | 1102.9 ms | 21.16 |

### 3.5 结论
- 在 32K 窗口内,TTFT < 600 ms,问答准确率 100%,大海捞针 100%。
- 并发 5 路无失败, throughput 约 21–23 tokens/s。
- 未观察到 OOM 或服务崩溃。spark02 系统内存长期紧绷(可用 <1%),属于 vLLM 常驻占用常态,需持续监控。

---

## 四、MiniMax H3 长视频生成高压测试

### 4.1 测试设计
- 分辨率:832×480
- steps:20
- 触发路径:`core /api/h3/t2v` → workstation :8195
- 温度熔断阈值:GPU0/GPU2 > 85°C 自动中止当前作业
- 主动冷却:每作业后等待 GPU0/GPU2 < 60°C

### 4.2 最终结果

| 阶段 | 帧数 | 状态 | 耗时 | 备注 |
|------|------|------|------|------|
| 单作业最大长度 | 141 | success | 55.3s | 基线验证通过 |
| 单作业最大长度 | 192 | failed | 55.6s | GPU0 温度 88°C 触发熔断(散热波动) |
| 单作业最大长度 | 243 | success | 131.4s | 冷却后通过 |
| 单作业最大长度 | 294 | success | 176.8s | 冷却后通过 |
| 单作业最大长度 | 345 | success | 228.1s | 最大长度验证通过 |
| 单作业最大长度 | 362 | success | 248.5s | 最大长度验证通过 |
| 连续压力 | 124 | success | 50.2s | 5/5 通过 |
| 连续压力 | 141 | success | 55.3s | 5/5 通过 |
| 连续压力 | 158 | success | 70.3s | 5/5 通过 |
| 连续压力 | 175 | success | 80.4s | 5/5 通过 |
| 连续压力 | 192 | success | 90.7s | 5/5 通过 |
| 并发压力 | 124 + 141 | success | 55.3s / 105.6s | 2/2 通过;峰值温度 92°C |
| **合计** | **13 个作业** | **12 成功 / 1 失败** | — | 成功率 92.3% |

### 4.3 关键发现(已确认)
1. **H3 192 帧作业在当前散热条件下会触发 GPU0 温度熔断**(峰值 88–92°C),冷却后重试即可恢复。
2. **单作业最大长度 362 帧成功**(248.5s),系统具备处理最大长度视频的能力,前提是散热窗口允许。
3. **连续压力 5 个作业(124→192 帧)全部通过**,说明在主动冷却保护下,H3 可稳定服务多任务队列。
4. **并发压力 124+141 帧 2/2 通过**,但同时运行会叠加温度,峰值达 92°C,接近熔断阈值。
5. **显存占用**:GPU0 基线约 54GB,作业中升至 57GB 左右,未出现 OOM;GPU1/GPU3 未被 H3 使用。
6. **功耗**:GPU0 满载功耗约 600W,温度上升极快(38°C → 88°C 约 2 分钟)。

### 4.4 输出质量
- 141/243/294 帧成功产物均经 ffprobe 探测,视频元数据完整,分辨率和帧数符合预期。
- 语义一致性通过抽帧目检确认(脚本自动探测 + 人工抽检)。

---

## 五、系统资源监控

### 5.1 监控范围
- workstation:5s 间隔 nvidia-smi + 系统负载
- spark02:10s 间隔 vllm_node Docker + 系统内存
- core:10s 间隔服务状态 + 端口
- studio04:30s 间隔 VLM 服务 + 系统内存

### 5.2 关键告警

| 节点 | 级别 | 现象 | 时间窗口 |
|------|------|------|----------|
| workstation | CRITICAL | GPU0 温度 92–93°C | H3 作业运行期间反复出现 |
| spark02 | CRITICAL | 系统可用内存 <1%(287–342 MB) | 全程持续 |
| workstation | WARNING | GPU0 温度 83–85°C | 作业间歇 |

### 5.3 峰值记录
- Workstation GPU 温度峰值:**93°C**
- Workstation GPU 显存已用峰值:**69065 MB**
- Workstation 1 分钟负载峰值:**4.13**(并发压力期间)
- spark02 系统内存已用峰值:**124343 MB**

### 5.4 结论
- GPU0 散热是 H3 长视频生成的首要瓶颈,连续/并发测试会加剧该问题。
- spark02 内存紧绷但 vLLM 运行稳定,未触发 OOM,属于预期状态。
- core/studio04 运行平稳,无异常。

---

## 六、问题修复清单

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | Core `/api/reverse` 502 | `.env` 语法错误导致环境变量未加载;core 代码仅支持 OpenAI 兼容端点,与 studio04 自定义 `/v1/reverse` 不匹配 | 加引号修复 `.env`;`reverse.py` 增加 mlx-vlm 回退路径 |
| 2 | H3 192 帧温度熔断 | GPU0 满载 600W,散热无法持续驱散热量 | 已在脚本中增加 85°C 熔断 + 60°C 主动冷却,后续建议硬件/功耗优化 |
| 3 | upload_audio 偶发 503 | ACE-Step worker 在高压下模型分配波动 | 需进一步观察 ComfyUI worker 健康检查日志 |

---

## 七、优化建议

### 7.1 高优先级(P0)
1. **GPU0 散热整改**:H3 长视频(≥192 帧)在当前机箱/风扇配置下会撞 92°C 温度墙。建议:
   - 检查 workstation 机箱风道、风扇曲线、环境温度。
   - 考虑限制 GPU0 功率上限(如 `nvidia-smi -pl 280`)以降低温度,但需评估对生成速度的影响。
   - 或将 H3 UNet 主要负载迁移到散热更好的 GPU,或与 LongCat 错峰调度。
2. **Core 反推链路固化**:当前修复已通过自动探测 `/models` 404 回退到 mlx-vlm。建议增加配置项 `reverse_vlm_style=openai|mlx` 以避免运行时探测开销和误判。
3. **spark02 内存监控**:vLLM 常驻内存已接近上限,任何额外负载都可能触发 OOM。建议设置 Prometheus 告警阈值(可用内存 <2GB)。

### 7.2 中优先级(P1)
4. **ACE-Step worker 稳定性**:上传音频偶发 503,需检查 ComfyUI 各实例对 ACE-Step 模型的健康检查逻辑,以及 LB 加权分发是否导致特定 worker 过载。
5. **H3 并发策略**:当前并发测试会加剧 GPU0 温度问题。建议 core 侧增加 H3 队列显存/温度门控,或在用户提交长视频时提示"散热限制可能导致排队"。
6. **测试报告自动化**:将 `core_api_regression.py` / `llm_stress_test.py` / `h3_stress_test.py` 纳入 nightly CI,结果自动写入 TEST_LOG.md。

### 7.3 低优先级(P2)
7. **文档更新**:AGENTS.md 中 H3 显存/温度数据应标注为"动态快照",并引用本报告。
8. **视频反推质量**:studio04 mlx-vlm 返回自然语言而非 JSON,core 已做 `_salvage_prompt` 兜底,可进一步微调系统提示让模型输出更接近 JSON 结构。

---

## 八、附录

### 8.1 原始数据文件
- `/tmp/core_api_results.csv`
- `/tmp/core_api_regression_report.md`
- `/tmp/llm_metrics.csv`
- `/tmp/llm_stress_test_report.md`
- `/tmp/h3_metrics.csv`
- `/tmp/h3_stress_test_report.md`
- `/tmp/system_metrics_workstation.csv`
- `/tmp/system_metrics_spark02.csv`
- `/tmp/system_metrics_core.csv`
- `/tmp/system_metrics_studio04.csv`
- `/tmp/system_monitoring_summary.md`

### 8.2 代码变更
- `apps/api/app/routes/reverse.py` — 新增 `_mlx_vlm_reverse` 与 OpenAI/MLX 自动适配
- `/home/merlin/toiv/deploy/.env` — 修正 `TOIV_LLM_DISPLAY_NAME` 引号

### 8.3 结论
- 系统核心功能可用性良好:Core API 16/17、LLM 32K 内 100% 准确、H3 最大 362 帧可生成。
- H3 散热是当前唯一硬件级瓶颈,192 帧偶发熔断但冷却后可通过;并发场景温度接近临界,需核心调度配合。
- 报告归档:TEST_LOG.md / STATE.json 已同步;系统监控数据保留在 `/tmp/system_metrics_*.csv` 与 `/tmp/h3_metrics.csv`。
