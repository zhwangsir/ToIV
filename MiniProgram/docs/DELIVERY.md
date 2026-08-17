# ToIV MiniProgram 交付清单

> 版本：v1.0.0
> 日期：2026-08-15
> 状态：**交付就绪**

---

## 一、交付物

| 类别 | 路径 | 说明 |
|------|------|------|
| 源码 | `src/` | UniApp + Vue3 + TS strict + Pinia |
| 构建产物 | `dist/build/mp-weixin/` | 微信小程序（生产基址 192.168.71.47:8090） |
| 构建产物 | `dist/build/mp-alipay/` | 支付宝小程序 |
| 构建产物 | `dist/build/mp-toutiao/` | 抖音小程序 |
| 构建产物 | `dist/build/h5/` | H5（开发/预览用） |
| 技术规格 | `docs/mini-program-tech-spec.md` | 初始化/目录/语法/组件/部署/契约 |
| 测试日志 | `TEST_LOG.md` | 31 里程碑完整测试记录 |
| 状态跟踪 | `STATE.json` | 31 里程碑状态 + next 候选 |
| UAT 报告 | `docs/UAT.md` | 47 项用户验收用例 100% 通过 |
| 走查截图 | `docs/ux-walkthrough/` | H5 走查截图（111 检查点） |
| 走查截图 | `docs/ux-walkthrough-weixin/` | 微信端走查截图（30 检查点） |

---

## 二、功能模块清单

| 模块 | 里程碑 | 核心能力 |
|------|--------|---------|
| 登录/鉴权 | MP2, MP31 | 账密登录（zod 校验/密码可见/token 持久化/弱网兜底）；微信登录已回退备查 |
| 创作 | MP3-MP11, MP14 | 12 引擎（txt2img/img2img/视频/音频/3D/avatar-talk）；反推/优化提示词；参数抽屉；R18 引擎 NSFW 门控 |
| 作业监控 | MP12, MP29 | 作业卡状态徽章；会话内 SSE 进度条（看门狗/去重/回退轮询）；quality_warning |
| 作品库 | MP13, MP19, MP25, MP28 | 无限分页；kind 过滤；多选/批量删除/批量保存；产物详情/版本链/存为资产 |
| 资产库 | MP13, MP27, MP28 | CRUD；多选批量删除；产物存为资产 prefill |
| 对话助手 | MP19-MP24, MP30 | SSE 流式；会话管理/分叉；文档挂载；附图上传；草稿持久化 |
| Agent 团队 | MP21-MP23 | 运行监控；确认门裁决；计划编辑；任务卡干预 |
| 设置页 | MP26 | 外观/资产/高级/关于；清理缓存；导出诊断；深浅色/五色板 |

---

## 三、质量指标

| 指标 | 数值 |
|------|------|
| 单元测试 | vitest 26 套件 **565 用例** |
| H5 走查 | **111 检查点** |
| 微信端走查 | **30 检查点** |
| UAT 用例 | **47 项，100% 通过** |
| 类型检查 | vue-tsc 0 错误 |
| 代码检查 | eslint 0 警告 |
| 构建成功率 | 4/4 端（h5/mp-weixin/mp-alipay/mp-toutiao） |
| 测试覆盖率 | 核心模块 ≥80%（stores/api/utils） |

---

## 四、部署说明

### 微信小程序（生产）

1. 微信开发者工具 → 导入 `dist/build/mp-weixin/`
2. 详情 → 本地设置 → 勾选「不校验合法域名…」（后端为局域网 IP）
3. 用管理员发放的账号密码登录

### 支付宝/抖音小程序

1. 对应开发者工具 → 导入 `dist/build/mp-alipay/` 或 `dist/build/mp-toutiao/`
2. 同上勾选域名校验豁免

### H5（开发/预览）

```bash
npm run dev:h5        # 开发
npm run build:h5      # 构建产物在 dist/build/h5/
```

---

## 五、后续项（外部依赖）

| 项 | 负责方 | 状态 |
|----|--------|------|
| MP9 Round 2 微信真机走查 | 用户手动 | 待执行（相册/摄像头/文件权限） |
| M18 Android 真机走查 | 用户手动 | 待执行（APK 已构建） |
| Agent 四期 upload/reprompt | 后端 R3.2 | 501 阻塞 |
| iOS 真机验证 | Apple Developer 账号 | 未提供 |
| 微信登录恢复 | uni 框架修复或原生 button 重写 | 备查（后端端点已部署） |

---

## 六、联系

- 后端 API：`http://192.168.71.47:8090`（生产）
- 设计规范：`../Mobile/docs/ui-ux-design-guidelines.md`
- 开发规范：`../Mobile/docs/development-standards.md`
