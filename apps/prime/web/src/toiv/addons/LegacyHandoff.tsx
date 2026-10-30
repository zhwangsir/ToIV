import Button from "../../components/ui/Button";
import ToivShell from "../shell/ToivShell";

const LEGACY_BASE = (import.meta as { env?: { VITE_LEGACY_BASE?: string } }).env?.VITE_LEGACY_BASE || "/studio";

export default function LegacyHandoff({ title, href, note }: { title: string; href: string; note: string }) {
    return (
        <ToivShell>
            <div className="toiv-empty">
                <p>{title} 仍在旧工作台。</p>
                <p className="meta">{note}</p>
                <Button variant="lime" onClick={() => { window.location.assign(`${LEGACY_BASE}${href}`); }}>打开旧版{title}</Button>
            </div>
        </ToivShell>
    );
}
