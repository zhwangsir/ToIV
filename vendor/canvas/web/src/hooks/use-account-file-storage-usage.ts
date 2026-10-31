import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { accountFileStorageUsageQueryKey } from "@/lib/account-storage-usage";
import { getAccountFileStorageUsage } from "@/services/api/resources";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { isLocalWorkspaceMode } from "@/services/workspace-mode";
import type { AccountFileStorageUsage } from "@/services/api/resources";

export function useAccountFileStorageUsage(enabled = true) {
    const storageMode = useUserStore((state) => state.storageMode);
    const user = useUserStore((state) => state.user);
    const assets = useAssetStore((state) => state.assets);
    const localMode = isLocalWorkspaceMode() || storageMode === "local" || user?.username === "local";
    const localUsage = useMemo<AccountFileStorageUsage>(() => ({
        usedBytes: assets.reduce((total, asset) => total + ("bytes" in asset.data && Number.isFinite(asset.data.bytes) ? Math.max(0, asset.data.bytes) : 0), 0),
        // Keep the local meter useful without pretending it is a server quota.
        totalBytes: 5 * 1024 * 1024 * 1024,
    }), [assets]);
    const query = useQuery({
        queryKey: accountFileStorageUsageQueryKey,
        // 信号必须传:侧栏每次导航重挂都会新发一次该请求,不 abort 会在 HTTP/1.1
        // 六连接池里累积长请求,把 /api/apps 之类首屏请求挤到排队 >10s(工具箱首进转圈真因)。
        queryFn: ({ signal }) => getAccountFileStorageUsage(signal),
        enabled: enabled && !localMode,
        // staleTime 内重挂不再发请求;refetchOnMount:"always" 会绕过 staleTime 造成累积。
        staleTime: 30_000,
        refetchOnMount: true,
    });
    return localMode ? { ...query, data: localUsage, isPending: false, isError: false } : query;
}
