# Wave0+1+2 交付证据（未 push）

## Tip sha
`36039b09`（未 push）

## 路由表（old → new）
| 旧 | 新 | 说明 |
|----|----|------|
| `/create` | `/create` | 单一创作工作台（无 project=自由创作） |
| `/toiv/ws/:id` | `/create?project=:id` | **永久重定向** |
| `/toiv/ws/:id?section=&shot=` | `/create?project=:id&section=&shot=` | query 保留 |
| `/toiv/drama` | `/toiv/drama` | 仍为项目选择列表 |
| 侧栏「新建短剧」 | 台内「新建短剧」 | 一级已移除 |

## 冒测 Checklist
| # | 项 | 结果 |
|---|----|------|
| A | 去 localStorage 真源；me/mode 占位 + 30s | PASS（me/mode 真接线） |
| B | 普通 NSFW 灰化+锁+标签；未知藏 | PASS |
| C | 回落 + 一次性徽标 | PASS |
| D | 侧栏一级无新建短剧 | PASS |
| E | /create+/toiv/ws 合并 + 永久重定向 | PASS |
| F | 设置多设备文案 | PASS |
| G | 普通软化 / 成人不进 | PASS |
| H | 元数据优先；文件名兜底 | PASS |
| 单测 | redline/r18/base-inventory | PASS 18 |

## 回落演示
成人选 NSFW → 切普通 → 回落 Qwen-Rapid-AIO-SFW-v23 / local-wan → 一次性徽标；在途不 abort。

## Wave2 勾选
DramaClaw✅ BeefTV✅ Toonflow部分 LumenX占位 P1未做 — 见 absorption-ledger.md
