<script setup lang="ts">
/**
 * 登录页（zod 校验 / 密码可见性 / 提交态，对齐 Mobile (auth)/login）
 * 成功 → reLaunch 回创作页（tab 栈重新初始化）
 *
 * MP32 原生 button 重写：MP31 实测 uni 编译器对自定义组件 <Button @click> 的
 * prop 事件映射在微信渲染层不可靠（按钮无响应），登录按钮全部改用原生
 * <button @tap>（内建组件直绑原生触摸事件，不经 prop 映射），微信一键登录
 * 随原生按钮恢复（条件编译仅 mp-weixin 渲染，链路 wx.login→code→/auth/wechat）。
 */
import { computed, reactive, ref } from 'vue';
import { z } from 'zod';

import Icon from '@/components/ui/icon.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthStore } from '@/stores/auth';

const { themeVars } = useAppTheme();
const auth = useAuthStore();

const schema = z.object({
  email: z.string().trim().min(1, '请输入邮箱').email('邮箱格式不正确'),
  password: z.string().min(1, '请输入密码'),
});

const form = reactive({ email: '', password: '' });
const errors = reactive<{ email?: string; password?: string }>({});
const showPassword = ref(false);
const submitting = ref(false);
const wechatSubmitting = ref(false);
const formError = ref('');

const canSubmit = computed(
  () => form.email.trim().length > 0 && form.password.length > 0 && !submitting.value,
);

async function handleSubmit() {
  formError.value = '';
  errors.email = undefined;
  errors.password = undefined;

  const parsed = schema.safeParse(form);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as 'email' | 'password';
      if (!errors[key]) errors[key] = issue.message;
    }
    return;
  }

  submitting.value = true;
  try {
    await auth.signIn(parsed.data.email, parsed.data.password);
    uni.reLaunch({ url: '/pages/index/index' });
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '登录失败，请重试';
  } finally {
    submitting.value = false;
  }
}

/** 微信一键登录：uni.login 取 code → 后端 /auth/wechat 换 token（仅 mp-weixin 渲染入口） */
async function handleWechatLogin() {
  formError.value = '';
  wechatSubmitting.value = true;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      uni.login({
        provider: 'weixin',
        success: (res) => (res.code ? resolve(res.code) : reject(new Error('微信授权失败，请重试'))),
        fail: () => reject(new Error('微信授权失败，请重试')),
      });
    });
    await auth.signInWithWechat(code);
    uni.reLaunch({ url: '/pages/index/index' });
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '微信登录失败，请重试';
  } finally {
    wechatSubmitting.value = false;
  }
}
</script>

<template>
  <view
    class="login"
    :style="themeVars"
  >
    <view class="login__hero">
      <view class="login__logo">
        <Icon
          name="sparkles"
          :size="72"
          color="var(--color-accent)"
        />
      </view>
      <text class="login__title">
        ToIV
      </text>
      <text class="login__subtitle">
        AI 创作工作台
      </text>
    </view>

    <view class="login__form">
      <!-- #ifdef MP-WEIXIN -->
      <button
        class="login__wechat"
        :loading="wechatSubmitting"
        :disabled="wechatSubmitting"
        hover-class="login__wechat--pressed"
        @tap="handleWechatLogin"
      >
        微信一键登录
      </button>
      <view class="login__divider">
        <view class="login__divider-line" />
        <text class="login__divider-text">
          或使用邮箱登录
        </text>
        <view class="login__divider-line" />
      </view>
      <!-- #endif -->

      <view class="field">
        <text class="field__label">
          邮箱
        </text>
        <input
          v-model="form.email"
          class="field__input"
          type="text"
          placeholder="name@example.com"
          placeholder-class="field__placeholder"
          :disabled="submitting"
          @confirm="handleSubmit"
        >
        <text
          v-if="errors.email"
          class="field__error"
        >
          {{ errors.email }}
        </text>
      </view>

      <view class="field">
        <text class="field__label">
          密码
        </text>
        <view class="field__password">
          <input
            v-model="form.password"
            class="field__input field__input--password"
            :password="!showPassword"
            placeholder="请输入密码"
            placeholder-class="field__placeholder"
            :disabled="submitting"
            @confirm="handleSubmit"
          >
          <view
            class="field__eye"
            @tap="showPassword = !showPassword"
          >
            <Icon
              :name="showPassword ? 'eye-off' : 'eye'"
              :size="40"
              color="var(--color-text-secondary)"
            />
          </view>
        </view>
        <text
          v-if="errors.password"
          class="field__error"
        >
          {{ errors.password }}
        </text>
      </view>

      <view
        v-if="formError"
        class="login__form-error"
      >
        <Icon
          name="circle-alert"
          :size="32"
          color="var(--color-danger)"
        />
        <text class="login__form-error-text">
          {{ formError }}
        </text>
      </view>

      <!-- 原生 button：绕开 uni 自定义组件 prop 事件映射（MP31 微信渲染层无响应） -->
      <button
        class="login__submit"
        :class="{ 'login__submit--disabled': !canSubmit }"
        :loading="submitting"
        :disabled="!canSubmit"
        hover-class="login__submit--pressed"
        @tap="handleSubmit"
      >
        登录
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
.login {
  min-height: 100vh;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 var(--space-8);

  &__hero {
    align-items: center;
    display: flex;
    flex-direction: column;
    margin-bottom: var(--space-12, 96rpx);
  }

  &__logo {
    width: 128rpx;
    height: 128rpx;
    border-radius: var(--radius-xl);
    background: var(--color-accent-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: var(--space-4);
  }

  &__title {
    font-size: var(--font-display);
    font-weight: 700;
    color: var(--color-text);
    letter-spacing: 2rpx;
  }

  &__subtitle {
    margin-top: var(--space-2);
    font-size: var(--font-body);
    color: var(--color-text-secondary);
  }

  &__form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  &__form-error {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__form-error-text {
    font-size: var(--font-caption);
    color: var(--color-danger);
    flex: 1;
  }

  &__divider {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
  }

  &__divider-line {
    flex: 1;
    height: 1rpx;
    background: var(--color-border);
  }

  &__divider-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }
}

/* 原生按钮样式复位 + 设计令牌对齐（ui-btn primary block 语义） */
.login__wechat,
.login__submit {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 96rpx;
  padding: 0 var(--space-6);
  border-radius: var(--radius-md);
  font-size: var(--font-body);
  font-weight: 500;
  line-height: 1.4;

  &::after {
    border: none; /* 微信原生按钮默认描边复位 */
  }
}

.login__wechat {
  background: var(--color-accent);
  color: var(--color-surface);

  &--pressed {
    opacity: 0.82;
  }

  &[disabled] {
    opacity: 0.45;
    background: var(--color-accent);
    color: var(--color-surface);
  }
}

.login__submit {
  background: var(--color-accent);
  color: var(--color-surface);

  &--pressed {
    opacity: 0.82;
  }

  &--disabled,
  &[disabled] {
    opacity: 0.45;
    background: var(--color-accent);
    color: var(--color-surface);
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  &__input {
    height: 96rpx;
    padding: 0 var(--space-4);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
    font-size: var(--font-body);
  }

  &__input--password {
    flex: 1;
    border: none;
    background: transparent;
  }

  &__password {
    display: flex;
    flex-direction: row;
    align-items: center;
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    padding-right: var(--space-2);
  }

  &__eye {
    min-width: 96rpx;
    min-height: 96rpx;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__placeholder {
    color: var(--color-text-secondary);
  }

  &__error {
    font-size: var(--font-caption);
    color: var(--color-danger);
  }
}
</style>
