# ToIV 浅色主题系统 · 五色板设计规范(2026-08-07)

> 用户决策(2026-08-07):放弃「曜石熔岩」深色单主题,转向浅色体系。
> 五套配色全部落地为可切换预设,默认「素白」。
> 实施前提:全站 token 执行度极高(硬编码 hex 仅 1 处),legacy 别名全部 var() 指向 canonical token,
> 因此在 canonical 层换色即可全站级联,五色板只是 5 组 token 覆盖块。

> ⚠️ **AA 勘误(2026-08-07,axe 门禁驱动)**:下文色板中 muted/accent/状态色的初版取值在浅色底上对比度不足,
> 已按 axe color-contrast serious 零容忍加固,**实际落地值以 `apps/web/app/globals.css` 为准**。差异如下:
> - 各主题 `--text-muted` 全部加深至 canvas/surface-3 上 ≥4.5:1:paper `#686A70`、wood `#665D4F`、mono `#636363`、mint `#4C665D`、apricot `#6A5B47`
> - 彩色 accent 加深至"accent 文本压在 accent-soft 底上"≥4.5:1:wood `#2F63B4`(hover `#2755A0`)、mint `#0A7158`(hover `#096049`)、apricot `#8A5429`(hover `#7A4822`);apricot secondary 加深为 `#675945`
> - 状态色加深:ok `#0C6B34`、warn `#9A5408`、err `#C81E1E`(soft 底 alpha 不变)

## 一、主题机制

- `:root` = 默认主题「素白」全部 token;其余 4 套用 `[data-theme="wood"|"mono"|"mint"|"apricot"]` 覆盖差异 token。
- 选择持久化 `localStorage["toiv_theme"]`;`layout.tsx` head 内联脚本在首帧前写入 `document.documentElement.dataset.theme`,杜绝 FOUC。
- `color-scheme: light`(表单控件/滚动条跟随);`themeColor` meta 改 `#FFFFFF`。
- 切换入口:灵动岛账户 Popover 内「主题」五色色板行(桌面),移动端「更多」抽屉同款。
- 深色主题整体移除,不做第六套(用户明确 redirect;维护 6 套玻璃/阴影成本翻倍)。

## 二、五套色板(全部 token 值)

### T1 素白 paper(默认)— 白色为主,黑色文字,极少量灰色点缀

| token | 值 |
|---|---|
| --bg-canvas | `#FFFFFF` |
| --bg-surface-1 | `#FAFAFA` |
| --bg-surface-2 | `#F4F4F5` |
| --bg-surface-3 | `#EBEBEE` |
| --border-subtle | `rgba(0,0,0,0.08)` |
| --border-strong | `rgba(0,0,0,0.16)` |
| --text-primary | `#17181A` |
| --text-secondary | `#54565C` |
| --text-muted | `#9A9CA3`(canvas 上 3.1:1,仅辅助/占位;正文级辅助用 secondary) |
| --accent | `#17181A`(近黑 CTA) |
| --accent-hover | `#2C2E33` |
| --accent-soft | `rgba(23,24,26,0.07)` |
| --accent-glow | `rgba(23,24,26,0.18)` |
| --text-on-accent | `#FFFFFF` |
| --accent-glow-shadow | `0 2px 12px rgba(0,0,0,0.18)` |
| --glass-bg | `rgba(255,255,255,0.72)` |
| --glass-border | `rgba(0,0,0,0.08)` |
| --glass-highlight | `inset 0 1px 0 rgba(255,255,255,0.65)` |

### T2 浅木淡蓝 wood — 白+浅木+淡蓝,自然明亮

| token | 值 |
|---|---|
| --bg-canvas | `#FDFCF9` |
| --bg-surface-1 | `#F7F2EA`(浅木) |
| --bg-surface-2 | `#F1EADD` |
| --bg-surface-3 | `#E8DFCE` |
| --border-subtle | `rgba(74,59,42,0.10)` |
| --border-strong | `rgba(74,59,42,0.20)` |
| --text-primary | `#2B2723` |
| --text-secondary | `#6B6154` |
| --text-muted | `#A39886` |
| --accent | `#4C86D9`(淡蓝) |
| --accent-hover | `#3D76CB` |
| --accent-soft | `rgba(76,134,217,0.12)` |
| --accent-glow | `rgba(76,134,217,0.28)` |
| --text-on-accent | `#FFFFFF` |
| --accent-glow-shadow | `0 2px 12px rgba(76,134,217,0.30)` |
| --glass-bg | `rgba(253,252,249,0.74)` |
| --glass-border | `rgba(74,59,42,0.10)` |

### T3 永恒中性 mono — 黑白灰经典,专业沉稳

| token | 值 |
|---|---|
| --bg-canvas | `#F5F5F4`(灰画布,白卡浮其上——与 T1 的白画布灰卡互为反转) |
| --bg-surface-1 | `#FFFFFF` |
| --bg-surface-2 | `#F4F4F4` |
| --bg-surface-3 | `#E9E9E9` |
| --border-subtle | `rgba(0,0,0,0.09)` |
| --border-strong | `rgba(0,0,0,0.17)` |
| --text-primary | `#111111` |
| --text-secondary | `#4B4B4B` |
| --text-muted | `#8C8C8C` |
| --accent | `#111111` |
| --accent-hover | `#2A2A2A` |
| --accent-soft | `rgba(0,0,0,0.07)` |
| --accent-glow | `rgba(0,0,0,0.16)` |
| --text-on-accent | `#FFFFFF` |
| --accent-glow-shadow | `0 2px 12px rgba(0,0,0,0.16)` |
| --glass-bg | `rgba(255,255,255,0.74)` |
| --glass-border | `rgba(0,0,0,0.09)` |

### T4 薄荷 mint — 白+薄荷绿/淡蓝,清爽活力

| token | 值 |
|---|---|
| --bg-canvas | `#FFFFFF` |
| --bg-surface-1 | `#F4FAF7` |
| --bg-surface-2 | `#EAF5F0` |
| --bg-surface-3 | `#DDECE4` |
| --border-subtle | `rgba(16,60,45,0.09)` |
| --border-strong | `rgba(16,60,45,0.18)` |
| --text-primary | `#152420` |
| --text-secondary | `#47605A` |
| --text-muted | `#8AA39C` |
| --accent | `#0E9F7A`(薄荷绿,白字 3.5:1,过 WCAG 非文本/大字 AA) |
| --accent-hover | `#0B8A6A` |
| --accent-soft | `rgba(14,159,122,0.12)` |
| --accent-glow | `rgba(14,159,122,0.26)` |
| --text-on-accent | `#FFFFFF` |
| --accent-glow-shadow | `0 2px 12px rgba(14,159,122,0.28)` |
| --glass-bg | `rgba(255,255,255,0.74)` |
| --glass-border | `rgba(16,60,45,0.09)` |

### T5 奶杏 apricot — 暖白+奶杏+浅棕,温暖治愈

| token | 值 |
|---|---|
| --bg-canvas | `#FDF9F3`(暖白) |
| --bg-surface-1 | `#FAF3E8`(奶杏) |
| --bg-surface-2 | `#F4EAD9` |
| --bg-surface-3 | `#EBDDC6` |
| --border-subtle | `rgba(90,64,40,0.10)` |
| --border-strong | `rgba(90,64,40,0.20)` |
| --text-primary | `#3A2E22` |
| --text-secondary | `#7A6A56` |
| --text-muted | `#AB9A82` |
| --accent | `#B5763F`(浅棕,白字 3.9:1) |
| --accent-hover | `#A26736` |
| --accent-soft | `rgba(181,118,63,0.13)` |
| --accent-glow | `rgba(181,118,63,0.26)` |
| --text-on-accent | `#FFF8F0` |
| --accent-glow-shadow | `0 2px 12px rgba(181,118,63,0.30)` |
| --glass-bg | `rgba(253,249,243,0.76)` |
| --glass-border | `rgba(90,64,40,0.10)` |

### 五套共用(只定义一次,在 :root)

| token | 值 | 说明 |
|---|---|---|
| --ok | `#16A34A` / --ok-soft `rgba(22,163,74,0.10)` | 浅色底适配 |
| --warn | `#D97706` / --warn-soft `rgba(217,119,6,0.10)` | |
| --err | `#DC2626` / --err-soft `rgba(220,38,38,0.10)` | |
| --run | `var(--accent)` / --run-soft `var(--accent-soft)` | 运行态收敛进 accent(沿用现语义) |
| --overlay-strong | `rgba(24,20,16,0.45)` | 模态背板 |
| --overlay-light | `rgba(24,20,16,0.55)` | **图片/视频 scrim 永远保持深色**,不随主题变浅(内容可读性) |
| --glass-blur | `blur(20px) saturate(1.4)` | 不变 |
| --shadow-sm | `0 1px 2px rgba(0,0,0,0.05)` | 浅色阴影全面调软 |
| --shadow-md | `0 2px 8px rgba(0,0,0,0.07)` | |
| --shadow-lg | `0 4px 16px rgba(0,0,0,0.09)` | |
| --shadow-xl | `0 8px 24px rgba(0,0,0,0.10)` | |
| --shadow-pop | `0 4px 20px rgba(0,0,0,0.10), 0 0 0 1px var(--border-subtle)` | |
| --shadow-lift | `0 8px 30px rgba(0,0,0,0.12), 0 0 0 1px var(--border-subtle)` | |
| --shadow-float | `0 12px 40px rgba(0,0,0,0.14), 0 0 0 1px var(--border-subtle)` | |

## 三、配套调整清单

1. **globals.css**:`color-scheme: dark → light`;canonical token 换 T1;新增 4 个 `[data-theme]` 覆盖块;噪点纹理(若为亮噪点则反相或降不透明至 1.5%);legacy 别名块不动(自动级联);`.av-*`/`.anim-*` 等混入的视图样式扫硬编码暗色值。
2. **glass.css / island.css / stage.css / library.css / motion.css**:扫 `rgba(255,255,255,*)`、`rgba(0,0,0,*)`、裸 hex,凡语义是"暗色底/亮文字"的一律改走 token;舞台(ResultPanel)底从纯黑改 `var(--bg-surface-1)`,内容 scrim 保持深色。
3. **styled-jsx 35 文件**:grep `rgba(255,255,255|#0|#1[0-9A-F]|color: white` 等暗色残留,改 token;不改布局逻辑。
4. **layout.tsx**:themeColor `#0A0908 → #FFFFFF`;删"深色单主题"注释;`<head>` 内联防 FOUC 脚本。
5. **组件**:`ui/Toast`、`OptimizeButton`、登录卡等若有用到 `rgba(255,255,255,...)` 高光,逐项过。
6. **主题切换器**:`IslandNav` 账户 Popover 加五色行(色块 + 名称,当前主题打勾);移动端 BottomNav「更多」抽屉同款;写入 localStorage + `document.documentElement.dataset.theme`,无刷新切换。
7. **canvas(ComfyUI iframe)**:浅色 splash 不再冲突,遮罩改暖白/纸白;ComfyUI 本体仍是第三方内容,不强制。

## 四、验收

- 5 主题 × 关键 6 视图(登录/对话/生成/作品库/画布/资源)1440×900 截图逐一过,无"暗块残留/白字白底/对比度崩"。
- axe 双尺寸全扫(浅色对对比度更敏感,muted 文字仅允许用在占位/禁用)。
- 本地 e2e 基线不劣化(113 passed / 14 环境性 failed)→ 部署 core → 生产 e2e 161 绿。
- e2e 中若有 `themeColor`、暗色断言或截图基线依赖,同步更新。
