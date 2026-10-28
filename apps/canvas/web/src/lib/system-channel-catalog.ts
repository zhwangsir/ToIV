import { sanitizeServerImageCapability, sanitizeServerTextCapability, sanitizeServerVideoCapability, type ModelCapabilityConfig } from "@/lib/model-capabilities";
import { normalizeModelProtocol } from "@/lib/model-protocols";
import { createModelChannel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

// GET /api/model-catalog 的 wire 形状（backend/internal/modelcatalog.CatalogResponse）。
// source=frontend 时 models 有语义；source=system 时 channels 有语义，两者互斥。
export type ModelCatalogResponse = {
    source: "frontend" | "system" | string;
    models: unknown[];
    channels: PublicChannelCatalog[];
};

export type PublicChannelCatalog = {
    id: string;
    name: string;
    displayName: string;
    sortOrder: number;
    models: PublicChannelCatalogModel[];
};

export type PublicChannelCatalogModel = {
    id: string;
    modelKey: string;
    displayName: string;
    icon: string;
    capability: string;
    protocol: string;
    capabilityConfig?: Record<string, unknown>;
    available: boolean;
};

type ChannelModelProfile = NonNullable<ModelChannel["modelProfiles"]>[number];

function catalogObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function catalogString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeCatalogCapability(value: unknown): ModelCapability | null {
    return value === "text" || value === "image" || value === "video" || value === "audio" ? value : null;
}

// 服务端能力配置按能力互斥下发（text 模型只有 text 段，以此类推）。
// 只接受与 capability 匹配且通过消毒的段；畸形段整体丢弃，不做部分合并。
function sanitizeCatalogCapabilityConfig(capability: ModelCapability, value: unknown): ModelCapabilityConfig | undefined {
    const object = catalogObject(value);
    if (!object) return undefined;
    if (capability === "text") {
        const text = sanitizeServerTextCapability(object.text);
        return text ? { version: 1, text } : undefined;
    }
    if (capability === "image") {
        const image = sanitizeServerImageCapability(object.image);
        return image ? { version: 1, image } : undefined;
    }
    if (capability === "video") {
        const video = sanitizeServerVideoCapability(object.video);
        return video ? { version: 1, video } : undefined;
    }
    return undefined;
}

function mapCatalogModel(raw: unknown): { model: string; profile: ChannelModelProfile } | null {
    const record = catalogObject(raw);
    if (!record) return null;
    if (record.available === false) return null;
    const model = catalogString(record.modelKey);
    if (!model) return null;
    const capability = normalizeCatalogCapability(record.capability);
    if (!capability) return null;
    // protocol 只接受字符串：未知协议原样保留给协议安装层裁决，非字符串直接忽略。
    const protocol = normalizeModelProtocol(record.protocol);
    const capabilityConfig = sanitizeCatalogCapabilityConfig(capability, record.capabilityConfig);
    const displayName = catalogString(record.displayName);
    const icon = catalogString(record.icon);
    return {
        model,
        profile: {
            model,
            ...(displayName ? { displayName } : {}),
            ...(icon ? { icon } : {}),
            capability,
            ...(protocol ? { protocol } : {}),
            ...(capabilityConfig ? { capabilityConfig } : {}),
        },
    };
}

function mapCatalogChannel(raw: unknown): ModelChannel | null {
    const record = catalogObject(raw);
    if (!record) return null;
    const id = catalogString(record.id);
    if (!id) return null;
    const models: string[] = [];
    const modelProfiles: ChannelModelProfile[] = [];
    if (Array.isArray(record.models)) {
        for (const rawModel of record.models) {
            const mapped = mapCatalogModel(rawModel);
            if (!mapped) continue;
            models.push(mapped.model);
            modelProfiles.push(mapped.profile);
        }
    }
    // 全部模型畸形/下架的渠道不下发，避免空占位渠道覆盖旧目录。
    if (!models.length) return null;
    const sortOrder = Number(record.sortOrder);
    return createModelChannel({
        id,
        name: catalogString(record.displayName) || catalogString(record.name) || id,
        ...(Number.isFinite(sortOrder) ? { sortOrder } : {}),
        scope: "system",
        apiKey: "system",
        baseUrl: `/api/ai/system/${id}`,
        apiFormat: "openai",
        models,
        modelProfiles,
    });
}

// 只消费 source=system 的在线渠道目录；frontend 逻辑模型不在本切片映射，
// 返回空数组表示“本次没有可合并的系统渠道”，调用方不得据此清空渠道。
export function systemChannelsFromCatalog(payload: unknown): ModelChannel[] {
    const response = catalogObject(payload);
    if (!response || response.source !== "system") return [];
    if (!Array.isArray(response.channels)) return [];
    const channels: ModelChannel[] = [];
    for (const raw of response.channels) {
        const channel = mapCatalogChannel(raw);
        if (channel) channels.push(channel);
    }
    return channels;
}
