import { beforeEach, describe, expect, it } from 'vitest';

import type { JobItem } from '@/types/api';
import {
  assetPrefillToForm,
  buildAssetPrefillQuery,
  canSaveArtifactAsAsset,
  parseAssetPrefill,
  saveArtifactAsAsset,
  suggestAssetName,
} from '@/utils/asset-prefill';
import {
  allDownloads,
  allLoadings,
  allNavigations,
  hideLoadingCount,
  installMockUni,
  lastToast,
  lastUpload,
  setDownloadError,
  setDownloadResult,
  setUploadResult,
} from './helpers/mock-uni';

function makeJob(overrides: Partial<JobItem> = {}): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: '一只在胶片暗房里的猫，柔光',
    seed: 42,
    created_at: '2026-08-15T00:00:00',
    results: ['outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: true,
    ...overrides,
  };
}

const resolveUrl = (p: string) => `https://api.test/${p}`;

describe('suggestAssetName（建议名）', () => {
  it('空串 / 纯空白 → 兜底「作品资产」', () => {
    expect(suggestAssetName('')).toBe('作品资产');
    expect(suggestAssetName('   \n\t ')).toBe('作品资产');
  });

  it('去空白后不足 12 字原样', () => {
    expect(suggestAssetName('雨夜 霓虹\n街区')).toBe('雨夜霓虹街区');
  });

  it('超 12 字截断（去空白后取前 12 字）', () => {
    expect(suggestAssetName('走查存资产：雨夜霓虹街区胶片感')).toBe('走查存资产：雨夜霓虹街区');
  });
});

describe('canSaveArtifactAsAsset（仅 image 产物渲染入口）', () => {
  it('image 类作业 + 图片产物 → true', () => {
    expect(canSaveArtifactAsAsset(makeJob(), 0)).toBe(true);
  });

  it('null job → false', () => {
    expect(canSaveArtifactAsAsset(null, 0)).toBe(false);
  });

  it('video / audio / 3D 类作业 → false', () => {
    expect(
      canSaveArtifactAsAsset(makeJob({ kind: 'wan_t2v', results: ['outputs/a.mp4'] }), 0),
    ).toBe(false);
    expect(
      canSaveArtifactAsAsset(makeJob({ kind: 'ace_audio', results: ['outputs/a.mp3'] }), 0),
    ).toBe(false);
    expect(
      canSaveArtifactAsAsset(makeJob({ kind: 'hunyuan3d', results: ['outputs/a.glb'] }), 0),
    ).toBe(false);
  });

  it('无产物 → false', () => {
    expect(canSaveArtifactAsAsset(makeJob({ results: [] }), 0)).toBe(false);
  });

  it('index 越界钳到最后一张；多产物切第 2 张各自可存', () => {
    const job = makeJob({ results: ['outputs/a.png', 'outputs/b.png'] });
    expect(canSaveArtifactAsAsset(job, 1)).toBe(true);
    expect(canSaveArtifactAsAsset(job, 99)).toBe(true);
  });

  it('image 类作业但当前产物是视频扩展名 → false（防御）', () => {
    expect(canSaveArtifactAsAsset(makeJob({ results: ['outputs/a.mp4'] }), 0)).toBe(false);
  });
});

describe('buildAssetPrefillQuery（产物 → prefill query）', () => {
  it('形状：images[0] 句柄+preview / name 建议名 / nsfw 透传', () => {
    const raw = buildAssetPrefillQuery(
      {
        path: 'outputs/a.png',
        prompt: '一只在胶片暗房里的猫，柔光',
        nsfw: true,
        upload: { filename: 'up-1.png', worker: 'w9' },
      },
      resolveUrl,
    );
    const parsed = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    expect(parsed.images).toEqual([
      { filename: 'up-1.png', worker: 'w9', preview: 'https://api.test/outputs/a.png' },
    ]);
    expect(parsed.name).toBe('一只在胶片暗房里的猫，柔');
    expect(parsed.nsfw).toBe(true);
  });

  it('返回值已 URL 编码（可直接拼 ?prefill=）', () => {
    const raw = buildAssetPrefillQuery(
      { path: 'outputs/a.png', prompt: '', nsfw: false, upload: { filename: 'f', worker: 'w' } },
      resolveUrl,
    );
    expect(raw).not.toContain('{');
    expect(raw).not.toContain('}');
    expect(raw).toContain('%7B');
  });
});

describe('parseAssetPrefill（防御解析）', () => {
  it('build → parse 往返一致', () => {
    const raw = buildAssetPrefillQuery(
      {
        path: 'outputs/a.png',
        prompt: '雨夜霓虹',
        nsfw: true,
        upload: { filename: 'up-1.png', worker: 'w9' },
      },
      resolveUrl,
    );
    expect(parseAssetPrefill(raw)).toEqual({
      images: [{ filename: 'up-1.png', worker: 'w9', preview: 'https://api.test/outputs/a.png' }],
      name: '雨夜霓虹',
      nsfw: true,
    });
  });

  it('直接吃未编码 JSON 串（uni onLoad query 已解码场景）', () => {
    const json = JSON.stringify({
      images: [{ filename: 'f.png', worker: 'w1', preview: 'https://x/p.png' }],
      name: '主角卡',
      nsfw: false,
    });
    expect(parseAssetPrefill(json)?.name).toBe('主角卡');
  });

  it('空入参 → null', () => {
    expect(parseAssetPrefill(undefined)).toBeNull();
    expect(parseAssetPrefill(null)).toBeNull();
    expect(parseAssetPrefill('')).toBeNull();
  });

  it('畸形 JSON / 非对象 → null', () => {
    expect(parseAssetPrefill('{oops')).toBeNull();
    expect(parseAssetPrefill('"str"')).toBeNull();
    expect(parseAssetPrefill('123')).toBeNull();
    expect(parseAssetPrefill('[]')).toBeNull();
    expect(parseAssetPrefill('null')).toBeNull();
  });

  it('images 缺失 / 非数组 / 全缺句柄 → null', () => {
    expect(parseAssetPrefill('{"name":"x"}')).toBeNull();
    expect(parseAssetPrefill('{"images":{}}')).toBeNull();
    expect(parseAssetPrefill('{"images":[]}')).toBeNull();
    expect(parseAssetPrefill('{"images":[{"worker":"w1"}]}')).toBeNull();
    expect(parseAssetPrefill('{"images":[{"filename":"f.png"}]}')).toBeNull();
  });

  it('部分图片缺句柄 → 过滤保留合法项', () => {
    const parsed = parseAssetPrefill(
      JSON.stringify({
        images: [
          { filename: '', worker: 'w1', preview: 'p1' },
          { filename: 'f.png', worker: 'w2', preview: 'p2' },
          'junk',
        ],
        name: 'ok',
      }),
    );
    expect(parsed?.images).toEqual([{ filename: 'f.png', worker: 'w2', preview: 'p2' }]);
  });

  it('name 缺失/空白 → 兜底「作品资产」；nsfw 缺失 → false；preview 缺失 → 空串', () => {
    const parsed = parseAssetPrefill(
      JSON.stringify({ images: [{ filename: 'f.png', worker: 'w1' }], name: '  ' }),
    );
    expect(parsed).toEqual({
      images: [{ filename: 'f.png', worker: 'w1', preview: '' }],
      name: '作品资产',
      nsfw: false,
    });
  });
});

describe('assetPrefillToForm（新建弹层表单初值）', () => {
  it('previewUri ← 产物 preview；name ← filename；名称/nsfw 透传', () => {
    const form = assetPrefillToForm({
      images: [{ filename: 'up-1.png', worker: 'w9', preview: 'https://api.test/outputs/a.png' }],
      name: '主角卡',
      nsfw: true,
    });
    expect(form.name).toBe('主角卡');
    expect(form.nsfw).toBe(true);
    expect(form.images).toEqual([
      {
        filename: 'up-1.png',
        worker: 'w9',
        previewUri: 'https://api.test/outputs/a.png',
        name: 'up-1.png',
      },
    ]);
  });
});

describe('saveArtifactAsAsset（下载 → 上传 → 携 prefill 跳资产页）', () => {
  beforeEach(() => {
    installMockUni();
  });

  const input = { path: 'outputs/a.png', prompt: '一只在胶片暗房里的猫，柔光', nsfw: false };

  it('成功：loading → downloadFile → upload → navigateTo prefill 可解析往返', async () => {
    setDownloadResult(200, 'tmp/dl-1.png');
    const uploadPaths: string[] = [];
    const ok = await saveArtifactAsAsset(input, (fp) => {
      uploadPaths.push(fp);
      return Promise.resolve({ filename: 'up-1.png', worker: 'w9' });
    });
    expect(ok).toBe(true);
    // 下载 URL 走 mediaUrl（相对路径拼 base）
    expect(allDownloads()).toHaveLength(1);
    expect(allDownloads()[0].url).toContain('/outputs/a.png');
    // 上传收到下载临时文件
    expect(uploadPaths).toEqual(['tmp/dl-1.png']);
    // loading 一次且已收起；无错误 toast
    expect(allLoadings()).toEqual([{ title: '准备中…' }]);
    expect(hideLoadingCount()).toBe(1);
    // 跳转资产页且 prefill 可解析
    expect(allNavigations()).toHaveLength(1);
    const url = allNavigations()[0];
    expect(url.startsWith('/pages/assets/index?prefill=')).toBe(true);
    const prefill = parseAssetPrefill(url.slice('/pages/assets/index?prefill='.length));
    expect(prefill?.images[0].filename).toBe('up-1.png');
    expect(prefill?.images[0].worker).toBe('w9');
    expect(prefill?.images[0].preview).toContain('/outputs/a.png');
    expect(prefill?.name).toBe('一只在胶片暗房里的猫，柔');
    expect(prefill?.nsfw).toBe(false);
  });

  it('默认上传链路：uploadImage kind=img2img（不注入 upload）', async () => {
    setDownloadResult(200, 'tmp/dl-2.png');
    setUploadResult(200, { filename: 'up-2.png', worker: 'w1' });
    const ok = await saveArtifactAsAsset(input);
    expect(ok).toBe(true);
    expect(lastUpload().url).toContain('kind=img2img');
    expect(lastUpload().filePath).toBe('tmp/dl-2.png');
    expect(allNavigations()).toHaveLength(1);
  });

  it('downloadFile 网络失败 → toast 错误且停留原页', async () => {
    setDownloadError('downloadFile:fail');
    const ok = await saveArtifactAsAsset(input, () =>
      Promise.resolve({ filename: 'f', worker: 'w' }),
    );
    expect(ok).toBe(false);
    expect(lastToast().title).toBe('下载失败，请检查网络');
    expect(allNavigations()).toHaveLength(0);
    expect(hideLoadingCount()).toBe(1);
  });

  it('downloadFile 非 200 → toast 重试文案且停留原页', async () => {
    setDownloadResult(500, 'tmp/dl-x.png');
    const ok = await saveArtifactAsAsset(input, () =>
      Promise.resolve({ filename: 'f', worker: 'w' }),
    );
    expect(ok).toBe(false);
    expect(lastToast().title).toBe('下载失败，请重试');
    expect(allNavigations()).toHaveLength(0);
  });

  it('uploadImage 失败 → toast 透传人话且停留原页', async () => {
    setDownloadResult(200, 'tmp/dl-3.png');
    const ok = await saveArtifactAsAsset(input, () => Promise.reject(new Error('上传失败，请重试')));
    expect(ok).toBe(false);
    expect(lastToast().title).toBe('上传失败，请重试');
    expect(allNavigations()).toHaveLength(0);
    expect(hideLoadingCount()).toBe(1);
  });
});
