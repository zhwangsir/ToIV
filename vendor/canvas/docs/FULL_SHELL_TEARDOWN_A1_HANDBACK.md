# FULL SHELL TEARDOWN · A1 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**（本机无 ToIV Next 登录会话；PNG 为 CSS fixture）

---

## 做了什么（布局重做，非换皮）

1. **共享 desk 原语**（`toiv-freezone-desk.css`）  
   - director 双栏 `.fz-desk-board` / `.fz-desk-main` / `.fz-desk-rail`  
   - `.fz-list` / `.fz-list-row` 密表、`.fz-pill` 筛选、`.fz-stat-strip` 概览  
   - 工具条 4px 栅格、控件 pill h28；poster 条高 44（去海报风）  
   - `.fz-auth-gap` 诚实会话空态样式

2. **工作台 home**（`home-dashboard.tsx` + css）  
   - 左：统计条 + **最近短剧列表行**；右：算力 + 精简工作入口 pill  
   - 加载 → `ToivSkeletonList`；空 → `ToivEmptyState`；失败 → **诚实「列表暂不可用 / 含 401」**，不造假项目

3. **短剧项目**（`drama-page.tsx`）  
   - 卡片网格 → **密表 list-row**；骨架/空态走 Toiv*；401 诚实空态

4. **任务中心**（`tasks-page.tsx`）  
   - 筛选改 `.fz-pill`；空/错 → ToivEmptyState；骨架 → ToivSkeletonList

5. **工具箱**（`market-page.tsx`）  
   - 分类 pill + 空/错诚实空态 + 骨架网格（未扩 A2 创作台）

6. **作品/画板（资产侧）**（`library-page.tsx`）  
   - 收进 fz-desk 工具条 + pill 页签；画板 denser cards；空/错诚实

7. **设置**（`settings-visual.css`）  
   - 分区头更密；`ant-btn-primary` 走 accent（青 `--fz-primary` 仅表单注释保留）

## 未做 / 不扩 scope

| 项 | 说明 |
|---|---|
| A2 创作台扫尾 | timeline zoom / aceternityMotion / play 杂色 — **另刀** |
| 401 会话修复 | 非本岗；UI 只诚实空态 |
| 现网硬刷截图 | 无本地 ToIV 前端会话 |
| media-library 主素材库深改 | 仅 toiv library/画板；完整 `/library` 素材面可后续 |

---

## 改动文件

- `apps/canvas/web/src/styles/toiv-freezone-desk.css`
- `apps/canvas/web/src/pages/home/home-dashboard.tsx`
- `apps/canvas/web/src/pages/home/home-dashboard.css`
- `apps/canvas/web/src/pages/toiv/drama-page.tsx`
- `apps/canvas/web/src/pages/toiv/tasks-page.tsx`
- `apps/canvas/web/src/pages/toiv/market-page.tsx`
- `apps/canvas/web/src/pages/toiv/library-page.tsx`
- `apps/canvas/web/src/pages/settings/settings-visual.css`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A1_HANDBACK.md`（新）
- `apps/canvas/docs/shots/a1-home.png` / `a1-drama.png` / `a1-tasks.png`（+ fixtures）

## 截图绝对路径（FIXTURE · 非现网硬刷）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a1-home.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a1-drama.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a1-tasks.png`

## 阻塞

- 无登录会话 → 无法现网硬刷；401 需会话岗  
- 脏树巨大，仅追加

## 建议 A2 入口

1. `apps/canvas/web/src/pages/create/creation-workbench.tsx`
2. `apps/canvas/web/src/components/create/*`（three-pane / timeline / stage-track）
3. R12 挂账：timeline zoom 读 CSS var；aceternityMotion→220；创作台残色与内部文案扫尾
