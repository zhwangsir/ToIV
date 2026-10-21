# Wave 流水线收口 · 2026-10-22

> 口令【全部按推荐包】后全自动：Doc → Default → P1 → P2 → P3 ‖ M0  
> 分支 `work/p0-fusion-20261016` · tip 仍 `e5307c63`（改动未 commit）  
> **未** push / 部署 / 下载权重（除 M0 账本）/ 重启

## 已交付

| 波 | 结果 | 测 |
|----|------|-----|
| Doc N9∥N6∥N8 | INVENTORY 横幅；产品方案 tip=ref2va；Drama∥Studio 门禁卡 | 文档 |
| Default N1→N2 | H3 默认 :8264；fleet +9311/8265 | 25 pass |
| P1 N3∥N4∥N10 | 新建短剧；侧栏序；去端口；雨夜 CTA；深链 | 39+1 pass |
| P2 N7+IA | 无台词越过 voice；配音→口型→合成；定妆；管线选择器 | 50+28 pass |
| P3 N5+IA | 创作语义菜单；列表↔看板；右侧检视器 | 24 pass |
| M0 | H3 int8 两条补进 MODEL_SOURCES | 零下载 |

## 残余（不阻塞主闭环）

- **P1.5** ✅ L1 fleet/hold 真接；L5 依赖三态 → **P15_P2_REMAINING_DONE**（执行器 A）  
- **P2** ✅ Job project_id 回跳；跳过口型确认；管线落库；QA 人话 → 同上  
- **P3** ~~竖排流水线；空画布模板/整理；引擎设置面板~~ → **P3_REMAINING_DONE**（执行器 B）  

## 冻结未做

P4 导出切片 · Dly 全组 · Wave M1②+ 下载（须另明示）

## 重大分叉（唯一待你）

若继续保鲜：**明示「做 M1 smoke」或「拉 SFW-v23」**；未明示则 M1+ 不动。  
若要固化代码：**明示 commit**（默认仍不 commit/push）。

> 2026-10-22 清扫 A：P1.5+P2 残余已落地，见 TEST_LOG。
