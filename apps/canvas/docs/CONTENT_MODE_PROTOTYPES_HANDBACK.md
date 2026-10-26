# 内容模式控件三原型 handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
目标：SFW/NSFW（ordinary|adult）主切换从设置灰按钮升为舞台道具；**A/B/C 三版可切换对比**。

## 共性

- 真源：`redline.ts` → GET/PATCH `/api/me/mode`（ordinary|adult）；账号全局；≤30s 轮询
- 切成人：两步确认（非阻断卡）
- 切回普通：既有回落 + NSFW 灰化锁标（未改 redline 业务）
- 色弱双通道：文案「普通/成人」+ 图标（盾/锁/胶片）+ 纹理（光幕/齿孔/刻度虚实）
- 设置页：**撤掉主切换按钮**，保留状态徽标 + 原型切换器 + `focus=r18` 确认闸兼容
- 禁 push；未改后端

## 原型

| ID | 名 | 落点 | 视觉 |
|----|----|------|------|
| **A** | 光幕拨片 | 舞台顶栏居中 | 胶囊轨 + 青光幕滑块；成人=暗紫锁幕+斜纹 |
| **B** | 胶片双轨 | 侧栏脚（默认） | 竖向齿孔胶片；普通哑光灰青 / 成人暗紫+锁 |
| **C** | 相位环 | 舞台右下悬浮 | 刻度环 + 中心字模；成人虚线环+锥纹芯 |

切换：侧栏脚 `A|光幕|胶片|相位环` 短钮，或设置→常用→内容模式「控件原型」。  
`localStorage["toiv_content_mode_prototype"]` = `a|b|c`（默认 `b`）。

## 关键文件

- `apps/canvas/web/src/lib/content-mode-prototype.ts`
- `apps/canvas/web/src/components/content-mode/*`（confirm / hook / switcher / A / B / C / stage-host / css / index）
- `apps/canvas/web/src/components/layout/app-top-nav.tsx`（舞台挂 A/C）
- `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx`（B + 切换器）
- `apps/canvas/web/src/components/layout/workspace-sidebar-update.css`
- `apps/canvas/web/src/components/layout/content-mode-chip.tsx`（shim→FilmModeRail）
- `apps/canvas/web/src/pages/settings/r18-settings-pane.tsx`
- 本文

## 建议截图路径

1. 侧栏切到 **B**：胶片双轨展开态 + 折叠态  
2. 切到 **A**：创作台顶栏光幕拨片（普通/成人各一）  
3. 切到 **C**：右下相位环 + 确认卡  
4. 设置→常用→内容模式：无主灰按钮，有原型切换与状态徽标  

## 自检

- [ ] 三原型均可切 ordinary↔adult，成人需确认  
- [ ] 失败/回落：`ContentModeFallbackTip` 仍工作  
- [ ] 设置页无「切换到成人/切回普通」主按钮  
- [ ] 未 push  
