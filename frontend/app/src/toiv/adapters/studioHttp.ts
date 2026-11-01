export class StudioHttpError extends Error {
    readonly status: number;
    readonly detail: unknown;
    constructor(status: number, detail: unknown, message: string) {
        super(message);
        this.name = "StudioHttpError";
        this.status = status;
        this.detail = detail;
    }
}

export function authHeaders(): Record<string, string> {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("toiv_token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Backend detail is either a string or {code,message,hint}; keep both readable and structured. */
export function studioDetailText(detail: unknown): string {
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
        const record = detail as Record<string, unknown>;
        const code = typeof record.code === "string" ? record.code : "";
        const message = typeof record.message === "string" ? record.message : "";
        const hint = typeof record.hint === "string" ? record.hint : "";
        if (message) return `${code ? `${code} · ` : ""}${message}${hint ? ` · ${hint}` : ""}`;
    }
    return "";
}

export async function studioRequest<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
        const payload = await res.json().catch(() => null) as { detail?: unknown } | null;
        const text = studioDetailText(payload?.detail);
        throw new StudioHttpError(res.status, payload?.detail, `${method} ${res.status}${text ? ` · ${text}` : ""}`);
    }
    return res.json() as Promise<T>;
}
