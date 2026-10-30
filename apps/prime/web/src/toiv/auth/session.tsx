import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import ToivShell from "../shell/ToivShell";
import Button from "../../components/ui/Button";

export const TOKEN_KEYS = ["toiv_token", "token"] as const;

export function currentToken(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem("toiv_token") ?? localStorage.getItem("token");
}

export function storeToken(token: string) {
    for (const key of TOKEN_KEYS) localStorage.setItem(key, token);
}

export function clearToken() {
    for (const key of TOKEN_KEYS) localStorage.removeItem(key);
}

export function RequireSession({ children }: { children: ReactNode }) {
    if (!currentToken()) return <Navigate to="/auth" replace />;
    return <>{children}</>;
}

export function ToivLoginPage() {
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setError("");
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        if (!res.ok) {
            setError("登录失败 · 检查账号口令");
            return;
        }
        const body = await res.json();
        if (!body.token) {
            setError("登录失败 · 服务端未返回令牌");
            return;
        }
        storeToken(body.token);
        navigate("/");
    };
    return (
        <ToivShell>
            <form className="toiv-login" onSubmit={submit} aria-label="ToIV 登录">
                <h2>登录 ToIV</h2>
                <label>账号<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
                <label>口令<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
                {error ? <p className="toiv-login-error" role="alert">{error}</p> : null}
                <Button variant="lime" type="submit">进入工作台</Button>
            </form>
        </ToivShell>
    );
}
