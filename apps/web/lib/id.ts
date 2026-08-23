/** 生成唯一 id。
 * crypto.randomUUID 仅安全上下文(HTTPS/localhost)可用;HTTP 明文(如 Tailscale http://100.77.80.100:3100)
 * 下为 undefined,直接调用会抛 "crypto.randomUUID is not a function"(2026-07-30 数字人页实测)。
 * 降级链: randomUUID → getRandomValues(非安全上下文也可用)拼 v4 → 时间戳+随机串。
 */
export function genId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
