# Settings / Models · R10补校准 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`d7274c16`  
合规：硬表尺寸 + IA；`--toiv-model-mgr-*`  canonical + 旧 `--toiv-model-*` 别名；**未 push**。

---

## A. 改了什么

| 项 | 值 |
|----|-----|
| Dialog | **1120** × `min(82vh, **760**)`（page-max 别名跟 dialog-w） |
| nav | **176** / 窄 icon **56**；nav-row **40**；control **36**；label-col **140** |
| provider / edit | mark **40**；drawer **420**；nested dialog **560** |
| IA 导航 | **模型｜引擎｜存储｜通用｜关于**（引擎独立） |
| content_mode | **设置内无主开关**；说明在「通用」；主切换仍顶栏光幕 |
| 成人 | 只滤模型条目；geometry unchanged |

遗留 URL：`common→models` / `compute→engines` / `advanced→general` / `diagnostics→about` 等仍解析。

---

## B. Token

`--toiv-settings-*` + `--toiv-model-mgr-*`（双端 freezone tokens）。  
CSS：`settings-visual.css`、`settings-model-inventory.css`。  
入口：`pages/settings/index.tsx`、`lib/settings-navigation.ts`、`redline` R18 gate → `section=general&focus=r18`。

---

## C. 自检

- [x] IA 五段文案为 模型｜引擎｜存储｜通用｜关于
- [x] `r18-settings-pane` 明确「不提供主开关」
- [x] 抽屉宽 token → mgr edit drawer 420
- [x] 旧 `--toiv-model-*` 别名指向 mgr
- [x] canvas↔web token 同步

---

## D. 风险

- Segmented 五段在窄屏可能挤；nav-w-icon 56 尚未做独立窄轨布局（token 已钉，壳仍 segmented）。
- 「存储」为轻量概览+链媒体库，非完整存储管理台。
- `?focus=r18` 确认闸仍可写模式（深链兼容），UI 无常驻主开关。
- **未 push**。
