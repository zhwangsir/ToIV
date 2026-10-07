# ToIV AI 短剧产品方案（正式）

> 锁定日期：2026-10-01；修订：2026-10-03 04:50（视频步按风格取分桶 refs；雨夜 splice2 结项）；**2026-10-08 02:10（按用户 10-07 拍板改默认路线：逐镜独立 Ref2VA + 首尾帧拼接；Motion Context 长视频续写降为可选）**。
> 主体：一句话 → 分镜 → 角色设定卡（定妆）→ 视频（逐镜 Ref2VA 参考锁定）→ 配音 → pad 对口型 → 成片。

## 1. 视频默认路线：逐镜独立短视频 + 参考锁定 + 拼接

- **用户拍板（2026-10-07 12:15）**：看过 c_hybrid 四镜拼片与 splice2 对比后定——长视频连续生成「效果一般」，**每镜独立短视频生成 + 首尾帧拼接**更好；c_hybrid 不换默认。
- **标准序（2026-10-07 16:20《两小时的注定》v2 实证）**：①角色卡定妆（每角色 front/side/full × 多 seed，目检选角）→ ②每镜 `MiniMaxH3ReferenceToVideo`（Ref2VA）带 4 张定妆参考（`<Picture N>` 1-based 标签）→ ③稳定提示词模板（场景 + 锚定人物 + 小幅动作 + 镜头 + 环境音；默认无对白人声）→ ④逐镜目检 → ⑤无损 concat。
- 默认档 length=124（最稳）；逐镜串行提交，不并行打 H3 实例；**不**把候选打到 `:8197`（与生产 `:8196` 同卡 GPU0）。
- 台词不进画面提示；负向含烧录字幕/店招/乱码英文/品牌 logo。
- 人脸可见强化（候选不过门禁时先改提示，禁止原样重抽种子）：正向 medium shot、hood down、face fully visible facing camera；负向 close-up of hands、hood covering face、half face。
- 店招乱码：靠无字场景图解决，不靠后期 OCR 硬抹。
- 已知边界：对白型 i2v 动戏自由度高，易致服装/面容漂移和次要人物乱入（v1 镜3-4）；Ref2VA 路线下偶有单帧服装着色漂移。
- **可选管线（保留不删）**：`c`（Motion Context 尾段续写 + Ref2VA + 原生音频）、`c_hybrid`（首帧=上一镜尾帧/全身定妆图）。代码、门禁、产物全部保留，门禁体系复用于设定卡线。
- **⚠ 代码现状（2026-10-08 核对）**：产品视频步默认仍是 `c`——`apps/api/app/services/studio/orchestrator.py` `render_shot` 中 `pipe = (pipeline or "c")`，且对 `c`/`c_hybrid` 自动取上一镜 `context_latent` 续写。要把产品默认切到「逐镜独立 Ref2VA（不续写）」需新增独立镜管线并改默认、补测、部署、真跑一镜验证，**尚未做**（见 §8 第一项）。

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
- 视频取参考：`ref_style` 显式 > 项目画风文案推断（二次元/古风）> 角色分桶里**唯一**有 panel 的风格；命中后优先读该分桶并附扁平列非 panel（sample）。双桶并存且无显式/推断时回落扁平列（雨夜林夏保持 sample×3 兜底）。
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

- 项目 `16e33f8b93dd45d9abca779816ede9b5`；默认成片（每镜独立生成 + 首尾帧拼接） `final-v3-facev5-VO-rainbed-splice2-4252418024475267717-5a4fb68ab56f.mp4`（**26764530** bytes / **54.68s**，status=ready）。
- 与 v1（`final-9b1f12e4…`，60.32s）并排比较后人脸/衔接择优，不默认替换历史成片；当前默认保持 splice2；**2026-10-03 04:3x 父代理结项：后续雨夜不再动**；2026-10-07 c_hybrid 方案D 四镜拼片对比后用户拍板不换默认。
- 镜次状态口径：0=voiced / 1=lipsynced / 2=error / 3=lipsynced（以项目库为准）；新候选须 `face_mean≥0.45` 才允许级联。
- Batch7：二次元 + 古风设定卡均已 `final_review=true` 落盘；古风按拍板不写入扁平 refs（进 `reference_images_by_style`）。

## 8. 下一优先

1. **产品视频步默认切到逐镜独立 Ref2VA**（不取上一镜 context_latent；每镜 4 张定妆参考；`c`/`c_hybrid` 作为显式可选）：改 `render_shot` 默认、补单测（默认不续写 / 显式 c 仍续写 / 无定妆参考时报错不静默回落）、`deploy.sh --skip-web` 部署、用一个测试项目真跑一镜端到端验证。
2. 一句话→成片产品路径压测（按 §1 标准序，含定妆选角步骤）。
3. 雨夜样片已结项（默认 splice2 不动）；c_hybrid 实验线 10-07 收口。
4. 设定卡视觉+UI 已收线（建卡/资料重拼/单格重生/导出）；expr_3 温柔格 10-07 按 C 认可现状交付，模型迭代后可重开。
5. 旧积压：INTENT d 少字清扫 / c 配音 TTS；小程序 AppID（等用户微信平台动作）。
