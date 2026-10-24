> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# 真片 dogfood 全链 · CI 切片

- **对照**: 2026-10-17 波 B 真机 dogfood + P1 e2e(`tmp/p0-20261016/e2e_p1.py`)
- **CI 可跑**: `pytest -m dogfood_ci` → `apps/api/tests/test_dogfood_full_chain_ci.py`
  - SVML→save→reflow dryrun/persist→场景冻结绑定→render/voice/assemble(mock)→E-8 路径闸→EDL
  - 锁定抓漏: `5edc8efc` E-8 URL 双形态、`3b410558` studio 回写→artifacts/video-done 总线
- **不进 CI(真机/nightly)**: Comfy/H3 出片、TTS 克隆、ffmpeg concat、Whisper 转写、QA 帧采样/响度、NAS 落盘
- **工作流**: `.github/workflows/ci.yml` 在 api-tests 全量后显式再跑 `-m dogfood_ci`
