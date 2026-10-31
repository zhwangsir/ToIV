import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, matchPath, useLocation } from "react-router-dom";
import Button from "../../components/ui/Button";

const NAV = [
    { to: "/studio", label: "项目" },
    { to: "/drama", label: "画布" },
    { to: "/drama/assets", label: "资产" },
    { to: "/history", label: "作品与任务" },
    { to: "/tools", label: "工具" },
    { to: "/settings", label: "设置" },
];

function currentSection(pathname: string) {
    if (/^\/drama\/(?:assets(?:\/|$)|projects\/[^/]+\/assets(?:\/|$))/.test(pathname)) return "/drama/assets";
    if (/^\/(?:drama|legacy\/canvas)(?:\/|$)/.test(pathname)) return "/drama";
    if (pathname === "/" || /^\/studio(?:\/|$)/.test(pathname)) return "/studio";
    return NAV.find((item) => matchPath({ path: item.to, end: false }, pathname))?.to;
}

export default function ToivShell({ children }: { children: ReactNode }) {
    const location = useLocation();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuId = useId();
    const burger = useRef<HTMLButtonElement>(null);
    const current = currentSection(location.pathname);

    useEffect(() => { setMenuOpen(false); }, [location.pathname, location.search]);
    useEffect(() => {
        if (!menuOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setMenuOpen(false);
                burger.current?.focus();
            }
        };
        const desktop = window.matchMedia("(min-width: 1101px)");
        const onResize = () => { if (desktop.matches) setMenuOpen(false); };
        document.addEventListener("keydown", onKeyDown);
        desktop.addEventListener("change", onResize);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            desktop.removeEventListener("change", onResize);
        };
    }, [menuOpen]);

    const closeMenu = () => {
        if (menuOpen) {
            setMenuOpen(false);
            burger.current?.focus();
        }
    };
    const centerLinks = NAV.map((item) => {
        const active = current === item.to;
        // Group aliases (home and project assets) are not URL prefixes of their library link.
        if (active && !matchPath({ path: item.to, end: false }, location.pathname)) {
            return <Link key={item.to} to={item.to} className="active" aria-current="page" onClick={closeMenu}>{item.label}</Link>;
        }
        return <NavLink key={item.to} to={item.to} className={() => active ? "active" : undefined}
            aria-current={active ? "page" : false} onClick={closeMenu}>{item.label}</NavLink>;
    });

    return (
        <div className="pf-shell toiv-shell">
            <header className="pf-nav">
                <div className="pf-nav-left">
                    <Link to="/" className="toiv-lockup" aria-label="ToIV 首页" onClick={closeMenu}>
                        <span className="mark">TV</span>ToIV
                    </Link>
                </div>
                <nav className="pf-nav-center" aria-label="主导航">{centerLinks}</nav>
                <div className="pf-nav-right">
                    <Button variant="lime" size="sm" to="/studio/new" onClick={closeMenu}>新建项目</Button>
                    <button ref={burger} type="button" className="pf-nav-burger"
                        aria-label={menuOpen ? "关闭菜单" : "打开菜单"} aria-expanded={menuOpen} aria-controls={menuId}
                        onClick={() => setMenuOpen((value) => !value)}>
                        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
                    </button>
                </div>
                {menuOpen ? (
                    <div className="pf-nav-drawer" id={menuId}>
                        <nav className="pf-nav-drawer-links" aria-label="移动导航">{centerLinks}</nav>
                    </div>
                ) : null}
            </header>
            <main className="pf-shell-main wide">{children}</main>
        </div>
    );
}
