import { storage } from '@/lib/mmkv';

import {
  applyReady,
  attachmentBusy,
  attachmentKeyFor,
  chipFor,
  clearAttachment,
  imageForRequest,
  loadAttachment,
  parseAttachment,
  pickedImageName,
  saveAttachment,
  serializeAttachment,
  startUpload,
  validatePickedImage,
} from '../attachment-utils';
import { draftKeyFor } from '../draft-utils';

// react-native-mmkv 由 jest moduleNameMapper 全局替换为内存替身（src/test/mmkv-mock.ts）
describe('attachment-utils（M30 附图状态机/校验/序列化纯函数层）', () => {
  beforeEach(() => {
    storage.clearAll();
  });

  it('状态机：startUpload 进入上传中（chip 预览+文件名）；已有 chip 再选 = 替换（直接覆盖旧态）', () => {
    const first = startUpload('file:///tmp/a.png', 'a.png');
    expect(first).toEqual({ status: 'uploading', previewUri: 'file:///tmp/a.png', name: 'a.png' });
    // 替换语义：新选直接覆盖，不保留旧句柄
    const second = startUpload('file:///tmp/b.png', 'b.png');
    expect(second.previewUri).toBe('file:///tmp/b.png');
    expect(second).not.toMatchObject({ filename: expect.anything() });
  });

  it('状态机：applyReady 落句柄（previewUri/name 继承上传中态）', () => {
    const uploading = startUpload('file:///tmp/a.png', 'a.png');
    const ready = applyReady(uploading, { filename: 'up-a.png', worker: 'http://w1' });
    expect(ready).toEqual({
      status: 'ready',
      previewUri: 'file:///tmp/a.png',
      name: 'a.png',
      filename: 'up-a.png',
      worker: 'http://w1',
    });
  });

  it('chipFor：上传中 chip 无移除钮（loading 态）；ready 可移除；null 无 chip', () => {
    expect(chipFor(null)).toBeNull();
    const uploading = startUpload('file:///tmp/a.png', 'a.png');
    expect(chipFor(uploading)).toEqual({
      uploading: true,
      previewUri: 'file:///tmp/a.png',
      label: 'a.png',
    });
    const ready = applyReady(uploading, { filename: 'up-a.png', worker: 'http://w1' });
    expect(chipFor(ready)).toEqual({
      uploading: false,
      previewUri: 'file:///tmp/a.png',
      label: 'a.png',
    });
  });

  it('attachmentBusy：仅上传中（发送键禁用语义）', () => {
    expect(attachmentBusy(null)).toBe(false);
    const uploading = startUpload('file:///tmp/a.png', 'a.png');
    expect(attachmentBusy(uploading)).toBe(true);
    expect(attachmentBusy(applyReady(uploading, { filename: 'f', worker: 'w' }))).toBe(false);
  });

  it('imageForRequest：ready → {filename,worker} 随 chat 上行；上传中/null 不带图', () => {
    expect(imageForRequest(null)).toBeUndefined();
    const uploading = startUpload('file:///tmp/a.png', 'a.png');
    expect(imageForRequest(uploading)).toBeUndefined();
    const ready = applyReady(uploading, { filename: 'up-a.png', worker: 'http://w1' });
    expect(imageForRequest(ready)).toEqual({ filename: 'up-a.png', worker: 'http://w1' });
  });

  it('validatePickedImage：扩展名白名单（gif 拒）/ >20MB 拒 / 合法通过 / fileName 缺省按 mime 推断', () => {
    expect(
      validatePickedImage({ uri: 'file:///tmp/a.gif', fileName: 'a.gif', mimeType: 'image/gif' }),
    ).toBe('仅支持 jpg / png / webp 图片');
    expect(
      validatePickedImage({
        uri: 'file:///tmp/big.png',
        fileName: 'big.png',
        mimeType: 'image/png',
        fileSize: 21 * 1024 * 1024,
      }),
    ).toBe('图片超过 20MB 上限');
    expect(
      validatePickedImage({ uri: 'file:///tmp/ok.png', fileName: 'ok.png', mimeType: 'image/png' }),
    ).toBeNull();
    // fileName 缺失走 mime 推断（webp 合法）
    expect(validatePickedImage({ uri: 'file:///tmp/x', fileName: null, mimeType: 'image/webp' })).toBeNull();
    // fileSize 不可得时不拦（后端 413 兜底）
    expect(
      validatePickedImage({ uri: 'file:///tmp/y.jpg', fileName: 'y.jpg', mimeType: 'image/jpeg' }),
    ).toBeNull();
  });

  it('pickedImageName：fileName 优先；缺省 upload.<ext>（mime 推断，识别不出回落 jpg）', () => {
    expect(pickedImageName({ uri: 'u', fileName: '猫.png', mimeType: 'image/png' })).toBe('猫.png');
    expect(pickedImageName({ uri: 'u', fileName: null, mimeType: 'image/webp' })).toBe('upload.webp');
    expect(pickedImageName({ uri: 'u', fileName: '  ', mimeType: 'image/jpeg' })).toBe('upload.jpg');
    expect(pickedImageName({ uri: 'u', fileName: null, mimeType: undefined })).toBe('upload.jpg');
  });

  it('serialize/parse 往返：仅 ready 句柄落盘（uploading 瞬态不持久化）', () => {
    expect(serializeAttachment(null)).toBeNull();
    expect(serializeAttachment(startUpload('file:///tmp/a.png', 'a.png'))).toBeNull();
    const ready = applyReady(startUpload('file:///tmp/a.png', 'a.png'), {
      filename: 'up-a.png',
      worker: 'http://w1',
    });
    const raw = serializeAttachment(ready);
    expect(raw).toBe(JSON.stringify({
      filename: 'up-a.png',
      worker: 'http://w1',
      previewUri: 'file:///tmp/a.png',
      name: 'a.png',
    }));
    // 恢复即 ready 完成态，不重复上传
    expect(parseAttachment(raw)).toEqual(ready);
  });

  it('parseAttachment 防御：空串/畸形 JSON/缺字段一律 null', () => {
    expect(parseAttachment(undefined)).toBeNull();
    expect(parseAttachment('')).toBeNull();
    expect(parseAttachment('not-json')).toBeNull();
    expect(parseAttachment('[]')).toBeNull();
    expect(parseAttachment('{"filename":"f"}')).toBeNull(); // 缺 worker/previewUri
    expect(parseAttachment('{"filename":"","worker":"w","previewUri":"p"}')).toBeNull();
    // name 缺省回落 filename（老数据兼容）
    expect(parseAttachment('{"filename":"f","worker":"w","previewUri":"p"}')).toEqual({
      status: 'ready',
      filename: 'f',
      worker: 'w',
      previewUri: 'p',
      name: 'f',
    });
  });

  it('持久化键挂在 assistant_draft: 前缀下（随草稿按会话隔离）', () => {
    expect(attachmentKeyFor('s1')).toBe(`${draftKeyFor('s1')}:image`);
    expect(attachmentKeyFor(undefined)).toBe('assistant_draft:__new__:image');
  });

  it('save/load/clear：按 sessionId 隔离；null 等价清除（不留空占位键）', () => {
    const ready = applyReady(startUpload('file:///tmp/a.png', 'a.png'), {
      filename: 'up-a.png',
      worker: 'http://w1',
    });
    expect(loadAttachment(undefined)).toBeNull();
    saveAttachment(undefined, ready);
    saveAttachment('s1', null);
    expect(loadAttachment(undefined)).toEqual(ready);
    expect(loadAttachment('s1')).toBeNull();
    // 覆盖写 + 清除
    const newer = applyReady(startUpload('file:///tmp/b.png', 'b.png'), {
      filename: 'up-b.png',
      worker: 'http://w2',
    });
    saveAttachment(undefined, newer);
    expect(loadAttachment(undefined)).toEqual(newer);
    saveAttachment(undefined, null);
    expect(loadAttachment(undefined)).toBeNull();
    expect(storage.contains(attachmentKeyFor(undefined))).toBe(false);
    // clearAttachment 幂等
    clearAttachment('ghost');
    expect(loadAttachment('ghost')).toBeNull();
  });
});
