# 内容模式：A 光幕拨片收束

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`

## 决定

用户收束：**A 光幕拨片**为唯一生产控件。  
落点：舞台顶栏居中（`ContentModeStageHost` → `LightCurtainPaddle`）。

## 行为

- 绑 `redline` / `setR18Mode` / me/mode（ordinary|adult）
- 成人两步确认；切回普通触发既有回落 + NSFW 锁标
- 色弱双通道：文案「普通/成人」+ 盾/锁图标 + 光幕纹理
- 设置页：仅状态说明 + `?focus=r18` 确认闸；**无主开关、无原型切换器**
- 侧栏脚：**不挂**胶片轨 / 原型切换器

## B / C 保留路径（默认不可见）

| 原型 | 文件 | 状态 |
|------|------|------|
| B 胶片双轨 | `components/content-mode/film-mode-rail.tsx` | 源码保留，未挂载 |
| C 相位环 | `components/content-mode/phase-ring.tsx` | 源码保留，未挂载 |
| 切换器 | `prototype-switcher.tsx` + `lib/content-mode-prototype.ts` | 保留；UI 已拆除 |

历史对比说明见 `CONTENT_MODE_PROTOTYPES_HANDBACK.md`（过期：切换器已下线）。

## 建议截图

1. `/create` 或 `/`：顶栏光幕（普通）  
2. 点「成人」→ 确认卡 → 光幕滑至成人态  
3. 设置→常用→内容模式：无灰按钮、无 A|B|C 切换  

## 紧急缩小（2026-10-26 用户截图后）

- 位：`top/right`，禁止 `left:50%` 居中  
- 尺：高 28px / 宽 ≤168px  
- 去装饰 hint、去成人强紫 glow；浅色页可读弱边  
- 动机：不再挡「和 ToIV 一起创作」

## TL 锁规格落地

- **挂载**：侧栏 utility 行，深浅色（AnimatedThemeToggler）左侧；舞台 StageHost 置空  
- **尺寸**：宽 ≈88–120px（默认 108）、高 30px、字 12px；折叠侧栏 56×28 图标态  
- **视觉**：静止近透明细边；激活弱 fill；无居中、无大紫晕  
