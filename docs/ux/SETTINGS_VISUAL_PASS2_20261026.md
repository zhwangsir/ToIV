# 设置页视觉整理 · 二轮 · 2026-10-26

> 目标：模型与算力 / 高级对齐常用区节奏；减长说明；分区标签 + 卡片网格。未 commit。

## 原则（沿用一轮）

1. 分区标签（`settings-block-label`）统一节奏。
2. 长说明压成一行 hint。
3. 卡片轻边框，少嵌套框。
4. 高级 Collapse 卡片化、默认收起。

## 改了什么

| 文件 | 变化 |
|------|------|
| `local-compute-pane.tsx` | 头区短文案；算力状态独立段；通道绑定 2 列 `settings-bind-card` |
| `settings-visual.css` | `settings-compute-stack/grid/bind-card` + 高级 Collapse 卡片化 |
| `index.tsx` | 高级区短说明 + `settings-advanced-stack` + Collapse `bordered={false}` |

## 预览

- 常用：`http://127.0.0.1:3001/settings?section=common`
- 模型与算力：`http://127.0.0.1:3001/settings?section=compute`
- 高级：`http://127.0.0.1:3001/settings?section=advanced`

## 未做

- 渠道表单内部字段再压缩（仍可能偏长，属功能表单）
- 暗色专项
