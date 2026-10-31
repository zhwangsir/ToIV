# FULL SHELL TEARDOWN · A0 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **对照反例**：公网 `/` 海报、`/?view=home` 登录门、`/studio/create` 杂色+内部文案

---

## A0 做了什么

1. **计划**：`apps/canvas/docs/FULL_SHELL_TEARDOWN_A0_PLAN.md`（含现网三反例硬验收）
2. **消灭登录后「像 1/2」的主因（青抢 CTA）**  
   - `toiv-freezone-desk.css`：`.fz-btn.is-primary` / phase pip / chip / card 渐变 → **`--fz-accent`（`#5ba0ff`）**  
   - 青 `#00bdcf`（`--fz-primary`）留给表单/shadcn，不再当工作台主焦点
3. **DNA 光幕高度**：双端 `toiv-freezone-tokens.css` `--toiv-switch-h` **32→28**；tokens 仍同步（diff 空）
4. **创作台顺手清（反例 3 部分）**  
   - 删除「主舞台留给… / 顶栏光幕」rail 脚注  
   - rail 头去掉误挂的 NSFW lock 徽标装饰；模式只读标签保留  
   - 媒体池脚注 / Inspector 双闸教学文案缩短，去掉调试腔  
   - rail 图标去青；storyboard pending 去青；阶段 chip 激活框改 accent  
   - play 控件 token **36→32**（仍 `#5ba0ff`）
5. **壳路由**：未新建第二壳——既有 `AppWorkspaceShell` 已是登录后唯一 chrome；web 仍 handoff→`/studio/`，`?classic=1` 逃生保留

## A0 未完成 / 留给后续

| 项 | 归口 |
|---|---|
| 工作台/短剧/任务/设置 **布局重做**（非换皮） | **A1** |
| timeline zoom 读 CSS var；aceternityMotion→220；play/其余杂色扫尾 | **A2** |
| 项目列表 **401**（会话/exchange） | 阻塞 · 非纯 UI |
| 未登录 landing 海报气质收敛（可辨但不污染） | **A3** |
| `freezone-shell.browser.test` 仍含浅色创作台期望 | A2 校正 |
| 真机登录硬刷验收 | 需用户会话 |

---

## 改动文件（本轮追加）

- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A0_PLAN.md`（新）
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A0_HANDBACK.md`（新）
- `apps/canvas/docs/shots/a0-home.png` / `a0-shell.png` / `a0-create.png`（+ html fixtures）
- `apps/canvas/web/src/styles/toiv-freezone-desk.css`
- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`
- `apps/canvas/web/src/styles/toiv-local-overrides.css`
- `apps/canvas/web/src/components/create/creation-studio-three-pane.css`
- `apps/canvas/web/src/components/create/creation-studio-asset-rail.tsx`
- `apps/canvas/web/src/components/create/creation-studio-media-pool.tsx`
- `apps/canvas/web/src/components/create/creation-studio-inspector.tsx`

## 静态验收指标（Playwright file://）

- 光幕轨高：**28px**
- play 背景：`rgb(91, 160, 255)` = `#5ba0ff`；尺寸 **32×32**
- 「04 生成」激活：accent ring（非青）

## 截图绝对路径

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a0-home.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a0-shell.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a0-create.png`

> 说明：本机 :3000 非 ToIV Next，无登录会话；截图为 **CSS fixture 静态壳**，非现网硬刷。

## 建议下一刀 A1 入口

1. `apps/canvas/web/src/pages/home/home-dashboard.tsx` + `home-dashboard.css`
2. `apps/canvas/web/src/pages/toiv/drama-page.tsx` / `tasks-page.tsx` / `market-page.tsx`
3. `apps/canvas/web/src/pages/settings`（对照 BeefTV director + DramaClaw 仪表盘密度）
