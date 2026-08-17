import { describe, expect, it } from 'vitest';

import { createSseParser } from '@/utils/sse';

type Collected = Array<[string, string]>;

function makeParser() {
  const events: Collected = [];
  const parser = createSseParser((event, data) => {
    events.push([event, data]);
  });
  return { parser, events };
}

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

describe('createSseParser 帧解析', () => {
  it('单帧完整派发：event + data', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\ndata: {"type":"text"}\n\n'));
    expect(events).toEqual([['msg', '{"type":"text"}']]);
  });

  it('event 缺省按规范归一化为 message', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('data: hello\n\n'));
    expect(events).toEqual([['message', 'hello']]);
  });

  it('多行 data 以 \\n 拼接', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('data: 第一行\ndata: 第二行\n\n'));
    expect(events).toEqual([['message', '第一行\n第二行']]);
  });

  it('data 冒号后单空格剥除、其余保留', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('data:  a\n\n')); // 两个空格 → 剥一个留一个
    expect(events).toEqual([['message', ' a']]);
  });

  it('一次推送连续多帧依次派发', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\ndata: a\n\nevent: done\ndata: {}\n\n'));
    expect(events).toEqual([
      ['msg', 'a'],
      ['done', '{}'],
    ]);
  });

  it('无 data 字段的帧不派发', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\n\n'));
    expect(events).toEqual([]);
  });

  it('data 为空的帧按 SSE 规范不派发', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\ndata:\n\n'));
    expect(events).toEqual([]);
  });

  it('comment 行 / 无冒号行 / id·retry 等未知字段忽略', () => {
    const { parser, events } = makeParser();
    parser.push(bytes(': 心跳注释\nid: 42\nretry: 3000\n畸形行\ndata: x\n\n'));
    expect(events).toEqual([['message', 'x']]);
  });

  it('\\r\\n 换行风格分帧', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\r\ndata: a\r\n\r\n'));
    expect(events).toEqual([['msg', 'a']]);
  });

  it('尾部不完整帧（无空行收尾）end() 时丢弃', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('data: 完整\n\ndata: 不完整'));
    parser.end();
    expect(events).toEqual([['message', '完整']]);
  });
});

describe('createSseParser 跨块与二进制', () => {
  it('帧可跨块：字段行从中切开', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('event: msg\nda'));
    parser.push(bytes('ta: x\n\n'));
    expect(events).toEqual([['msg', 'x']]);
  });

  it('分帧空行可跨块：\\n 与 \\n 分属两块', () => {
    const { parser, events } = makeParser();
    parser.push(bytes('data: a\n'));
    parser.push(bytes('\n'));
    expect(events).toEqual([['message', 'a']]);
  });

  it('UTF-8 多字节字符跨块：挂起待续不丢不错', () => {
    const { parser, events } = makeParser();
    const full = bytes('data: 你好\n\n'); // 你=E4 BD A0 好=E5 A5 BD
    const head = full.subarray(0, 8); // 切在「你」的第 2 字节后
    parser.push(head);
    expect(events).toEqual([]); // 未出空行且字符未齐，无派发
    parser.push(full.subarray(8));
    expect(events).toEqual([['message', '你好']]);
  });

  it('非法字节容错为 U+FFFD 且流不中断', () => {
    const { parser, events } = makeParser();
    parser.push(new Uint8Array([...bytes('data: '), 0xff, ...bytes('x\n\n')]));
    expect(events).toEqual([['message', '�x']]);
  });

  it('end() 冲刷：挂起的残缺 UTF-8 序列容错为 U+FFFD', () => {
    const { parser, events } = makeParser();
    // 「你」只来了首字节就到流尾；帧本身完整（空行已到）
    parser.push(new Uint8Array([...bytes('data: '), 0xe4, ...bytes('\n\n')]));
    parser.end();
    expect(events).toEqual([['message', '�']]);
  });

  it('接受 ArrayBuffer 入参（微信端 onChunkReceived 形状）', () => {
    const { parser, events } = makeParser();
    const buf = bytes('data: ab\n\n');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parser.push(ab);
    expect(events).toEqual([['message', 'ab']]);
  });

  it('接受带偏移的 ArrayBufferView（Uint8Array subarray）', () => {
    const { parser, events } = makeParser();
    const padded = new Uint8Array([0, 0, ...bytes('data: v\n\n'), 0]);
    const view = padded.subarray(2, padded.length - 1);
    parser.push(view);
    expect(events).toEqual([['message', 'v']]);
  });
});
