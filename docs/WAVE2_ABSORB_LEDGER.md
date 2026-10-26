# Wave2 可落地抽并台账（跨端执行）
钉点：2026-10-26 Asia/Shanghai · HEAD commits via `git ls-remote`  
规则（用户死令）：MIT → 可复制代码并标源；AGPL/GPL/NC/ELv2/SAL → 只抽模式/交互节奏/设计 token，实现必须重写；禁整仓白标。本地学习、不商用。  
路径前缀：`apps/canvas/web/src/`（相对 ToIV 仓根）。闸：前端 `redline.ts`（若无则新建于 `lib/`）+ 后端 403 双闸；PrintFilm 式软化仅普通模式。

| P | 源仓 | commit | 许可 | 允许复制代码 | 抽取范围 | 落点建议文件 | 一句：可抽 / 不可抄 |
|---|------|--------|------|--------------|----------|--------------|---------------------|
| P0 | glanderness/BeefTV | `4e832b7e9056e862171b731387f4247fbede8f6f` | SAL 1.0 (+历史 MIT) | **否**（SAL 区）；历史 MIT 文件若可证属 Part B 另议 | 画布+Agent 同屏节奏；节点/导演工具条信息架构；项目-资产-任务-设置导航；暗色工作台 token；审核失败分类→R18 提示文案模式 | `layouts/user-layout.tsx`；`components/layout/workspace-sidebar-nav.tsx`；`components/layout/workspace-top-bar.tsx`；`pages/canvas/canvas-refresh-shell.tsx`；`components/canvas/canvas-toolbar.tsx`；`lib/redline.ts`（新建或既有） | 可抽交互节奏与壳层 IA；不可抄 SAL 覆盖下的源码/白标整壳 |
| P0 | dramaclaw/dramaclaw | `f14b8e4b893f271b605d70b53cc682771dd77682` | ELv2 | **否** | Freezone 左栏+满幅；画布⇄流水线双轨切换；节点圆角/间距 token | `components/layout/workspace-sidebar-nav.tsx`；`components/layout/workspace-page.tsx`；`pages/canvas/canvas-refresh-shell.tsx`；`components/ui/` 下 token CSS 变量（重写） | 可抽双轨壳与暗色 token；不可抄 ELv2 源码或对外托管同款壳 |
| P0 | HBAI-Ltd/Toonflow-app | `30139c931e80476caa718b31684b86383c6e83ce` | MIT | **是**（保留版权头+NOTICE） | 无限画布交互、助手侧栏、节点工作流边界、主题切换实现 | `components/canvas/infinite-canvas.tsx`；`components/canvas/canvas-project-sidebar.tsx`；Agent 侧栏对齐 `pages/toiv/agent-page.tsx` 或 canvas 内助手抽屉；主题：`components/layout/` / 既有 theme provider | 可复制 MIT 画布/侧栏实现并标源；不可整仓改名冒充 Toonflow |
| P0 | alibaba/lumenx | `f2a02e23171447c939e7d8e1386b24d17049bbf1` | MIT | **是**（保留版权头+NOTICE） | 角色三视图/R2V 锁定 UI；分镜表+卡片；Playground 入口 | `components/canvas/canvas-character-reference-modal.tsx`；`canvas-character-reference-node.tsx`；`pages/assets/index.tsx`；`pages/toiv/library-page.tsx`；分镜相关 `storyboard-assets-cell.tsx` | 可复制 MIT 三视图/锁定组件并标源；不可照搬通义托管审核策略 |
| P1 | Heroesjouney/AIMovieStudiov2 | `eb52643b62429ee1a3f94e94ef06f38fc13dfcbb` | AGPL-3.0 | **否** | 3D 舞台 / Timeline / Library 三栏布局节奏 | `lib/plugins/builtin/editor/editor-shell.tsx`；`editor-timeline-panel.tsx`；`components/canvas/canvas-timeline-dialog.tsx`；`library-card-shell.tsx` | 可抽三栏布局节奏；不可抄 AGPL 代码（含 Comfy Driver） |
| P1 | UllrAI/CineGen-ShortDrama | `f823501fc9c9f0daace80c8018db39b1acef94c3` | AniKuku ACL | **否**（无归因商业例外未买） | Shot 网格、首尾帧编辑、侧栏阶段切换交互 | `components/canvas/canvas-grid-split-picker.tsx`；`canvas-video-frame-dialog.tsx`；`pages/toiv/drama-page.tsx` / drama-detail；SVML 类型对齐自有 `types/` | 可抽镜头网格与首尾帧交互；不可无归因并 ACL 源码 |
| P1 | shuyu-labs/BigBanana-AI-Director | `ead7a5ca0513d7c225f72197ac78712a825a9ae9` | Community NC | **否** | Phase 01–04 阶段导航；先资产后镜头 IA | `pages/projects/index.tsx` 或项目向导新建；`pages/create/creation-workspace.tsx` 阶段条 | 可抽阶段导航 IA；不可抄 Community/NC 源码 |

## 执行序（跨端）
1. DramaClaw 壳双轨 + BeefTV IA/工具条节奏（均重写）  
2. Toonflow-app MIT 画布/侧栏（可复制标源）  
3. LumenX MIT 三视图锁定（可复制标源；赶不及可标后续）  
4. P1 三栏/镜头网格/阶段条（均重写）

## 禁
- 整仓白标；把竞品 SaaS 审核软化当成人默认（软化仅普通模式）  
- 将前端闸当成唯一控制而忽略后端 403  
- klaus-2/koma-studio、Toonflow-web 归档仓

详参：[重点仓深挖](https://cursor.com/canvas/store-2a7cb835-7fcb-4cd4-b2c8-cb0ee07b899c/9a6e4b46-d3de-4981-bebf-88a9bdd8c5f6)
