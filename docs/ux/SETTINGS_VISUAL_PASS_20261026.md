# 设置页视觉整理 · 2026-10-26

> 目标：常用区一眼能懂；槽位表为主、快捷示例次要；减少说明噪音；LoRA 管理弹层可读。
> 范围：仅视觉与信息架构；未堆新控件。未 commit。

## 设计原则（5）

1. **槽位表是主表面**：白底分区卡片承载逐行自选；其它块降级为次要条。
2. **少文案**：删重复「主控/过滤规则」长段；hint 压到一行。
3. **层次用留白与字号，不用更多框**：统一 `settings-slot-row` 双列；LoRA 用轻 chip，不用虚线大框。
4. **次要可折叠**：快捷示例默认收起；R18 / 同卡互斥改为安静条，不抢主视线。
5. **弹层信息分层**：标题 → 用途一行 → pill（兼容 / 强度 / trigger），避免标签挤成一团。

## 改了什么

| 文件 | 变化 |
|------|------|
| `settings-visual.css`（新） | 常用区节奏、槽位表面、LoRA chip/卡片、次要条样式 |
| `index.tsx` | 常用区 `settings-common-stack`；算力/角色槽分区标签；导入视觉 CSS |
| `model-slot-table.tsx` | 去长说明；SlotRow/Readonly 改双列；短 helper |
| `slot-lora-row.tsx` | chip 化挂件；弹层卡片 + pill；文案压缩 |
| `model-mix-presets-bar.tsx` | secondary-card；更短标签 |
| `llm-mutex-banner.tsx` | 去高饱和 Amber 大框 → 安静 note |
| `r18-settings-pane.tsx` | 单行开关 + 开启后才展开入口 |

## 预览

`http://127.0.0.1:3001/settings` → **常用**（MateBook）

## 未做

- 模型与算力 / 高级区深度视觉
- 完整 design-system 抽组件
- 暗色专项微调（沿用现有 token）

## 二轮

见 `SETTINGS_VISUAL_PASS2_20261026.md`（模型与算力 / 高级）。
