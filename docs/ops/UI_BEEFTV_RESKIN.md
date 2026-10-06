# UI 换肤规范：ToIV Web 按 BeefTV 设计语言（2026-10-06）

> 用户裁决：现有 UI 与 BeefTV 差距大，先按 BeefTV 设计、后续再调整。
> 本档为 token 级换肤的唯一依据；布局/组件结构不动（那属于"后续再调整"）。
> 参照源：`core:/home/merlin/beeftv/web/src/styles/globals.css`（三层 token 架构，21.7k 行）。

## 一、差距诊断（为什么看着"差距大"）

| 维度 | ToIV 现状 | BeefTV | 差距感受来源 |
|---|---|---|---|
| 画布 | #FAFAF9 微暖灰 | #FFFFFF 纯白 | 发灰发旧 |
| 面板阶梯 | #FAFAFA/#F4F4F5/#EBEBEE | 白卡+hairline / neutral-50/100 | 层级含糊 |
| 描边 | rgba(0,0,0,.08) 过淡 | rgba(17,17,17,.13) hairline + 实色 neutral-200 | 边界不清 |
| 圆角 | 控件8/面板12 | 控件12/卡片16（更饱满） | 不够柔和 |
| 排版 | Inter + **Fraunces 衬线展示位** | **纯 Inter**，无衬线 | 混搭显旧 |
| 阴影 | 全软黑影 | 亮靠 hairline 线、暗靠影（elevation 体系） | 浮层发虚 |
| 暗色 | #101114 偏蓝 | #0F0F0F/#181818/#222 纯中性 | 底色偏色 |

## 二、Token 映射表（本次落地的全部改动）

### 亮色 `:root`（minimal 缺省）
| Token | 旧值 | 新值（=BeefTV） |
|---|---|---|
| --bg-canvas | #FAFAF9 | **#FFFFFF** |
| --bg-surface-1 | #FAFAFA | **#FFFFFF**（白卡+hairline，BeefTV 卡=白底靠线） |
| --bg-surface-2 | #F4F4F5 | **#F7F7F8**（neutral-50） |
| --bg-surface-3 | #EBEBEE | **#ECECEE**（neutral-100） |
| --border-subtle | rgba(0,0,0,.08) | **rgba(17,17,17,.13)**（hairline 实测值） |
| --border-strong | rgba(0,0,0,.16) | **rgba(17,17,17,.24)** |
| --text-primary | #17181A | **#0A0A0A**（neutral-950） |
| --text-secondary | #54565C | **#525252**（neutral-600） |
| --text-muted | #64666C | **#6E6E73**（neutral-500 系，AA 保持） |
| --accent | #17181A | **#242426**（BeefTV btn-solid-bg） |
| --accent-hover | #2C2E33 | **#333538** |
| --font-display | Fraunces 衬线 | **Inter 无衬线**（去衬线化） |

### 圆角（对齐 BeefTV control 12 / card 16）
| Token | 旧 | 新 |
|---|---|---|
| --radius-badge | 6px | **8px** |
| --radius-control | 8px | **12px** |
| --radius-panel | 12px | **16px** |

### 阴影（elevation-card 特征：近距+轻远距双层）
| Token | 新值 |
|---|---|
| --shadow-md | 0 1px 2px rgba(0,0,0,.05), 0 2px 6px rgba(0,0,0,.06) |
| --shadow-lg | 0 2px 5px rgba(0,0,0,.05), 0 10px 26px rgba(0,0,0,.10) |
| --shadow-xl | 0 3px 10px rgba(0,0,0,.09), 0 24px 60px rgba(0,0,0,.14) |

### 暗色 `[data-mode="dark"]`（BeefTV #0F0F0F 纯中性系）
| Token | 旧 | 新 |
|---|---|---|
| --bg-canvas | #101114（偏蓝） | **#0F0F0F** |
| --bg-surface-1 | #16181C | **#181818** |
| --bg-surface-2 | #1C1F24 | **#202020** |
| --bg-surface-3 | #23262D | **#2A2A2A** |
| --border-subtle | rgba(255,255,255,.09) | **rgba(255,255,255,.10)** |
| --border-strong | rgba(255,255,255,.16) | **rgba(255,255,255,.18)** |
| --text-muted | （现状） | **#A8A8A8**（BeefTV dark muted） |

### 不动项
- 其余全部预设主题（paper/cinema/graphite）、版型/间距/z-index/断点体系、状态色五套、玻璃材质
- 布局与组件结构（用户明示"后续再调整"）

## 三、验收
1. `themeContrast.test.ts` 等 web 测试全绿（AA 门禁不破）
2. core 真机部署后 BUILD_ID 更新 + 首页/工作台截图目检（白画布、hairline 卡片、12/16 圆角、纯 Inter）
3. 亮/暗两模式各截图一张入档
