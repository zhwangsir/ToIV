import { useStudioToast } from "./toast-store";

export function ToastHost() {
    const toasts = useStudioToast((state) => state.toasts);
    return (
        <div className="stv-toasts" aria-live="polite">
            {toasts.map((toast) => (
                <div className={`stv-toast${toast.warn ? " warn" : ""}`} key={toast.id}>
                    <i />{toast.text}
                </div>
            ))}
        </div>
    );
}
