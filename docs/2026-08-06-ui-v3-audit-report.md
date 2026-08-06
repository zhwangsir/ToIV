# UI v3 页面走查报告(2026-08-06,五路并行审计)

> 方法:5 个并行 agent 对 13 个页面 × (桌面 1440×900 + 移动 390×844) 真机截图 + 交互态走查 + axe 扫描。
> 截图佐证在 /tmp/audit_g{1-5}_*.png。本报告按严重度重组,原始分组报告见会话记录。

## P0 — 功能性死页/全局组件损坏(必须先修)

### 1. Switch 开关全站隐形(0×0 渲染)
- **根因**:`components/ui/Switch.tsx` 内有两个 `<style jsx>` 块,第二块(尺寸/背景规则)的 scoped hash class 未挂到 `<button>` 上,规则全失效 → 开关 computed 0×0 透明
- **影响面**:`AvatarTalkView`(智能体/记忆/知识库三开关)、`AgentsAdminView`、`generate/ResultPanel`(A/B 开关)、`generate/ParamField` —— **全站所有 Switch**
- **连带解释**:走查组 1 报的「视频页 高清放大/RIFE 补帧只有标签没有控件」即是此 bug
- **修法**:合并为一个 style 块,或样式迁全局 CSS

### 2. videoEdit / imageEdit 视图 100% 黑屏
- **根因**:`app/page.tsx:413-443` 渲染 switch 漏了 `videoEdit` 和 `imageEdit` 分支;组件已 lazy import、已注册 VALID_VIEWS、已进灵动岛,但 JSX 从不渲染 → 空 `<div class="view-root view-stage">`
- **修法**:补两个渲染分支(各一行级改动)
- 附注:`?view=video-edit`(连字符)是非法键会静默回落对话页,可加 legacy 映射

### 3. 画布页永久卡 ComfyUI splash(用户历史遗留问题实锤)
- **根因(服务端)**:iframe 指向 `192.168.71.127:8188`,`/system_stats` 200,但 `/assets/*` 下 62 个 JS/CSS 全部 **403 Forbidden** → Vue 应用永远起不来。是 workstation 上 ComfyUI 静态资源权限/反代问题,不是前端 bug
- **根因(前端)**:`CanvasView.tsx:50-55` 只 probe `/system_stats`,probe 过就渲染 iframe,感知不到内部 403;无超时、无错误态、无重试
- **主题冲突**:浅色 splash 铺满视口,与暖黑主题撕裂;即使修好 403,ComfyUI 默认浅色嵌入也需注入暗色样式或外壳过渡
- **修法**:① workstation 查 8188 静态资源 403(文件权限/反代);② CanvasView 加 15s 加载超时兜底错误态 + 重试;③ ComfyUI 侧启用暗色主题或注入 user.css

## P1 — 布局广泛影响(多视图/全桌面用户)

### 4. 参数浮板溢出视口(三视图通病)
- image 展开高级参数溢出;video 默认态即溢出(引擎/底模/时长/帧率/高清放大/RIFE 六项);audio 歌词多行把浮板顶出视口顶
- **修法**:浮板 `max-height: calc(100vh - 岛高 - 边距)` + `overflow-y: auto`

### 5. audio 视图布局结构崩(该视图问题最重)
- AudioView 生成 tab 内舞台 + TtsCard(48%)同屏分高 → 舞台被压半屏:三步卡被 PromptBar 遮挡、移动端舞台完全不可见且页面不可滚动;TtsCard「合成配音」按钮 900px 视口被截
- **修法**:TtsCard 移到「编辑」tab 或改可收起抽屉,还舞台完整高度

### 6. A/B 对比开关被参数浮板遮挡(桌面端点不到)
- ResultPanel 把 A/B 开关浮右上,参数浮板也锚右上,完全盖住(5s 点击超时);移动端浮板转 static 才露出
- **修法**:并入左上状态胶囊行,或浮板让出顶部热区

### 7. fusion 网格右侧 456px 死空间 + badge 静态不可读
- `.fusion-grid { max-width: 960px }` 无 `margin: 0 auto` → 贴左不居中也不撑满
- 能力 badge 静止态暗棕近隐形,hover 才点亮 → 信息不应依赖 hover
- **修法**:网格居中或放宽; badge 静态用 accent-soft 底 + accent 字(与原 badge-accent 一致)

### 8. 作品库三处破损
- **筛选分类是假的**:`kindToFilter()` 未识别 kind 一律回退 image → transcribe/voice_track/dub_lipsync/frame_interpolate/hunyuan_i2v 全算「图像」,音频/视频 tab 永远空态
- **hover 快捷操作条压字**:`.lib-actions` 胶囊叠在提示词文本上把文字截成两截
- **失败卡黑墙**:13 件作品 12 件是 1:1 失败占位大卡,整页一面黑墙;占位图标与提示词左上角重叠
- **修法**:kind 映射表补齐(transcribe/voice_track→音频,dub_lipsync/frame_interpolate/hunyuan→视频,未知→全部而非图像);hover 时提示词文本让位/淡出;失败卡高度收敛 4:3 或固定矮高;占位卡 icon 与文本分层

## P2 — 移动端破损链

9. 生成三视图移动端:参数面板独占首屏+与 sticky PromptBar 层叠打架;结果图被遮挡;空态三步卡不可见且页面不可滚动 → 移动端结构重排(面板默认收起为抽屉)
10. studio 项目内顶部阶段条 390px 竖排断字(「剧本」断成 剧/本)→ 横向滚动或图标-only
11. dub 步骤条第 4 步被裁且无可滑提示 → 渐变遮罩/等宽压缩
12. admin 用户表「管理员」徽章竖排断行(缺 nowrap);「创建时间」列被裁无滚动提示 → nowrap + 边缘渐隐
13. assistant 移动端 placeholder 截断且内容是桌面快捷键 → 按端适配

## P3 — 体验兜底与抛光

14. **assistant 静默装死**:后端不可达时发送消息无 loading/无错误气泡/无 toast(等 40s 无任何反馈);已发送对话不进「历史」侧栏(显示「暂无历史对话」)→ 错误态气泡+重试、打字指示器、会话持久化或侧栏刷新
15. **生成错误抛底层原文**:ComfyUI 断连显示 `sent 1011 (internal error) keepalive ping timeout...` → 用户友好文案包装 + 详情折叠
16. 杂项:尺寸 chip 向下展开溢出视口(改向上);chip 展开态 Esc/点击不收起;引擎 chip 展开为原生 select 样式不统一;生成中占位框宽高比与目标尺寸不符(1024² 任务显示 16:9 框);studio 日期 `8/6/2026` 美式格式;library seed 超长折行/Badge 用原始 kind 名过长;toast 堆叠遮挡筛选 tabs;锁定步骤点击无反馈;avatar「开始对话」禁用态仍实心橙;空态居中以舞台为参照收起浮板后不重排;filmstrip/A/B 纯会话态刷新即空(设计如此,但需文案明示)
17. **需求核实项**:资源页没有「GPU worker 在线状态卡」(Grep 全库无此组件)——疑似旧 IA 移除,需确认是否还要

## 建议修复顺序

| 批 | 内容 | 理由 |
|----|------|------|
| 第一批 P0 | #1 Switch、#2 渲染分支、#3 canvas(前端兜底先做,服务端 403 并行查) | 全是「点了没反应/死页」,用户感知最强 |
| 第二批 P1 | #4 浮板滚动、#6 A/B 挪位、#7 fusion、#8 作品库、#5 audio 结构 | 桌面主路径布局 |
| 第三批 P2 | #9-13 移动端链 | 移动端独立成批 |
| 第四批 P3 | #14-16 错误态/文案抛光 | 体验兜底 |

每批走完 axe 双尺寸 + 相关 e2e,全部完成部署 core + 生产回归。
