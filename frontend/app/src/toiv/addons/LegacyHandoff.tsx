import Button from "../../components/ui/Button";
import ToivShell from "../shell/ToivShell";

export function legacyDestination(base: string | undefined, href: string, origin: string, appBase: string): string | null {
    if (!base || !href.startsWith("/") || href.startsWith("//")) return null;
    try {
        const target = new URL(base, origin);
        const activePath = appBase.replace(/\/+$/, "");
        if (target.origin !== origin || !["http:", "https:"].includes(target.protocol) || target.username || target.password) return null;
        if (target.search || target.hash || !activePath || target.pathname.replace(/\/+$/, "") === activePath || target.pathname.startsWith(`${activePath}/`)) return null;
        target.pathname = `${target.pathname.replace(/\/+$/, "")}${href}`;
        return target.href;
    } catch {
        return null;
    }
}

export default function LegacyHandoff({ title, href, note }: { title: string; href: string; note: string }) {
    const destination = typeof window === "undefined" ? null : legacyDestination(
        import.meta.env?.VITE_LEGACY_BASE, href, window.location.origin, import.meta.env?.BASE_URL || "/",
    );
    return (
        <ToivShell>
            <section className="pf-section pf-empty" aria-labelledby="handoff-title">
                <h1 id="handoff-title">{title}</h1>
                <p>{note}</p>
                {!destination && <p role="status">独立旧版入口尚未配置，此预览不会跳转。当前生产工作台不受影响。</p>}
                <Button variant="lime" disabled={!destination} onClick={() => { if (destination) window.location.assign(destination); }}>打开旧版{title}</Button>
            </section>
        </ToivShell>
    );
}
