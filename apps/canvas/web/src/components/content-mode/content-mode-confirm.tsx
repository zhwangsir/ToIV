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
    return (
        <div className={className ? `cm-confirm ${className}` : "cm-confirm"} role="alertdialog" aria-label={`确认切换到${COPY_MODE_ADULT}`} data-testid="content-mode-confirm">
            <p className="cm-confirm-title">{COPY_CONFIRM_SWITCH}</p>
            <p className="cm-confirm-body">
                {COPY_ACCOUNT_GLOBAL} · {COPY_ACCOUNT_SYNC_HINT}。{COPY_IN_FLIGHT_SAFE}。
            </p>
            <div className="cm-confirm-actions">
                <button type="button" className="cm-confirm-btn is-primary" onClick={onConfirm} data-testid="content-mode-confirm-enable">
                    确认切换到{COPY_MODE_ADULT}
                </button>
                <button type="button" className="cm-confirm-btn" onClick={onCancel} data-testid="content-mode-confirm-cancel">
                    取消
                </button>
            </div>
        </div>
    );
}
