# ToIV 小程序端技术规范（UniApp）

> 版本：v1.0（2026-08-13）
> 适用范围：`ToIV/MiniProgram/` 目录下全部小程序代码
> 上位约束：ToIV 根仓库 `AGENTS.md`、用户画像硬性规则、Mobile 端 `docs/development-standards.md` 与 `docs/ui-ux-design-guidelines.md`
> 目标平台：微信小程序（主）、H5（辅）、App（预留）

---

## 一、技术选型

| 层级 | 选型 | 版本/说明 |
|---|---|---|
| 跨端框架 | UniApp | Vue3 + Vite + TypeScript 官方 CLI 模板 |
| 前端框架 | Vue 3 | Composition API + `<script setup lang="ts">` |
| 语言 | TypeScript | `strict: true`，与 Mobile 端同等严格 |
| 状态管理 | Pinia | 官方内置，组合式 API 友好 |
| 持久化 | pinia-plugin-persistedstate | 自定义 storage 驱动为 `uni.setStorageSync` |
| UI 组件库 | uView Plus 为主 + uni-ui 补充 | uView Plus 3.x（Vue3/鸿蒙/小程序兼容） |
| 图标库 | vu-icons/uniapp（Lucide 风格） | 小程序环境 SVG 降级方案，保持 Lucide 视觉一致性 |
| 网络请求 | uni.request + uni.addInterceptor | 自研 httpClient，对齐 Mobile `lib/api.ts` 行为 |
| 样式 | SCSS + CSS 变量 + rpx | 复用 Mobile `theme/tokens.ts` 色彩语义 |
| 构建 | Vite | Node >= 18/20 |

### 1.1 不选其他方案的原因

- **Taro**：React 栈更顺手，但 ToIV 小程序端明确要用 UniApp 生态，且团队 Vue3 学习成本低于 React。
- **原生小程序**：开发效率低，多端复用差。
- **uView 2.x / uv-ui**：uView 2.x 主要面向 Vue2；uv-ui 虽兼容 Vue3，但维护节奏与文档完整性弱于 uView Plus 3.x。

---

## 二、项目初始化

```bash
# 官方 Vue3 + TypeScript + Vite 模板
npx degit dcloudio/uni-preset-vue#vite-ts MiniProgram

# 若 github 拉取失败，换 gitee 镜像
npx degit dcloudio/uni-preset-vue#vite-ts --mode=git mini-program
```

进入项目后安装核心依赖：

```bash
cd MiniProgram
npm install

# UI 库
npm install uview-plus@3

# 状态管理 + 持久化
npm install pinia pinia-plugin-persistedstate

# 图标
npm install vu-icons

# 校验
npm install zod
```

---

## 三、目录结构

```
MiniProgram/
├── src/
│   ├── pages/                    # 主包页面
│   │   ├── index/index.vue       # 创作首页（Prompt-First）
│   │   ├── jobs/jobs.vue         # 作业列表
│   │   ├── library/library.vue   # 作品库
│   │   └── profile/profile.vue   # 我的
│   ├── pages-sub/                # 分包页面（按需加载）
│   │   └── artifact/artifact.vue # 作品详情
│   ├── components/               # 全局组件
│   │   ├── ui/                   # 基础 UI 封装
│   │   │   ├── icon.vue          # Lucide 图标统一封装
│   │   │   ├── button.vue        # 按钮四态封装
│   │   │   ├── prompt-bar.vue    # 贴底提示词输入条
│   │   │   ├── param-sheet.vue   # 参数抽屉
│   │   │   ├── job-card.vue      # 作业卡片
│   │   │   ├── gallery-grid.vue  # 作品网格
│   │   │   └── empty.vue         # 空状态
│   │   └── business/             # 业务组件
│   ├── api/                      # 接口定义（与 Mobile lib/api.ts 对齐）
│   │   ├── client.ts             # uni.request 封装
│   │   ├── auth.ts
│   │   ├── generate.ts
│   │   ├── jobs.ts
│   │   ├── library.ts
│   │   └── upload.ts
│   ├── types/                    # TypeScript 类型
│   │   ├── api.ts                # DTO，尽量与 Mobile src/types/api.ts 同构
│   │   └── global.d.ts
│   ├── stores/                   # Pinia stores
│   │   ├── index.ts
│   │   ├── auth.ts               # token / 用户信息
│   │   ├── settings.ts           # 主题/色板/NSFW/API 覆盖
│   │   └── draft.ts              # 创作草稿（非持久化）
│   ├── utils/                    # 工具函数
│   │   ├── storage.ts            # 跨端 storage 适配
│   │   ├── format.ts
│   │   └── platform.ts           # 平台判断
│   ├── composables/              # 组合式函数
│   │   ├── use-app-theme.ts
│   │   ├── use-poll.ts           # 作业轮询
│   │   └── use-upload.ts         # 图片上传
│   ├── static/                   # 静态资源（不编译）
│   ├── App.vue
│   ├── main.ts
│   ├── manifest.json             # 各平台应用配置
│   ├── pages.json                # 页面路由/窗口/tabBar
│   └── uni.scss                  # 全局 SCSS 变量
├── .env / .env.development / .env.production
├── vite.config.ts
├── tsconfig.json
├── eslint.config.mjs
├── package.json
└── README.md
```

### 3.1 目录规则

- `pages/` 只放页面，禁止放可复用组件。
- `components/ui/` 对应 Mobile `components/ui/`，保持同名组件接口一致。
- `api/client.ts` 承担 Mobile `lib/api.ts` 职责：统一 baseURL、token、X-NSFW 头、错误处理。
- 路径别名 `@/* → src/*`，禁止三层以上相对导入。

---

## 四、语法与组件规范

### 4.1 强制使用 Vue3 组合式 API

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

interface Props {
  engineId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  submit: [payload: { prompt: string; engine: string }]
}>()

const authStore = useAuthStore()
const prompt = ref('')
const isSubmitting = ref(false)

const canSubmit = computed(() => prompt.value.trim().length > 0 && !isSubmitting.value)

async function handleSubmit() {
  if (!canSubmit.value) return
  emit('submit', { prompt: prompt.value, engine: props.engineId })
}
</script>
```

### 4.2 页面生命周期

小程序页面使用 UniApp 生命周期钩子，与 Vue 生命周期共存：

```vue
<script setup lang="ts">
import { onLoad, onShow, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app'

onLoad((options) => {
  // 页面参数解析
})

onShow(() => {
  // 页面显示时刷新状态
})

onPullDownRefresh(() => {
  // 下拉刷新
})

onReachBottom(() => {
  // 上拉加载更多
})
</script>
```

### 4.3 条件编译

优先用平台判断函数，必须平台隔离时用条件编译：

```vue
<script setup lang="ts">
import { isH5, isMpWeixin } from '@/utils/platform'

// 运行时判断
if (isH5()) {
  // H5 专属逻辑
}
</script>

<template>
  <!-- 编译期条件编译 -->
  <!-- #ifdef MP-WEIXIN -->
  <button open-type="share">分享</button>
  <!-- #endif -->
</template>
```

---

## 五、组件库选型

### 5.1 主库：uView Plus 3.x

- **版本**：3.8.x（2026-08-12 更新）
- **优势**：120+ 组件、Vue3 + nvue + 鸿蒙 + 小程序全端兼容、维护稳定、工具函数丰富。
- **使用方式**：npm 安装 + `easycom` 自动引入。

```ts
// main.ts
import uviewPlus from 'uview-plus'
import 'uview-plus/index.scss'

app.use(uviewPlus)
```

核心组件映射：

| 场景 | uView Plus 组件 |
|---|---|
| 按钮 | `up-button` |
| 表单输入 | `up-input`、`up-textarea` |
| 弹窗 | `up-popup`、`up-modal` |
| 抽屉 | `up-popup`（mode="bottom"） |
| 列表 | `up-list`、`up-cell` |
| 加载/空状态 | `up-loading`、`up-empty` |
| 图片上传 | `up-upload` |
| 消息提示 | `up-toast` |

### 5.2 补充：uni-ui

- **定位**：官方基础组件，性能最优，全端 100% 兼容。
- **使用场景**：当 uView Plus 某个组件在小程序端表现异常，或需要更轻量的官方实现时，用 uni-ui 补充。
- **典型组件**：`uni-popup`、`uni-load-more`、`uni-icons`（仅作为 fallback，不主用）。

### 5.3 组件库选型结论

- **默认全部使用 uView Plus**，保持视觉与交互一致性。
- **uni-ui 作为备案组件库**，需经技术负责人确认方可引入。
- 禁止同时引入多个大型 UI 库，避免样式冲突和包体积膨胀。

---

## 六、状态管理

### 6.1 Pinia 基础配置

```ts
// src/stores/index.ts
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { storageAdapter } from '@/utils/storage'

const pinia = createPinia()

pinia.use(
  piniaPluginPersistedstate({
    storage: storageAdapter,
    key: (id) => `toiv_mp_${id}`,
  })
)

export default pinia
```

```ts
// src/main.ts
import { createSSRApp } from 'vue'
import App from './App.vue'
import pinia from '@/stores'

export function createApp() {
  const app = createSSRApp(App)
  app.use(pinia)
  return { app }
}
```

### 6.2 跨端 storage 适配器

```ts
// src/utils/storage.ts
export const storageAdapter = {
  getItem(key: string) {
    try {
      return uni.getStorageSync(key) ?? null
    } catch {
      return null
    }
  },
  setItem(key: string, value: string) {
    try {
      uni.setStorageSync(key, value)
    } catch (e) {
      console.error('[storage] set failed:', e)
    }
  },
  removeItem(key: string) {
    try {
      uni.removeStorageSync(key)
    } catch {
      // ignore
    }
  },
}
```

### 6.3 Store 分层

| Store | 职责 | 持久化 |
|---|---|---|
| `auth.ts` | token、用户基本信息 | token 持久化；用户快照可持久化 |
| `settings.ts` | 色板、深浅模式、API 基址覆盖、NSFW 意图 | 全部持久化 |
| `draft.ts` | 当前创作提示词、参考图、参数 | **不持久化**，一次性语义 |

```ts
// src/stores/auth.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAuthStore = defineStore(
  'auth',
  () => {
    const token = ref('')
    const user = ref<{ id: string; name: string } | null>(null)
    const isLoggedIn = computed(() => !!token.value)

    function setToken(value: string) {
      token.value = value
    }

    function logout() {
      token.value = ''
      user.value = null
    }

    return { token, user, isLoggedIn, setToken, logout }
  },
  {
    persist: {
      paths: ['token', 'user'],
    },
  }
)
```

---

## 七、网络请求

### 7.1 封装目标

对齐 Mobile `lib/api.ts`：

- token 从 Pinia `authStore.token` 读取，注入 `Authorization: Bearer <token>`。
- NSFW 意图由 `settingsStore.nsfwIntent` 注入请求头 `X-NSFW: 1`。
- 错误处理：网络错误 → "网络开小差"；HTTP 非 2xx → 后端 msg；401 → 清理 token 跳转登录。
- baseURL 优先级：用户覆盖 > 环境变量 `VITE_API_BASE` > 默认生产值。

### 7.2 httpClient 实现

```ts
// src/api/client.ts
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'

const BASE_URL = import.meta.env.VITE_API_BASE || 'http://192.168.71.47:8090'

interface HttpOptions extends Omit<UniApp.RequestOptions, 'url' | 'method'> {
  nsfw?: boolean
}

function request<T = unknown>(method: UniApp.RequestOptions['method'], url: string, options: HttpOptions = {}) {
  const authStore = useAuthStore()
  const settingsStore = useSettingsStore()

  const baseUrl = settingsStore.apiBase || BASE_URL
  const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`

  const header: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.header,
  }

  if (authStore.token) {
    header.Authorization = `Bearer ${authStore.token}`
  }
  if (options.nsfw ?? settingsStore.nsfwIntent) {
    header['X-NSFW'] = '1'
  }

  return new Promise<T>((resolve, reject) => {
    uni.request({
      url: fullUrl,
      method,
      header,
      timeout: options.timeout || 30000,
      data: options.data,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T)
        } else if (res.statusCode === 401) {
          authStore.logout()
          uni.navigateTo({ url: '/pages/login/login' })
          reject(new Error('登录已过期'))
        } else {
          const msg = (res.data as any)?.msg || `请求失败 (${res.statusCode})`
          uni.showToast({ title: msg, icon: 'none' })
          reject(new Error(msg))
        }
      },
      fail: (err) => {
        uni.showToast({ title: '网络开小差，请稍后重试', icon: 'none' })
        reject(err)
      },
    })
  })
}

export const http = {
  get: <T>(url: string, options?: HttpOptions) => request<T>('GET', url, options),
  post: <T>(url: string, options?: HttpOptions) => request<T>('POST', url, options),
  // ...
}
```

### 7.3 图片上传

```ts
// src/api/upload.ts
export function uploadImage(filePath: string) {
  const authStore = useAuthStore()
  const settingsStore = useSettingsStore()
  const baseUrl = settingsStore.apiBase || import.meta.env.VITE_API_BASE

  return new Promise<{ filename: string; worker: string }>((resolve, reject) => {
    uni.uploadFile({
      url: `${baseUrl}/api/upload`,
      filePath,
      name: 'file',
      header: authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {},
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(res.data))
        } else {
          reject(new Error('上传失败'))
        }
      },
      fail: reject,
    })
  })
}
```

---

## 八、图标方案

### 8.1 选型

- **小程序原生不支持 `<svg>` 标签**，因此不能直接使用 `@lucide/vue`。
- 使用 `vu-icons/uniapp`：基于 Lucide 图标集，小程序端自动降级为 mask/background-image 方案，支持 `size`/`color`。
- 所有图标统一通过 `components/ui/icon.vue` 封装，禁止散落自定义 SVG 或 emoji。

### 8.2 Icon 封装

```vue
<!-- src/components/ui/icon.vue -->
<script setup lang="ts">
import { computed, type Component } from 'vue'
import * as Icons from 'vu-icons/uniapp'

type IconName = keyof typeof Icons

const props = defineProps<{
  name: IconName
  size?: number | string
  color?: string
}>()

const IconComponent = computed(() => Icons[props.name] as Component)
</script>

<template>
  <component :is="IconComponent" :size="size" :color="color" />
</template>
```

---

## 九、样式与主题

### 9.1 复用 Mobile 设计 Token

小程序端复用 Mobile `theme/tokens.ts` 的色彩语义，以 CSS 变量形式注入：

```scss
// src/uni.scss
:root {
  --color-bg: #f8f7f5;
  --color-surface: #ffffff;
  --color-text: #1a1a1a;
  --color-text-secondary: #6b6b6b;
  --color-accent: #2563eb;
  --color-accent-soft: #eff6ff;
  --color-success: #16a34a;
  --color-warning: #f59e0b;
  --color-danger: #dc2626;
  --radius-sm: 6rpx;
  --radius-md: 10rpx;
  --radius-lg: 16rpx;
  --space-1: 8rpx;
  --space-2: 16rpx;
  --space-3: 24rpx;
  --space-4: 32rpx;
}
```

### 9.2 规则

- **浅色优先**，深色模式通过 `.dark` 类覆盖变量。
- 禁止裸写 `#hex` 和魔法数字，一律使用 CSS 变量或 SCSS 变量。
- 间距基于 4pt 网格，用 rpx 实现屏幕适配。
- 触碰热区 >= 48rpx × 48rpx，视觉元素可更小但热区补足。

---

## 十、API 契约对齐

小程序端与 Mobile、Web 共用 `apps/api` 后端，必须复用同一套 DTO：

| 能力 | 接口 | 说明 |
|---|---|---|
| 登录 | `POST /api/auth/login` | 字段 `username`/`password`，响应 `token` |
| 引擎列表 | `GET /api/engines` | 与 Mobile 同构 |
| 文生图 | `POST /api/generate` | 与 Mobile 同构 |
| 图生图 | `POST /api/generate`（img2img） | 先 `POST /api/upload` 获取 filename/worker |
| 作业查询 | `GET /api/jobs/:id` | 轮询语义复刻 Mobile `lib/poll.ts` |
| 作品库 | `GET /api/library` | 待后端 offset/cursor 支持 |

- `src/types/api.ts` 尽量与 `Mobile/src/types/api.ts` 保持一致。
- 后端字段命名以 `apps/api` 源码为准，禁止凭记忆编造。

---

## 十一、开发流程

沿用 Mobile 端规范：

1. **TDD**：先写测试/类型，再写实现。
2. **提交格式**：`feat(mp): 接入登录页`、`fix(mp): 修复 rpx 适配`。
3. **分支**：Trunk-Based，`feat(mp)/xxx`、`fix(mp)/xxx`，生命周期 <= 3 天。
4. **质量门**：
   - `npx vue-tsc --noEmit` 0 错误
   - `npm run lint` 0 警告
   - 小程序端真机/开发者工具验证通过

---

## 十二、部署流程

| 环境 | 命令 | 产物 |
|---|---|---|
| 开发 | `npm run dev:mp-weixin` | `dist/dev/mp-weixin`，导入微信开发者工具 |
| H5 预览 | `npm run dev:h5` | 本地 H5 服务 |
| 生产构建 | `npm run build:mp-weixin` | `dist/build/mp-weixin`，上传微信小程序后台 |
| App | `npm run build:app-plus` | 需要 HBuilderX 云打包 |

---

## 十三、下一步建议

1. 初始化 `MiniProgram/` 项目并安装依赖。
2. 配置 `vite.config.ts`、`tsconfig.json`、`manifest.json`、`pages.json`。
3. 实现 `api/client.ts`、`stores/auth.ts`、`stores/settings.ts`、`components/ui/icon.vue`。
4. 搭建四页骨架（创作 / 作业 / 作品库 / 我的）。
5. 接入登录流程，打通后端 `/api/auth/login`。
6. 微信小程序开发者工具真机验证。
