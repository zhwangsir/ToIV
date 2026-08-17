import {
  buildAssetPrefillParam,
  parseAssetPrefill,
  suggestAssetName,
} from '../asset-prefill';

describe('suggestAssetName（M28 建议名）', () => {
  it('prompt 去空白后截断前 12 字', () => {
    expect(suggestAssetName('一只在月球上的猫')).toBe('一只在月球上的猫');
    expect(suggestAssetName('一二三四五六七八九十十一十二十三十四')).toBe(
      '一二三四五六七八九十十一',
    );
  });

  it('空白（空格/换行）先去除再计字', () => {
    expect(suggestAssetName('a b c\nd')).toBe('abcd');
    expect(suggestAssetName('  赛博 街道 夜景  ')).toBe('赛博街道夜景');
  });

  it('空串 / 纯空白 / null / undefined → 兜底「作品资产」', () => {
    expect(suggestAssetName('')).toBe('作品资产');
    expect(suggestAssetName('   \n ')).toBe('作品资产');
    expect(suggestAssetName(null)).toBe('作品资产');
    expect(suggestAssetName(undefined)).toBe('作品资产');
  });
});

describe('buildAssetPrefillParam（M28 预填参数编码）', () => {
  it('编码产物为 encodeURIComponent(JSON)，结构含 images/name/nsfw', () => {
    const param = buildAssetPrefillParam({
      filename: 'up-a.png',
      worker: 'http://w1',
      preview: 'https://api.test/outputs/a.png?token=t',
      prompt: '一只在月球上的猫',
      nsfw: true,
    });
    const decoded = JSON.parse(decodeURIComponent(param));
    expect(decoded).toEqual({
      images: [
        {
          filename: 'up-a.png',
          worker: 'http://w1',
          preview: 'https://api.test/outputs/a.png?token=t',
        },
      ],
      name: '一只在月球上的猫',
      nsfw: true,
    });
  });

  it('往返：build → parse 还原结构化对象', () => {
    const param = buildAssetPrefillParam({
      filename: 'up-a.png',
      worker: 'http://w1',
      preview: 'https://api.test/outputs/a.png?token=t',
      prompt: '',
      nsfw: false,
    });
    expect(parseAssetPrefill(param)).toEqual({
      images: [
        {
          filename: 'up-a.png',
          worker: 'http://w1',
          preview: 'https://api.test/outputs/a.png?token=t',
        },
      ],
      name: '作品资产',
      nsfw: false,
    });
  });
});

describe('parseAssetPrefill（M28 预填参数解码，防御解析失败静默忽略）', () => {
  it('空 / 非字符串 → null', () => {
    expect(parseAssetPrefill(undefined)).toBeNull();
    expect(parseAssetPrefill(null)).toBeNull();
    expect(parseAssetPrefill('')).toBeNull();
  });

  it('畸形 JSON / 非对象 → null', () => {
    expect(parseAssetPrefill('not-a-json')).toBeNull();
    expect(parseAssetPrefill(encodeURIComponent('[1,2]'))).toBeNull();
    expect(parseAssetPrefill(encodeURIComponent('123'))).toBeNull();
  });

  it('images 缺失 / 空数组 → null', () => {
    expect(parseAssetPrefill(encodeURIComponent('{"name":"x","nsfw":false}'))).toBeNull();
    expect(
      parseAssetPrefill(encodeURIComponent('{"images":[],"name":"x","nsfw":false}')),
    ).toBeNull();
  });

  it('image 缺 filename / worker → null', () => {
    expect(
      parseAssetPrefill(encodeURIComponent('{"images":[{"worker":"http://w1"}],"name":"x"}')),
    ).toBeNull();
    expect(
      parseAssetPrefill(encodeURIComponent('{"images":[{"filename":"a.png"}],"name":"x"}')),
    ).toBeNull();
  });

  it('缺 name / nsfw / preview 字段时给安全默认', () => {
    expect(
      parseAssetPrefill(
        encodeURIComponent('{"images":[{"filename":"a.png","worker":"http://w1"}]}'),
      ),
    ).toEqual({
      images: [{ filename: 'a.png', worker: 'http://w1', preview: '' }],
      name: '',
      nsfw: false,
    });
  });
});
