/**
 * 底层错误 → 用户友好文案(走查 P3:生成链路错误冒泡扫尾)。
 *
 * 只包装已知模式(WebSocket 1011 / keepalive / ECONNREFUSED / timeout / 5xx),
 * message 给主文案,detail 保留原文供「技术详情」展开;未知模式原文兜底(detail=null,
 * 避免同一句话在主文案和详情里重复出现)。
 */
export interface FriendlyError {
  message: string;
  detail: string | null;
}

const PATTERNS: { re: RegExp; message: string }[] = [
  // ComfyUI WebSocket 断连:"sent 1011 (internal error) keepalive ping timeout" 等
  { re: /1011|keepalive|ping timeout/i, message: "生成服务连接中断,请重试" },
  // 服务不可达
  {
    re: /ECONNREFUSED|ECONNRESET|connection refused|failed to fetch|networkerror|load failed/i,
    message: "无法连接生成服务,请检查服务状态后重试",
  },
  // 超时(前端 apiFetch 超时文案「请求超时 (Ns)」也落这里)
  { re: /timed?\s*out|超时/i, message: "生成服务响应超时,请重试" },
  // 后端 5xx
  { re: /(?<!\d)5\d{2}(?!\d)|internal server error/i, message: "生成服务内部错误,请稍后重试" },
];

export function friendlyError(raw: string): FriendlyError {
  const text = raw.trim();
  for (const { re, message } of PATTERNS) {
    if (re.test(text)) {
      return { message, detail: text || null };
    }
  }
  return { message: text || "生成失败", detail: null };
}
