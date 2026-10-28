# BF1.1 · 精选灵感回补 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280
- **口径**：恢复 create 空态「精选灵感 / Skill」；**不**恢复 SoftGlow；**不**回首页意图墙；BF0 composer-first / `beeftv-create` / `?project=` 三栏不动

---

## 做了什么

1. **`CreationFeaturedWorks` 从 HEAD 回补**（与 `0a426713` 块字节一致）
   - `creation-workspace.tsx`：恢复 `listAddedSkills` / `Skill`、`creationCanonSkills`、`creationFeaturedWorks` / `inspirationSource` import
   - 恢复 `creationSkillWorks` + `export function CreationFeaturedWorks`
2. **create 空态挂载**
   - `create/index.tsx`：re-import `CreationFeaturedWorks`
   - 在 `creation-empty-workspace` 内、`creation-launchpad`（含 `CreationEmptySuggest`）**之后**挂回 `<CreationFeaturedWorks onStartPrompt=… />`（对齐 HEAD）
3. **解开 fail-closed 隐藏**
   - `creation-product.css`：去掉 `.creation-empty-workspace > .creation-featured-works { display:none !important }`；保留 empty-art / legacy empty-suggest 隐藏

## 没做什么

- **未**恢复 `ToivSoftGlow`（文件仍缺席）
- **未**改首页 / `homeIntentBarItems`（dashboard 仍禁整墙铺首页）
- **未**改 `?project=` 三栏密台 / BF0 composer-first / `data-surface="beeftv-create"`
- **未**改 `creation-inspirations.ts` / `creation-canon-skills.ts`（数据文件本就在）
- **未 commit / push / deploy / reset --hard / clean**

---

## 验收

| 项 | 结果 |
|---|---|
| create 无 project：精选灵感 / Skill | ✅ FIXTURE 文案命中 |
| 分类 pill：全部灵感 | 视频 | 图片 | 文本 | ✅（计数 22 / 7 / 6 / 9） |
| 卡片：标题 + 副标 +「原创提示词」 | ✅（例：雨夜霓虹…） |
| CTA accent `#4A7FC1` | ✅ `rgb(74, 127, 193)` |
| 首页无快捷意图墙 | ✅ 代码 spot-check（本波未触 home） |
| composer-first / beeftv-create | ✅ workbench 仍 `is-composer-first` + `data-surface="beeftv-create"` |
| SoftGlow | ✅ 仍 ABSENT |
| tip | ✅ `0a426713` |

### Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-bf1_1-create-featured-inspirations.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/bf1_1-create-featured-inspirations.png` |

---

## 改动文件面

- `apps/canvas/web/src/pages/create/creation-workspace.tsx`
- `apps/canvas/web/src/pages/create/index.tsx`
- `apps/canvas/web/src/pages/create/creation-product.css`
- `apps/canvas/docs/shots/fixture-bf1_1-create-featured-inspirations.html`（新增）
- `apps/canvas/docs/shots/bf1_1-create-featured-inspirations.png`（新增）
- `apps/canvas/docs/BF1_1_FEATURED_INSPIRATIONS_HANDBACK.md`（本文件）

**明确：未 commit。停手等 TL 审。**
