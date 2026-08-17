import { parseSseStream } from '../sse';

/**
 * SSE 解析器测试（M19.1）
 * 契约来源：apps/api/app/routes/agent.py（sse_starlette EventSourceResponse，
 * `event: msg\r\ndata: <json>\r\n\r\n` ×N + `event: done\r\ndata: {}\r\n\r\n`）
 */

const encoder = new TextEncoder();

/** 由字符串块构建真实 ReadableStream reader（贴近 expo/fetch 生产形状） */
function readerFromText(...chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return stream.getReader();
}

/** 手写 mock reader（中止语义断言用，真实流 cancel 后 read 行为依赖运行时） */
function manualReader(chunks: Uint8Array[]) {
  let i = 0;
  return {
    read: jest.fn(async () =>
      i >= chunks.length
        ? { done: true as const, value: undefined }
        : { done: false as const, value: chunks[i++] },
    ),
    cancel: jest.fn(async () => undefined),
  };
}

function collect(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  const events: { event: string; data: string }[] = [];
  const done = parseSseStream(reader, (event, data) => events.push({ event, data }), signal);
  return { events, done };
}

describe('parseSseStream（SSE 解析，M19.1）', () => {
  it('完整 msg+done 序列逐帧派发', async () => {
    const { events, done } = collect(
      readerFromText(
        'event: msg\r\ndata: {"type":"text","content":"你好"}\r\n\r\n',
        'event: msg\r\ndata: {"type":"tool","name":"generate_image"}\r\n\r\n',
        'event: done\r\ndata: {}\r\n\r\n',
      ),
    );
    await done;
    expect(events).toEqual([
      { event: 'msg', data: '{"type":"text","content":"你好"}' },
      { event: 'msg', data: '{"type":"tool","name":"generate_image"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('事件横跨 chunk 边界：缓冲拼接后完整派发', async () => {
    const full = 'event: msg\r\ndata: {"type":"text","content":"abc"}\r\n\r\n';
    const mid = Math.floor(full.length / 2);
    const { events, done } = collect(readerFromText(full.slice(0, mid), full.slice(mid)));
    await done;
    expect(events).toEqual([{ event: 'msg', data: '{"type":"text","content":"abc"}' }]);
  });

  it('UTF-8 多字节字符跨 chunk 切断：流式解码不乱码', async () => {
    const payload = 'event: msg\n\ndata: {"content":"你好，世界"}\n\n';
    const bytes = encoder.encode(payload);
    // 「你」为 3 字节序列：切在其第 1 字节后（前半 chunk 末尾是残缺 UTF-8）
    const head = encoder.encode('event: msg\n\ndata: {"content":"你');
    const cut = head.length - 2; // 落在「你」序列中间
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const { events, done } = collect(stream.getReader());
    await done;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data)).toEqual({ content: '你好，世界' });
  });

  it('行尾 \\n 与 \\r\\n 混合均可解析', async () => {
    const { events, done } = collect(
      readerFromText('event: msg\ndata: a\n\nevent: msg\r\ndata: b\r\n\r\n'),
    );
    await done;
    expect(events).toEqual([
      { event: 'msg', data: 'a' },
      { event: 'msg', data: 'b' },
    ]);
  });

  it('注释/心跳行（: 开头）跳过不派发', async () => {
    const { events, done } = collect(
      readerFromText(': ping\r\n\r\nevent: msg\r\ndata: x\r\n\r\n'),
    );
    await done;
    expect(events).toEqual([{ event: 'msg', data: 'x' }]);
  });

  it('同一事件多行 data 按规范以 \\n 拼接', async () => {
    const { events, done } = collect(
      readerFromText('event: msg\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n'),
    );
    await done;
    expect(events).toEqual([{ event: 'msg', data: '第一行\n第二行' }]);
  });

  it('无 data 的事件块不派发（仅注释/仅 event 名）', async () => {
    const { events, done } = collect(
      readerFromText('event: msg\r\n\r\nevent: done\r\ndata: {}\r\n\r\n'),
    );
    await done;
    expect(events).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('缺省事件名为 message（无 event 行的裸 data 帧）', async () => {
    const { events, done } = collect(readerFromText('data: raw\r\n\r\n'));
    await done;
    expect(events).toEqual([{ event: 'message', data: 'raw' }]);
  });

  it('流尾未以空行收尾的挂起事件按规范丢弃', async () => {
    const { events, done } = collect(readerFromText('event: msg\r\ndata: 完整\r\n\r\ndata: 挂起'));
    await done;
    expect(events).toEqual([{ event: 'msg', data: '完整' }]);
  });

  it('data 前导空格剥一个（规范）："data:  x" → " x"', async () => {
    const { events, done } = collect(readerFromText('data:  x\r\n\r\n'));
    await done;
    expect(events).toEqual([{ event: 'message', data: ' x' }]);
  });

  it('开始前已 aborted：取消 reader 且不读不派发', async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = manualReader([encoder.encode('data: x\n\n')]);
    const events: { event: string; data: string }[] = [];
    await parseSseStream(
      reader as unknown as ReadableStreamDefaultReader<Uint8Array>,
      (event, data) => events.push({ event, data }),
      controller.signal,
    );
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('读取中途 abort：停止后续派发', async () => {
    const controller = new AbortController();
    const reader = manualReader([
      encoder.encode('data: a\n\n'),
      encoder.encode('data: b\n\n'),
      encoder.encode('data: c\n\n'),
    ]);
    const events: { event: string; data: string }[] = [];
    await parseSseStream(
      reader as unknown as ReadableStreamDefaultReader<Uint8Array>,
      (event, data) => {
        events.push({ event, data });
        if (events.length === 1) controller.abort(); // 首帧后中止
      },
      controller.signal,
    );
    expect(events).toEqual([{ event: 'message', data: 'a' }]);
  });
});
