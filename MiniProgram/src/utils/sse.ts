/**
 * SSE 增量解析器（POST /api/agent/chat 流式响应，MP19）
 * - 跨块二进制拼接 + 自实现 UTF-8 增量解码：不依赖 TextDecoder（微信真机可能无），
 *   多字节字符跨块边界挂起待续，残缺字节按 U+FFFD 容错（不中断流）
 * - 按空行（\n\n，容错 \r\n\r\n）分帧，帧可跨块缓冲；帧内解析 event:/data: 行
 *   （多行 data 以 \n 拼接；data 为空的帧按 SSE 规范不派发）
 * - 容错：comment（: 开头）/无冒号行/id·retry 等未知字段忽略；
 *   end() 时尾部不完整帧按 SSE 规范丢弃
 * 纯函数无运行时依赖，node 环境可直接单测
 */

/** (event, data) 回调：event 缺省按 SSE 规范归一化为 'message' */
export type SseEventCallback = (event: string, data: string) => void;

export interface SseParser {
  /** 喂入一块二进制数据（uni-h5 onChunkReceived 实际给 Uint8Array，微信端给 ArrayBuffer，两者都收） */
  push(chunk: ArrayBuffer | ArrayBufferView): void;
  /** 流结束冲刷：尾部不完整帧丢弃，挂起的残缺 UTF-8 字节容错为 U+FFFD 后一并评估 */
  end(): void;
}

/** 增量 UTF-8 解码：能吃掉的完整序列立即解码，末尾不完整序列挂起到下一次 push */
function createUtf8IncrementalDecoder() {
  let pending: number[] = [];

  function decode(bytes: Uint8Array, flush: boolean): string {
    const all =
      pending.length > 0
        ? (() => {
            const merged = new Uint8Array(pending.length + bytes.length);
            merged.set(pending, 0);
            merged.set(bytes, pending.length);
            return merged;
          })()
        : bytes;
    let out = '';
    let i = 0;
    const n = all.length;
    while (i < n) {
      const b0 = all[i];
      if (b0 < 0x80) {
        out += String.fromCharCode(b0);
        i += 1;
        continue;
      }
      let need = 0;
      let cp = 0;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        cp = b0 & 0x1f;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        cp = b0 & 0x0f;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        cp = b0 & 0x07;
      } else {
        // 非法前导字节（含孤立续字节）：替换字符容错，前进一字节
        out += '�';
        i += 1;
        continue;
      }
      if (i + need >= n) {
        if (!flush) break; // 多字节序列跨块：挂起待续
        out += '�';
        i += 1;
        continue;
      }
      let valid = true;
      for (let j = 1; j <= need; j += 1) {
        const bj = all[i + j];
        if ((bj & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (bj & 0x3f);
      }
      if (!valid) {
        out += '�';
        i += 1;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    pending = flush ? [] : Array.from(all.subarray(i));
    return out;
  }

  return {
    push(bytes: Uint8Array): string {
      return decode(bytes, false);
    },
    flush(): string {
      return decode(new Uint8Array(0), true);
    },
  };
}

export function createSseParser(onEvent: SseEventCallback): SseParser {
  const decoder = createUtf8IncrementalDecoder();
  let textBuffer = '';

  function dispatchFrame(frame: string): void {
    let event = '';
    let data = '';
    let hasData = false;
    for (const line of frame.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue; // 帧内空行 / comment
      const colon = line.indexOf(':');
      if (colon < 0) continue; // 无冒号畸形行容错忽略
      const field = line.slice(0, colon);
      let value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // SSE 规范：冒号后单空格剥除
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        data = hasData ? `${data}\n${value}` : value;
        hasData = true;
      }
      // id / retry / 未知字段忽略
    }
    // SSE 规范：无 data 字段、或 data 缓冲为空的帧不派发
    if (!hasData || data === '') return;
    onEvent(event === '' ? 'message' : event, data);
  }

  function drain(): void {
    let match = /\r?\n\r?\n/.exec(textBuffer);
    while (match) {
      const frame = textBuffer.slice(0, match.index);
      textBuffer = textBuffer.slice(match.index + match[0].length);
      if (frame !== '') dispatchFrame(frame);
      match = /\r?\n\r?\n/.exec(textBuffer);
    }
  }

  return {
    push(chunk) {
      const bytes =
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      textBuffer += decoder.push(bytes);
      drain();
    },
    end() {
      textBuffer += decoder.flush();
      drain();
      // 尾部不完整帧（无空行收尾）按 SSE 规范丢弃
      textBuffer = '';
    },
  };
}
