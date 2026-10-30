import type { ReactNode } from "react";
import { Link } from "react-router-dom";

const NAV = [
    { to: "/studio", label: "流水线" },
    { to: "/drama", label: "画布" },
    { to: "/history", label: "剪辑湾" },
    { to: "/tools", label: "工具" },
    { to: "/settings", label: "设置" },
];

export default function ToivShell({ children }: { children: ReactNode }) {
    return (
        <div className="pf-shell">
            <header className="pf-nav">
                <div className="pf-nav-left">
                    <Link to="/" className="toiv-lockup" aria-label="ToIV 首页">
                        <span className="mark">TV</span>ToIV
                    </Link>
                </div>
                <nav className="pf-nav-center" aria-label="主导航">
                    {NAV.map((item) => <Link key={item.to} to={item.to}>{item.label}</Link>)}
                </nav>
            </header>
            <main className="pf-shell-main wide">{children}</main>
        </div>
    );
}
