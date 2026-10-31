import { describe, expect, it } from 'vitest';

import {
  appUploadKind,
  buildRunValues,
  hasDualContentModes,
  isDeferredParam,
  isEditableParam,
  mediaFilenames,
  normalizeParam,
  normalizeParamsSchema,
  requiredParamLabel,
  schemaInitialValues,
} from '@/utils/app-runner';

describe('app-runner normalize (U10b)', () => {
  it('normalizeParam: 非法 type 兜底 text，default 缺省补 null', () => {
    const p = normalizeParam({ key: 'prompt', label: '提示词', type: 'weird' });
    expect(p.type).toBe('text');
    expect(p.default).toBeNull();
    expect(p.label).toBe('提示词');
  });

  it('normalizeParam: slider/options/required/mask', () => {
    const p = normalizeParam({
      key: 'steps',
      type: 'slider',
      min: 1,
      max: 40,
      step: 1,
      default: 20,
      required: true,
      mask: true,
      options: [{ value: 'a', label: 'A', nsfw: true }],
    });
    expect(p.type).toBe('slider');
    expect(p.min).toBe(1);
    expect(p.max).toBe(40);
    expect(p.required).toBe(true);
    expect(p.mask).toBe(true);
    expect(p.options?.[0]).toMatchObject({ value: 'a', label: 'A', nsfw: true });
  });

  it('normalizeParamsSchema 过滤空 key', () => {
    expect(normalizeParamsSchema([{ key: '', type: 'text' }, { key: 'p', type: 'text' }])).toHaveLength(
      1,
    );
  });
});

describe('app-runner values (U10b)', () => {
  const schema = normalizeParamsSchema([
    { key: 'prompt', label: '提示词', type: 'textarea', default: null },
    { key: 'steps', label: '步数', type: 'number', default: 20 },
    { key: 'cfg', label: 'CFG', type: 'slider', default: 7 },
    { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }] },
    { key: 'hires', label: '高清', type: 'switch', default: false },
    { key: 'images', label: '参考图', type: 'images', default: null },
    { key: 'video', label: '驱动视频', type: 'video', required: false, default: null },
    { key: 'audio', label: '音频', type: 'audio', default: null },
    { key: 'mask', label: '遮罩', type: 'images', mask: true, default: null },
  ]);

  it('schemaInitialValues', () => {
    const v = schemaInitialValues(schema);
    expect(v.prompt).toBe('');
    expect(v.steps).toBe(20);
    expect(v.hires).toBe(false);
    expect(v.images).toEqual([]);
    expect(v.video).toEqual([]);
  });

  it('buildRunValues: number 空串省略；images 抽 filename；deferred 跳过', () => {
    const out = buildRunValues(schema, {
      prompt: '雨夜',
      steps: '',
      cfg: '7.5',
      mode: 'a',
      hires: 1,
      images: [{ filename: 'a.png', worker: 'w1', previewUri: 'x', name: 'a' }, 'https://demo/x.png'],
      video: ['v.mp4'],
      audio: ['a.wav'],
      mask: ['m.png'],
    });
    expect(out.prompt).toBe('雨夜');
    expect(out.steps).toBeUndefined();
    expect(out.cfg).toBe(7.5);
    expect(out.hires).toBe(true);
    expect(out.images).toEqual(['a.png']);
    expect(out.video).toBeUndefined();
    expect(out.audio).toBeUndefined();
    expect(out.mask).toBeUndefined();
  });

  it('mediaFilenames 剔除远程 demo', () => {
    expect(mediaFilenames(['https://x/a.png', 'local.png'])).toEqual(['local.png']);
    expect(mediaFilenames([{ filename: 'b.png' }])).toEqual(['b.png']);
  });

  it('requiredParamLabel: 空 prompt / 空 images / 必填 audio / 可选 video', () => {
    expect(requiredParamLabel(schema, { ...schemaInitialValues(schema) })).toBe('提示词');
    const filled = {
      ...schemaInitialValues(schema),
      prompt: '雨夜',
      images: [{ filename: 'a.png', worker: 'w', previewUri: '', name: 'a' }],
    };
    // audio default null → 必填缺口（本轮不可填）
    expect(requiredParamLabel(schema, filled)).toBe('音频');
    // 去掉 audio 参数后应通过；mask 也是必填缺口
    const noAudio = schema.filter((p) => p.key !== 'audio' && p.key !== 'mask');
    expect(requiredParamLabel(noAudio, filled)).toBeNull();
    // video required:false 不卡
    expect(requiredParamLabel(schema.filter((p) => p.key === 'video'), { video: [] })).toBeNull();
  });
});

describe('app-runner misc (U10b)', () => {
  it('isEditable / isDeferred', () => {
    expect(isEditableParam(normalizeParam({ key: 'p', type: 'text' }))).toBe(true);
    expect(isEditableParam(normalizeParam({ key: 'i', type: 'images' }))).toBe(true);
    expect(isEditableParam(normalizeParam({ key: 'm', type: 'images', mask: true }))).toBe(false);
    expect(isDeferredParam(normalizeParam({ key: 'a', type: 'audio' }))).toBe(true);
    expect(isDeferredParam(normalizeParam({ key: 'm', type: 'images', mask: true }))).toBe(true);
  });

  it('appUploadKind + dual modes', () => {
    expect(appUploadKind('h3-t2v')).toBe('h3_i2v');
    expect(appUploadKind('wan-animate')).toBe('wan_animate');
    expect(appUploadKind('rh-acc-1')).toBe('img2img');
    expect(hasDualContentModes(['sfw', 'nsfw'])).toBe(true);
    expect(hasDualContentModes(['sfw'])).toBe(false);
  });
});
