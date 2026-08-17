/**
 * SSE 流解析（M19 对话助手）
 * - 载体：expo/fetch 的 FetchResponse.body（ReadableStream<Uint8Array>），RN 无原生 EventSource
 * - 规范：W3C Server-Sent Events —— `field: value` 行 + 空行派发；`:` 开头为注释/心跳跳过
 * - 契约（已读 apps/api/app/routes/agent.py 源码验证）：sse_starlette EventSourceResponse
 *   每个事件 `event: msg\r\ndata: <json>\r\n\r\n`，流尾 `event: done\r\ndata: {}\r\n\r\n`；
 *   sse_starlette 保活为注释行（`: ping`），解析层天然忽略
 * - UTF-8 多字节字符可能跨 chunk 切断：TextDecoder({stream:true}) 增量解码兜底
 * - 行尾兼容 \r\n / \n / \r 三种切割（规范允许）
 */

export type SseEventCallback = (event: string, data: string) => void;

/**
 * 逐块读取 reader，解析完整事件后回调 onEvent(event, data)
 * - 同一事件多行 data 按规范以 '\n' 拼接
 * - 流尾未以空行收尾的挂起事件按规范丢弃（后端恒以空行收尾，此分支仅防御）
 * - signal 中止即取消 reader 并静默结束（调用方自判 aborted 语义，与 apiFetch 一致）
 */
export async function parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: SseEventCallback,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = (): void => {
    // 无 data 的事件（如纯注释块/keep-alive 空块）不派发
    if (dataLines.length > 0) onEvent(eventName, dataLines.join('\n'));
    eventName = 'message';
    dataLines = [];
  };

  const consumeLine = (line: string): void => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // 注释/心跳
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // 规范：冒号后至多剥一个空格
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // id/retry 字段本契约不使用，忽略
  };

  if (signal?.aborted) {
    await reader.cancel();
    return;
  }
  const onAbort = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? ''; // 末段为不完整行，留待下一块拼接
      for (const line of lines) consumeLine(line);
      if (signal?.aborted) return;
    }
    // 冲刷解码器尾部 + 处理缓冲区残余行（挂起事件不派发，见头注释）
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
