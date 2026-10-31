# Strangler 收敛 · R11 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
公网创作台：**`/studio/create`**（canvas 内 `/create`）  
硬约束：**禁 iframe 第二壳**；三层路由对齐；**未 push**。

---

## A. 改了什么

把助手 / 引擎工具孤面平滑重定向到创作台；侧栏与命令面板入口改指；web EXTERNAL + middleware 对外一律 `/studio/create`。

未动：短剧 `/toiv/drama`、市场 `/toiv/market`、任务 `/toiv/tasks`、媒体库 `/library`（合法同屏面，非本轮孤面）。

---

## B. 路由表（三层对齐）

| 旧 path / view | middleware 308（外） | EXTERNAL_VIEW（外） | canvas Navigate（内） | 行为 |
|---|---|---|---|---|
| `/create` | → `/studio/create` | — | `/create` 本体 | redirect |
| `?view=create|image|video|generate|ltxstudio` | — | `/studio/create` | — | redirect |
| `?view=assistant` | — | `/studio/create` | — | redirect（原 LEGACY→home） |
| `?view=audio|imageEdit|videoEdit|dub` | — | `/studio/create` | — | redirect |
| `/toiv/agent`、`/toiv/runs/:id` | → `/studio/create` | — | → `/create` | redirect |
| `/toiv/audio`、`/image-tools`、`/video-tools`、`/dub-tools` | → `/studio/create` | — | → `/create` | redirect |
| `/toiv/ws/:id` | （通配先到 `/studio/toiv/ws/:id`） | — | → `/create?project=` | redirect（既有） |
| `/library` | → `/studio/library` | `library`→`/studio/toiv/library`† | `/library` 媒体库 | keep / alias |
| `/market`、`/tasks`、`/toiv/*`（其余） | 既有 F12 表 | 既有 | 既有页 | keep |

† `library` EXTERNAL 仍进 canvas library 链（`/toiv/library`→`/library?source=works`），**不**吞进 create；「旧 library 逃逸」指不再保留经典壳第二入口。

侧栏/命令面板：`智能体对话` 与工具项 → 内链 `/create`（外链等价 `/studio/create`）。

---

## C. 自检（无 iframe）

- [x] 无新增 iframe 嵌旧页当壳
- [x] 对外/middleware 目标无裸 `/create`（一律 `/studio/create`）
- [x] canvas 内 Navigate 用 `/create`，表内已标「内/外」
- [x] matcher 含 `/create`、`/create/:path*`

---

## D. 风险

- `/studio/toiv/agent` 书签依赖 canvas Navigate；middleware 只拦裸 `/toiv/agent`。
- 工具页源码仍在仓内（只断路由）；后续可删页降包体。
- 市场/短剧/任务未收敛——若 TL 下一刀要并进 create，需另表。
- 运维 OpenResty 无专用 location；改 Next/canvas 即可（本轮已改）。
- **未 push**。
