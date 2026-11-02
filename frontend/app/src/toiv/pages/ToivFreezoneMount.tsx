import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import ToivShell from "../shell/ToivShell";

/**
 * Prime 路由壳：iframe 挂载 apps/freezone-web（DramaClaw Freezone）。
 * 禁 import vendor/canvas；子应用独立 bundle。
 *
 * Dev: VITE_FREEZONE_ORIGIN=http://127.0.0.1:5174
 * Prod same-origin: /freezone/projects/:id/freezone （freezone-web base=/freezone/）
 */
export default function ToivFreezoneMount() {
    const { projectId = "" } = useParams<{ projectId: string }>();
    const [search] = useSearchParams();
    const canvas = search.get("canvas");

    const src = useMemo(() => {
        const origin = (import.meta.env.VITE_FREEZONE_ORIGIN as string | undefined)?.replace(/\/+$/, "");
        const path = `/projects/${encodeURIComponent(projectId)}/freezone`;
        const url = origin
            ? new URL(path, `${origin}/`)
            : new URL(`/freezone${path}`, window.location.origin);
        if (canvas) url.searchParams.set("canvas", canvas);
        return url.toString();
    }, [projectId, canvas]);

    return (
        <ToivShell>
            <section
                className="toiv-freezone-mount"
                aria-label="Freezone 画布"
                style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 64px)" }}
            >
                <div className="pf-history-head" style={{ padding: "12px 16px" }}>
                    <div>
                        <h1 style={{ margin: 0, fontSize: 18 }}>自由画布 · Freezone</h1>
                        <p className="pf-muted" style={{ margin: "4px 0 0" }}>
                            本地预览·不可生成 · 项目 {projectId || "—"}
                        </p>
                    </div>
                </div>
                <iframe
                    title="Freezone"
                    src={src}
                    style={{ flex: 1, width: "100%", border: 0, minHeight: 640, background: "#0b0b0f" }}
                    allow="clipboard-read; clipboard-write; fullscreen"
                />
            </section>
        </ToivShell>
    );
}
