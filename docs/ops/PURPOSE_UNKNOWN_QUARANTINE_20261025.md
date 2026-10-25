# 用途未核实（P-C）LoRA 隔离记录 — 2026-10-25

> 时区：Asia/Shanghai。依据：`MODEL_PURPOSE_FROM_CARDS_20261025.csv`（purpose_evidence=P-C；P-D=0）。
>
> **策略**：同卷 `mv` 隔离，**未 `rm`**，可回滚。未 commit / 未 push / 未部署。

## 1. 摘要

| 项 | 数量 |
|---|---:|
| CSV 中 P-C basename | 53 |
| 磁盘文件实例已隔离 | 58 |
| 跳过 | 0 |
| 失败 | 0 |
| 产品默认/lora_catalog 引用跳过 | 0（∩ catalog=∅；无 gate 默认硬引用） |

按根：
- `h3_loras`: **8**
- `toiv_loras`: **23**
- `windows_loras`: **27**

隔离后可用库存约计（真机 find `*.safetensors`）：

| 根 | 隔离前 | 隔离后 |
|---|---:|---:|
| `toiv/comfyui-models/loras` | 264 | 239 |
| `toiv/comfyui-models/h3/loras` | 39 | 30 |
| `Windows/.../models/loras` | 129 | 102 |

## 2. 隔离根路径（NAS via workstation CIFS）

```
/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/
  loras/...
  h3/loras/...
/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/
  loras/...
```

相对 NAS 卷：
- `toiv/comfyui-models/_quarantine_purpose_unknown_20261025/`
- `Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/`

## 3. 回滚（整批）

在 `workstation-lan` 上：

```bash
NAS=/home/merlin/nas_mount
Q1=$NAS/toiv/comfyui-models/_quarantine_purpose_unknown_20261025
Q2=$NAS/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025
# 主库 + H3
find "$Q1/loras" -type f -name '*.safetensors' -print0 | while IFS= read -r -d '' f; do
  rel=${f#"$Q1/loras/"}
  mkdir -p "$(dirname "$NAS/toiv/comfyui-models/loras/$rel")"
  mv -- "$f" "$NAS/toiv/comfyui-models/loras/$rel"
done
find "$Q1/h3/loras" -type f -name '*.safetensors' -print0 2>/dev/null | while IFS= read -r -d '' f; do
  rel=${f#"$Q1/h3/loras/"}
  mkdir -p "$(dirname "$NAS/toiv/comfyui-models/h3/loras/$rel")"
  mv -- "$f" "$NAS/toiv/comfyui-models/h3/loras/$rel"
done
# Windows 旧树
find "$Q2/loras" -type f -name '*.safetensors' -print0 | while IFS= read -r -d '' f; do
  rel=${f#"$Q2/loras/"}
  mkdir -p "$(dirname "$NAS/Windows/ComfyUI/ComfyUIModel/models/loras/$rel")"
  mv -- "$f" "$NAS/Windows/ComfyUI/ComfyUIModel/models/loras/$rel"
done
```

单文件回滚：对照下文「原路径 → 新路径」表，反向 `mv`。

## 4. 保护与跳过

- **未动** P-A / P-B。
- **未动** `lora_catalog` 21 张（与 P-C 交集为空）。
- **未动** 当前产品默认/在跑路径上的非 LoRA 权重。
- 账本/选择器里出现的文件名（`docs/MODEL_SOURCES.json`、`docs/NAS_MODEL_PICKER.json`、`apps/api/app/data/model_sources.json`）视为**库存索引**，不是运行默认；已隔离文件对应账本行标 `status=blocked`，**未删行**。
- 断链 symlink：本批 P-C 命中文件均为普通文件（symlink=0），无单独断链项。

## 5. 明细（原路径 → 新路径）

| basename | root | src | dst | size |
|---|---|---|---|---:|
| `PlagueKind-tiddies-realismslider.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/PlagueKind-tiddies-realismslider.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/PlagueKind-tiddies-realismslider.safetensors` | 77580824 |
| `VBVR_H3_attn_only.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/VBVR_H3_attn_only.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/VBVR_H3_attn_only.safetensors` | 32826752 |
| `epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | 155110392 |
| `h3_flywheel_smoke6_20260827.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827.safetensors` | 309964704 |
| `minimax-h3-digicam.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/minimax-h3-digicam.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/minimax-h3-digicam.safetensors` | 155110352 |
| `toiv_h3_smoke_v1_30steps.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/toiv_h3_smoke_v1_30steps.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/toiv_h3_smoke_v1_30steps.safetensors` | 309964696 |
| `tutu-t8-minimax-h3-av-20to8-nfe-lora-step000300-bf16-comfyui.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/tutu-t8-minimax-h3-av-20to8-nfe-lora-step000300-bf16-comfyui.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/tutu-t8-minimax-h3-av-20to8-nfe-lora-step000300-bf16-comfyui.safetensors` | 773709596 |
| `tutu_t8_minimax_h3_av_20to8_nfe_step300_comfyui.safetensors` | h3_loras | `/home/merlin/nas_mount/toiv/comfyui-models/h3/loras/tutu_t8_minimax_h3_av_20to8_nfe_step300_comfyui.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/h3/loras/tutu_t8_minimax_h3_av_20to8_nfe_step300_comfyui.safetensors` | 773709596 |
| `30-360-high.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/30-360-high.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/30-360-high.safetensors` | 306807976 |
| `FullDynamic_Ultimate_Fusion_Elite.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/FullDynamic_Ultimate_Fusion_Elite.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/FullDynamic_Ultimate_Fusion_Elite.safetensors` | 987745068 |
| `Kook_Qwen_V3极致真实.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Kook_Qwen_V3极致真实.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Kook_Qwen_V3极致真实.safetensors` | 236117032 |
| `Kook_Zimage_如梦似幻.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Kook_Zimage_如梦似幻.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Kook_Zimage_如梦似幻.safetensors` | 158818896 |
| `Kook_Zimage_瑶光.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Kook_Zimage_瑶光.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Kook_Zimage_瑶光.safetensors` | 317580200 |
| `LTX-2.3-Guofeng-V0.1.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/LTX-2.3-Guofeng-V0.1.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/LTX-2.3-Guofeng-V0.1.safetensors` | 428150680 |
| `LTX-2.3-OmniNFT-Lora.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/LTX-2.3-OmniNFT-Lora.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/LTX-2.3-OmniNFT-Lora.safetensors` | 1233639152 |
| `LTX2.3-IC-LORA-Dual-Character.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/LTX2.3-IC-LORA-Dual-Character.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/LTX2.3-IC-LORA-Dual-Character.safetensors` | 327287347 |
| `Ltx2.3-Licon-VBVR-I2V-390K-R32-LoRA.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Ltx2.3-Licon-VBVR-I2V-390K-R32-LoRA.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Ltx2.3-Licon-VBVR-I2V-390K-R32-LoRA.safetensors` | 554006432 |
| `Qwen-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Qwen-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Qwen-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 849608296 |
| `Qwen-image Edit Anything to Real Characters动漫转真人.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Qwen-image Edit Anything to Real Characters动漫转真人.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Qwen-image Edit Anything to Real Characters动漫转真人.safetensors` | 354082336 |
| `SESELAORUYAO.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/SESELAORUYAO.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/SESELAORUYAO.safetensors` | 359259656 |
| `WAN22_MoCap_fullbodyCOPY_ED.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/WAN22_MoCap_fullbodyCOPY_ED.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/WAN22_MoCap_fullbodyCOPY_ED.safetensors` | 2129598528 |
| `Wan2.2-Fun-A14B-InP-Fusion-Elite.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/Wan2.2-Fun-A14B-InP-Fusion-Elite.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/Wan2.2-Fun-A14B-InP-Fusion-Elite.safetensors` | 858457612 |
| `WanAnimate_relight_lora_fp16-new.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/WanAnimate_relight_lora_fp16-new.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/WanAnimate_relight_lora_fp16-new.safetensors` | 1436672440 |
| `bounce_test_HighNoise-000005.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/bounce_test_HighNoise-000005.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/bounce_test_HighNoise-000005.safetensors` | 306847584 |
| `gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` | 628203616 |
| `i2l_smoke_20260827.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/i2l_smoke_20260827.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/i2l_smoke_20260827.safetensors` | 19905400 |
| `ltx-2.3-22b-distilled-lora-384_1.1.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/ltx-2.3-22b-distilled-lora-384_1.1.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/ltx-2.3-22b-distilled-lora-384_1.1.safetensors` | 7605507256 |
| `ltx2.3宋玉触发词songyu.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/ltx2.3宋玉触发词songyu.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/ltx2.3宋玉触发词songyu.safetensors` | 100769608 |
| `ltx2.3紫灵触发词ziling.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/ltx2.3紫灵触发词ziling.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/ltx2.3紫灵触发词ziling.safetensors` | 100769608 |
| `ltx2.3韩立触发词hanli.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/ltx2.3韩立触发词hanli.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/ltx2.3韩立触发词hanli.safetensors` | 100769608 |
| `sulphur_lora_rank_768.safetensors` | toiv_loras | `/home/merlin/nas_mount/toiv/comfyui-models/loras/sulphur_lora_rank_768.safetensors` | `/home/merlin/nas_mount/toiv/comfyui-models/_quarantine_purpose_unknown_20261025/loras/sulphur_lora_rank_768.safetensors` | 10268001040 |
| `30-360-high.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/30-360-high.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/30-360-high.safetensors` | 306807976 |
| `BounceHighWan2_2.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/BounceHighWan2_2.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/BounceHighWan2_2.safetensors` | 306847512 |
| `CloseUpFacialCum-v10_High.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/CloseUpFacialCum-v10_High.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/CloseUpFacialCum-v10_High.safetensors` | 306807976 |
| `Kook_Zimage_如梦似幻.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Kook_Zimage_如梦似幻.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Kook_Zimage_如梦似幻.safetensors` | 158818896 |
| `Kook_Zimage_瑶光.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Kook_Zimage_瑶光.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Kook_Zimage_瑶光.safetensors` | 317580200 |
| `NaughtyTimes_pruned_r128_v2.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/NaughtyTimes_pruned_r128_v2.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/NaughtyTimes_pruned_r128_v2.safetensors` | 1121254016 |
| `VBVR_H3_attn_only.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/VBVR_H3_attn_only.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/VBVR_H3_attn_only.safetensors` | 32826752 |
| `Wan22-I2V-HIGH-Hip_Slammin_Assertive_Cowgirl.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22-I2V-HIGH-Hip_Slammin_Assertive_Cowgirl.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22-I2V-HIGH-Hip_Slammin_Assertive_Cowgirl.safetensors` | 306847760 |
| `Wan22-I2V-LOW-Hip_Slammin_Assertive_Cowgirl.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22-I2V-LOW-Hip_Slammin_Assertive_Cowgirl.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22-I2V-LOW-Hip_Slammin_Assertive_Cowgirl.safetensors` | 306847752 |
| `Wan22_CumV3_High.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22_CumV3_High.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22_CumV3_High.safetensors` | 613527272 |
| `Wan22_CumV3_Low.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22_CumV3_Low.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22_CumV3_Low.safetensors` | 613527264 |
| `Wan22_I2V_A14B_FutaTF_lora_v1_high_noise.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22_I2V_A14B_FutaTF_lora_v1_high_noise.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22_I2V_A14B_FutaTF_lora_v1_high_noise.safetensors` | 306808750 |
| `Wan22_I2V_A14B_FutaTF_lora_v1_low_noise.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/Wan22_I2V_A14B_FutaTF_lora_v1_low_noise.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/Wan22_I2V_A14B_FutaTF_lora_v1_low_noise.safetensors` | 306808750 |
| `bounceV03-000084.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/bounceV03-000084.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/bounceV03-000084.safetensors` | 596449384 |
| `chasing_blowjob_wan22_v1.0_000001500_high_noise.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/chasing_blowjob_wan22_v1.0_000001500_high_noise.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/chasing_blowjob_wan22_v1.0_000001500_high_noise.safetensors` | 306808488 |
| `cutifier_krea2.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/cutifier_krea2.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/cutifier_krea2.safetensors` | 228587728 |
| `epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | 155110392 |
| `realism_engine_krea2_v3.1.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/realism_engine_krea2_v3.1.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/realism_engine_krea2_v3.1.safetensors` | 1562410296 |
| `sht_sunian_v1.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/sht_sunian_v1.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/sht_sunian_v1.safetensors` | 85438420 |
| `sht_suxue_v1.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/sht_suxue_v1.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/sht_suxue_v1.safetensors` | 85438420 |
| `sht_xiaoyan_v1.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/sht_xiaoyan_v1.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/sht_xiaoyan_v1.safetensors` | 85438428 |
| `slop_twerk_HighNoise_merged3_7_v2.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/slop_twerk_HighNoise_merged3_7_v2.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/slop_twerk_HighNoise_merged3_7_v2.safetensors` | 306847584 |
| `wan22-f4c3spl4sh-100epoc-high-k3nk.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/wan22-f4c3spl4sh-100epoc-high-k3nk.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/wan22-f4c3spl4sh-100epoc-high-k3nk.safetensors` | 319116504 |
| `wan22-f4c3spl4sh-154epoc-low-k3nk.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/wan22-f4c3spl4sh-154epoc-low-k3nk.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/wan22-f4c3spl4sh-154epoc-low-k3nk.safetensors` | 306807976 |
| `wan_fingering_pussy_i2v2.2hi_v10.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/wan_fingering_pussy_i2v2.2hi_v10.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/wan_fingering_pussy_i2v2.2hi_v10.safetensors` | 306847624 |
| `wan_fingering_pussy_i2v2.2lo_v10.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/wan_fingering_pussy_i2v2.2lo_v10.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/wan_fingering_pussy_i2v2.2lo_v10.safetensors` | 306847624 |
| `zimage_i2l_flatvector_smoke.safetensors` | windows_loras | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/loras/zimage_i2l_flatvector_smoke.safetensors` | `/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models/_quarantine_purpose_unknown_20261025/loras/zimage_i2l_flatvector_smoke.safetensors` | 19905400 |

机器可读日志：[`PURPOSE_UNKNOWN_QUARANTINE_LOG_20261025.tsv`](PURPOSE_UNKNOWN_QUARANTINE_LOG_20261025.tsv)
隔离前清单：[`PURPOSE_UNKNOWN_MANIFEST_PRE_20261025.tsv`](PURPOSE_UNKNOWN_MANIFEST_PRE_20261025.tsv)

## 6. 文档连带更新

- `MODEL_PURPOSE_FROM_CARDS_20261025.csv`：P-C 行加 `availability=quarantined` + `quarantine_dst`（bak `.bak.pre-quarantine`）
- `docs/MODEL_SOURCES.json`：对应 basename `status=blocked`，notes 记 quarantine 日期与 reason（bak `.bak.quarantine-20261025`）
- 本文件 + inventory / RESEARCH 摘要回写
- `TEST_LOG.md` 一行

