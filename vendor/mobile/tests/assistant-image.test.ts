import { beforeEach, describe, expect, it } from 'vitest';

import {
  attachImageState,
  buildChatImage,
  canSendWithImage,
  chooseAssistantImage,
  failImageState,
  parseImageDraft,
  readyImageState,
  serializeImageDraft,
} from '@/utils/assistant-image';
import {
  installMockUni,
  lastActionSheet,
  lastChooseImage,
  setActionSheetChoice,
  setChooseImageResult,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
});

describe('附图状态机（MP30）', () => {
  it('attach：进入 uploading 态（替换语义：已有 chip 再选直接覆盖）', () => {
    const s = attachImageState('/tmp/a.png');
    expect(s).toEqual({ previewUri: '/tmp/a.png', status: 'uploading', filename: '', worker: '' });

    const ready = readyImageState(s, '/tmp/a.png', { filename: 'a.png', worker: 'w1' });
    const replaced = attachImageState('/tmp/b.png');
    expect(replaced?.status).toBe('uploading');
    expect(replaced?.previewUri).toBe('/tmp/b.png');
    expect(ready?.status).toBe('ready');
  });

  it('ready：uploading → ready 落 filename/worker；previewUri 不匹配的迟到回调丢弃', () => {
    const s = attachImageState('/tmp/a.png');
    const ready = readyImageState(s, '/tmp/a.png', { filename: 'a.png', worker: 'w1' });
    expect(ready).toEqual({
      previewUri: '/tmp/a.png',
      status: 'ready',
      filename: 'a.png',
      worker: 'w1',
    });

    // 已替换为 b：a 的上传结果迟到，不得覆盖新 chip
    const after = readyImageState(replaced(), '/tmp/a.png', { filename: 'a.png', worker: 'w1' });
    expect(after?.previewUri).toBe('/tmp/b.png');
    expect(after?.status).toBe('uploading');

    function replaced() {
      return attachImageState('/tmp/b.png');
    }
  });

  it('ready 幂等保护：已 ready 的 chip 不再被重复回调改写', () => {
    const s = attachImageState('/tmp/a.png');
    const ready = readyImageState(s, '/tmp/a.png', { filename: 'a.png', worker: 'w1' });
    const again = readyImageState(ready, '/tmp/a.png', { filename: 'b.png', worker: 'w2' });
    expect(again).toEqual(ready);
  });

  it('fail：失败清 chip（最小实现：toast 由页面层补）；不匹配的迟到失败不动现 chip', () => {
    const s = attachImageState('/tmp/a.png');
    expect(failImageState(s, '/tmp/a.png')).toBeNull();

    const other = attachImageState('/tmp/b.png');
    expect(failImageState(other, '/tmp/a.png')).toEqual(other);
    expect(failImageState(null, '/tmp/a.png')).toBeNull();
  });

  it('canSendWithImage：无图/ready 可发；uploading 禁发', () => {
    expect(canSendWithImage(null)).toBe(true);
    expect(canSendWithImage(attachImageState('/tmp/a.png'))).toBe(false);
    const ready = readyImageState(attachImageState('/tmp/a.png'), '/tmp/a.png', {
      filename: 'a.png',
      worker: 'w1',
    });
    expect(canSendWithImage(ready)).toBe(true);
  });

  it('buildChatImage：ready → {filename,worker}；uploading/空 → null（不带 image 字段）', () => {
    expect(buildChatImage(null)).toBeNull();
    expect(buildChatImage(attachImageState('/tmp/a.png'))).toBeNull();
    const ready = readyImageState(attachImageState('/tmp/a.png'), '/tmp/a.png', {
      filename: 'a.png',
      worker: 'w1',
    });
    expect(buildChatImage(ready)).toEqual({ filename: 'a.png', worker: 'w1' });
  });
});

describe('附图草稿序列化（MP30：按会话隔离持久化 ready 句柄）', () => {
  it('serialize：仅 ready 态可序列化；uploading/空 → null', () => {
    expect(serializeImageDraft(null)).toBeNull();
    expect(serializeImageDraft(attachImageState('/tmp/a.png'))).toBeNull();
    const ready = readyImageState(attachImageState('/tmp/a.png'), '/tmp/a.png', {
      filename: 'a.png',
      worker: 'w1',
    });
    const raw = serializeImageDraft(ready);
    expect(raw).toBe(JSON.stringify({ filename: 'a.png', worker: 'w1', previewUri: '/tmp/a.png' }));
  });

  it('serialize → parse 往返：恢复 ready chip 不重复上传', () => {
    const ready = readyImageState(attachImageState('/tmp/a.png'), '/tmp/a.png', {
      filename: 'a.png',
      worker: 'w1',
    });
    const restored = parseImageDraft(serializeImageDraft(ready)!);
    expect(restored).toEqual(ready);
    expect(buildChatImage(restored)).toEqual({ filename: 'a.png', worker: 'w1' });
  });

  it('parse 防御：畸形 JSON / 非对象 / 缺句柄字段 → null', () => {
    expect(parseImageDraft('{')).toBeNull();
    expect(parseImageDraft('"str"')).toBeNull();
    expect(parseImageDraft('[]')).toBeNull();
    expect(parseImageDraft('{}')).toBeNull();
    expect(parseImageDraft('{"filename":"a.png"}')).toBeNull();
    expect(parseImageDraft('{"filename":"a.png","worker":"w1"}')).toBeNull(); // 缺 previewUri
    expect(parseImageDraft('{"filename":"","worker":"w1","previewUri":"/tmp/a.png"}')).toBeNull();
    expect(parseImageDraft('{"filename":1,"worker":"w1","previewUri":"/tmp/a.png"}')).toBeNull();
  });
});

describe('chooseAssistantImage 选图封装（MP30：showActionSheet + chooseImage 全端三件套）', () => {
  it('拍照通道：action sheet 第 0 项 → chooseImage sourceType=camera', async () => {
    setActionSheetChoice(0);
    setChooseImageResult('/tmp/camera.png');
    const p = chooseAssistantImage();
    await expect(p).resolves.toBe('/tmp/camera.png');
    expect(lastActionSheet().itemList).toEqual(['拍照', '相册']);
    expect(lastChooseImage().sourceType).toEqual(['camera']);
  });

  it('相册通道：action sheet 第 1 项 → chooseImage sourceType=album', async () => {
    setActionSheetChoice(1);
    setChooseImageResult('/tmp/album.png');
    await expect(chooseAssistantImage()).resolves.toBe('/tmp/album.png');
    expect(lastChooseImage().sourceType).toEqual(['album']);
    expect(lastChooseImage().count).toBe(1);
  });

  it('action sheet 取消 / 选图取消 → null（不提示）', async () => {
    setActionSheetChoice(null);
    await expect(chooseAssistantImage()).resolves.toBeNull();

    setActionSheetChoice(0);
    setChooseImageResult(null);
    await expect(chooseAssistantImage()).resolves.toBeNull();
  });
});
