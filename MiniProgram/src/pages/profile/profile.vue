<script setup lang="ts">
/**
 * 我的页（MP5）
 * - 账户卡片：邮箱 + 角色（auth store 快照，弱网兜底在 restore 层）
 * - 外观：显示模式三段切换 + 五色板换肤（换肤零组件改动由 Token 保证）
 * - 高级：API 基址覆盖（自定义服务端）+ NSFW 意图开关（开启需二次确认）
 * - 关于（MP26）：关于展开（版本/定位/版权）+ 检查更新 + 清理缓存（白名单保护）+ 导出诊断（脱敏）
 * - 退出登录：secondary 克制变体语义，确认后清空会话回登录页
 */
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { resolveApiBase } from '@/api/config';
import TabBar from '@/components/business/tab-bar.vue';
import Icon from '@/components/ui/icon.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import manifest from '@/manifest.json';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore, type ThemeMode } from '@/stores/settings';
import { getPalette, palettes } from '@/theme/tokens';
import {
  buildDiagnostics,
  formatBytes,
  planCacheClear,
  type StorageKeyStat,
} from '@/utils/maintenance';
import { platformName } from '@/utils/platform';

const APP_VERSION = manifest.versionName;

const { themeVars, isDark, palette } = useAppTheme();
const { requireAuth } = useAuthGuard();
const auth = useAuthStore();
const settings = useSettingsStore();

const MODES: { id: ThemeMode; label: string; icon: string }[] = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'sun-moon' },
];

const user = computed(() => auth.user);
const effectiveApiBase = computed(() => resolveApiBase());
const swatchMode = computed(() => (isDark.value ? 'dark' : 'light'));

onShow(() => {
  requireAuth();
  refreshCacheSize();
});

// ── API 基址覆盖 ──
function editApiBase() {
  uni.showModal({
    title: 'API 基址',
    editable: true,
    placeholderText: '留空恢复默认',
    content: settings.apiBaseOverride ?? '',
    success: (res) => {
      if (!res.confirm) return;
      const value = (res.content ?? '').trim();
      if (value && !/^https?:\/\//.test(value)) {
        uni.showToast({ title: '需以 http(s):// 开头', icon: 'none' });
        return;
      }
      settings.setApiBase(value || null);
      uni.showToast({ title: value ? '已覆盖，下次请求生效' : '已恢复默认', icon: 'none' });
    },
  });
}

function resetApiBase() {
  if (!settings.apiBaseOverride) return;
  settings.setApiBase(null);
  uni.showToast({ title: '已恢复默认', icon: 'none' });
}

// ── NSFW 意图 ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onNsfwToggle(e: any) {
  const on = !!e?.detail?.value;
  if (!on) {
    settings.setNsfw(false);
    return;
  }
  // 开启前二次确认；取消则回弹开关
  uni.showModal({
    title: '开启 NSFW 意图',
    content: '开启后可能显示成人向引擎与内容，请确认你已年满 18 岁且当地法律允许。',
    confirmText: '我已知晓',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) settings.setNsfw(true);
      // 取消不动作：switch 受控于 settings.nsfwIntent，自动回弹
    },
  });
}

// ── 参考资产库（MP13） ──
function goAssets() {
  uni.navigateTo({ url: '/pages/assets/index' });
}

// ── 关于（MP26） ──
const aboutOpen = ref(false);
function toggleAbout() {
  aboutOpen.value = !aboutOpen.value;
}

/** 检查更新：小程序端 getUpdateManager 监听只绑一次；H5 无此 API 降级提示 */
let updateManagerBound = false;
function checkUpdate() {
  if (typeof uni.getUpdateManager !== 'function') {
    uni.showToast({ title: 'H5 端自动保持最新', icon: 'none' });
    return;
  }
  if (!updateManagerBound) {
    updateManagerBound = true;
    const um = uni.getUpdateManager();
    um.onCheckForUpdate((res) => {
      if (!res.hasUpdate) uni.showToast({ title: `已是最新版本 v${APP_VERSION}`, icon: 'none' });
    });
    um.onUpdateReady(() => {
      uni.showModal({
        title: '新版本已就绪',
        content: '重启小程序应用更新',
        confirmText: '立即重启',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) um.applyUpdate();
        },
      });
    });
    um.onUpdateFailed(() => {
      uni.showToast({ title: '更新下载失败，请稍后重试', icon: 'none' });
    });
  }
  uni.showToast({ title: '正在检查更新…', icon: 'none' });
}

// ── 清理缓存（MP26） ──
const cacheSizeText = ref('--');

/** 汇总 uni storage 键 + 估算大小（键长 + 值长）；存储不可用按空计 */
function collectStorageStats(): StorageKeyStat[] {
  try {
    const info = uni.getStorageInfoSync();
    return info.keys.map((key) => {
      let size = key.length;
      try {
        const raw: unknown = uni.getStorageSync(key);
        if (typeof raw === 'string') size += raw.length;
        else if (raw !== '' && raw != null) size += JSON.stringify(raw)?.length ?? 0;
      } catch {
        // 单键读取失败按 0 计
      }
      return { key, size };
    });
  } catch {
    return [];
  }
}

function refreshCacheSize() {
  const total = collectStorageStats().reduce((sum, k) => sum + k.size, 0);
  cacheSizeText.value = formatBytes(total);
}

/** 二次确认 → 白名单外逐项删除（clearStorageSync 全清会误伤 token/设置/草稿，不可用） */
function confirmClearCache() {
  const stats = collectStorageStats();
  const plan = planCacheClear(stats.map((s) => s.key));
  if (plan.toRemove.length === 0) {
    uni.showToast({ title: '暂无缓存可清理', icon: 'none' });
    return;
  }
  const freed = stats
    .filter((s) => plan.toRemove.includes(s.key))
    .reduce((sum, s) => sum + s.size, 0);
  uni.showModal({
    title: '清理缓存',
    content: `将清理约 ${formatBytes(freed)} 缓存；登录状态、设置与对话草稿会保留。`,
    confirmText: '清理',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return;
      for (const key of plan.toRemove) {
        try {
          uni.removeStorageSync(key);
        } catch {
          // 单键删除失败不中断其余
        }
      }
      refreshCacheSize();
      uni.showToast({ title: `已清理 ${formatBytes(freed)}`, icon: 'none' });
    },
  });
}

// ── 导出诊断（MP26） ──
function exportDiagnostics() {
  const sys = uni.getSystemInfoSync();
  const diagnostics = buildDiagnostics({
    app: { name: manifest.name, version: APP_VERSION },
    env: {
      platform: platformName(),
      system: `${sys.platform} ${sys.system}`.trim(),
      pixelRatio: sys.pixelRatio,
      sdkVersion: sys.SDKVersion || null,
      hostVersion: sys.hostVersion || null,
    },
    apiBase: effectiveApiBase.value,
    loggedIn: auth.isLoggedIn,
    nsfwIntent: settings.nsfwIntent,
    storageKeys: collectStorageStats(),
    now: new Date().toISOString(),
  });
  uni.setClipboardData({
    data: JSON.stringify(diagnostics, null, 2),
    success: () => uni.showToast({ title: '诊断信息已复制', icon: 'none' }),
    fail: () => uni.showToast({ title: '复制失败，请重试', icon: 'none' }),
  });
}

// ── 退出登录 ──
function confirmSignOut() {
  uni.showModal({
    title: '退出登录',
    content: '退出后需重新登录才能继续创作',
    confirmText: '退出',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return;
      auth.signOut();
      uni.reLaunch({ url: '/pages/login/login' });
    },
  });
}
</script>

<template>
  <view
    class="profile"
    :style="themeVars"
  >
    <!-- 账户卡片 -->
    <view class="profile__user">
      <view class="profile__avatar">
        <Icon
          name="user"
          :size="48"
          color="var(--color-accent)"
        />
      </view>
      <view class="profile__user-main">
        <text class="profile__email">
          {{ user?.email ?? '未登录' }}
        </text>
        <text class="profile__role">
          {{ user ? `角色：${user.role}` : '会话未建立' }}
        </text>
      </view>
    </view>

    <!-- 外观 -->
    <text class="profile__section">
      外观
    </text>
    <view class="profile__modes">
      <view
        v-for="m in MODES"
        :key="m.id"
        class="profile__mode"
        :class="{ 'profile__mode--active': settings.mode === m.id }"
        hover-class="profile__mode--pressed"
        @tap="settings.setMode(m.id)"
      >
        <Icon
          :name="m.icon"
          :size="32"
          :color="settings.mode === m.id ? 'var(--color-accent)' : 'var(--color-text-secondary)'"
        />
        <text
          class="profile__mode-label"
          :class="{ 'profile__mode-label--active': settings.mode === m.id }"
        >
          {{ m.label }}
        </text>
      </view>
    </view>

    <!-- 色板 -->
    <view class="profile__panel">
      <view
        v-for="(p, idx) in palettes"
        :key="p.id"
        class="profile__row"
        :class="{ 'profile__row--bordered': idx > 0 }"
        hover-class="profile__row--pressed"
        @tap="settings.setPalette(p.id)"
      >
        <view
          class="profile__swatch"
          :style="{ backgroundColor: getPalette(p.id, swatchMode).accent }"
        />
        <text
          class="profile__row-label"
          :class="{ 'profile__row-label--active': settings.paletteId === p.id }"
        >
          {{ p.name }}
        </text>
        <Icon
          v-if="settings.paletteId === p.id"
          name="check"
          :size="36"
          color="var(--color-accent)"
        />
      </view>
    </view>

    <!-- 参考资产库（MP13） -->
    <text class="profile__section">
      资产
    </text>
    <view class="profile__panel">
      <view
        class="profile__row"
        hover-class="profile__row--pressed"
        @tap="goAssets"
      >
        <Icon
          name="folder"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            参考资产库
          </text>
          <text class="profile__row-sub">
            角色/场景/道具/风格卡，创作时直接引用
          </text>
        </view>
        <Icon
          name="chevron-right"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
    </view>

    <!-- 高级 -->
    <text class="profile__section">
      高级
    </text>
    <view class="profile__panel">
      <view
        class="profile__row"
        hover-class="profile__row--pressed"
        @tap="editApiBase"
      >
        <Icon
          name="settings"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            API 基址
          </text>
          <text
            class="profile__row-sub"
            number-of-lines="1"
          >
            {{ effectiveApiBase }}
          </text>
        </view>
        <text
          v-if="settings.apiBaseOverride"
          class="profile__row-action"
          @tap.stop="resetApiBase"
        >
          重置
        </text>
        <Icon
          v-else
          name="chevron-right"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
      <view class="profile__row profile__row--bordered">
        <Icon
          name="eye"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            NSFW 意图
          </text>
          <text class="profile__row-sub">
            按请求放行成人向引擎与内容
          </text>
        </view>
        <switch
          :checked="settings.nsfwIntent"
          :color="palette.accent"
          @change="onNsfwToggle"
        />
      </view>
    </view>

    <!-- 关于（MP26） -->
    <text class="profile__section">
      关于
    </text>
    <view class="profile__panel">
      <view
        class="profile__row"
        hover-class="profile__row--pressed"
        data-action="about-toggle"
        @tap="toggleAbout"
      >
        <Icon
          name="info"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            关于 ToIV
          </text>
          <text class="profile__row-sub">
            版本 / 定位 / 版权
          </text>
        </view>
        <Icon
          :name="aboutOpen ? 'chevron-up' : 'chevron-down'"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
      <view
        v-if="aboutOpen"
        class="profile__about"
      >
        <text class="profile__about-name">
          ToIV · v{{ APP_VERSION }}
        </text>
        <text class="profile__about-line">
          AI 创作平台 · 私有化部署 · 本地推理集群
        </text>
        <text class="profile__about-line">
          © 2026 ToIV
        </text>
      </view>
      <view
        class="profile__row profile__row--bordered"
        hover-class="profile__row--pressed"
        data-action="check-update"
        @tap="checkUpdate"
      >
        <Icon
          name="refresh-cw"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            检查更新
          </text>
          <text class="profile__row-sub">
            当前版本 v{{ APP_VERSION }}
          </text>
        </view>
        <Icon
          name="chevron-right"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
      <view
        class="profile__row profile__row--bordered"
        hover-class="profile__row--pressed"
        data-action="clear-cache"
        @tap="confirmClearCache"
      >
        <Icon
          name="trash-2"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            清理缓存
          </text>
          <text
            class="profile__row-sub"
            number-of-lines="1"
          >
            估算占用 {{ cacheSizeText }}，登录与设置保留
          </text>
        </view>
        <Icon
          name="chevron-right"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
      <view
        class="profile__row profile__row--bordered"
        hover-class="profile__row--pressed"
        data-action="export-diagnostics"
        @tap="exportDiagnostics"
      >
        <Icon
          name="copy"
          :size="36"
          color="var(--color-text-secondary)"
        />
        <view class="profile__row-main">
          <text class="profile__row-label">
            导出诊断信息
          </text>
          <text class="profile__row-sub">
            版本/平台/存储键清单复制到剪贴板（不含隐私值）
          </text>
        </view>
        <Icon
          name="chevron-right"
          :size="32"
          color="var(--color-text-secondary)"
        />
      </view>
    </view>

    <!-- 退出登录 -->
    <view
      class="profile__signout"
      hover-class="profile__signout--pressed"
      @tap="confirmSignOut"
    >
      <Icon
        name="log-out"
        :size="36"
        color="var(--color-danger)"
      />
      <text class="profile__signout-text">
        退出登录
      </text>
    </view>

    <TabBar :selected="3" />
  </view>
</template>

<style scoped lang="scss">
.profile {
  min-height: 100vh;
  background: var(--color-bg);
  padding: 0 var(--space-4);

  &__user {
    margin-top: var(--space-4);
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  &__avatar {
    width: 112rpx;
    height: 112rpx;
    border-radius: 999rpx;
    background: var(--color-accent-soft);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__user-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  &__email {
    font-size: var(--font-heading);
    font-weight: 600;
    color: var(--color-text);
  }

  &__role {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__section {
    display: block;
    margin-top: var(--space-6);
    margin-bottom: var(--space-3);
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    letter-spacing: 2rpx;
  }

  &__modes {
    display: flex;
    flex-direction: row;
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-1);
  }

  &__mode {
    flex: 1;
    height: 80rpx;
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    &--active {
      background: var(--color-accent-soft);
    }

    &--pressed {
      opacity: 0.85;
    }
  }

  &__mode-label {
    font-size: var(--font-body);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
      font-weight: 600;
    }
  }

  &__panel {
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  &__row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    min-height: 96rpx;
    padding: var(--space-3) var(--space-4);

    &--bordered {
      border-top: 1rpx solid var(--color-border);
    }

    &--pressed {
      opacity: 0.85;
    }
  }

  &__row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2rpx;
  }

  &__row-label {
    font-size: var(--font-body);
    color: var(--color-text);

    &--active {
      font-weight: 600;
    }
  }

  &__row-sub {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    overflow: hidden;
  }

  &__row-action {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
    padding: var(--space-2) var(--space-3);
  }

  &__swatch {
    width: 40rpx;
    height: 40rpx;
    border-radius: 999rpx;
    border: 1rpx solid var(--color-border);
  }

  &__about {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1rpx solid var(--color-border);
  }

  &__about-name {
    font-size: var(--font-body);
    font-weight: 600;
    color: var(--color-text);
  }

  &__about-line {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__signout {
    margin-top: var(--space-6);
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    height: 96rpx;
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__signout-text {
    font-size: var(--font-body);
    color: var(--color-danger);
    font-weight: 500;
  }
}
</style>
