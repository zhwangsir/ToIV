import { systemChannelsFromCatalog } from "@/lib/system-channel-catalog";
import { fetchModelCatalog } from "@/services/api/model-catalog";
import { useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export type SystemCatalogHydrationResult = "merged" | "skipped-frontend" | "stale-user" | "failed";

export type SystemCatalogHydrationDeps = {
    userId: string;
    signal?: AbortSignal;
    fetchCatalog: () => Promise<unknown>;
    isCurrentUser: (userId: string) => boolean;
    mergeSystemChannels: (channels: ModelChannel[]) => void;
    onFailure?: (error: unknown) => void;
};

// 系统渠道目录水合的唯一编排点：client-root-init 只负责在已认证、非 localMode 时调用。
// 拉取成功且用户仍是发起者时合并规范化后的系统渠道；frontend 源不在本切片消费；
// 任何失败都保留现有配置并显式上报，不假装成功。
export async function hydrateSystemModelCatalog({ userId, signal, fetchCatalog, isCurrentUser, mergeSystemChannels, onFailure }: SystemCatalogHydrationDeps): Promise<SystemCatalogHydrationResult> {
    let payload: unknown;
    try {
        payload = await fetchCatalog();
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return "failed";
        onFailure?.(error);
        return "failed";
    }
    if (!isCurrentUser(userId)) return "stale-user";
    const response = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { source?: unknown }) : null;
    if (response?.source !== "system") {
        // frontend 逻辑模型源不在本切片臆造映射，也不清空渠道。
        return "skipped-frontend";
    }
    // source=system 时以服务端目录为准替换 system 段（映射为空即清空下架渠道）。
    mergeSystemChannels(systemChannelsFromCatalog(payload));
    return "merged";
}

export function hydrateSystemModelCatalogForUser(userId: string, signal?: AbortSignal): Promise<SystemCatalogHydrationResult> {
    return hydrateSystemModelCatalog({
        userId,
        signal,
        fetchCatalog: () => fetchModelCatalog(signal),
        isCurrentUser: (id) => useUserStore.getState().user?.id === id,
        mergeSystemChannels: (channels) => useConfigStore.getState().mergeSystemChannels(channels),
        onFailure: (error) => console.warn("系统模型目录拉取失败，保留当前渠道配置", error),
    });
}
