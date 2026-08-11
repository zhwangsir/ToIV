# 音频功能修复与页面排版重设计说明

> 日期：2026-08-10
> 涉及范围：ToIV Web 前端 + API 后端

---

## 一、音频功能修复

### 1.1 问题诊断

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P1 | `/api/audio/files/{name}` 不支持 Range 请求 | `get_audio_file` 使用 `FileResponse` 直返整文件，无 206 Partial 支持 | `<audio>` 进度条无法拖动，部分浏览器报 SRC_NOT_SUPPORTED |
| P2 | ACE 音乐产物 Content-Type 错误 | ComfyUI `/view` 对非图片文件回落默认 `image/png` | 浏览器 `<audio>` 拒绝播放错误 MIME 类型 |
| P3 | 前端音频播放器样式碎片化 | `ResultPanel` 舞台区和 `AudioView` 编辑区样式定义分散 | 不同页面音频播放器外观不一致 |

### 1.2 修复方案

#### P1：Range 请求支持

**文件**：`apps/api/app/routes/audio_tools.py`

- `get_audio_file` 改为手动 Range 实现：新增 `request: Request` 参数，整段读入产物 bytes（上限 50MB）后调用 `_ranged_response` 切片返回
- 复用 `app.routes.images._ranged_response`，与 `/api/images` 同一套 Range 逻辑
- 保留原有 400（非法文件名）/404（不存在）行为与 NAS→本地回退双目录查找逻辑

```python
# 修复后核心逻辑
return _ranged_response(
    path.read_bytes(), "audio/wav", request.headers.get("range")
)
```

#### P2：Content-Type 按扩展名修正

**文件**：`apps/api/app/routes/images.py`

- 新增 `_AUDIO_CONTENT_TYPES` 映射：
  - `.mp3` → `audio/mpeg`
  - `.wav` → `audio/wav`
  - `.flac` → `audio/flac`
  - `.ogg` → `audio/ogg`
- 在 `get_image` 的 `_ranged_response` 调用前按文件扩展名覆盖 content-type

```python
content_type = _AUDIO_CONTENT_TYPES.get(
    Path(safe_filename).suffix.lower(), content_type
)
```

#### P3：前端样式确认

- `.media-audio` 样式在 `app/styles/stage.css:191` 已有完整定义（舞台区 `width: min(520px, 90%)`，对比区 `width: 100%`）
- 无需额外修改

### 1.3 验证结果

| 测试项 | 结果 |
|--------|------|
| `test_audio_sep.py` + `test_images_range.py` | 21/21 通过 |
| 后端全量测试（排除 redis_integration） | 1143 passed / 0 failed |

---

## 二、页面排版重设计

### 2.1 现状分析

从音频工坊/AI视频页面截图识别的排版问题：

| 问题 | 表现 |
|------|------|
| 视觉锚点缺失 | 空状态大面积留白，用户视线无聚焦点 |
| 层次感不足 | 步骤卡片、参数面板、输入框边界模糊 |
| 页头分隔弱 | 标题/描述与内容区无视觉分隔 |
| 悬浮感不够 | 底部输入框与主区域融为一体 |

### 2.2 设计方案

**修改文件**：`apps/web/app/globals.css`（末尾追加约 140 行）

#### 页头优化
- `.page-header` 添加底部边框线，增强标题区与内容区的视觉分隔
- `.page-header-title` 字距 -0.02em，提升标题紧凑感
- `.page-header-desc` 限制最大宽度 480px，行高 1.6，提升可读性

#### 空状态视觉聚焦
- `.empty-editorial::before` 添加径向渐变光晕（accent-soft 色），320px 圆形，作为视觉锚点
- `.empty-display` 字距 -0.03em，增强大标题张力
- `.empty-tip` 添加 hover 上浮 + 阴影效果，增强交互反馈

#### 参数面板边界增强
- `.generate-params` 添加左边框 + 背景色区分，与主区域拉开层级

#### 底部输入框悬浮感
- `.prompt-bar-container` / `.generate-prompt-bar` 添加 `shadow-lift` + 圆角 + 边框

#### 舞台区域
- `.stage-media-wrap` 添加圆角 + 阴影，作品更突出
- `.filmstrip-item` 添加 hover 缩放 + 选中态增强阴影

#### 音频播放器统一
- `.media-audio` 统一样式：宽度 100%、最大 480px、高度 48px、圆角

#### 响应式适配
- ≤1023px：光晕缩至 240px，页头间距收紧
- ≤767px：光晕缩至 200px，大标题缩至 24px

### 2.3 设计原则

- **不动 TSX 结构**：所有优化通过 CSS 层叠实现，现有组件零改动
- **token 驱动**：全部使用 `globals.css` 已有的 CSS 变量（间距/颜色/圆角/阴影），保持五色板主题兼容
- **渐进增强**：hover/transition 动效为增量体验，不影响基础功能

---

## 三、涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `apps/api/app/routes/audio_tools.py` | 修改 | Range 请求支持 |
| `apps/api/app/routes/images.py` | 修改 | 音频 Content-Type 修正 |
| `apps/web/app/globals.css` | 追加 | 页面排版优化样式（~140 行） |

---

## 四、测试验证

| 测试 | 结果 |
|------|------|
| 后端目标测试（audio_sep + images_range） | 21/21 通过 |
| 后端全量测试（排除 redis_integration） | 1143 passed / 0 failed |
| 前端构建 | 成功 |
| 前端 vitest | N/A（项目无 vitest，用 Playwright e2e） |
