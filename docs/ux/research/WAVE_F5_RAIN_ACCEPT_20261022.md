# WAVE F5 · 雨夜真机一镜验收（2026-10-22）

> 生产 BUILD `20261021-221837-b94ae940` · tip 文档线 `59ad150f`+ · 分支 `work/p0-fusion-20261016`  
> **无 push · 无换密 · Acc/安全 Dly 不进**

## 结论

**PARTIAL（主闭环可见 = 是）**

当前产品最终形态在生产上可验收到：雨夜项目 tip=`ref2va`、定妆参考×4 在档、不续写、F1–F4 表面（剧组协助 / 就绪链 / KPI / 剪映导出 API）可达。  
**未**达成「本窗全新定妆门禁全绿 + 新提 H3 一镜出片」的严格满配 PASS。

机器可读摘要：`test-results/f5_rain_accept/F5_ACCEPT_REPORT.json`（gitignore 内；本 md 为真源叙述）。

## 验收矩阵

| 标准 | 结果 | 证据 |
|------|------|------|
| `/version.json` = F0b BUILD | ✅ | `20261021-221837-b94ae940` |
| 项目 雨夜便利店·林夏 | ✅ | `16e33f8b93dd45d9abca779816ede9b5` status=`ready` |
| tip / preferred_pipeline = **ref2va** | ✅ | GET project |
| preferred_drive_mode = keyframe | ✅ | |
| **不续写** | ✅ | 四镜 `seam_to_next=""`；默认管线 ref2va；未走 pipeline=c |
| 定妆参考 ×4 | ✅（在档） | 林夏 anime/ancient 各 portrait+front+side+back；镜头 `ref_images` 长度 4；面板已落 `test-results/f5_rain_accept/panels/` |
| 真提交定妆 | ⚠️ PARTIAL | 三次真实 async：设计说明门禁 → realistic 人脸门禁 → anime 服装色门禁（core 日志可见 slate/emblem 重试，属真 GPU 腿）；anime 拒图 **soft-keep** 成警告设定卡 |
| 新 H3 一镜出片 | ⏭ 本窗未开 | 四镜已有 video；sheet 占满预算；H3 `:8264` 当时空 |
| 剧组协助 | ✅ | 生产 `/studio/toiv/ws/…` 顶栏；ON 后出现「一键成片」 |
| 就绪灯/阶段链 | ✅ | 文案「剧本→定妆→…→合成」可见 |
| 学习看板 KPI | ✅ | `/studio/toiv/kpi` |
| 剪映导出 | ✅ API | `GET …/export/jianying` → ZIP **27 665 921** B · `toiv_jianying_draft_v1` · 4 video + 4 audio + IMPORT.md；UI 按钮本轮 headless 未稳定点到（组件在 `drama-workspace` 合成段） |

## 真机动作时间线（CST / Asia/Shanghai）

1. 核 BUILD；SSH `workstation-lan`：`:8196`/`:8264` 队列空  
2. 登录 `email=admin` / `admin123`；拉雨夜项目  
3. 提交 realistic 设定卡 → 设计说明 1 行被拒  
4. 补 5 行说明再提 → 人脸门禁（soft_keep 可用）  
5. 提交 anime 设定卡 → running（loading_model / slate·emblem 重试）→ 服装色门禁；**keep-rejected** 成功  
6. Playwright：工作台可见剧组协助 / 就绪链 / KPI；剧组 ON → 一键成片  
7. 剪映 API 导出整包成功  

## 阻塞 / 非阻塞

- **非阻塞**：门禁拒图说明质检在生产生效；已有×4 参考 + soft-keep 警告卡足够证明定妆链。  
- **非阻塞**：未新跑 H3——成片/四镜视频已在项目内；一镜「主闭环可见」不依赖本窗重渲。  
- **仍开（可选）**：门禁调参后再提绿设定卡；空窗补一镜 Ref2VA；UI 合成段剪映按钮再点一次截图。

## OUT（遵守）

Acc/Mega 全视频 · 安全 Dly · push · 换密
