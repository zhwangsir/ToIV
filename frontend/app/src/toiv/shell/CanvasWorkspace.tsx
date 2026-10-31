import { useEffect, useState, type ReactNode } from "react";
import Button from "../../components/ui/Button";

const MOBILE_QUERY = "(max-width: 900px)";

function panelsStartOpen(): boolean {
    if (typeof window === "undefined") return true;
    return !window.matchMedia(MOBILE_QUERY).matches;
}

export default function CanvasWorkspace({ left, center, right, taskbar }: {
    left: ReactNode;
    center: ReactNode;
    right: ReactNode;
    taskbar: ReactNode;
}) {
    const [leftOpen, setLeftOpen] = useState(panelsStartOpen);
    const [rightOpen, setRightOpen] = useState(panelsStartOpen);

    useEffect(() => {
        const mobile = window.matchMedia(MOBILE_QUERY);
        const onViewport = () => {
            if (mobile.matches) {
                setLeftOpen(false);
                setRightOpen(false);
            }
        };
        mobile.addEventListener("change", onViewport);
        return () => mobile.removeEventListener("change", onViewport);
    }, []);

    useEffect(() => {
        if (!leftOpen && !rightOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setLeftOpen(false);
                setRightOpen(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [leftOpen, rightOpen]);

    return (
        <div className="toiv-workspace">
            <div className="toiv-workspace-body">
                {leftOpen ? <aside id="toiv-workspace-left" className="toiv-workspace-panel left" aria-label="场景栏">{left}</aside> : null}
                <section className="toiv-workspace-center" aria-label="画布">
                    <div className="toiv-workspace-chrome">
                        <Button size="sm" variant="outline" aria-expanded={leftOpen} aria-controls="toiv-workspace-left"
                            onClick={() => setLeftOpen((open) => !open)}>
                            {leftOpen ? "收起场景栏" : "展开场景栏"}
                        </Button>
                        <Button size="sm" variant="outline" aria-expanded={rightOpen} aria-controls="toiv-workspace-right"
                            onClick={() => setRightOpen((open) => !open)}>
                            {rightOpen ? "收起检查栏" : "展开检查栏"}
                        </Button>
                    </div>
                    {center}
                </section>
                {rightOpen ? <aside id="toiv-workspace-right" className="toiv-workspace-panel right" aria-label="检查栏">{right}</aside> : null}
            </div>
            {taskbar}
        </div>
    );
}
