<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';

import { assertApiBaseSane, resolveApiBase } from '@/api/config';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';

onLaunch(() => {
  // 1. 设置先行：恢复色板/模式/API 覆盖/NSFW 意图并桥接回 api 层
  const settings = useSettingsStore();
  settings.restore();

  // 2. 生产回环防呆（开发构建放行）
  assertApiBaseSane(resolveApiBase(), import.meta.env.DEV);

  // 3. 会话恢复（异步，页面侧用 status 做门控）
  const auth = useAuthStore();
  void auth.restore();
});
</script>

<style lang="scss">
/* 全局基础样式：页面根节点由各页 :style="themeVars" 注入变量 */
page {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
}
</style>
