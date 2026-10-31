# Landing / Login / Home restyle handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
目标：DramaClaw 级暗色+青蓝一眼新视觉；进 Beef 主壳；禁第二产品；禁抄 DC cinematic TSX。

## 改动文件

| 块 | 文件 |
|----|------|
| 官网 | `apps/web/public/site/index.html`、`apps/web/public/site/styles.css` |
| 登录 | `apps/web/components/landing/LandingPage.tsx`、`apps/web/app/styles/landing.css` |
| 登录后首页 | `apps/canvas/web/src/pages/home/home-dashboard.tsx`、`home-dashboard.css` |
| 本文 | `apps/canvas/docs/LANDING_HOME_RESTYLE_HANDBACK.md` |

## 前后对比要点

### 官网 `/`（静态 site）
| 项 | 前 | 后 |
|----|----|----|
| 画布 | `#0f0f0f` 中性灰 | `#0a0c12` Freezone/DC |
| CTA | 白实心 `#f5f5f5` | 电光青 `#00bdcf` + glow |
| 氛围 | 无 | CSS 侧光/光斑 `stage-glow` / `stage-rays` |
| 样片卡 | 平灰 demo | 海报感边框 + hover 抬升 + accent 描边 |
| 能力卡 | 灰面 | 暗玻璃 + primary soft 图标底 |

### 登录 `/?view=home`（未登录 LandingPage）
| 项 | 前 | 后 |
|----|----|----|
| 默认壳 | minimal 亮 + 近黑 accent | `.landing` 强制暗壳 + `data-mode=dark` |
| Primary | `#242426` | `#00bdcf`；accent 字色 `#5ba0ff` |
| 登录卡 | 浅玻璃 | 暗玻璃 + 青蓝边 |
| 输入 | 亮 surface | `#0d0e14` 场 + 蓝 focus ring |

### 登录后首页 `/studio/`（canvas Home）
| 项 | 前 | 后 |
|----|----|----|
| `--user-accent` 面内 | `#c1c1c5` 灰 | `--home-primary #00bdcf` |
| 新建 CTA | 白块渐变图标 | 青实心按钮 + glow |
| Hero | 灰点阵 ripple | Freezone 光晕面板 |
| 最近项目 | 中性灰卡 | 暗面 + primary 预览底 |

## 建议截图路径（人工）

1. 裸 `/` — 官网 hero + CTA  
2. `/?view=home` 未登录 — 左右登录壳  
3. `/studio/` — 首页新建短剧 hero + 最近短剧  
4. `/studio/create` — 对照创作台同壳（应同暗底节奏）

## 自检清单

- [x] site `:root --background: #0a0c12`；`--primary: #00bdcf`；`--accent: #5ba0ff`
- [x] LandingPage 挂载写 `data-mode=dark`；`.landing` 作用域覆盖 minimal
- [x] home-dashboard 无 `#c1c1c5` 作为主 accent；无白块 create icon
- [x] 未新建营销站 / 第二 auth 壳 / 第三首页路由
- [x] 未改后端、redline、me、mode 业务；未 push

## 许可

仅对齐 `third_party/dramaclaw/DESIGN.md` token 与 Freezone 节奏；未复制 DC `LoginCinematic*` 源码。
