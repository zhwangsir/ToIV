# Light Curtain · Topbar R2 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`c87a6a02`（Visual System Reset R1）  
合规：B 仓美学重写禁并码；本轮自写挂载/动效，无 A/B 源码复制。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| DramaClaw 安静 pill / chip | B | 胶囊轨形状、弱边静止态 | 不抄组件 |
| BeefTV glow / director `#4f8cff` | B | 成人态 **弱** `glow-director` 辅通道 | 不作主 accent / 地板 |
| R1 `--toiv-*` | repo | 尺寸/色/时长 token | — |
| Toonflow 中灰工具壳 | A 节奏 | 不入光幕 | 不当创作强调 |

**融合**：成人/普通升为顶栏右一等公民；侧栏脚只留账户/更新/深浅色。

---

## B. 1:1 复刻点

| 项 | 值 | 标注 |
|----|-----|------|
| 高度 | `30px` / compact `28px`（`--toiv-light-curtain-h*`） | R1 · TL 28–32 |
| 宽度 | `108`（88–120）/ compact `56` | R1 |
| 字号 | `12px` | R1 |
| 主 accent / 辅 cyan | `#5ba0ff` / `#00bdcf` | TL 钉 |
| 成人弱 glow | `0 0 14px rgb(79 140 255 / .22)` + inset director | B 融合 · director 辅 |
| 成人 fill | `nsfw-lock` `#8b7cff` 14% + 细纹理 | repo |
| 过渡 | `200ms` + `--toiv-ease-out` | DNA / R2 仪式感 |
| 文案+图标 | 「普通/成人」+ ShieldCheck / Lock | 色盲双通道 |

---

## C. 落地蓝图

### 挂载

| 面 | 插入点 | 文件 |
|----|--------|------|
| 产品工作台顶栏右 | `.app-workspace-topbar-actions` 首位（模型配置左侧） | `workspace-top-bar.tsx` |
| 壳层接线 | `AppWorkspaceShell` 渲染 `WorkspaceTopBar` + `WorkspaceTopBarExtensionProvider` | `app-top-nav.tsx` |
| 画布顶栏右（hideChrome） | `canvas-topbar-local-cluster`（lg）全尺寸；`tools-cluster`（&lt;lg）compact | `canvas-project-top-bar.tsx` |
| 侧栏脚 | **已拆除** `LightCurtainPaddle`；保留账户/更新/主题 | `workspace-sidebar-nav.tsx` |

### 视觉数值

- rail：h 30 · pad 2 · radius full · 近透明底 + 细边  
- ordinary veil：cyan 14% soft  
- adult：nsfw-lock 边 40% mix · director 外微光 14px · veil 纹理 + inset glow  
- 确认卡：顶栏/画布下开（`top: calc(100% + 8px)`），不挡标题  
- 禁：正中浮岛、巨幅紫晕、设置页主开关

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 一等公民位 | **顶栏右工具带**（产品 + 画布）；侧栏脚不再是主入口 |
| 绑定 | 既有 `redline` / me/mode / `setR18Mode`；成人两步确认 |
| 只改什么 | 光幕态 + 列表过滤；**不换**底色 token / 路由 / `/create` 唯一台 |
| 设置 | 仅说明 + `?focus=r18`；**拒绝**设置页主开关 |
| 色盲 | 文案 + 锁/盾 + 纹理/色相（普通青辅 / 成人紫锁） |

