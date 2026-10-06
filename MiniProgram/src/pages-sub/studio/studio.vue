<script setup lang="ts">
/**
 * C6 全平台（2026-10-07）：创作工作台 web-view 壳。
 * 承载 /studio PWA（Phase C 后 Next 直出 + ToIV JWT 直验）：
 * 登录态取 uni storage token，经 URL 引导参数递给 H5——SPA 侧（main.tsx）落
 * localStorage.toiv_token 并调 /studio/auth/exchange 播种会话 cookie 后自清参数。
 * 未登录重定向登录页（含微信一键登录 uni.login → /auth/wechat）。
 *
 * 发布前置（用户操作，见 docs/ops/DRAMA_UI_PLAN.md C6 条目）：
 *  ① manifest.json mp-weixin appid 填入；
 *  ② mp 后台「业务域名」（web-view 用）配置 https://toiv.wineryz.top——需下载校验文件，
 *    部署到站点根（toiv-web app/[verifyFile]/route.ts 从 STUDIO_MP_VERIFY_DIR 承载）；
 *  ③ 「request 合法域名」同域配置（uni.request /api/auth/wechat 用）。
 */
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { getToken } from '@/api/client';
import { resolveApiBase } from '@/api/config';

const studioUrl = ref('');

onShow(() => {
  const token = getToken();
  if (!token) {
    uni.redirectTo({ url: '/pages/login/login' });
    return;
  }
  const base = resolveApiBase().replace(/\/$/, '');
  studioUrl.value = `${base}/studio/?miniapp_token=${encodeURIComponent(token)}`;
});
</script>

<template>
  <!-- #ifdef MP-WEIXIN -->
  <web-view
    v-if="studioUrl"
    :src="studioUrl"
  />
  <!-- #endif -->
  <!-- #ifndef MP-WEIXIN -->
  <view class="studio-fallback">
    <text>创作工作台仅微信小程序端提供</text>
  </view>
  <!-- #endif -->
</template>

<style scoped>
.studio-fallback {
  display: flex;
  height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 32rpx;
  text-align: center;
  color: var(--toiv-text-secondary, #666);
  font-size: 28rpx;
}
</style>
