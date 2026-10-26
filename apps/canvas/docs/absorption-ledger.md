# Wave2 可落地抽并台账（跨端执行）

钉点：2026-10-26 Asia/Shanghai · 唯一台账 Page `cd3cf4be`  
规则（用户死令）：MIT → 可复制代码并标源；AGPL/GPL/NC/ELv2/SAL → 只抽模式/交互节奏/设计 token，实现必须重写；禁整仓白标。本地学习、不商用。  
路径前缀：`apps/canvas/web/src/`。闸：前端 `redline.ts` + 后端 403 双闸；软化仅普通模式。

| P | 源仓 | commit | 许可 | 允许复制代码 | 抽取范围 | 落点建议文件 | 可抽 / 不可抄 |
|---|------|--------|------|--------------|----------|--------------|----------------|
| P0 | glanderness/BeefTV | `4e832b7` | SAL 1.0 | **否** | 画布+Agent 同屏；工具条 IA；项目-资产-任务-设置；暗色 token；审核失败→R18 提示 | `workspace-sidebar-nav.tsx`；`canvas-refresh-shell.tsx`；`redline.ts` | 可抽节奏/IA；不可抄 SAL 源码 |
| P0 | dramaclaw/dramaclaw | `f14b8e4` | ELv2 | **否** | 左栏+满幅；画布⇄流水线双轨；节点 token | `workspace-sidebar-nav.tsx`；`toiv-local-overrides.css` | 可抽双轨壳；不可抄 ELv2 |
| P0 | HBAI-Ltd/Toonflow-app | `30139c9` | MIT | **是+NOTICE** | 无限画布、助手侧栏、节点边界、主题 | `lib/absorb/toonflow/*`；assistant float；arrange | 可复制标源；不可整仓冒充 |
| P0 | alibaba/lumenx | `f2a02e2` | MIT | **是+NOTICE** | 三视图/R2V；分镜表+卡片；Playground | `lib/absorb/lumenx/*`；character-reference-modal；shot-card-shell | 可复制标源；不可照搬审核 |
| P1 | AIMovieStudiov2 | `eb52643` | AGPL-3.0 | **否** | 三栏布局节奏 | editor.tsx Stage/Library/Timeline labels | 只抽节奏 |
| P1 | CineGen-ShortDrama | `f823501` | ACL | **否** | Shot 网格、首尾帧 | canvas-grid-split-picker 首尾帧提示 | 只抽交互 |
| P1 | BigBanana-AI-Director | `ead7a5c` | NC | **否** | Phase 导航 IA | creation-phase-strip + workbench chrome | 只抽 IA |

## 执行序
1. DramaClaw 双轨壳 + BeefTV IA（重写）  
2. Toonflow MIT（可复制标源）  
3. LumenX MIT（可复制；赶不及标后续）  
4. P1 三栏/镜头网格/阶段条（重写）

## 落地勾选（2026-10-26 · tip fb1fa5a2）

| 项 | 状态 | 说明 |
|----|------|------|
| P0 DramaClaw 双轨壳 + Freezone token | ✅ 已落地（重写） | Freezone CSS；左栏+满幅；创作台 chrome |
| P0 BeefTV IA / 工具条节奏 | ✅ 已落地（重写） | 一级导航；失败/守卫；`redline.ts` 账号态 |
| P0 Toonflow 画布+助手侧栏 | ✅ 已落地（MIT 复制标源） | arrangeSelection + floating 几何；助手 dock↔float；NOTICE |
| P0 LumenX 三视图/R2V | ✅ 已落地（MIT 复制标源） | character-image + three-view-lock；角色卡三栏锁定；shot card shell；dock 入口 |
| P1 AIMovieStudio 三栏 | ✅ 增量（重写） | editor Stage/Library/Timeline 标签节奏 |
| P1 CineGen 镜头网格 | ✅ 增量（重写） | grid-split 首尾帧提示 |
| P1 BigBanana 阶段条 | ✅ 已落地（重写） | CreationPhaseStrip 01–04 挂创作台 chrome |

详见 `NOTICE-ABSORPTION.md`。
