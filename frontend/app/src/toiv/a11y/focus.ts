const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.getClientRects().length > 0);
}

export function focusFirst(root: HTMLElement | null): void {
    if (!root) return;
    (focusables(root)[0] ?? root).focus();
}

export function containTab(event: KeyboardEvent, root: HTMLElement | null): void {
    if (!root || event.key !== "Tab") return;
    const items = focusables(root);
    if (!items.length) {
        event.preventDefault();
        root.focus();
        return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
            event.preventDefault();
            last.focus();
        }
        return;
    }
    if (active === last || !root.contains(active)) {
        event.preventDefault();
        first.focus();
    }
}
