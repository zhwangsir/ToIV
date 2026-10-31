# ToIV · 未成年硬关 FE-only 单锁加固 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **范围**：`apps/canvas/web` only；未动 Cosmos / App Shell / 门面大结构 / `apps/api/**`

---

## 做了什么

1. **`redline.ts` POLICY**  
   - 头注释写明：未成年硬关亦 FE-only；与 content_mode **同锁文件**。  
   - 后端 R5 退役 `require_not_underage` 后，前端仍须可靠拦截。

2. **birthdate 同步（本波核心）**  
   - `normalizeBirthdateIso` / `extractBirthdateFromAuthMe` / `syncBirthdateFromAuthMe`  
   - `GET /auth/me` → `setStoredBirthdate`；字段在但空 → 清本地；字段未透出（R5 前）→ **不动**本地。  
   - 挂点：`refreshAccountContentMode` **先** `await syncBirthdateFromAuthMe()`，再拉/应用 content_mode；`initR18Mode` → `refreshAccountContentMode`（含轮询）。  
   - 同步失败 **永不抛错**。

3. **既有闸自检保留**  
   - `isUnderage()` → `setR18Mode(true)` 返 false；`isR18Mode()` 恒 false  
   - 光幕：`LightCurtainPaddle` 成人钮 `disabled` + `COPY_UNDERAGE_ADULT`  
   - `applyAccountModePayload`：未成年时强制 `ordinary`（防他端脏 adult）

4. **错误分类口径**（`generation-error.ts`）  
   - 主路径 = FE `isUnderage`；旧后端未成年 403 文案仅 **兼容识别**（次路径）。  
   - 额外识别 FE 文案 `COPY_UNDERAGE_ADULT`。

5. **测**  
   - `bun test test/redline-guard.test.ts test/r18-mode.test.ts` → **19 pass / 0 fail**  
   - 增补：extract/normalize birthdate、apply 强制 ordinary、coverage 含 FE-only  
   - light-curtain underage：既有 browser 测仍覆盖 disabled；本波另附 FIXTURE 截图

6. **FIXTURE（可选）**  
   - `apps/canvas/docs/shots/fixture-underage-light-curtain.html`  
   - `apps/canvas/docs/shots/underage-light-curtain-disabled.png`

---

## 改动文件面

| 路径 | 说明 |
|---|---|
| `apps/canvas/web/src/redline.ts` | POLICY + birthdate sync + refresh 挂点 + coverage |
| `apps/canvas/web/src/services/toiv/r18-mode.ts` | 薄 re-export 增补 sync/extract/normalize |
| `apps/canvas/web/src/lib/generation-error.ts` | 未成年 403→次路径注释；FE 文案识别 |
| `apps/canvas/web/test/redline-guard.test.ts` | underage FE-only / birthdate 单测 |
| `apps/canvas/web/test/r18-mode.test.ts` | legacy 403 兼容测改名 + FE 文案 |
| `apps/canvas/docs/UNDERAGE_FE_ONLY_HANDBACK.md` | 本文件 |
| `apps/canvas/docs/shots/fixture-underage-light-curtain.html` | 光幕 underage fixture |
| `apps/canvas/docs/shots/underage-light-curtain-disabled.png` | 截图 |

---

## 关键 diff 摘要（相对工作树；tip 未动）

```text
apps/canvas/web/src/redline.ts                 | POLICY + syncBirthdateFromAuthMe
                                                 + refresh 先同步 birthdate
                                                 + REDLINE_GUARD_COVERAGE 未成年 FE-only
apps/canvas/web/src/services/toiv/r18-mode.ts  | +3 re-export
apps/canvas/web/src/lib/generation-error.ts    | 主路径 FE / 次路径旧 403
apps/canvas/web/test/redline-guard.test.ts     | + extract / force ordinary / coverage
apps/canvas/web/test/r18-mode.test.ts          | legacy underage 403 compat + FE copy
```

（工作树上 `redline.ts` 相对 tip 的大 diff 还含 W1-A 单锁迁入，本波增量是 birthdate/POLICY/refresh 挂点。）

---

## 自检表

| 检查 | 结果 |
|---|---|
| `isUnderage()` + `setR18Mode(true)` → false | PASS（单测） |
| `isR18Mode()` 未成年恒 false | PASS |
| `applyAccountModePayload(adult)` 未成年 → ordinary | PASS |
| 光幕成人钮 disabled + title 含「未满足」 | PASS（既有 browser + FIXTURE） |
| birthdate 空清本地 / 缺字段不动 | PASS（extract 单测） |
| tip `0a426713`；未 commit | PASS |

---

## 残点 / 风险

| 项 | 说明 |
|---|---|
| `/auth/me` 尚未透出 `birthdate` | 当前 API `_user_dict` 无该字段；R5 到位后 sync 自动生效；字段缺省时 **不清** 本地 |
| 现网登录肉眼 | 无本机会话硬刷；FIXTURE 非现网 |
| light-curtain browser 本波未重跑 | 依赖既有 underage case；单元测已绿 |
| 双请求 | refresh 每次额外 GET `/auth/me`（birthdate）；可后波与 mode 合并 |

**禁 commit / push / deploy。停手等审。**
