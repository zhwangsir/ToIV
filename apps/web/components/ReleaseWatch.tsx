"use client";

import { useCallback, useState } from "react";
import {
  deployedVersionDiffers,
  fetchDeployedBuildId,
  resolveRunningBuildId,
  VERSION_POLL_INTERVAL_MS,
} from "@/lib/releaseWatch";
import { usePoll } from "@/hooks/usePoll";
import { useToast } from "@/components/ui/Toast";

/**
 * 发版软提示组件(发版防御三件套之一):
 * 挂载后通过 usePoll 低频轮询 /version.json,比对 BUILD_ID,
 * 发现不一致时弹出 toast「新版本已发布,刷新即可更新」——硬阻断不做,
 * 让用户在合适时机自行刷新。提示过一次即停止(信号粘性)。
 * 页面隐藏时 usePoll 自动暂停,回前台立即补一次。
 * 仅生产启用:dev 下 .next/BUILD_ID 与构建指纹不同源,比对会误报。
 */
export function ReleaseWatch() {
  const { info } = useToast();
  // 提示过一次即停止轮询(信号粘性,继续轮询无意义)
  const [notified, setNotified] = useState(false);

  const running = resolveRunningBuildId();
  const enabled =
    process.env.NODE_ENV === "production" && running !== null && !notified;

  const check = useCallback(async () => {
    if (running === null) return;
    const deployed = await fetchDeployedBuildId();
    if (deployedVersionDiffers(deployed, running)) {
      info("新版本已发布,刷新即可更新");
      setNotified(true);
    }
  }, [info, running]);

  usePoll(check, {
    intervalMs: VERSION_POLL_INTERVAL_MS,
    enabled,
    immediate: true,
  });

  return null;
}
