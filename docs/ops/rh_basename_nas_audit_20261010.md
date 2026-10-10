# RH basename NAS 对盘（2026-10-10 04:20 Asia/Shanghai）

- 扫描源: `.regen_tmp/capability_gap_scan_market_reset_20261010/`
- public_rh_keep=**79**（scan ok，无 missing basename 再列）
- RH reimport: **deferred**，无精确 basename
- soft-hide: flux1-nunchaku / ltx25-multishot（hide 后不追）

## SenseVoice
- ledger: `docs/MODEL_SOURCES.{md,json}` 已入 `SenseVoiceSmall` ok
- NAS: `audio/SenseVoiceSmall/model.pt` 936291369 / sha256 833ca2dc…a3ea
- NAS SOURCES.md / picker gaps.SenseVoice → 齐

## Basename 齐/缺/blocked

| mark | basename | app | note |
|---|---|---|---|
| 齐 | `ae.safetensors` | flux1-nunchaku | soft-hide；:8196 已有；不追节点 Nunchaku* |
| 齐 | `clip_l.safetensors` | flux1-nunchaku | soft-hide |
| 齐 | `t5xxl_fp8_e4m3fn.safetensors` | flux1-nunchaku | soft-hide |
| blocked | `svdq-fp4_r32-flux.1-dev.safetensors` | flux1-nunchaku | soft-hide+缺节点；NAS 无精确名；不追（hide 后不救） |
| 齐 | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | ltx25-multishot | soft-hide；权重齐但缺 LTXVDualCFGGuider；hide 后不追 |
| 齐 | `ltx-2.5-22b-distilled-transformer-nvfp4.safetensors` | ltx25-multishot | soft-hide |
| 齐 | `ltx-2.5-audio-vae-bf16.safetensors` | ltx25-multishot | soft-hide |
| 齐 | `ltx-2.5-video-vae-bf16.safetensors` | ltx25-multishot | soft-hide |
| 齐 | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` | ltx25-multishot | soft-hide |
| 缺 | `MiniMax-H3-FL2VA-int8_convrot.safetensors` | rh-acc-5759833090 / 6910604290 | 精确名缺；功能等价 h3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors 齐；需别名非重下 |
| 缺 | `MiniMax-H3-audio_vae.safetensors` | rh-acc-5759833090 / 6910604290 | 精确名缺；等价 h3/vae/minimax_h3_audio_vae_fp32.safetensors 齐 |
| 缺 | `MiniMax-H3-video_vae.safetensors` | rh-acc-5759833090 / 6910604290 | 精确名缺；等价 h3/vae/minimax_h3_video_vae_fp16.safetensors 齐 |
| 齐 | `qwen3-vl-32b-int8_convrot.safetensors` | rh-acc-5759833090 | keeper 假阴池：:8195 清单偏少 |
| 齐 | `taeh3.safetensors` | rh-acc-5158893569 | NAS 齐；scan both 偏节点/池 |
| 齐 | `minimax_h3_fl2va_bf16.safetensors` | rh-acc-5158893569 | 齐 |
| 齐 | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | rh-acc-5158893569 | 齐 |

## Matrix hold（仍无精确 basename，未开下）
- SkyReels
- HunyuanVideo(新矩阵)
- FLUX.2

## Blockers
- RH reimport 清单未出 → 无法批量标齐/缺
- MiniMax RH 存储名缺别名（功能权重已在 h3/）——别名需设备/开发侧，非本车道重下
- soft-hide 两卡：节点缺为主；权重大多齐；政策不追

> **2026-10-10 13:05 补记（文档债批）**：上文「ledger 已入 SenseVoiceSmall ok」当时实未提交（`git log -S SenseVoice` 全史为零），本日已 backfill——json totals ok=479/total=816，与本文对齐。本文件自 `.regen_tmp/`（gitignore）迁入 `docs/ops/` 持久化。
