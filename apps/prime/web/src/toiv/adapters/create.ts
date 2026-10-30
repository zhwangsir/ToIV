export type PrimeCreateInput = { title: string; premise?: string; style?: string; svml?: string };
export type PrimeCreateResult = { id: string; title: string; imported: boolean };

function authHeaders(): HeadersInit {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

const jsonHeaders = (): HeadersInit => ({ ...authHeaders(), "Content-Type": "application/json" });

export async function createPrimeProject(input: PrimeCreateInput): Promise<PrimeCreateResult> {
    const created = await fetch("/api/studio/projects", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ title: input.title.trim() || "未命名短剧", premise: input.premise ?? "", style: input.style ?? "" }),
    });
    if (!created.ok) throw new Error(`create ${created.status}`);
    const project = (await created.json()) as { id?: string; title?: string };
    const id = project.id ?? "";
    if (!id) throw new Error("create missing id");
    let imported = false;
    if (input.svml?.trim()) {
        const res = await fetch(`/api/studio/projects/${encodeURIComponent(id)}/import-svml`, {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ script: input.svml }),
        });
        if (!res.ok) throw new Error(`import-svml ${res.status}`);
        imported = true;
    }
    return { id, title: project.title ?? input.title, imported };
}
