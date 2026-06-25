"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { getMe, setNsfwEnabled as apiSetNsfwEnabled } from "@/lib/api";

/**
 * 全局 R18(成人内容)软开关状态。
 *
 * - 默认关(enabled=false)。挂载时 getMe() 取账户真实状态(字段暂缺则优雅降级为 false)。
 * - setEnabled 调 POST /api/account/nsfw 持久化 + 即时更新全局状态。
 * - revision 在切换成功后自增 —— 消费方(创作台 / 画布 / 作品库)据此重新拉取列表,
 *   让后端的服务端过滤即时生效(前端不自行过滤内容)。
 */
export interface NsfwContextValue {
  /** 当前账户是否开启 R18(显隐 NSFW 档入口的唯一真相)。 */
  enabled: boolean;
  /** 切换 R18 软开关:持久化 + 更新全局状态;成功返回服务端确认值,失败抛错。 */
  setEnabled: (next: boolean) => Promise<boolean>;
  /** 切换成功后自增的修订号;消费方监听它触发数据重拉。 */
  revision: number;
  /** getMe 是否仍在拉取(可用于初始态占位)。 */
  loading: boolean;
}

const Ctx = createContext<NsfwContextValue | null>(null);

export function NsfwProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);

  // 挂载时取账户 R18 状态;失败(字段缺失 / 会话问题)静默降级为默认关。
  useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (alive) setEnabledState(me.nsfw_enabled);
      })
      .catch(() => {
        /* 优雅降级:保持默认关 */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    const confirmed = await apiSetNsfwEnabled(next);
    setEnabledState(confirmed);
    // 分区切换后触发消费方重拉(后端已据此过滤模型 / 作品)。
    setRevision((r) => r + 1);
    return confirmed;
  }, []);

  const value = useMemo<NsfwContextValue>(
    () => ({ enabled, setEnabled, revision, loading }),
    [enabled, setEnabled, revision, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNsfw(): NsfwContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNsfw 必须在 NsfwProvider 内使用");
  return v;
}
