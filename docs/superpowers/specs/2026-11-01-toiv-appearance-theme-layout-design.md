# ToIV Prime 外观系统 v2：主题库 + 排版偏好（2026-11-01）

> 状态：设计定稿，按 TDD 实施。范围仅 `frontend/app/src/toiv/**`、`src/styles/toiv-skin.css`、`src/main.tsx`，不触碰冻结 vendor 文件。

## 1. 问题与目标

现状只有「4 套内置主题 + 每主题 6 个颜色覆盖」，且覆盖只接受 hex。用户要的是**默认主题 + 自定义**的完整方式，包含 UI 与排版：

- 主题：可命名保存、复制、删除、导入/导出；颜色覆盖从 6 个扩到 16 个（含透明度）。
- 排版：密度、圆角、导航高度、内容宽度、行距、界面缩放、动效偏好，全部持久化。
- 改动即时生效，设置页有真实预览；刷新后保持；可整体导出分享。

不做：按页面/按路由单独覆盖；跟随系统深浅切换；主题市场；后端存储（外观属于浏览器偏好）。

## 2. 数据模型

单一 localStorage 键 `toiv_appearance`：

```ts
interface AppearanceState {
  activeTheme: string;              // 内置 id 或 custom-*
  overrides: ThemeOverrideMap;      // 内置主题的颜色覆盖（沿用 v1 结构）
  customThemes: CustomTheme[];      // 上限 24
  layout: LayoutPreferences;
}
interface CustomTheme {
  id: string;                       // custom-<base36 时间>-<随机>
  name: string;                     // ≤ 40 字
  base: ThemeId;                    // 必为内置 id，提供未覆盖 token 与 dark
  tokens: ThemeOverrides;           // 仅颜色 token 覆盖
  createdAt: string;
}
interface LayoutPreferences {
  density: "compact" | "regular" | "relaxed";
  radius: "square" | "classic" | "round";
  navHeight: "compact" | "standard" | "relaxed";
  contentWidth: "focus" | "standard" | "wide" | "full";
  lineHeight: "tight" | "normal" | "loose";
  textScale: "sm" | "md" | "lg";
  motion: "full" | "reduced" | "system";
}
```

自定义主题 = `base` + 覆盖，解析时合并内置 palette；`dark` 由 base 决定。内置主题保持只读，覆盖仍存放在 `overrides[base]`，现有行为与测试不变。

**迁移**：读不到 `toiv_appearance` 时，用 v1 的 `toiv_theme` / `toiv_theme_overrides` 生成初始状态；不删除 v1 键。损坏 JSON 回退默认（light + 标准排版）。

## 3. 颜色模型

- 可编辑 **16 个颜色 token**，分三组：
  - 品牌与画布：`--pf-lime`、`--pf-lime-soft`、`--bg-canvas`、`--grid-color`
  - 表面与文字：`--pf-bg`、`--pf-card`、`--pf-line`、`--pf-ink`、`--text-secondary`、`--pf-muted`
  - 状态色：`--toiv-danger`、`--toiv-success`、`--toiv-warning`、`--toiv-info`、`--node-border-selected`、`--toiv-scrim`
- 阴影 token（`--pf-shadow`、`--toiv-shadow-float`）不可编辑，随 base 继承，避免任意 CSS 注入。
- 值域：`#rgb` / `#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)`，逐通道 0–255、alpha 0–1，严格正则 + 数值校验。
- `--pf-line`、`--grid-color`、`--toiv-scrim` 显示透明度滑杆；其余颜色 alpha 固定 1。
- 对比度门禁沿用：`--text-secondary` vs `--pf-bg` ≥ 4.5 显示 AA 通过，低于则 `role="alert"`。

## 4. 排版映射

| 偏好 | 取值 | 落地 |
|---|---|---|
| density | compact / regular / relaxed | `--toiv-space` 0.85 / 1 / 1.2，乘到 Prime 自有间距 |
| radius | square / classic / round | 覆盖 `--pf-radius` 4/14/22px，`--pf-radius-sm` 3/10/16px |
| navHeight | compact / standard / relaxed | 覆盖 `--pf-nav-h` 44/48/56px |
| contentWidth | focus / standard / wide / full | `--toiv-content-max` 1080/1280/1440/1680px，作用于 `.pf-shell-main.wide` |
| lineHeight | tight / normal / loose | `--toiv-line-height` 1.4/1.5/1.7，作用于 `html` |
| textScale | sm / md / lg | 根字号 14.4/16/17.6px（printfilm 用 rem，整体等比） |
| motion | full / reduced / system | `data-motion`；reduced 关闭过渡动画，system 跟随 `prefers-reduced-motion` |

另提供三档排版预设（紧凑 / 标准 / 舒展）与「恢复默认排版」。

## 5. 应用方式

`<html>` 上：`data-theme=<base>`、`data-theme-kind=builtin|custom`、`data-density`、`data-content-width`、`data-motion`，并写入上述 CSS 变量与根字号。切换/重置时先清空 18 个主题 token 的内联值，再写入当前解析结果，避免残留（沿用 v1 行为）。

启动：`main.tsx` 调 `applyStoredAppearance()`；设置页每次提交先 `saveAppearance()` 再 `applyAppearanceTo()`。

## 6. 设置页结构

```
设置
├─ 外观预览（右栏 sticky：真实 nav / 文案 / 按钮 / 卡片 / 画布格）
├─ 主题预设（4 张卡片，radiogroup 名称仍为「主题」）
├─ 我的主题（保存当前 / 自定义卡片切换 / 两步删除 / 导入 / 导出）
├─ 颜色（16 项分组编辑 + 透明度 + 对比度 + 恢复默认）
├─ 排版（预设 + 7 个 segmented 控件 + 恢复默认）
└─ 模型与渠道（旧设置入口，保留）
```

宽屏两列（主区 + 预览栏），≤1100px 单列。所有控件 role=radio / aria-checked，错误 `role="alert"`，成功 `role="status"`。

导入/导出格式：

```json
{ "schema": "toiv.appearance", "version": 2, "exportedAt": "...",
  "theme": { "name": "...", "base": "light", "tokens": { "--pf-lime": "#..." } },
  "layout": { ... } }
```

导入校验：≤64KB、schema/version、名称 1–40 字、base 必须是内置主题、token 严格校验；id 重新生成、名称冲突加后缀、布局可选应用；上限 24 个。

## 7. 可访问性

- 控件键盘可达，焦点环沿用 `--pf-ink` 2px；toggle 组用 radiogroup 语义。
- 预览为 `role="group" aria-label="外观预览"`，不含可交互元素。
- reduced/system 动效偏好；颜色对比度提示；自定义主题名作为可读文本。
- 色板卡片的对比度沿用内置主题测试（ink ≥7:1，secondary/muted ≥4.5:1）。

## 8. 测试

单元（bun test）：
- 默认状态、v1 迁移、损坏存储回退；
- 自定义主题增删改、命名去重、24 上限、删除当前主题回退 base；
- token 净化（含 rgba、拒绝 rgb 越界/未知 token/阴影）；
- 导出→导入往返、错误 schema/超大文件/坏 JSON/缺名称；
- 排版净化与 `applyLayoutTo` 的 dataset/变量/根字号。

浏览器（Playwright + harness）：
- 排版控件改变 `data-density`/`--pf-radius`/`--pf-nav-h`，刷新保持；
- 另存为我的主题→切换→颜色写入自定义而非内置覆盖；
- 两步删除当前自定义主题回退；
- 导入 JSON 文件生效，导出下载内容可解析；
- 原 5 条主题用例保持绿。

门禁：`bun test test/`、`bun run lint`、`bun run build`；冻结清单 sha256 不变。

## 9. 风险

- 根字号缩放会让 rem 布局整体变大，110% 在窄屏可能溢出 → 选项上限 110%，内容宽度可切换聚焦。
- 旧主题数据迁移一次性、只读，不回写 v1；回滚代码后 v1 仍可用。
- localStorage 不可写时仅本会话生效，不阻塞 UI（与 v1 一致）。
