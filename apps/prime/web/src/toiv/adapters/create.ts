import { primeShotWriteInput, type PrimeShotInput } from "./storyboard";

export type PrimeCreateInput = { title: string; premise?: string; style?: string; svml?: string };
export type PrimeCreateResult = {
    id: string; title: string; imported: boolean;
    recovery?: { script: string; stage: "check" | "parse" | "characters" | "shots"; message: string };
};
function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(path, { method, headers: { ...authHeaders(), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) {
        const detail = await res.json().catch(() => null) as { detail?: unknown } | null;
        throw new Error(`${method} ${res.status}${typeof detail?.detail === "string" ? ` · ${detail.detail}` : ""}`);
    }
    return res.json() as Promise<T>;
}
async function readEmptyProject(id: string) {
    const detail = await request<{ id: string; characters: { name: string }[]; shots: unknown[] }>(`/api/studio/projects/${encodeURIComponent(id)}`);
    if (detail.id !== id || !Array.isArray(detail.shots) || !Array.isArray(detail.characters)) {
        throw new Error("无法确认项目现有数据；请打开项目核对，未覆盖任何镜头");
    }
    if (detail.shots.length) throw new Error("项目已有镜头，已保留且未覆盖；可能已导入或已被编辑，请打开项目核对");
    return detail;
}

/** Resume only inside the known project; ambiguous/partial previous writes are never overwritten. */
export async function retryPrimeImport(project: PrimeCreateResult, script: string): Promise<PrimeCreateResult> {
    const base = { id: project.id, title: project.title, imported: false };
    let stage: NonNullable<PrimeCreateResult["recovery"]>["stage"] = "check";
    try {
        if (!project.id || !script.trim()) throw new Error("项目 ID 或脚本文本为空，未执行导入");
        const current = await readEmptyProject(project.id);
        const path = `/api/studio/projects/${encodeURIComponent(project.id)}`;
        stage = "parse";
        const parsed = await request<{ shots: PrimeShotInput[]; characters: string[]; count: number }>(`${path}/import-svml`, "POST", { script });
        if (!Array.isArray(parsed.shots) || !parsed.shots.length || parsed.shots.some(s => !s || typeof s !== "object") ||
            !Array.isArray(parsed.characters) || parsed.characters.some(n => typeof n !== "string")) {
            throw new Error("SVML 解析结果不完整或没有镜头，未写入");
        }
        stage = "characters";
        const existing = new Set(current.characters.map(c => c.name.trim()));
        for (const name of parsed.characters) {
            const normalized = name.trim();
            if (normalized && !existing.has(normalized)) {
                await request(`${path}/characters`, "POST", { name: normalized });
                existing.add(normalized);
            }
        }
        stage = "check";
        await readEmptyProject(project.id);
        stage = "shots";
        await request(`${path}/shots`, "PUT", { shots: parsed.shots.map(primeShotWriteInput) });
        return { ...base, imported: true };
    } catch (error) {
        return { ...base, recovery: { script, stage, message: error instanceof Error ? error.message : "导入失败，请核对项目后重试" } };
    }
}

export async function createPrimeProject(input: PrimeCreateInput): Promise<PrimeCreateResult> {
    const project = await request<{ id?: string; title?: string }>("/api/studio/projects", "POST", {
        title: input.title.trim() || "未命名短剧", premise: input.premise ?? "", style: input.style ?? "",
    });
    if (!project.id) throw new Error("创建响应缺少项目 ID，请先到项目库核对，勿重复创建");
    const result = { id: project.id, title: project.title ?? input.title, imported: false };
    // Once the project exists, all import errors return its ID instead of throwing it away.
    return input.svml?.trim() ? retryPrimeImport(result, input.svml) : result;
}
