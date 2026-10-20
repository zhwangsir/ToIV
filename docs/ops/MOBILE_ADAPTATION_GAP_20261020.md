# 移动端适配缺口图（2026-10-20）

## 三端现状

| 端 | 角色 | 移动就绪度 |
|----|------|------------|
| **canvas `/studio`** | 主 UI（侧栏 + 市场/任务/短剧/无限画布） | 壳层：viewport/PWA/侧栏≤1023 浮层/部分 `@media`；M4-2 `toiv-mobile.css` 已扩产品壳。**无限画布**仅有窄屏 fit + 专注模式，非完整触控编辑 |
| **apps/web** | 薄壳（登录/落地/`/studio` handoff） | `viewport` export + `globals.css` 多档媒体查询；经典生成台已撤 |
| **MiniProgram/** | **唯一原生移动产品**（uni-app，微信优先） | 市场瀑布流(U10a)+运行器(U10b)等已测；README：待微信真机走查/合法域名；勿当已上架 |

融合计划口径（`UI_FUSION_PLAN`）：移动 = SPA 响应式保浏览/任务/库/对话；小程序 = 轻入口；画布深编辑偏桌面。

## 本刀已做（无需产品重设计拍板）

- 扩展 `apps/canvas/web/src/styles/toiv-mobile.css`：市场/任务/工具壳 padding、顶栏折行、搜索满宽、网格收窄、抽屉全宽、44px 触控、safe-area
- `market-page` / `tasks-page` / 工具页挂载 class + 抽屉 `rootClassName="toiv-app-drawer"`
- 契约测 `test/toiv-mobile-shell.test.ts`

## 明确未交付

- 无限画布多指缩放/节点拖拽/框选等**触控手势完整化**
- 小程序微信提审/AppID 配置（用户侧）
- web 经典壳再开一套独立移动 IA（已 handoff 到 `/studio`）

## 请用户拍板的范围

1. **A（推荐默认）**：壳 + ToIV 市场/任务/库/登录可手机用；画布深编辑继续桌面/小程序轻入口  
2. **B**：A + 小程序继续补能力（通知/深链）  
3. **C**：也要无限画布触控一等公民（需单独战役，估人周级）

## 建议下一刀

- 真机 390×844 走查市场运行抽屉 + 任务中心（截图入 `tmp/`）  
- 若选 C：立项「canvas touch viewport」手势与命中区规范  
- MiniProgram 真机权限清单收口（相册/摄像头）
