# `/studio/create` 302→home 热修 handback

**日期**: 2026-10-27（Asia/Shanghai）  
**分支**: `work/p0-fusion-20261016`  
**基线**: `8bd97534`  
**范围**: 只修踢回经典壳；**不 push / 不 deploy**

## 公网实锤（修前）

```text
/create            → 308 /studio/create
/studio/create     → 302 /?view=home
/?view=home        → 200（经典薄壳）
BUILD              = 20261026-174816-8bd97534
```

`curl -sSI https://toiv.wineryz.top/studio/create` → `Location: /?view=home`（无 cookie）。

## 根因（一句话）

`apps/web/lib/studioGuard.ts` 的 `decideStudioAccess` 对 **SPA 无/无效 `toiv_session`** 一律 `redirect → LOGIN_HOME (/?view=home)`；登录态在 `localStorage.toiv_token`，中间件看不见。叠加 `page.tsx` EXTERNAL `location.replace('/studio/create')` **未先 exchange**，深链与 `/create` 308 链都会被打回经典壳。

| 环节 | 文件 | 行为 |
|------|------|------|
| 308 | `apps/web/middleware.ts` `RETIRED_FACE_REDIRECTS` | `/create` → `/studio/create`（正确） |
| 302 | `apps/web/lib/studioGuard.ts` + middleware `guardStudio` | SPA 无 cookie → `/?view=home`（故障点） |
| 客户端 | `apps/web/app/page.tsx` `EXTERNAL_VIEW_REDIRECTS` | 不等 auth、不 exchange 就 replace（加重） |

API 闸（401/403/503）未改；非 admin 且未开 `STUDIO_MULTITENANT` 的**已识别**会话仍踢 `CLASSIC_HOME`。

## 修复要点

1. **SPA 无会话 → `pass`**（放行壳）：`decideStudioAccess` 非 API 且 `v.kind !== "ok"` 时不再 302 home。数据面仍靠 `/studio/api/*` + canvas Bearer。
2. **EXTERNAL 深链**：等 `auth !== loading`；`auth === "out"` 停落地/登录；`auth === "in"` 先 `POST /studio/auth/exchange` 再 `location.replace(ext)`（exchange 失败仍进 SPA）。

## 自检

```bash
# 单元（MateBook 仓内）
cd apps/web && node --import ./tests/register.mjs --test \
  tests/studioAdminGuard.test.ts tests/f9HomeHandoff.test.ts \
  tests/studioIdentity.test.ts tests/f12RetiredRedirects.test.ts
# 期望: pass, fail 0
```

### 本地 / 修后验证 `curl -I`（需本机已起 web，默认 :3100）

修前逻辑（与公网一致）：无 cookie 时 `/studio/create` → **302** `/?view=home`。

修后期望：

```bash
# 1) /create 仍 308 到正式创作台（不变）
curl -sSI http://127.0.0.1:3100/create | egrep -i 'HTTP|location'

# 2) 无 cookie：应放行壳（中间件 next / 200），禁止再 302 → /?view=home
curl -sSI http://127.0.0.1:3100/studio/create | egrep -i 'HTTP|location|x-middleware'

# 3) ?view=create：Next 页 200；客户端登录后 exchange→进 /studio/create
curl -sSI 'http://127.0.0.1:3100/?view=create' | egrep -i 'HTTP|location'
```

带登录态（可选）：先

```bash
curl -sS -X POST http://127.0.0.1:3100/studio/auth/exchange \
  -H "authorization: Bearer <ToIV_JWT>" -D - -o /dev/null
# 取出 set-cookie: toiv_session=...
curl -sSI http://127.0.0.1:3100/studio/create \
  -H 'cookie: toiv_session=<JWT>' | egrep -i 'HTTP|location'
```

公网在 **deploy 本 tip 后** 用同样命令；未 deploy 前公网仍为旧 302。

## 风险

| 项 | 说明 |
|----|------|
| 未登录直开 `/studio/create` | 现可看到 SPA 壳；API 仍 401。`?view=create` 未登录停 Landing，不硬撞 studio。 |
| 非 admin + 未开多租户 | 有有效 cookie 时仍 `CLASSIC_HOME`（止血保留）。现网 historically `STUDIO_MULTITENANT=1`。 |
| 308 缓存 | 浏览器可能记住旧链；发版后硬刷新抽测。 |

## 触及文件

- `apps/web/lib/studioGuard.ts`
- `apps/web/middleware.ts`（注释）
- `apps/web/app/page.tsx`
- `apps/web/tests/studioAdminGuard.test.ts`
- `apps/web/tests/f9HomeHandoff.test.ts`
- 本文
