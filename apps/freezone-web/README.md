# freezone-web (ToIV P0)

DramaClaw Freezone 子应用。ELv2 源在 `vendor/dramaclaw/`（保留 NOTICE / LICENSE / brand）。
本目录 `src/` + `public/` 为 vendor frontend 的可构建副本；改 vendor 后执行：

```bash
pnpm sync:vendor   # scripts/sync-from-vendor.sh
```

**禁**与 `vendor/canvas`（BeefTV）交叉 import / 同路由混装。

## 本地验法（亮壳）

```bash
cd apps/freezone-web
pnpm install
pnpm build          # 必须过
pnpm dev            # http://127.0.0.1:5174  · mode=ce · mock API
```

浏览器打开：

- `http://127.0.0.1:5174/projects/toiv-demo/freezone`
- 任意项目 id 亦可：`/projects/<id>/freezone`（mock 会自动登记项目）

Prime 壳联调（另开终端）：

```bash
cd frontend/app
VITE_FREEZONE_ORIGIN=http://127.0.0.1:5174 pnpm dev
# 登录后打开 /drama/projects/<id>/freezone （basename 多为 /studio）
# 旧书签 /drama/projects/<id>/canvas 会 Navigate → freezone
```

## 许可

Elastic-2.0 — 见 `LICENSE`、`NOTICE`、`../../vendor/dramaclaw/NOTICE`。保留 `public/brand/`。

## 已知缺口

- Gen / jobs / SSE / push / recipes：mock **501**，禁假称已通
- SuperChat / freezone_assistant：product-surfaces **默认关**
- 会话：mock 用户 `toiv-local`，未桥接 ToIV session cookie
- 画布持久化：dev mock **进程内存**（非云端）
- BE freezone 前缀未实现 — 等后端项
