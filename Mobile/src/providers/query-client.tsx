import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * 服务端状态入口（规范 3.2：服务端状态一律走 TanStack Query）
 * - retry 2：对齐轮询场景的弱网容忍；mutation 不自动重试（生成提交不可重放）
 * - 页面失焦不自动 refetch：RN 无窗口焦点语义，刷新靠轮询/下拉刷新显式触发
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: 0 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
