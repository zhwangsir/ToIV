import type { ReactNode } from "react";

export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
    return (
        <div className="stv-field">
            <label htmlFor={htmlFor}>{label}</label>
            {children}
        </div>
    );
}
