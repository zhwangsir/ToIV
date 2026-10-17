/**
 * 时间显示单一源（T-U UI 波 #未修2 收口）：全站统一「年月日时分」口径。
 * formatDateTime → "YYYY-MM-DD HH:mm"；formatDate → "YYYY-MM-DD"（日期级）。
 * 非法/空输入统一回 "—"，与各页历史行为一致。
 */
const pad2 = (n: number) => String(n).padStart(2, "0");

function toDate(value: string | number | Date | null | undefined): Date | null {
    if (value === null || value === undefined || value === "") return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
    const d = toDate(value);
    if (!d) return "—";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDate(value: string | number | Date | null | undefined): string {
    const d = toDate(value);
    if (!d) return "—";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
