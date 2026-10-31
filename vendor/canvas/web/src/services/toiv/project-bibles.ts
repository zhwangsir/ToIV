/**
 * P0-4 ProjectBible 前端客户端（吃现有 /api/project-bibles 内存骨架）。
 * 读历史必须显式 version；禁止 version=latest；本波不加 NSFW 闸。
 */
import { toivHttp } from "@/services/toiv/client";

export type ProjectBibleListItem = {
    id: string;
    title: string;
    status: string;
    current_version: string;
    latest_version: string;
    frozen_at?: string | null;
};

export type ProjectBibleCharacter = {
    id?: string;
    name_zh?: string;
    name_en?: string;
    name?: string;
    [key: string]: unknown;
};

export type ProjectBibleLocation = {
    id?: string;
    name?: string;
    color_temp?: string;
    keywords?: string[];
    [key: string]: unknown;
};

export type ProjectBibleDocument = {
    id?: string;
    title?: string;
    version?: string;
    status?: string;
    style_prefix?: string;
    characters?: ProjectBibleCharacter[];
    locations?: ProjectBibleLocation[];
    frozen_at?: string | null;
    [key: string]: unknown;
};

export type ProjectBibleVersionMeta = {
    version: string;
    sha256?: string;
    status?: string;
    frozen_at?: string | null;
    created_at?: string | null;
};

export type ProjectBibleGetResponse = {
    kind: "working_copy" | "version";
    version?: string;
    sha256?: string;
    status?: string;
    frozen_at?: string | null;
    bible?: ProjectBibleListItem & Record<string, unknown>;
    document: ProjectBibleDocument;
};

export type ProjectBibleVersionsResponse = {
    id: string;
    current_version: string;
    latest_version: string;
    versions: ProjectBibleVersionMeta[];
};

function assertExplicitVersion(version: string): string {
    const v = String(version ?? "").trim();
    if (!v) {
        throw new Error("version_required: 读历史必须显式 version");
    }
    if (v.toLowerCase() === "latest") {
        throw new Error("version_required: version=latest 禁止");
    }
    return v;
}

export async function listProjectBibles(): Promise<ProjectBibleListItem[]> {
    const { data } = await toivHttp.get<{ items?: ProjectBibleListItem[] }>("/project-bibles");
    return Array.isArray(data?.items) ? data.items : [];
}

/** 无 version → 工作副本（API 契约）。UI 展示冻结版请走 getProjectBibleVersion。 */
export async function getProjectBibleWorking(bibleId: string): Promise<ProjectBibleGetResponse> {
    const { data } = await toivHttp.get<ProjectBibleGetResponse>(
        `/project-bibles/${encodeURIComponent(bibleId)}`,
    );
    return data;
}

/** 读指定不可变版；强制显式 version，拒绝 latest。 */
export async function getProjectBibleVersion(
    bibleId: string,
    version: string,
): Promise<ProjectBibleGetResponse> {
    const v = assertExplicitVersion(version);
    const { data } = await toivHttp.get<ProjectBibleGetResponse>(
        `/project-bibles/${encodeURIComponent(bibleId)}`,
        { params: { version: v } },
    );
    return data;
}

export async function listProjectBibleVersions(bibleId: string): Promise<ProjectBibleVersionsResponse> {
    const { data } = await toivHttp.get<ProjectBibleVersionsResponse>(
        `/project-bibles/${encodeURIComponent(bibleId)}/versions`,
    );
    return data;
}

export function characterLabel(c: ProjectBibleCharacter): string {
    return (
        String(c.name_zh || c.name_en || c.name || c.id || "未命名角色").trim() || "未命名角色"
    );
}

export function locationLabel(loc: ProjectBibleLocation): string {
    return String(loc.name || loc.id || "未命名地点").trim() || "未命名地点";
}
