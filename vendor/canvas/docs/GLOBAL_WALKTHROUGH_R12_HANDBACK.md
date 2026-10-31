# Global Walkthrough · R12 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`f0d789a3`（R11）
最终 tip：`git rev-parse HEAD`（本 R12补；基 `ae158cce`）
DNA：accent `#5ba0ff` / cyan `#00bdcf`；文案普通/成人；光幕只在顶栏。  
**未 push / 未 deploy。**

---

## A. 扫到什么

| 类 | 发现 |
|----|------|
| 白底硬编码 | 资产「新建」按钮 CSS+JS 强刷 `#fff`；选中勾 `#fff`；三栏 border mix `#fff`；local-compute fallback `#fff`；队列 log 硬色 |
| 光幕位置 | 顶栏右 `LightCurtainPaddle` 正确；侧栏脚残留 `.app-workspace-sidebar-content-mode` / `.app-workspace-content-mode-chip` CSS（无 JSX 挂载，仍可回魂） |
| 叠层 | 队列 panel 80 / bottom 70、时间线 2/3 为魔法数，未进 `--toiv-z-*` |
| 窄屏双表面 | ≤900px 创作左轨+舞台+详情与工作区侧栏同时露 → 双导航感；侧栏「智能体」与「创作」同指 `/create` 双入口 |
| token 缺口 | z-index / 部分硬色未进 freezone tokens |
| Strangler 漏网 | market 四工具链仍 `/toiv/*-tools`；create 工作区 3D 捷径仍 `image-tools`；**`/toiv/runs/:id` 丢 id**；**`/create/foo` → `/studio/create/foo` 可能 404**；assistant 初态曾强制 home 闪经典壳 |
| 运维备注 | 308 会被 CDN/浏览器永久记住，发版后需硬刷新抽测 |

---

## B. 修了什么

### 运维审回优先三项

| # | 处理 |
|---|------|
| ① `/toiv/runs/:id` 丢 id | **已修**：middleware → `/studio/create?run=$1`（合并既有 query）；canvas `ToivRunToCreateRedirect` → `/create?run=:id`。hash 不达服务端，无法由 middleware 保留（记入风险）。 |
| ② `/create/foo` NotFound | **已修**：middleware `/create` 与 `/create/*` → **`/studio/create`**（不再拼 `$1`）；canvas 增加 `/create/*` → `/create`（保留 query）。 |
| ③ assistant 双轨 | **已确认并收口**：唯一 EXTERNAL `assistant → /studio/create`；无 LEGACY `assistant→home`；初态对 EXTERNAL key 只占位、effect 立刻 `location.replace`；侧栏去掉与「创作」重复的「智能体对话」项。 |

### 其它落地

- 资产新建按钮：Freezone 暗面 + accent；删除 JS `#fff` important
- 选中勾 / 三栏 border / local-compute / 队列 log → token
- `--toiv-z-*`（pane/timeline/drawer/queue/topbar/modal）canvas↔web 双同步；队列/时间线接线
- 侧栏 content-mode 残留类 `display:none`
- ≤900px 隐藏创作左轨（仅舞台+详情）
- market / create 工作区工具链 → `/create`
- 命令面板「智能体」标明创作台同屏

---

## C. 自检

- [x] 光幕仅顶栏右；侧栏脚无主开关可达
- [x] 无新增 iframe 第二壳
- [x] 对外/middleware 无裸 `/create`；`/create/*` → `/studio/create`
- [x] runs 带 `?run=`
- [x] assistant 单 EXTERNAL 轨
- [x] canvas↔web token sync（含 `--toiv-z-*`）
- [x] `f12RetiredRedirects` 测试通过

---

## D. 风险 / 未修项

- **308 缓存**：CDN/浏览器会永久记住旧 Location；发版后硬刷新抽测（本轮不 deploy）
- hash 无法经 middleware 保留（浏览器不上传 fragment）
- `/create?run=` 消费方若尚未读 query，只保证深链不丢 id（UI 接线可后补）
- globals.css 大量浅色主题 `#ffffff` 未本轮清扫（非 Freezone 暗壳主路径）
- 市场/短剧/任务面仍独立，未吞进 create
- 工具页源码仍在仓（路由已断）

---



## F. R12补 · TL 收窄落地（叠 tip）

| 项 | 结果 |
|----|------|
| timeline zoom | **已修**：`creation-studio-preview-timeline.tsx` 读 `--toiv-timeline-zoom-base-pps`（及 min/max/step）；**禁** `96*zoom` |
| aceternityMotion | **已修**：`panel: 0.22` = `--toiv-motion-base:220`；fast 0.15；ease `[0.22,1,0.36,1]` |
| 运维①②③ | 已在 tip `ae158cce`：runs `?run=`；`/create/*`→create；assistant 单 EXTERNAL 轨 |
| P1-3 时间线能力 | **backlog**：拖片长 / 字幕轨 / PlayerChrome / 可拖坞高（见 `PREVIEW_TIMELINE_R8_HANDBACK` §E） |
| P2 全项 | **挂账**：nav 窄轨56 / 渠道抽屉420 / 媒体分页·focus / 节点像素门禁 |

## E. R1–R12 tip 链

| Round | short | 标题 |
|-------|-------|------|
| R1 | `c87a6a02` | Freezone Visual System Reset — design tokens + shell wire |
| R2 | `e68427ac` | Light Curtain — topbar-right first-class paddle |
| R2补 | `eac519c9` | align `--toiv-switch-*` quiet pill（普通|成人） |
| R3 | `73358b6c` | three-pane studio shell（rail \| stage \| inspector） |
| R3补+R4 | `8cfbcab7` | script+storyboard cards + R3 geometry nail |
| R5 | `a140e360` | Freezone node graph visual |
| R6 | `c02226b4` | media pool + NSFW rail；calibrate `--toiv-node-*` |
| R6补 | `4669bf52` | calibrate `--toiv-media-*` library sizes |
| R7 | `1b132535` | generation queue dock |
| R7补 | `e8391a95` | calibrate `--toiv-job-*` queue sizes |
| R8 | `d021f98b` | preview timeline dock |
| R9 | `7087fbfe` | empty / skeleton / soft motion |
| R10 | `d7274c16` | settings model inventory list+drawer |
| R9补+R10补 | `b188df77` | hard-table calibrate（motion/settings） |
| R11 | `f0d789a3` | strangler converge orphan surfaces to create |
| R12 | `ae158cce` | global walkthrough + runs/create/assistant 路由审修 |
| R12补 | `git log -1 --format=%h` | timeline zoom token + aceternityMotion 220 |

