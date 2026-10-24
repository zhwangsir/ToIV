> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# Wave residual wrap — N2 fleet 探针 + 变体下单 UI

- **时间**：2026-10-22 04:13 Asia/Shanghai
- **分支**：`work/p0-fusion-20261016`（未 commit/push）
- **前置**：D5-A + gate 文档/bak 已收口

## 探针结论

CosyVoice2/3、Qwen3-TTS、ASR、SenseVoice 在 workstation LAN `192.168.71.127` **TCP Connection refused**（04:11）。IndexTTS `:9200` 对照健康。五口改为 `probe=none` 并写入末次探针 note，**不再盲标「待运维确认」且不污染 Admin 在线率分母**；端口声明保留防误删。

## 变体下单

设定卡抽屉新增「画风变体 · 下单」：两档 sheet-orderable 走现网 async；扩展四档明示 API 缺口并展示已登记 `style_variants`。

## 下一可选

fleet CosyVoice 若需再启服务 → 改回 http 探针并清 note；扩展画风产品化下单 API；Mega/Acc smoke；dogfood。
