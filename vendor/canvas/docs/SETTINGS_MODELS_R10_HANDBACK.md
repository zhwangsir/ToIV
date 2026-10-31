# Settings / Models · R10 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`7087fbfe`（R9 empty/motion）  
不动：顶栏光幕主开关位置；三栏 / 时间线 / 队列骨架。  
合规：B 仓只重写；本 tip Freezone 自写（未并 A 源码）。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| Vercel 设置 IA | 公开模式 | **列表 + 抽屉表单**，拒满页表单墙 | 再造第二设置壳 |
| 既有三层 IA（常用/模型与算力/高级） | repo R0 | 成人闸不进主路径；R18 仅说明 | 设置内主 Switch |
| ModelSlotTable / redline | repo | NSFW 普通灰锁；默认基座写回 config | 绕过 listable 规则 |
| 顶栏 LightCurtain | R2 | 唯一主 content_mode 切换 | 设置页再放主开关 |

**结论**：`SettingsModelInventory` 挂「常用」；抽屉设默认基座；`R18SettingsPane` 只读说明（文案改为顶栏光幕）。

---

## B. 1:1 / 钉死点

| 项 | 值 |
|----|-----|
| IA | 列表行 52 · 抽屉宽 **420** · 页宽 max **920** |
| 交互 | 点行 → 抽屉；设默认出图/视频/文本/助手 |
| NSFW | 普通：灰化 + `NsfwLockBadge` + 禁设默认；成人可选 |
| content_mode | **设置内无主开关**；只读态 + 说明；`?focus=r18` 确认闸保留（非主路径） |
| 文案 | 普通/成人；说明指向**顶栏右侧光幕** |
| 成人几何 | unchanged |

---

## C. 落地蓝图

| 层 | 路径 |
|----|------|
| Token | `toiv-freezone-tokens.css` `--toiv-settings-*` / `--toiv-model-*`（双端） |
| 清单+抽屉 | `pages/settings/settings-model-inventory.tsx` + `.css` |
| 挂载 | `pages/settings/index.tsx`「常用」：角色槽 → 清单 → 内容模式说明 |
| 说明 | `r18-settings-pane.tsx`（无主 Switch；顶栏文案） |
| 视觉 | `settings-visual.css` 绑 `--toiv-settings-page-max` |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 位置未改；设置不重复主切换 |
| NSFW 模型 | 与角色槽同一 redline：`isNsfwAssetListable` / `Selectable` |
| 三栏/时间线/队列 | 未改 |

---

## E. 风险

- 清单依赖 `config.models`；空清单引导去「模型与算力」。
- `?focus=r18` 确认闸仍可写模式（深链兼容），但 UI 无常驻主开关。
- 抽屉未覆盖渠道 CRUD（仍在高级 Collapse / Modal）。
- **未 push**。
