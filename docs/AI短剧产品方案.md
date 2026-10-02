# ToIV AI 短剧产品方案（正式）

> 锁定日期：2026-10-01；修订：2026-10-03 00:25（设定卡双风格收线 + 资料重拼 UI + 雨夜 splice2 基线固化）。
> 主体：一句话 → 分镜 → 角色设定卡 → 视频（管线 C）→ 配音 → pad 对口型 → 成片。

## 1. 视频默认管线 C

- Motion Context 续写（上段尾 22 帧画面 + 1s 音频）+ Ref2VA 多参考 + 原生音频。
- 每镜默认 2 候选；串行提交到 H3 专用实例 `:8195`（GPU2）。
- **不**把第二候选打到 `:8197`：该实例与生产 `:8196` 同卡 GPU0，并行会抢生产显存。
- 台词不进画面提示；负向含烧录字幕/店招/乱码英文/品牌 logo。
- 人脸可见强化（候选不过门禁时先改提示，禁止原样重抽种子）：正向 medium shot、hood down、face fully visible facing camera；负向 close-up of hands、hood covering face、half face。
- 店招乱码：靠无字场景图解决，不靠后期 OCR 硬抹。

## 2. 选优规则

- 裁脸相似度（insightface buffalo_l）为主；疑似烧录字幕/OCR 降权。
- 连贯分：贴近上一镜末帧/场景参考；**regression** 扣「与镜0首帧过像」。
- **人脸门禁**：`face_mean ≥ 0.45` 且非空，否则 `CandidatePickError`，shot 标红，**禁止回落首候选**；未过禁止级联后续镜。
- 无人脸检出写入 `pick_note`/`error=无人脸检出`，应加候选重跑。

## 3. 角色设定卡

- 固定版式：左立绘+资料；中三视图（正/侧/背，可加 3/4）；下方面部/表情/服饰拆解/色板/设计说明。
- 风格：二次元 / 古风写实；两套可并存，设定卡文件按 `style` 分存。
- Ref2VA 只允许主立绘+三视图；整卡拼贴不得写入视频参考。
- **参考图按风格分存**：`reference_images_by_style = {anime:[…], ancient_realistic:[…]}`；写入某一风格不覆盖另一风格。
- 扁平 `reference_images` 留给写实/样片链（如雨夜 `sample_linxia`×3）；`apply_to_video_refs` 只更新分桶，不改扁平列。
- 视频取参考：指定风格时优先读分桶，再附扁平列中的非 panel（sample）；未指定风格时回落扁平列。
- **产品 UI**：建卡 / 按风格列表 / 资料编辑（身份·性格·身高·设计说明）/ 单格重生与替换 / 格锁定 / PNG 导出；**保存资料**走 `POST …/character-sheet/recompose`（锁全部图像格只重拼文字，不跑 Comfy、不写 refs）。
- **过审基线（2026-10-03）**：二次元 `char_sheet_803fb69b_anime_4f54ebedae5b`（21:00）；古风 `char_sheet_803fb69b_ancient_realistic_79fb925aacc1`（23:53 入卡，`final_review=true`）。

## 4. 配音与对口型

- 产品 API：voice → lipsync（**按源视频时长 pad 配音**，防成片被截断）。
- 断言：每镜 lipsync 时长 ≈ 源视频（误差 < 0.5s）；四镜样片目标成片 ≈ 60s。
- 雨夜样片可叠环境声床（雨声 -28dB）；成片静音门禁用 silencedetect。

## 5. 场景参考

- 每镜独立场景图（门外/货架/收银/出门）；须为**空镜环境**，禁止误用角色脸特写当场景。
- 场景图无字招牌；程序/生成侧抹掉可读文字。

## 6. 失败路径

- 缺镜头 → 404；未配音对口型 → 422；选优失败 → shot `error` + UI 标红。

## 7. 雨夜样片（收线结论 · 2026-10-03）

- 项目 `16e33f8b93dd45d9abca779816ede9b5`；默认成片 `final-v3-facev5-VO-rainbed-splice2-4252418024475267717-5a4fb68ab56f.mp4`（**26764530** bytes / **54.68s**，status=ready）。
- 与 v1（`final-9b1f12e4…`，60.32s）并排比较后人脸/衔接择优，不默认替换历史成片；当前默认保持 splice2，未授权不重渲。
- 镜次状态口径：0=voiced / 1=lipsynced / 2=error / 3=lipsynced（以项目库为准）；新候选须 `face_mean≥0.45` 才允许级联。
- Batch7：二次元 + 古风设定卡均已 `final_review=true` 落盘；古风按拍板不写入扁平 refs（进 `reference_images_by_style`）。

## 8. 下一优先

- 设定卡完整 UI 已接资料重拼；继续压失败/边界（无卡保存 404、跨风格不互盖 refs）。
- 旧积压：INTENT e/f（速度分档 + 评分表复跑）、`:8197` Motion Context 缺口、GitHub 推送偶发 443。
