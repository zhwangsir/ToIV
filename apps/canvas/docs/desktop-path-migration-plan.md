# 桌面路径迁移方案（BeefTV → ToIV）

状态：P0+P1+P2 已合 tip `37de0363`（feat `040c2862`）。未搬生产数据、未部署。P3（`.beeftv/runtime`、updates 缓存）未做。
基线 tip：`8d22d144`（含 command_guard 品牌文案）。CLI / MCP 协议 id 继续保留 `beeftv`。

## 1. 现状盘点（代码事实）

| 类别 | 当前值 | 位置 |
| --- | --- | --- |
| 桌面默认数据目录 | `…/ToIV`（已改） | `backend/cmd/desktop/main.go` `defaultDataDir` |
| runtimeinfo 默认数据目录 | `…/ToIV`（遗留 `BeefTV` 回退） | `backend/internal/runtimeinfo/runtimeinfo.go` `DefaultDataDir` |
| macOS 安装包名 | `ToIV.app`（认遗留 `BeefTV.app`） | `desktopupdate/config.go`；`/Applications/ToIV.app` |
| Windows 主程序 | `ToIV.exe`（认遗留 `BeefTV.exe`） | updater layout / replace / harness |
| 更新锁 / helper | `.ToIV.update.lock` / `ToIV-update-helper`（仍清遗留 BeefTV 前缀） | `desktopupdate/cleanup.go` `helper.go` |
| 更新缓存 | `<cache>/BeefTV/updates` | `desktopupdate/engine.go` |
| 更新器 UA | `BeefTV-Desktop-Updater/…` | `desktopupdate/http.go`（有意保留，不在本方案） |
| Windows 运行描述符 | `%USERPROFILE%/.beeftv/runtime/<hash>.json` | `runtimeinfo/path_windows.go` |
| 插件后缀 | `.beeftv-plugin` | 协议，本方案不改 |
| MCP / CLI 二进制 | `beeftv` / `beeftv.exe` | 协议，本方案不改 |
| env 覆盖 | `CANVAS_DESKTOP_DATA_DIR`；另认 `BEEFTV_DATA_DIR` | runtimeinfo + desktop |

注释已写「DefaultDataDir 与 defaultDataDir 保持同一套规则」，但实现已分裂：桌面写 `ToIV`，MCP/运行时发现仍读 `BeefTV`。

用户机上典型路径：

- macOS 数据：`~/Library/Application Support/BeefTV`（旧）与可能的 `…/ToIV`（新桌面）
- Windows 数据：`%AppData%\BeefTV`（旧）与可能的 `%AppData%\ToIV`
- 安装：`/Applications/BeefTV.app` 或 `BeefTV.exe` 旁资源

## 2. 目标

1. 默认数据目录统一为 `ToIV`（桌面与 runtimeinfo 一致）。
2. 安装产物对外名逐步变为 `ToIV.app` / `ToIV.exe`（需与 updater、本地脚本、文档同批）。
3. 旧路径可读：首次启动若新目录空、旧目录有数据，则迁移或挂载旧目录（见阶段）。
4. 不改：MCP server id、CLI 命令名、`.beeftv-plugin`、更新器对外 UA、Windows `.beeftv/runtime` 描述符根（可另开刀）。

## 3. 阶段（先方案，再按阶段合代码）

### P0 — 对齐发现路径（小刀，推荐先做）

- `runtimeinfo.DefaultDataDir` 与 `defaultDataDir` 同规则：优先 env，否则 `UserConfigDir()/ToIV`。
- 增加 legacy 回退：若 `ToIV` 不存在且 `BeefTV` 存在，**只读发现**仍指向旧目录（或返回旧路径），避免 MCP 找不到已开着的桌面。
- 单测：新旧目录、仅旧、仅新、env 覆盖、Windows 影子路径不受影响。
- 不做：搬文件、改 `.app` 名。

### P1 — 数据目录迁移（需显式确认后再写）

推荐策略（二选一，合代码前定稿）：

- **A. 一次性 rename/move**：启动时若 `ToIV` 空且 `BeefTV` 非空 → `os.Rename`（跨盘则 copy+verify+标记）；失败则继续用旧路径并记诊断。
- **B. 符号链接 / junction**：`ToIV` → `BeefTV`，写路径用新名、物理仍旧；卸载/升级风险更低，但 Windows junction 要测 MSIX。

硬约束：

- 禁止静默删旧目录。
- 迁移前后对 SQLite 做在线备份（现有桌面更新流程已有备份习惯）。
- `CANVAS_DESKTOP_DATA_DIR` 显式设置时跳过迁移。
- 迁移 marker（如 `ToIV/.migrated-from-beeftv`）防止反复搬。

### P2 — 安装包 / updater 改名（已合 tip `37de0363`）

- `appBundleName` → `ToIV.app`；Windows 主文件 → `ToIV.exe`；helper / lock 前缀同步。
- `scripts/update-local-beeftv-app.sh` 与 release 脚本改目标路径（可保留旧脚本名一版兼容）。
- updater 必须能识别**旧安装路径**上的 `BeefTV.app` 并替换/迁移到 `ToIV.app`（或首次更新仍写旧 bundle，下一版再切——需定一条，避免半新半旧）。
- 文档：`desktop-release.md`、`AGENTS.md` 正式路径、QUICKSTART。

### P3 — 收尾（可选）

- Windows `.beeftv/runtime` → `.toiv/runtime`（读旧写新）。
- 更新缓存目录 `BeefTV/updates` → `ToIV/updates`。
- 仍保留：CLI `beeftv`、插件后缀、UA `BeefTV-Desktop-Updater`（除非产品另行授权）。

## 4. 风险与闸门

| 风险 | 缓解 |
| --- | --- |
| 桌面已写 `ToIV`、MCP 仍找 `BeefTV` → 双开或连不上 | P0 必做 |
| 半迁移导致两套库 | marker + 单写路径；失败回退旧路径 |
| updater 只认 `BeefTV.app` 装不上新包 | P2 与 release 同批；测试 harness 双名 |
| 用户仍开着旧 `.app` | 本地更新脚本先杀旧进程（现有逻辑） |
| 生产 /studio | 本方案不部署、不开闸 |

闸门：每阶段合 main 前 `go test` 覆盖 desktopupdate + runtimeinfo；P1 必须用户或 ToIV开发书面确认策略 A/B；不碰生产刷新。

## 5. 非目标

- 不改 MCP/CLI 协议名 `beeftv`。
- 不改 `.beeftv-plugin` api 与后缀。
- 不在本刀改 Web `/studio` 或生产 token。
- 不在方案阶段搬任何真实用户目录。

## 6. 建议落地顺序

1. 审本方案，确认 P1 选 A 或 B。
2. 合 P0（发现路径对齐 + legacy 回退）。
3. 再开 P1 实现分支；staging/本机干跑后再谈 P2 打包改名。
