/**
 * Vite `base` keeps a trailing slash (`/arcreel/`); wouter Router `base` and
 * absolute document paths must NOT. Dev base `/` → empty string.
 */
export const APP_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

/**
 * Strip the mount prefix so callers see app-relative paths (`/app/...`).
 * safeReturnPath and wouter setLocation both expect paths without APP_BASE.
 */
export function toAppPath(fullPath: string): string {
  if (!APP_BASE) return fullPath;
  if (
    fullPath === APP_BASE ||
    fullPath.startsWith(`${APP_BASE}/`) ||
    fullPath.startsWith(`${APP_BASE}?`) ||
    fullPath.startsWith(`${APP_BASE}#`)
  ) {
    return fullPath.slice(APP_BASE.length) || "/";
  }
  return fullPath;
}

/**
 * wouter `~` escapes nested routes AND the Router base (absolutePath drops
 * base when the target starts with `~`). Re-prefix APP_BASE so nest escapes
 * still land on `/arcreel/login` in production, and `/login` in dev.
 */
export function loginRedirectTarget(fromAppPath: string): string {
  return `~${APP_BASE}/login?from=${encodeURIComponent(fromAppPath)}`;
}

/** Hard navigation target for 401 handlers (must include mount prefix). */
export function loginDocumentPath(fromAppPath?: string | null): string {
  const path = `${APP_BASE}/login`;
  if (fromAppPath && fromAppPath.startsWith("/app/")) {
    return `${path}?from=${encodeURIComponent(fromAppPath)}`;
  }
  return path;
}
