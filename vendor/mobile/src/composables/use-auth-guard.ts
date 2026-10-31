/**
 * 鉴权门控：tab 页 onShow 调用，未登录踢到登录页
 * restoring 状态由页面自行渲染 loading，不在此跳转（避免冷启动闪烁误踢）
 */
import { useAuthStore } from '@/stores/auth';

export function useAuthGuard() {
  const auth = useAuthStore();

  function requireAuth(): boolean {
    if (auth.status === 'signedOut') {
      uni.reLaunch({ url: '/pages/login/login' });
      return false;
    }
    return true;
  }

  return { auth, requireAuth };
}
