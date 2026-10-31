import { useEffect, useId, useRef } from "react";

import {
    COPY_ACCOUNT_GLOBAL,
    COPY_ACCOUNT_SYNC_HINT,
    COPY_CONFIRM_SWITCH,
    COPY_IN_FLIGHT_SAFE,
    COPY_MODE_ADULT,
} from "@/redline";

export function ContentModeConfirm({
    onConfirm,
    onCancel,
    className,
}: {
    onConfirm: () => void;
    onCancel: () => void;
    className?: string;
}) {
    const rootRef = useRef<HTMLDivElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const bodyId = useId();

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        confirmRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onCancel();
        };
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) onCancel();
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("pointerdown", onPointerDown);
            previousFocus?.focus();
        };
    }, [onCancel]);

    return (
        <div ref={rootRef} className={className ? `cm-confirm ${className}` : "cm-confirm"} role="alertdialog" aria-labelledby={titleId} aria-describedby={bodyId} data-testid="content-mode-confirm">
            <p className="cm-confirm-title" id={titleId}>{COPY_CONFIRM_SWITCH}</p>
            <p className="cm-confirm-body" id={bodyId}>
                {COPY_ACCOUNT_GLOBAL} · {COPY_ACCOUNT_SYNC_HINT}。{COPY_IN_FLIGHT_SAFE}。
            </p>
            <div className="cm-confirm-actions">
                <button ref={confirmRef} type="button" className="cm-confirm-btn is-primary" onClick={onConfirm} data-testid="content-mode-confirm-enable">
                    确认切换到{COPY_MODE_ADULT}
                </button>
                <button type="button" className="cm-confirm-btn" onClick={onCancel} data-testid="content-mode-confirm-cancel">
                    取消
                </button>
            </div>
        </div>
    );
}
