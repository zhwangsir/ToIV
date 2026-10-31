# FULL SHELL TEARDOWN · W1-B Create 空态 / 死码 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280
- **口径**：A4.1 安静空态 + A6 accent `#4A7FC1` + B1 `250/67/56`；**未**做 B2 IA / landing / 后端 / DesktopShell

---

## 做了什么

1. **`CreationFeaturedWorks` 源码删除**（非 `?debug=1` 挂回）
   - 自 `creation-workspace.tsx` 移除组件 + `creationSkillWorks` 数据块
   - 卸掉仅服务于瀑布的 import：`listAddedSkills` / `creationCanonSkills` / `creationFeaturedWorks` / `inspirationSource`
   - 默认空态路径本就只挂 `CreationEmptySuggest`（A4.1 灰阶文案 + 单行 CTA）；现无任何回潮入口
2. **`ToivSoftGlow` 无消费者 → 删除**
   - 删 `components/toiv/toiv-soft-glow.tsx`
   - `toiv-empty-loading.css`：去掉可回潮 glow 结构，仅留 fail-closed `::before { display:none }`
   - `creation-studio-three-pane.css` 内 A4 禁用规则保留作防御
3. **数据文件保留**（仍有单测 / 其它入口）
   - `creation-inspirations.ts`、`creation-canon-skills.ts`（`findCreationCanonSkill` 仍被 create/index 使用）— **不再被空态瀑布挂载**

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w1b-create-empty.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w1b-create-empty.png` |

**CTA 采样**：`rgb(74, 127, 193)`（`#4A7FC1`）— 截图像素精确命中（例 x=970,y=315）。

空态表述：无灵感瀑布 / 无 Skill 墙 / 无 Sparkles 图标堆。

---

## 改动文件面

- `apps/canvas/web/src/pages/create/creation-workspace.tsx`
- `apps/canvas/web/src/components/toiv/toiv-soft-glow.tsx`（**删除**）
- `apps/canvas/web/src/components/toiv/toiv-empty-loading.css`
- `apps/canvas/docs/shots/fixture-w1b-create-empty.html`
- `apps/canvas/docs/shots/w1b-create-empty.png`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_W1B_CREATE_DEADCODE_HANDBACK.md`

---

## 验收对照

- [x] 空态无灵感瀑布 / Skill 墙 / Sparkles 堆（源码已删 FeaturedWorks）
- [x] accent 采样 `rgb(74,127,193)`；B1 密度本波未触壳尺寸
- [x] tip `0a426713`；未 commit

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无会话；仅 FIXTURE |
| `creation-inspirations.ts` 仍在仓 | 单测保留；空态不挂；若要物理删数据文件另刀 |
| 线程内消息 `Sparkles` / `WandSparkles` | 非空态墙；不在本波 |
| B2 create 三栏 IA | 明确不做（等 W1 过审） |

**禁 commit / push / deploy。停手等审。**
