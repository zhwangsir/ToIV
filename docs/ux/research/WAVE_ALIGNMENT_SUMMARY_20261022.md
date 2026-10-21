# Wave 迭代 · 需求对齐摘要与风险清单

> 日期：2026-10-22（Asia/Shanghai）  
> 状态：**拍板前冻结**；禁止业务编码 / commit / push / 部署  
> 信号门：收到用户【全部按推荐包】后从 Wave Doc 开工  
> 真源：`docs/ux/EXECUTION_MASTER_PLAN_20261022.md`

## 契约

- 自主执行 Agent 接管 Wave 总待办。  
- 拍板前：只梳理 / 校验 / 对齐 / 文档。  
- 拍板后：Doc → Default → P1 → P2 → P3 ‖ Wave M。  
- 默认不 commit / 不 push / 不部署；分支 `work/p0-fusion-20261016`；留痕 `TEST_LOG.md`。  
- Dly 全组暂缓；禁 Toonflow 化 / 关 IndexTTS / 重做切 Ref2VA / 盲抄旧端口。

## 推荐拍板包

D1-A · D2-A · D3-A · D4-C · D5-A · D6-A · D7-A · D8-A

## 依赖顺序

`【全部按推荐包】 → N9∥N6∥N8 → N1→N2 → N3∥N4∥N10+P1 → N7+P2 → N5+P3`  
并行：`M0 → M1①smoke →（明示）下载 → M2 → M3 →（明示）升级 → M4`

仲裁：壳层感知优先；大下载错峰；IndexTTS 与 P2 发版错开。

## 风险（摘要）

| 级 | 风险 | 缓解 |
|----|------|------|
| 高 | 无确认下载/改 gate/重启 TTS | Wave M 确认门 |
| 高 | N7 误判无台词 | 字段写入验收 + assemble 对齐 |
| 中 | N1 默认口 / N2 误摘探针 | 只改 default+example；改前真机扫 |
| 中 | 文档 tip≠生产包 | N6 只文档；部署另窗 |
| 低 | P3 看板 vs 竖排 | D2-A 允许看板轻量档 |

## 默认裁决（附录 C，不另问）

1. N1 IP：跟 core `.env` LAN；端口→8264。  
2. N5 默认视频引擎：H3。  
3. N7：无台词 → assemble 优先。  
4. N3：主 CTA→Studio 空态，按 IA 最小实现。  
5. N2：先扫再摘；可疑探针保留+注释。  
6. Wave M 下载 ≠ 壳层拍板；须另明示。

## 等待

【全部按推荐包】
