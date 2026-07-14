# 模型选择锁定策略

> 日期:2026-07-13
> 范围:除 NSFW 专区外,所有视图的模型选择 UI 锁定为平台默认模型

## 一、背景

用户要求:
- NSFW 专区(`/nsfw`)保留完整模型选择能力(底模/采样器/调度器)
- 其他所有视图**不允许修改模型**,统一使用后端配置的"默认最好效果对应模型"

## 二、后端默认模型机制

### 数据结构(`lib/types.ts`)

```typescript
interface ModeModels {
  models: string[];
  editable: boolean;
  checkpoints?: CheckpointTag[];  // 仅 image 模式
  default?: string | null;          // 仅 image 模式:平台默认底模
}

interface ModelsResponse {
  checkpoints: string[];
  samplers: string[];
  schedulers: string[];
  modes?: Record<string, ModeModels>;  // image/video/model3d/audio
}
```

### 关键结论

- 后端通过 `modes.image.default` 下发平台默认底模(来源 `settings.default_ckpt`)
- **仅 image 模式**有 `default` 字段;video/model3d/audio 暂无
- `GET /api/models` 返回,NSFW 专区附加 `X-NSFW: 1` 头走 R18 通道
- 默认采样器回落 `euler`,调度器回落 `normal`(CreateView 已实现的逻辑)

## 三、各视图现状与处理方案

### 需要锁定的视图(2 个)

| 视图 | 文件 | 现状 | 缺陷 | 处理方案 |
|---|---|---|---|---|
| **漫剧** | `components/manju/ManjuView.tsx` | 底模 select(新建/编辑表单) | 仅取 `res.checkpoints`,未读 `modes.image.default` | 改为自动填充默认底模,隐藏 select,显示只读底模名 |
| **训练** | `components/train/TrainView.tsx` | 训练基模 select | 仅取 `res.checkpoints`,未读 `modes.image.default`,初始空且强制校验 | 改为自动填充默认底模,隐藏 select |

### 不需要锁定的视图(8 个)

| 视图 | 原因 |
|---|---|
| **创作(CreateView)** | 用户明确保留;且已正确读取 `modes.image.default` |
| **NSFW 专区** | 用户明确保留完整选择能力 |
| **AI 助手** | 无模型选择 UI,后端固定 GLM-5.2 |
| **ComfyUI** | iframe 加载原生前端,不在前端控制范围 |
| **译制** | 无模型 select,后端固定 Whisper/IndexTTS/LatentSync |
| **作品库** | 只读历史作品 |
| **看板** | 只读项目卡片/详情 |
| **用户管理** | 无模型 select |
| **模型库** | 管理界面,本身即配置入口,排除 |

## 四、实施细节

### 4.1 ManjuView 改造

**位置**:
- 模型加载:`listModels()` 第 412 行
- select 工厂:`ckptSelect` 第 933-951 行
- 新建表单使用:第 1038-1043 行
- 编辑表单使用:第 1245-1250 行

**改动**:
1. `listModels().then((res) => setModels(res.checkpoints ?? []))` → 同时读取 `res.modes?.image?.default`
2. 新建项目时,`newForm.ckpt_name` 初始值设为默认底模(非空字符串)
3. 隐藏 select,改为只读展示底模名(badge 样式)
4. 保留 `editForm.ckpt_name` 的已有值回填(编辑时不覆盖)

### 4.2 TrainView 改造

**位置**:
- 模型加载:`listModels()` 第 113 行
- select JSX:第 359-372 行
- 表单校验:`if (!form.base_ckpt)` 第 217-218 行

**改动**:
1. `listModels().then((res) => setCheckpoints(res.checkpoints ?? []))` → 同时读取 `res.modes?.image?.default`
2. 加载完成后自动填充 `form.base_ckpt = default || checkpoints[0]`
3. 隐藏 select,改为只读展示底模名
4. 移除 `if (!form.base_ckpt)` 校验(已有默认值,不会为空)

## 五、验收标准

1. `/nsfw` 专区:CreateView 的底模/采样器/调度器 select 正常可选
2. 漫剧新建项目:底模自动填充为平台默认,无 select 下拉
3. 训练启动:基模自动填充为平台默认,无 select 下拉
4. 看板/作品库:已有的底模字段只读展示不变
5. `npx tsc --noEmit` 0 错误
6. `npx playwright test` 全部通过
