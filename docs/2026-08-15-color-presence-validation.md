# 颜色标记草图在场校验 · 实现与校验报告（2026-08-15）

> 来源：DramaClaw 借鉴 #4（docs/2026-08-15-dramaclaw-deep-dive.md 第二节第 4 条）
> 目标：角色以专属颜色火柴人/色块出现在草图中 → CV 颜色检测判定「该出场的角色是否真在画面里」→ 差异记录与反哺。

---

## 一、实现概览

| 件 | 位置 | 说明 |
|---|---|---|
| 核心服务 | apps/api/app/services/drama_presence.py | 调色板/颜色分配/prompt 后缀/在场检测/宫格切分/位置分带/产物取图 |
| 模型列 | DramaShot.detected_colors + db.py 幂等 ALTER | 存 {color_map, per_character, checked_at, source} |
| prompt 注入 | grid-storyboard / scene-layout 加 `color_mark`（默认 False，零行为变更） | True 时追加色标草图指令并写 expected 段 |
| 校验端点 | `POST /drama/projects/{pid}/presence-check` | 逐 shot 取图→检测→期望比对→报告+落库 |
| 测试 | tests/test_drama_presence.py（18 例） | 纯函数/端点/prompt 注入/调色板性质 |

## 二、关键设计决策（差异分析 vs DramaClaw）

1. **调色板重新设计，未照抄**：DramaClaw 荧光 12 色中 `#00FFCC` 与 `#00FFFF` RGB 距离仅 51 < 检测阈值 60，会互相串色。本实现取色相环 0°~330° 每 30° 一色、全饱和全明度，任意两色 RGB 距离 ≥127 > 2×60——**数学上保证单像素至多命中一色**，并由 `test_palette_rgb_separable` 常驻守住。
2. **阈值**：`distance_threshold=60`（容忍草图偏色 + JPEG/缩放伪影 10~40 的实测偏移，且小于最小两两距离之半：宁漏边缘像素也不串色）；`min_coverage=0.002`（比 DramaClaw 的 0.8% 松——无串色风险后误报只剩离散噪点，放宽降漏报；0.2% ≈ 1024² 中 45×45 色块，小火柴人躯干稳定命中）。
3. **纯 PIL 实现**（未引入 numpy）：降采样 ≤384px + 无彩色速跳 + 5bit 量化记忆化；实测 1024² 典型 **14.6ms**、全彩噪声最坏 39.5ms。
4. **宫格判定**：项目内同 URL 被多 shot 共享即宫格图，≤9→3x3、>9→5x5 行优先切第 shot.idx 块；单镜参考图整检。
5. **位置感知三级**：layout actors 带 x∈[0,1] → x±0.15 分带检测：region（位置命中）/ elsewhere（在场但位置偏）/ missing（缺失）。

## 三、校验结果（测试证据）

- 纯函数 9 例：合成图红/蓝块命中与未命中、覆盖率、阈值边界、宫格切分、region 三态、分配确定性
- 端点 5 例：mock 取图 → missing/unexpected 报告、persist 落库、无图 shot→unavailable 不炸全局、归属 404
- prompt 注入 3 例：color_mark=True 含颜色指令 / False 不含 / 未知角色名分配新色
- 回归：test_drama_studio + test_storyboard_valid_ids 90/90；全量见 TEST_LOG

## 四、差异点处理建议（按 ROI 分级）

| 差异类型 | 语义 | 建议处理 | ROI |
|---|---|---|---|
| missing（期望角色未检出） | 草图漏画/颜色未遵循 | 前端分镜卡红条提示 → 重生成该 shot 参考图（color_mark 模式） | 高：直接消灭「角色缺席」进渲染 |
| unexpected（检出未期望色） | 串角色/噪点 | 低优先；仅当 coverage 显著（>1%）时提示 | 中：多为伪影，人工确认即可 |
| elsewhere（在场但位置偏） | 走位与 layout 不符 | 提示级，供导演台微调 x | 中：比 missing 弱一档 |
| unavailable（图取不到） | worker 掉线/历史异机产物 | 不计失败，重试或忽略 | 低 |

## 五、遗留与边界

1. 前端接线点：presence-check 返回的 per_character/region_check 可渲染分镜卡角标 + 角色色块徽章（detected_colors.color_map 的 hex）；建议入口=宫格分镜页「校验在场」按钮
2. 角色 >12 时颜色取模复用（drama 项目通常 ≤8，接受）
3. 宫格列数靠共享数推断；未来支持非方形宫格需把 grid_size 显式存项目
4. 反哺 render 阶段参考图过滤（DramaClaw 的完整闭环）未做——当前价值在「检测+报告」，过滤策略需产品确认后接
