import { useLayoutEffect, useRef, useState } from "react";

export type SlidingTabItem = { key: string; label: string; done?: boolean };

export function SlidingTabs({ items, value, onChange, label = "制片流水线" }: { items: SlidingTabItem[]; value: string; onChange: (key: string) => void; label?: string }) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const [box, setBox] = useState({ left: 0, width: 0 });
    const active = Math.max(0, items.findIndex((item) => item.key === value));
    useLayoutEffect(() => {
        const el = refs.current[active];
        if (el) setBox({ left: el.offsetLeft, width: el.offsetWidth });
    }, [active]);
    return (
        <nav className="stv-tabs" role="tablist" aria-label={label}>
            <span className="stv-tabs-slider" style={{ left: box.left, width: box.width }} aria-hidden="true" />
            {items.map((item, index) => (
                <button key={item.key} type="button" role="tab" aria-selected={item.key === value}
                    ref={(el) => { refs.current[index] = el; }} onClick={() => onChange(item.key)}>
                    {item.done ? <span className="tick">✓</span> : null}{item.label}
                </button>
            ))}
        </nav>
    );
}
