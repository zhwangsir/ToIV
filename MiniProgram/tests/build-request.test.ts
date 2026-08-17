import { describe, expect, it } from 'vitest';

import type { EngineInfo, UploadedRefAudio, UploadedRefImage, UploadedRefVideo } from '@/types/api';
import {
  buildAceMusicRequest,
  buildAvatarTalkRequest,
  buildH3I2VRequest,
  buildH3NsfwI2VRequest,
  buildH3NsfwT2VRequest,
  buildH3T2VRequest,
  buildImg2ImgRequest,
  buildLongCatContinueRequest,
  buildLongCatI2VRequest,
  buildLongCatT2VRequest,
  buildLtx25I2VRequest,
  buildLtx25T2VRequest,
  buildLtxNsfwI2VRequest,
  buildLtxNsfwLipsyncRequest,
  buildLtxNsfwT2VRequest,
  buildTxt2ImgRequest,
  buildWanAnimateRequest,
  buildWanVaceRequest,
  defaultParamValues,
  engineImagesMax,
  engineNeedsAudio,
  engineNeedsMultiImage,
  engineNeedsRefImage,
  engineNeedsVideo,
  engineSheetParams,
  isEngineSupported,
  nsfwDurationSec,
  parseLoraValues,
  parseResolution,
  REF_AUDIO_MAX_BYTES,
  REF_IMAGE_MAX_BYTES,
  REF_VIDEO_MAX_BYTES,
  SUPPORTED_ENGINE_IDS,
  uploadKindForEngine,
  validateRefAudio,
  validateRefImage,
  validateRefVideo,
} from '@/utils/build-request';

const txt2imgEngine: EngineInfo = {
  id: 'sdxl',
  label: 'SDXL',
  kind: 'image',
  available: true,
  nsfw: false,
  params: [
    { key: 'width', label: '宽', type: 'number', default: 1024 },
    { key: 'height', label: '高', type: 'number', default: 1024 },
    { key: 'steps', label: '步数', type: 'number', default: 28 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 7 },
    { key: 'sampler', label: '采样器', type: 'select', default: 'euler_a', options: [] },
    { key: 'negative', label: '负面', type: 'textarea', default: '' },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const img2imgEngine: EngineInfo = {
  ...txt2imgEngine,
  id: 'sdxl-i2i',
  params: [
    { key: 'images', label: '参考图', type: 'images', default: [] },
    { key: 'denoise', label: '重绘幅度', type: 'number', default: 0.6, min: 0.1, max: 1 },
    { key: 'steps', label: '步数', type: 'number', default: 28 },
  ],
};

describe('engineNeedsRefImage', () => {
  it('含 images 参数 → true', () => {
    expect(engineNeedsRefImage(img2imgEngine)).toBe(true);
  });

  it('无 images 参数 → false', () => {
    expect(engineNeedsRefImage(txt2imgEngine)).toBe(false);
  });

  it('null/undefined → false', () => {
    expect(engineNeedsRefImage(null)).toBe(false);
    expect(engineNeedsRefImage(undefined)).toBe(false);
  });
});

describe('defaultParamValues', () => {
  it('提取非 images 参数默认值', () => {
    const values = defaultParamValues(img2imgEngine);
    expect(values).toEqual({ denoise: 0.6, steps: 28 });
    expect(values.images).toBeUndefined();
  });

  it('空引擎回落空对象', () => {
    expect(defaultParamValues(null)).toEqual({});
  });
});

describe('buildTxt2ImgRequest', () => {
  it('白名单透传 + 数字强转 + 空串剔除', () => {
    const req = buildTxt2ImgRequest('  a cat  ', {
      width: '768',
      height: 512,
      steps: 30,
      cfg: 6.5,
      sampler: 'dpm++',
      negative: '  blur ',
      style_preset: '',
      seed: null,
      evil: 'should-drop',
    });
    expect(req).toEqual({
      positive: 'a cat',
      width: 768,
      height: 512,
      steps: 30,
      cfg: 6.5,
      sampler: 'dpm++',
      negative: 'blur',
      seed: null,
    });
    expect('evil' in req).toBe(false);
    expect('style_preset' in req).toBe(false);
  });

  it('非数字值被丢弃', () => {
    const req = buildTxt2ImgRequest('x', { width: 'abc' });
    expect('width' in req).toBe(false);
  });

  it('seed 缺省不出现在请求里', () => {
    const req = buildTxt2ImgRequest('x', {});
    expect('seed' in req).toBe(false);
  });
});

describe('buildImg2ImgRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'f.png',
    worker: 'w1',
    previewUri: '/tmp/f.png',
    name: 'f.png',
  };

  it('带 image/worker 且无 width/height/batch_size', () => {
    const req = buildImg2ImgRequest('a dog', ref, {
      denoise: 0.7,
      steps: 25,
      width: 999,
      batch_size: 4,
    });
    expect(req.image).toBe('f.png');
    expect(req.worker).toBe('w1');
    expect(req.denoise).toBe(0.7);
    expect(req.steps).toBe(25);
    expect('width' in req).toBe(false);
    expect('batch_size' in req).toBe(false);
  });
});

describe('validateRefImage', () => {
  it('合法 jpg 通过', () => {
    expect(validateRefImage('/tmp/a.jpg', 1024)).toBeNull();
  });

  it('非法扩展名被拒', () => {
    expect(validateRefImage('/tmp/a.txt')).toContain('JPG');
  });

  it('超 20MB 被拒', () => {
    expect(validateRefImage('/tmp/a.png', REF_IMAGE_MAX_BYTES + 1)).toContain('20MB');
  });

  it('边界 20MB 通过', () => {
    expect(validateRefImage('/tmp/a.png', REF_IMAGE_MAX_BYTES)).toBeNull();
  });

  it('H5 blob: URL 跳过扩展名校验（uni-h5 chooseImage 返回无扩展名对象 URL，MIME 由 accept 约束 + 后端魔数兜底）', () => {
    expect(validateRefImage('blob:http://localhost:9810/9f2c1a', 1024)).toBeNull();
  });

  it('H5 blob: URL 仍守 20MB 上限', () => {
    expect(validateRefImage('blob:http://localhost:9810/9f2c1a', REF_IMAGE_MAX_BYTES + 1)).toContain(
      '20MB',
    );
  });
});

// ── MP10 SFW 视频引擎 ──

const ltx25T2VEngine: EngineInfo = {
  id: 'ltx25-t2v',
  label: 'LTX 2.5 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'negative', label: '负面', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 960, min: 256, max: 1920, step: 32 },
    { key: 'height', label: '高度', type: 'number', default: 544, min: 256, max: 1088, step: 32 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'fps', label: '帧率', type: 'number', default: 24, min: 8, max: 60 },
    { key: 'steps', label: '步数', type: 'number', default: 8, min: 1, max: 50 },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const ltx25I2VEngine: EngineInfo = {
  ...ltx25T2VEngine,
  id: 'ltx25-i2v',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...ltx25T2VEngine.params,
    { key: 'strength', label: '首帧强度', type: 'number', default: 0.7, min: 0, max: 1 },
  ],
};

const wanAnimateEngine: EngineInfo = {
  id: 'wan-animate',
  label: 'Wan2.2 动作迁移',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    { key: 'video', label: '驱动视频', type: 'video', default: null },
    { key: 'negative', label: '负面', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 7.5, min: 0.5, max: 31, step: 0.5 },
    { key: 'steps', label: '步数', type: 'number', default: 6, min: 1, max: 50 },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const wanVaceEngine: EngineInfo = {
  ...wanAnimateEngine,
  id: 'wan-vace',
  params: [
    { key: 'images', label: '参考图(1-4 张)', type: 'images', max: 4, default: null },
    ...wanAnimateEngine.params.filter((p) => p.key !== 'images' && p.key !== 'video'),
  ],
};

describe('SUPPORTED_ENGINE_IDS / isEngineSupported', () => {
  it('图像四件套 + 视频四引擎 + MP11 六引擎 + MP12 五引擎 + MP14 数字人在册', () => {
    for (const id of ['txt2img', 'img2img', 'nsfw-txt2img', 'nsfw-img2img',
      'ltx25-t2v', 'ltx25-i2v', 'wan-animate', 'wan-vace',
      'h3-t2v', 'h3-i2v', 'longcat-t2v', 'longcat-i2v', 'longcat-continue', 'ace-music',
      'ltx-nsfw-t2v', 'ltx-nsfw-i2v', 'ltx-nsfw-lipsync', 'h3-nsfw-t2v', 'h3-nsfw-i2v',
      'avatar-talk']) {
      expect(SUPPORTED_ENGINE_IDS).toContain(id);
    }
  });

  it('未知/空引擎不支持', () => {
    expect(isEngineSupported({ ...ltx25T2VEngine, id: 'future-engine' })).toBe(false);
    expect(isEngineSupported(null)).toBe(false);
  });

  it('MP12 起 5 个 R18 引擎已放行（可见性由后端按 X-NSFW 头过滤）', () => {
    for (const id of ['ltx-nsfw-t2v', 'ltx-nsfw-i2v', 'ltx-nsfw-lipsync', 'h3-nsfw-t2v', 'h3-nsfw-i2v']) {
      expect(isEngineSupported({ ...ltx25T2VEngine, id })).toBe(true);
    }
  });

  it('MP14 起 avatar-talk 数字人已放行（SFW 引擎，主站上下文可见）', () => {
    expect(isEngineSupported({ ...ltx25T2VEngine, id: 'avatar-talk' })).toBe(true);
  });
});

describe('engineNeedsVideo / engineImagesMax / engineNeedsMultiImage', () => {
  it('wan-animate 需要驱动视频', () => {
    expect(engineNeedsVideo(wanAnimateEngine)).toBe(true);
    expect(engineNeedsVideo(ltx25T2VEngine)).toBe(false);
    expect(engineNeedsVideo(null)).toBe(false);
  });

  it('images max 解析：vace=4 / animate=1 / 无参数=0', () => {
    expect(engineImagesMax(wanVaceEngine)).toBe(4);
    expect(engineImagesMax(wanAnimateEngine)).toBe(1);
    expect(engineImagesMax(ltx25I2VEngine)).toBe(1);
    expect(engineImagesMax(ltx25T2VEngine)).toBe(0);
  });

  it('images 缺省 max 按 1', () => {
    const engine: EngineInfo = {
      ...wanVaceEngine,
      params: [{ key: 'images', label: '参考图', type: 'images', default: null }],
    };
    expect(engineImagesMax(engine)).toBe(1);
  });

  it('engineNeedsMultiImage 仅 max>1', () => {
    expect(engineNeedsMultiImage(wanVaceEngine)).toBe(true);
    expect(engineNeedsMultiImage(wanAnimateEngine)).toBe(false);
  });
});

describe('uploadKindForEngine', () => {
  it('按引擎映射 upload kind', () => {
    expect(uploadKindForEngine('ltx25-i2v')).toBe('ltx_i2v');
    expect(uploadKindForEngine('wan-animate')).toBe('wan_animate');
    expect(uploadKindForEngine('wan-vace')).toBe('wan_vace');
    expect(uploadKindForEngine('h3-i2v')).toBe('h3_i2v');
    // capabilities.py 无 longcat 专用 kind，对齐 Web GenerateView fallback
    expect(uploadKindForEngine('longcat-i2v')).toBe('ltx_i2v');
    expect(uploadKindForEngine('img2img')).toBe('img2img');
    expect(uploadKindForEngine('unknown')).toBe('img2img');
  });

  it('MP12：R18 引擎映射（lipsync 专用 kind / h3-nsfw 与 SFW 同链路）', () => {
    expect(uploadKindForEngine('ltx-nsfw-i2v')).toBe('ltx_i2v');
    expect(uploadKindForEngine('ltx-nsfw-lipsync')).toBe('ltx_lipsync');
    expect(uploadKindForEngine('h3-nsfw-i2v')).toBe('h3_i2v');
  });

  it('MP14：avatar-talk → avatar（人像/音频同 kind 互钉，后端转运 LongCat 实例）', () => {
    expect(uploadKindForEngine('avatar-talk')).toBe('avatar');
  });
});

describe('defaultParamValues（视频引擎）', () => {
  it('images/video 类型参数不进默认值表', () => {
    const values = defaultParamValues(wanAnimateEngine);
    expect(values.images).toBeUndefined();
    expect(values.video).toBeUndefined();
    expect(values.width).toBe(832);
    expect(values.duration).toBe(7.5);
  });
});

describe('buildLtx25T2VRequest', () => {
  it('白名单透传 + 数字强转 + 空串剔除 + duration 映射 duration_sec', () => {
    const req = buildLtx25T2VRequest('  a cat  ', {
      width: '960',
      height: 544,
      duration: 7.5,
      fps: 24,
      steps: 8,
      negative: '  blur ',
      seed: null,
      evil: 'drop',
    });
    expect(req).toEqual({
      positive: 'a cat',
      negative: 'blur',
      width: 960,
      height: 544,
      duration_sec: 7.5,
      fps: 24,
      steps: 8,
      seed: null,
    });
    expect('evil' in req).toBe(false);
  });

  it('不带 cfg/sampler 等图像键；duration 缺省省略(后端默认 5s)', () => {
    const req = buildLtx25T2VRequest('x', { cfg: 7, sampler: 'euler' });
    expect('cfg' in req).toBe(false);
    expect('sampler' in req).toBe(false);
    expect('duration_sec' in req).toBe(false);
  });
});

describe('buildLtx25I2VRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'f.png',
    worker: 'w-ltx',
    previewUri: '/tmp/f.png',
    name: 'f.png',
  };

  it('带 image/worker/strength', () => {
    const req = buildLtx25I2VRequest('a dog', ref, { strength: 0.8, steps: 10 });
    expect(req.image).toBe('f.png');
    expect(req.worker).toBe('w-ltx');
    expect(req.strength).toBe(0.8);
    expect(req.steps).toBe(10);
  });

  it('strength 缺省不出现', () => {
    const req = buildLtx25I2VRequest('a dog', ref, {});
    expect('strength' in req).toBe(false);
  });
});

describe('buildWanAnimateRequest', () => {
  const refImage: UploadedRefImage = {
    filename: 'img.png',
    worker: 'w1',
    previewUri: '/tmp/img.png',
    name: 'img.png',
  };
  const refVideo: UploadedRefVideo = {
    filename: 'drive.mp4',
    worker: 'w1',
    previewUri: '/tmp/drive.mp4',
    name: 'drive.mp4',
    duration: 6,
  };

  it('image/video/worker 齐，worker 取参考图落点', () => {
    const req = buildWanAnimateRequest('跳舞', refImage, refVideo, {
      width: 832,
      duration: 10,
      fps: 16,
    });
    expect(req).toMatchObject({
      positive: '跳舞',
      image: 'img.png',
      video: 'drive.mp4',
      worker: 'w1',
      width: 832,
      duration_sec: 10,
      fps: 16,
    });
  });

  it('不传 relight_lora/cfg/shift（后端默认）', () => {
    const req = buildWanAnimateRequest('x', refImage, refVideo, { relight_lora: true, cfg: 5 });
    expect('relight_lora' in req).toBe(false);
    expect('cfg' in req).toBe(false);
  });
});

describe('buildWanVaceRequest', () => {
  const refs: UploadedRefImage[] = [
    { filename: 'a.png', worker: 'w1', previewUri: '/tmp/a.png', name: 'a.png' },
    { filename: 'b.png', worker: 'w1', previewUri: '/tmp/b.png', name: 'b.png' },
  ];

  it('images 数组 + worker 取第一张落点', () => {
    const req = buildWanVaceRequest('多参考', refs, { duration: 5, steps: 20 });
    expect(req.images).toEqual(['a.png', 'b.png']);
    expect(req.worker).toBe('w1');
    expect(req.duration_sec).toBe(5);
    expect(req.steps).toBe(20);
  });

  it('不传 start_image/end_image（注册表未暴露）', () => {
    const req = buildWanVaceRequest('x', refs, { start_image: 's.png', end_image: 'e.png' });
    expect('start_image' in req).toBe(false);
    expect('end_image' in req).toBe(false);
  });
});

describe('validateRefVideo', () => {
  it('合法 mp4 通过', () => {
    expect(validateRefVideo('/tmp/a.mp4', 1024)).toBeNull();
  });

  it('webm/mov 通过，大小写不敏感', () => {
    expect(validateRefVideo('/tmp/a.WEBM')).toBeNull();
    expect(validateRefVideo('/tmp/a.mov')).toBeNull();
  });

  it('非法扩展名被拒', () => {
    expect(validateRefVideo('/tmp/a.avi')).toContain('MP4');
  });

  it('超 200MB 被拒', () => {
    expect(validateRefVideo('/tmp/a.mp4', REF_VIDEO_MAX_BYTES + 1)).toContain('200MB');
  });

  it('边界 200MB 通过', () => {
    expect(validateRefVideo('/tmp/a.mp4', REF_VIDEO_MAX_BYTES)).toBeNull();
  });
});

// ── MP11：H3 / LongCat / ACE 引擎 ──

describe('parseLoraValues', () => {
  it('非数组 → 空数组', () => {
    expect(parseLoraValues(undefined)).toEqual([]);
    expect(parseLoraValues('h3.safetensors')).toEqual([]);
    expect(parseLoraValues(null)).toEqual([]);
  });

  it('逐项透传 name/strength', () => {
    expect(parseLoraValues([{ name: 'a.safetensors', strength: 0.8 }])).toEqual([
      { name: 'a.safetensors', strength: 0.8 },
    ]);
  });

  it('strength 非有限数 → 缺省 0.6', () => {
    expect(parseLoraValues([{ name: 'a.safetensors' }])).toEqual([
      { name: 'a.safetensors', strength: 0.6 },
    ]);
    expect(parseLoraValues([{ name: 'a.safetensors', strength: Number.NaN }])).toEqual([
      { name: 'a.safetensors', strength: 0.6 },
    ]);
  });

  it('strength 越界钳 0.5-1.0', () => {
    expect(parseLoraValues([{ name: 'a.safetensors', strength: 0.1 }])[0].strength).toBe(0.5);
    expect(parseLoraValues([{ name: 'a.safetensors', strength: 2 }])[0].strength).toBe(1);
  });

  it('缺 string name 的项跳过', () => {
    expect(
      parseLoraValues([null, { strength: 0.7 }, { name: 42 }, { name: 'b.safetensors', strength: 0.7 }]),
    ).toEqual([{ name: 'b.safetensors', strength: 0.7 }]);
  });
});

describe('buildH3T2VRequest', () => {
  it('白名单透传 + loras 数组 + 数字强转 + duration 映射 duration_sec', () => {
    const req = buildH3T2VRequest('  海港黄昏  ', {
      width: '1344',
      height: 768,
      duration: 5,
      steps: 20,
      negative: '  低饱和  ',
      seed: null,
      loras: [{ name: 'h3_detail.safetensors', strength: 0.7 }],
      evil: 'drop',
    });
    expect(req).toEqual({
      positive: '海港黄昏',
      negative: '低饱和',
      width: 1344,
      height: 768,
      duration_sec: 5,
      steps: 20,
      seed: null,
      loras: [{ name: 'h3_detail.safetensors', strength: 0.7 }],
    });
    expect('evil' in req).toBe(false);
  });

  it('不带 fps/cfg（模板内锁定）；loras 缺省归一为空数组', () => {
    const req = buildH3T2VRequest('x', { fps: 24, cfg: 5 });
    expect('fps' in req).toBe(false);
    expect('cfg' in req).toBe(false);
    expect(req.loras).toEqual([]);
  });
});

describe('buildH3I2VRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'f.png',
    worker: 'w-h3',
    previewUri: '/tmp/f.png',
    name: 'f.png',
  };

  it('带 image/worker + loras + duration_sec', () => {
    const req = buildH3I2VRequest('一只猫动起来', ref, {
      duration: 6,
      loras: [{ name: 'h3_motion.safetensors' }],
    });
    expect(req.image).toBe('f.png');
    expect(req.worker).toBe('w-h3');
    expect(req.duration_sec).toBe(6);
    expect(req.loras).toEqual([{ name: 'h3_motion.safetensors', strength: 0.6 }]);
  });
});

describe('buildLongCatT2VRequest', () => {
  it('白名单透传 width/height/steps/fps + duration 映射 duration_sec', () => {
    const req = buildLongCatT2VRequest('长镜头', {
      width: 832,
      height: 480,
      duration: 60,
      steps: 10,
      fps: 16,
      negative: '抖动',
      cfg: 1,
      sampler: 'euler',
    });
    expect(req).toEqual({
      positive: '长镜头',
      negative: '抖动',
      width: 832,
      height: 480,
      duration_sec: 60,
      steps: 10,
      fps: 16,
    });
    expect('cfg' in req).toBe(false);
    expect('sampler' in req).toBe(false);
  });
});

describe('buildLongCatI2VRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'lc.png',
    worker: 'w-ltx',
    previewUri: '/tmp/lc.png',
    name: 'lc.png',
  };

  it('带 image/worker，不传 loras 键', () => {
    const req = buildLongCatI2VRequest('x', ref, { steps: 12 });
    expect(req.image).toBe('lc.png');
    expect(req.worker).toBe('w-ltx');
    expect(req.steps).toBe(12);
    expect('loras' in req).toBe(false);
  });
});

describe('buildLongCatContinueRequest', () => {
  it('video 取自 values 并 trim；duration_sec/steps 保留', () => {
    const req = buildLongCatContinueRequest('接着走', {
      video: '  /api/images?path=outputs/a.mp4  ',
      duration: 7.5,
      steps: 10,
    });
    expect(req.video).toBe('/api/images?path=outputs/a.mp4');
    expect(req.duration_sec).toBe(7.5);
    expect(req.steps).toBe(10);
  });

  it('width/height/fps 空值省略不传（后端向源视频实测对齐）', () => {
    const req = buildLongCatContinueRequest('x', {
      video: '/api/images?path=outputs/a.mp4',
      width: '',
      height: undefined,
      fps: '',
    });
    expect('width' in req).toBe(false);
    expect('height' in req).toBe(false);
    expect('fps' in req).toBe(false);
  });

  it('video 缺失/非字符串 → 空串（提交校验在 UI 层拦截）', () => {
    expect(buildLongCatContinueRequest('x', {}).video).toBe('');
    expect(buildLongCatContinueRequest('x', { video: 42 }).video).toBe('');
  });
});

describe('buildAceMusicRequest', () => {
  it('positive → tags 映射 + 白名单数字键', () => {
    const req = buildAceMusicRequest('  lo-fi hip hop  ', {
      lyrics: '[verse] night rain',
      seconds: '60',
      steps: 50,
      cfg: 5,
      seed: 7,
      width: 832,
      evil: 'drop',
    });
    expect(req).toEqual({
      tags: 'lo-fi hip hop',
      lyrics: '[verse] night rain',
      seconds: 60,
      steps: 50,
      cfg: 5,
      seed: 7,
    });
    expect('width' in req).toBe(false);
    expect('positive' in req).toBe(false);
  });

  it('lyrics 空串省略（后端默认纯音乐）', () => {
    const req = buildAceMusicRequest('piano solo', { lyrics: '   ' });
    expect('lyrics' in req).toBe(false);
  });
});

// ── MP12：R18 视频引擎（契约对齐 Web lib/engines.ts _ltxNsfwPayload/_h3NsfwPayload、Mobile generate-screen）──

const ltxNsfwT2VEngine: EngineInfo = {
  id: 'ltx-nsfw-t2v',
  label: 'LTX 2.3 文生视频（R18）',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'resolution', label: '分辨率', type: 'select', default: '1280x720', options: [] },
    { key: 'duration', label: '时长', type: 'select', default: '6', options: [] },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'steps', label: '步数', type: 'number', default: 20, min: 1, max: 50 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 1, min: 1, max: 10 },
    { key: 'use_upscale', label: '高清放大', type: 'switch', default: false },
    { key: 'use_rife', label: '补帧', type: 'switch', default: false },
    { key: 'negative', label: '负面', type: 'textarea', default: '' },
    { key: 'seed', label: '种子', type: 'number', default: null },
  ],
};

const ltxNsfwLipsyncEngine: EngineInfo = {
  ...ltxNsfwT2VEngine,
  id: 'ltx-nsfw-lipsync',
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    { key: 'audio', label: '驱动音频', type: 'audio', default: null },
    ...ltxNsfwT2VEngine.params,
    { key: 'id_lora', label: 'ID LoRA', type: 'text', default: '' },
    { key: 'id_lora_strength', label: 'ID LoRA 强度', type: 'number', default: 0.8, min: 0, max: 2 },
  ],
};

describe('engineNeedsAudio', () => {
  it('lipsync 含 audio 参数 → true；t2v/空 → false', () => {
    expect(engineNeedsAudio(ltxNsfwLipsyncEngine)).toBe(true);
    expect(engineNeedsAudio(ltxNsfwT2VEngine)).toBe(false);
    expect(engineNeedsAudio(null)).toBe(false);
    expect(engineNeedsAudio(undefined)).toBe(false);
  });
});

describe('defaultParamValues（MP12：audio 媒体参数不进默认值表）', () => {
  it('audio/images 跳过，其余参数保留默认值', () => {
    const values = defaultParamValues(ltxNsfwLipsyncEngine);
    expect(values.audio).toBeUndefined();
    expect(values.images).toBeUndefined();
    expect(values.resolution).toBe('1280x720');
    expect(values.id_lora_strength).toBe(0.8);
  });
});

describe('validateRefAudio', () => {
  it('合法 mp3/wav/flac 通过（大小写不敏感）', () => {
    expect(validateRefAudio('/tmp/a.mp3', 1024)).toBeNull();
    expect(validateRefAudio('/tmp/a.WAV')).toBeNull();
    expect(validateRefAudio('/tmp/a.flac')).toBeNull();
  });

  it('非法扩展名被拒', () => {
    expect(validateRefAudio('/tmp/a.aac')).toContain('wav');
    expect(validateRefAudio('/tmp/a.txt')).toContain('wav');
  });

  it('超 20MB 被拒 / 边界 20MB 通过', () => {
    expect(validateRefAudio('/tmp/a.mp3', REF_AUDIO_MAX_BYTES + 1)).toContain('20MB');
    expect(validateRefAudio('/tmp/a.mp3', REF_AUDIO_MAX_BYTES)).toBeNull();
  });
});

describe('parseResolution', () => {
  it('合法 WxH 解析为宽高', () => {
    expect(parseResolution('1280x720', '768x384')).toEqual({ width: 1280, height: 720 });
  });

  it('非法/空值回落 fallback 预设', () => {
    expect(parseResolution('wide', '768x384')).toEqual({ width: 768, height: 384 });
    expect(parseResolution('', '768x384')).toEqual({ width: 768, height: 384 });
  });
});

describe('nsfwDurationSec', () => {
  it('数值字符串直传秒数（含新增 4s/8s 档）', () => {
    expect(nsfwDurationSec('6')).toBe(6);
    expect(nsfwDurationSec('4')).toBe(4);
    expect(nsfwDurationSec('8')).toBe(8);
    expect(nsfwDurationSec('15')).toBe(15);
  });

  it('非法/缺失 duration 回落默认 6s', () => {
    expect(nsfwDurationSec('abc')).toBe(6);
    expect(nsfwDurationSec(undefined)).toBe(6);
    expect(nsfwDurationSec('-1')).toBe(6);
  });
});

describe('buildLtxNsfwT2VRequest', () => {
  it('resolution 预设换算 + duration 直传 duration_sec + 开关布尔化 + 白名单透传', () => {
    const req = buildLtxNsfwT2VRequest('  霓虹雨夜  ', {
      resolution: '1280x720',
      duration: '6',
      fps: 16,
      steps: 20,
      cfg: 1,
      negative: '  低画质  ',
      seed: null,
      use_upscale: true,
      use_rife: false,
      evil: 'drop',
    });
    expect(req).toEqual({
      positive: '霓虹雨夜',
      negative: '低画质',
      width: 1280,
      height: 720,
      duration_sec: 6,
      fps: 16,
      steps: 20,
      cfg: 1,
      seed: null,
      use_upscale: true,
      use_rife: false,
    });
    expect('evil' in req).toBe(false);
    expect('resolution' in req).toBe(false);
    expect('duration' in req).toBe(false);
  });

  it('预设缺失回落 1280x720 / 6 秒；开关缺省 false', () => {
    const req = buildLtxNsfwT2VRequest('x', {});
    expect(req.width).toBe(1280);
    expect(req.height).toBe(720);
    expect(req.duration_sec).toBe(6);
    expect(req.use_upscale).toBe(false);
    expect(req.use_rife).toBe(false);
  });

  it('fps 非数字不透传；duration 解析不受影响', () => {
    const req = buildLtxNsfwT2VRequest('x', { fps: 'high' });
    expect(req.duration_sec).toBe(6);
    expect('fps' in req).toBe(false);
  });
});

describe('buildLtxNsfwI2VRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'r18.png',
    worker: 'w-ltx',
    previewUri: '/tmp/r18.png',
    name: 'r18.png',
  };

  it('t2v 全集 + image/worker 落点', () => {
    const req = buildLtxNsfwI2VRequest('动起来', ref, {
      resolution: '960x544',
      duration: '10',
      fps: 24,
    });
    expect(req.image).toBe('r18.png');
    expect(req.worker).toBe('w-ltx');
    expect(req.width).toBe(960);
    expect(req.height).toBe(544);
    expect(req.duration_sec).toBe(10);
  });
});

describe('buildLtxNsfwLipsyncRequest', () => {
  const refImage: UploadedRefImage = {
    filename: 'face.png',
    worker: 'w-sync',
    previewUri: '/tmp/face.png',
    name: 'face.png',
  };
  const refAudio: UploadedRefAudio = { filename: 'voice.mp3', worker: 'w-sync', name: 'voice.mp3' };

  it('图/音互钉句柄 + id_lora trim 透传', () => {
    const req = buildLtxNsfwLipsyncRequest('对口型', refImage, refAudio, {
      id_lora: '  id_face.safetensors ',
      id_lora_strength: 1.2,
    });
    expect(req.image).toBe('face.png');
    expect(req.worker).toBe('w-sync');
    expect(req.audio).toBe('voice.mp3');
    expect(req.id_lora).toBe('id_face.safetensors');
    expect(req.id_lora_strength).toBe(1.2);
  });

  it('id_lora 留空省略；强度缺省省略（后端补默认 0.8）', () => {
    const req = buildLtxNsfwLipsyncRequest('x', refImage, refAudio, { id_lora: '   ' });
    expect('id_lora' in req).toBe(false);
    expect('id_lora_strength' in req).toBe(false);
  });
});

describe('buildH3NsfwT2VRequest', () => {
  it('resolution 默认 1280x736 + duration 直传 duration_sec + loras 叠加；fps 不透传', () => {
    const req = buildH3NsfwT2VRequest('  火山  ', {
      duration: '10',
      steps: 24,
      loras: [{ name: 'r18.safetensors', strength: 0.9 }],
      fps: 24,
    });
    expect(req).toEqual({
      positive: '火山',
      width: 1280,
      height: 736,
      duration_sec: 10,
      steps: 24,
      loras: [{ name: 'r18.safetensors', strength: 0.9 }],
    });
    expect('fps' in req).toBe(false);
  });

  it('非法 duration 回落 6 秒；新增 4s/8s 档直传（不再前端查帧数表）', () => {
    expect(buildH3NsfwT2VRequest('x', { duration: 'abc' }).duration_sec).toBe(6);
    expect(buildH3NsfwT2VRequest('x', { duration: '4' }).duration_sec).toBe(4);
    expect(buildH3NsfwT2VRequest('x', { duration: '8' }).duration_sec).toBe(8);
  });

  it('resolution 预设换算覆盖默认值', () => {
    const req = buildH3NsfwT2VRequest('x', { resolution: '960x544' });
    expect(req.width).toBe(960);
    expect(req.height).toBe(544);
  });
});

describe('buildH3NsfwI2VRequest', () => {
  const ref: UploadedRefImage = {
    filename: 'h3r18.png',
    worker: 'w-pool',
    previewUri: '/tmp/h3r18.png',
    name: 'h3r18.png',
  };

  it('t2v 全集 + image/worker 落点', () => {
    const req = buildH3NsfwI2VRequest('x', ref, { duration: '15' });
    expect(req.image).toBe('h3r18.png');
    expect(req.worker).toBe('w-pool');
    expect(req.duration_sec).toBe(15);
  });
});

// ── MP14：LongCat-Avatar 数字人（契约对齐 routes/avatar_studio.py AvatarTalkRequest）──

/** 与后端注册表 _avatar_talk_params() 同形状：audio 为 text 占位（非 audio 类型） */
const avatarTalkEngine: EngineInfo = {
  id: 'avatar-talk',
  label: 'LongCat-Avatar 数字人',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '人像首帧', type: 'images', max: 1, default: null },
    { key: 'audio', label: '驱动音频', type: 'text', default: '' },
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 3.7, min: 0.5, max: 100, step: 0.1 },
    { key: 'fps', label: '帧率', type: 'number', default: 25, min: 8, max: 30 },
    { key: 'steps', label: '采样步数', type: 'number', default: 12, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

describe('engineNeedsAudio（MP14：avatar-talk text 占位 audio 键）', () => {
  it('avatar-talk 需要驱动音频（text 占位也识别）', () => {
    expect(engineNeedsAudio(avatarTalkEngine)).toBe(true);
  });

  it('无 audio 键的同名前缀引擎不误判', () => {
    expect(engineNeedsAudio({ ...avatarTalkEngine, params: [] })).toBe(false);
    expect(engineNeedsAudio({ ...avatarTalkEngine, id: 'avatar-talk-v2' })).toBe(false);
  });
});

describe('engineSheetParams（MP14）', () => {
  it('avatar-talk 剔除 text 占位 audio 键，其余保留', () => {
    const keys = engineSheetParams(avatarTalkEngine).map((p) => p.key);
    expect(keys).not.toContain('audio');
    expect(keys).toContain('width');
    expect(keys).toContain('duration');
    expect(keys).toContain('images'); // images 由 param-sheet 内部再过滤，这里原样保留
  });

  it('非 avatar-talk 引擎原样透传', () => {
    expect(engineSheetParams(ltxNsfwLipsyncEngine)).toEqual(ltxNsfwLipsyncEngine.params);
    expect(engineSheetParams(null)).toEqual([]);
  });
});

describe('buildAvatarTalkRequest', () => {
  const refImage: UploadedRefImage = {
    filename: 'portrait.png',
    worker: 'w-pool',
    previewUri: '/tmp/portrait.png',
    name: 'portrait.png',
  };
  const refAudio: UploadedRefAudio = { filename: 'voice.wav', worker: 'w-pool', name: 'voice.wav' };

  it('image/audio/worker 齐，worker 取人像落点；白名单数字键透传 + duration 映射 duration_sec', () => {
    const req = buildAvatarTalkRequest('  一位女士面对镜头自然说话  ', refImage, refAudio, {
      width: '480',
      height: 832,
      duration: 3.7,
      fps: 25,
      steps: 12,
      negative: '  低画质  ',
      seed: null,
      evil: 'drop',
    });
    expect(req).toEqual({
      positive: '一位女士面对镜头自然说话',
      image: 'portrait.png',
      audio: 'voice.wav',
      worker: 'w-pool',
      negative: '低画质',
      width: 480,
      height: 832,
      duration_sec: 3.7,
      fps: 25,
      steps: 12,
      seed: null,
    });
    expect('evil' in req).toBe(false);
  });

  it('shift/cfg/dmd_lora_strength 注册表未外露，出现即透传（缺省后端补默认）', () => {
    const req = buildAvatarTalkRequest('x', refImage, refAudio, {
      shift: 12,
      cfg: 1,
      dmd_lora_strength: 0.8,
    });
    expect(req.shift).toBe(12);
    expect(req.cfg).toBe(1);
    expect(req.dmd_lora_strength).toBe(0.8);
  });

  it('缺省参数省略不传；values.audio 文本占位不进请求体', () => {
    const req = buildAvatarTalkRequest('x', refImage, refAudio, { audio: 'should-not-pass' });
    expect(req.audio).toBe('voice.wav');
    expect('width' in req).toBe(false);
    expect('duration_sec' in req).toBe(false);
    expect('seed' in req).toBe(false);
  });

  it('数值钳到后端边界由后端 422 兜底，构建层只做强转', () => {
    const req = buildAvatarTalkRequest('x', refImage, refAudio, { duration: '100', fps: '30' });
    expect(req.duration_sec).toBe(100);
    expect(req.fps).toBe(30);
  });
});
