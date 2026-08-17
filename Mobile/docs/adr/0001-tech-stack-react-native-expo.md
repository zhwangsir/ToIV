# ADR 0001：ToIV 移动端技术选型 —— React Native (Expo)

> 状态：✅ Accepted（2026-08-11）
> 决策人：移动端负责人（AI Assistant），经用户授权「你更向往哪种」自行拍板
> 范围：ToIV 移动端（iOS / Android / 平板，后续可扩 Web 兜底）

---

## 1. Context（背景）

- ToIV 已有：FastAPI 后端（core `192.168.71.47:8090`，Bearer token 认证）、Next.js 15 + React 19 + TypeScript Web 端（`:3100`）。
- 需要：一套代码覆盖 iOS + Android 的移动端，承接「创作提交 → 作业轮询 → 媒体画廊 → 个人中心」核心链路。
- 团队/生态现状：全项目 TypeScript + React 心智；图标硬性规定 Lucide 唯一来源；用户偏好浅色优先、简洁优雅、克制动效。

## 2. Decision（决定）

采用 **React Native + Expo** 生态：

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Expo（最新稳定 SDK，`create-expo-app@latest` 初始化时锁定） | OTA 热更、EAS 云构建、原生能力开箱即用 |
| 路由 | Expo Router（文件路由，`src/app/`） | 与 Next.js App Router 同心智，天然深链 |
| 语言 | TypeScript `strict` | 与 Web 共享类型定义（API DTO） |
| 服务端状态 | TanStack Query | 行业 2026 主流（约 80% 采用项目的服务端数据由它管理），对齐 Web `swr-cache` 职责 |
| 客户端状态 | Zustand + MMKV 持久化 | 轻量（~1KB）、无 Provider、TS 友好 |
| 样式 | NativeWind v4（Tailwind for RN）+ 设计 Token | 与 Web token 体系对齐，支持 CSS 变量换肤 |
| 图标 | **lucide-react-native（唯一图标源）** | 🔒 全项目硬性规定，禁止 emoji / 其他图标库 / 自定义 SVG |
| 媒体 | expo-video / expo-image / expo-audio | 画廊与播放核心场景，自带缓存 |
| 动效 | Reanimated + Gesture Handler | UI 线程 60fps，克制动效的技术载体 |
| 认证存储 | expo-secure-store | token 落 Keychain/Keystore，**禁止 AsyncStorage 存 token** |

## 3. Alternatives Considered（备选方案对比）

| 方案 | 优势 | 否决原因 |
|---|---|---|
| **Uniapp 生态** | 小程序一端多发；国内插件市场成熟 | Vue 技术栈与现有 React/TS 体系断裂；类型系统与工程化弱；ToIV 无小程序诉求；长链路媒体体验上限低 |
| **Flutter 生态** | 渲染一致性最高；性能上限好 | 引入 Dart 全新语言栈，与 Web 团队零复用；包体积大；与现有类型/工具链完全割裂。若未来出现极致端上性能诉求可复议 |
| **原生双端（Swift/Kotlin）** | 体验与性能上限最高；平台能力最全 | 双倍人力与维护成本；ToIV 移动端本质是「API 消费 + 媒体展示」，重计算全在集群端，用不到原生极限；迭代速度慢 |
| **React Native (Expo)** ✅ | 与 Web 同语言同心智，类型/工具链/图标库直接复用；OTA 绕过商店审核热修；EAS 全链路成熟 | 原生定制模块需 Config Plugin；端上不承担重计算（对 ToIV 无影响） |

## 4. Consequences（后果与约束）

**收益**
- 一套 TS 代码覆盖 iOS/Android/Web 三端潜力；API DTO 类型可从 `apps/web/lib/types.ts` 平移。
- Expo Updates（OTA）：JS 层热修不过审，契合快速迭代。
- Expo Router 文件路由 + 深链，与 Next.js 开发者零摩擦。

**代价与边界**
- 端上不做任何模型推理/重媒体处理（全部走 core API + 集群）。
- 需要原生能力时走 Expo Config Plugin / Development Build，不用 Expo Go 作为最终验证环境。
- 🔒 每个里程碑必须**真机验证**（iOS + Android 实体机），模拟器/预览不构成验收依据（对齐 AGENTS.md「文档仅供参考，必须真机验证」硬性规则）。

## 5. 复议条件

出现以下任一情况时重开本决策：① 端上需本地推理或重度音视频处理；② Expo 官方停止维护；③ 商店政策禁止 OTA 热更。
