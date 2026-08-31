# ToIV 前端全面重设计:对话驱动(D 方案混合)— 设计稿

> 2026-08-31 · 状态:已获用户方向确认(D 混合)/ 待用户终审
> 前置基础设施:Qwen3.8-Flash-Next-Uncensored NVFP4 双 Spark TP=2(1M 上下文),进行中

## 1. 背景与问题

当前 IA 为「9 项平铺导航 + 融合五卡第二门户 + 三个聚合 tab + 孤儿视图」的多中心结构,审计确认五大问题:

1. models/train/backlot 双轨容器(ResourcesView tab 内嵌 + 独立 view key 并存)
2. 视频编辑双入口(融合卡 videoEdit vs GenerateView 内 AiVideoEditView)
3. 短剧三路径(studio / animatic / drama 遗留)
4. /agent-runs 孤儿路由(无任何导航入口)
5. GenerateView/AudioView/LibraryView 三个超级杂糅视图(2500+ 行级)

用户痛点:功能分布太杂乱。范围决策:**IA + 视觉风格全面重做**(用户明示)。

## 2. 目标架构:对话为家 + 引导卡片 + 逃生舱

### 2.1 新 IA 三层结构

```
L0 首页 = 对话(Assistant 升格)
  ├─ 空态: 场景引导卡片(做图/做片/做短剧/数字人/译制/音频) + 「继续上次」
  ├─ 对话流: 提案卡/产物内嵌/进度流
  └─ 全局: Shift+Enter 任何页面唤起同一助手(现状保留)

L1 工作台层(逃生舱,顶部精简导航)
  创作: 图片 / 视频 / 音频 (GenerateView 系)
  场景: 短剧工作室(studio 合并 animatic+drama) / 数字人 / 译制 / 图片编辑 / 视频剪辑
  资产: 作品库 / 主体库
  探索: 市场(应用+技能) / 画布(专家逃生舱)

L2 系统层(收纳,不占一级导航)
  资源中心(模型/训练/看板) / 设置 / 观测(admin) / 管理(admin)
```

### 2.2 五项问题治理决策

| 问题 | 决策 |
|---|---|
| 双轨容器 | models/train/backlot 仅保留资源中心 tab 容器,独立 view key 301 重定向进资源中心对应 tab |
| 视频编辑双入口 | AiVideoEditView 从 GenerateView 拆出,并入 videoEdit 视图为「AI 编辑」模式;生成页只留引擎切换 |
| 短剧三路径 | studio 为唯一入口;animatic 保留为 studio 内的「动态分镜」阶段;drama 旧管线视图删除(R18 直达链接 301 到 studio) |
| agent-runs 孤儿 | 并入对话首页「任务」抽屉(Agent Team 作为助手多智能体模式的运行记录) |
| 超级视图杂糅 | GenerateView 拆:舞台(产物) / 参数(引擎+ParamField) / 引用(主体) 三区;LibraryView 的 3D 纹理/超分操作收进产物详情抽屉 |

### 2.3 助手 UI 驱动能力(配合 D)

后端新增助手工具(前端 bridge 执行):
- `navigate_view(view, params)` — 跳转并预填(如「帮我把这张图送到译制」→ dub 页预填视频)
- `prefill_generate(kind, params)` — 预填生成参数不提交
- `open_asset(asset_id)` — 打开产物详情
- 提案卡确认门机制(propose_plan)保留,复杂多步任务一律走提案确认

### 2.4 视觉方向

- 延续用户既有偏好:浅色系优先、Film Atelier 暗房隐喻退潮为「工作台」隐喻、粒子仅用于首页空态背景(微粒聚集成引导卡片,克制,≤300 粒,速度 ≤1.2,不遮文字)
- 色板 ≤5 色,lucide-react 唯一图标源,动效 ≤320ms,遵循 reduced-motion
- 对话首页视觉锚点:输入框为舞台中心,引导卡片围绕;产出物在对话流内以胶片条(filmstrip)形式内嵌

## 3. 数据流

对话首页 → AssistantOverlay 组件升格为整页视图;工具调用经 SSE 流回;navigate_view 工具经前端 bridge 写 view 状态机(page.tsx)。其余视图 URL(?view=)体系保留兼容,LEGACY_VIEW_REDIRECTS 扩充收纳旧 key。

## 4. 错误处理

- 助手不可用(spark 双机全挂):首页降级为场景卡片门户(C 方案形态),对话区替换为「助手离线」提示 + 传统导航自动展开
- navigate_view 目标不存在:助手侧返回错误并重述可用目标
- 长任务:提案确认门 + 任务中心追踪(现状保留)

## 5. 测试策略

- 每波次:TDD 新测试 + npm test 全量 + tsc 0 + 干净 build
- IA 重构:view key 重定向断言、导航项快照、admin 注入不重复
- 助手工具:navigate_view/prefill 单测 + e2e(对话→跳转→预填)
- 回归基线:当前 npm test 910 / pytest 2974

## 6. 实施波次

- W1 IA 骨架:三层结构落地、五项治理决策、旧 key 重定向
- W2 对话首页:Assistant 整页化、引导卡片、「继续上次」
- W3 助手 UI 驱动工具:navigate/prefill/open_asset + bridge
- W4 视觉焕新:token 体系调整、首页粒子空态、filmstrip 产物内嵌
- W5 降级路径 + 全量回归 + 生产部署

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 老用户找不到原入口 | 逃生舱一级导航保留全部高频项;旧 URL 301 不 404 |
| 助手可靠性成为单点 | L0 离线降级为 C 形态门户 |
| 27B→125B 切换质量波动 | 验收测试套件(qwen38_acceptance.py)全绿才切换;27B 容器保留热回退 |
