import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
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

async function exchangeSession(token: string, signal?: AbortSignal) {
    const response = await fetch("/studio/auth/exchange", {
        method: "POST", credentials: "same-origin", headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (!response.ok) throw new Error("工作台会话建立失败，请重试");
}

export function RequireSession({ children }: { children: ReactNode }) {
    const location = useLocation();
    const [state, setState] = useState<"checking" | "ready" | "invalid" | "error">("checking");
    const [attempt, setAttempt] = useState(0);
    const token = currentToken();
    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();
        setState("checking");
        const check = async () => {
            try {
                const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
                if (response.status === 401 || response.status === 403) {
                    if (!controller.signal.aborted) { clearToken(); setState("invalid"); }
                    return;
                }
                if (!response.ok) throw new Error("登录验证暂不可用");
                const body = await response.json();
                if (!body.user?.id) throw new Error("登录响应异常");
                await exchangeSession(token, controller.signal);
                if (!controller.signal.aborted) setState("ready");
            } catch {
                if (!controller.signal.aborted) setState("error");
            }
        };
        void check();
        return () => controller.abort();
    }, [token, attempt]);
    if (!token || state === "invalid") return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
    if (state === "ready") return <>{children}</>;
    return <ToivShell><section className="pf-section pf-empty" aria-live="polite">
        {state === "checking" ? <p role="status">正在验证登录…</p> : <>
            <p role="alert">暂时无法验证工作台会话，已保留登录状态。</p>
            <Button variant="lime" onClick={() => setAttempt(value => value + 1)}>重试验证</Button>
        </>}
    </section></ToivShell>;
}

export function ToivLoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);
    const submitting = useRef(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setPending(true);
        setError("");
        try {
            const res = await fetch("/api/auth/login", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email.trim(), password }),
            });
            if (!res.ok) throw new Error(res.status === 401 ? "登录失败，请检查账号和口令" : "登录服务暂不可用，请重试");
            const body = await res.json();
            if (typeof body.token !== "string" || !body.token) throw new Error("登录响应异常，请重试");
            await exchangeSession(body.token);
            storeToken(body.token);
            setPassword("");
            const from = location.state?.from;
            navigate(typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && from !== "/auth" ? from : "/", { replace: true });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "连接失败，请重试");
        } finally {
            submitting.current = false;
            setPending(false);
        }
    };
    return (
        <ToivShell>
            <form className="toiv-login" onSubmit={submit} aria-label="ToIV 登录" aria-busy={pending}>
                <h1>登录 ToIV</h1>
                <label>账号<input required disabled={pending} value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" /></label>
                <label>口令<input required disabled={pending} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
                {error ? <p className="toiv-login-error" role="alert">{error}</p> : null}
                <Button variant="lime" type="submit" disabled={pending || !email.trim() || !password}>{pending ? "正在登录…" : "进入工作台"}</Button>
            </form>
        </ToivShell>
    );
}
