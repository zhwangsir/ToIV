# WAVE_CLOSE 2026-10-24 — Naming N3 / Deploy Align

**开始**: 2026-10-24 09:47 Asia/Shanghai  
**分支**: `work/p0-fusion-20261016`  
**范围**: 体检报告 P1+P2（命名落地 + commit + 部署 API/web + 真源回写）  
**冻结**: Acc-8Step / Mega · Security Dly · push · DOWN 口上线

## 固定顺序
1. 收尾 P1 代码：Canvas/desktop LLM 别名 → 仅 `deepseek-v4-flash-dspark`；fleet_registry 注释；platform-models/能力文档 DOWN 口；`test_llm_proxy.py` 单模型；apps/ 热路径旧别名
2. 分批 commit（不 push）
   - A: N1 API + tests + .env.example
   - B: docs 真源（CLUSTER_TRUTH / AGENTS / README / archive / TEST_LOG）
   - C: canvas/desktop 别名清理
3. 部署 API → core（`--skip-web`），重启 toiv-api，核 health + 磁盘默认
4. 部署 web（`--web-only` 或全量后半段），对齐 BUILD
5. 回写 CLUSTER_TRUTH / TEST_LOG / 规范 Canvas
6. 终检探针

## 成功标准
- spark `/v1/models` 仅 `deepseek-v4-flash-dspark`
- core 磁盘 `config.py` 默认不再含 `qwen3.6-uncensored` / `:8189`
- fleet roles 真名；health 绿
- 三批 commit 落库、无 secrets、无 push


## 执行结果（2026-10-24 09:50 Asia/Shanghai）

- ✅ P1 代码收尾 + 三批 commit（未 push）
- ✅ API deploy `--skip-web core`
- ✅ Web deploy `--web-only core` BUILD `20261024-014946-52e7db23`
- ✅ 生产 gate 清伪装别名
- ✅ 终检探针绿
- ⏭ 冻结项未做（Acc / Security Dly / push / DOWN）
