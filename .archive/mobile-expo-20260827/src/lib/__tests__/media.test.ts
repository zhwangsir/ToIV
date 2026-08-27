import { downloadAndSaveToLibrary, downloadToCache } from '@/lib/media';
import { File } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';

jest.mock('expo-file-system', () => {
  class MockFile {
    static downloadFileAsync = jest.fn();
    dir: unknown;
    name: string;
    constructor(dir: unknown, name: string) {
      this.dir = dir;
      this.name = name;
    }
    get uri() {
      return `file:///mock/cache/${this.name}`;
    }
  }
  return {
    Paths: { cache: { uri: 'file:///mock/cache' } },
    File: MockFile,
  };
});

jest.mock('expo-media-library', () => ({
  Asset: { create: jest.fn() },
  requestPermissionsAsync: jest.fn(),
}));

const mockDownload = (File as unknown as { downloadFileAsync: jest.Mock }).downloadFileAsync;
const mockRequestPermission = requestPermissionsAsync as jest.Mock;
const mockAssetCreate = (Asset as unknown as { create: jest.Mock }).create;

describe('downloadAndSaveToLibrary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('下载成功且权限已授 → 保存到相册', async () => {
    mockDownload.mockResolvedValue(undefined);
    mockRequestPermission.mockResolvedValue({ status: 'granted' });
    mockAssetCreate.mockResolvedValue(undefined);

    await downloadAndSaveToLibrary('https://api.test/outputs/a.png?token=t');

    expect(mockDownload).toHaveBeenCalledWith(
      'https://api.test/outputs/a.png?token=t',
      expect.any(File),
    );
    expect(mockAssetCreate).toHaveBeenCalledWith('file:///mock/cache/a.png');
  });

  it('下载失败 → 抛「下载失败」', async () => {
    mockDownload.mockRejectedValue(new Error('network'));
    await expect(downloadAndSaveToLibrary('https://x')).rejects.toThrow('下载失败');
  });

  it('权限拒绝 → 抛「需要相册权限」', async () => {
    mockDownload.mockResolvedValue(undefined);
    mockRequestPermission.mockResolvedValue({ status: 'denied' });
    await expect(downloadAndSaveToLibrary('https://x')).rejects.toThrow('需要相册权限');
    expect(mockAssetCreate).not.toHaveBeenCalled();
  });
});

describe('downloadToCache（M28 存为资产下载源）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('下载成功 → 返回缓存文件 URI（剥 query 取文件名），不碰相册权限', async () => {
    mockDownload.mockResolvedValue(undefined);
    const uri = await downloadToCache('https://api.test/outputs/a.png?token=t');
    expect(uri).toBe('file:///mock/cache/a.png');
    expect(mockDownload).toHaveBeenCalledWith(
      'https://api.test/outputs/a.png?token=t',
      expect.any(File),
    );
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockAssetCreate).not.toHaveBeenCalled();
  });

  it('下载失败 → 抛「下载失败」', async () => {
    mockDownload.mockRejectedValue(new Error('network'));
    await expect(downloadToCache('https://x')).rejects.toThrow('下载失败');
  });
});
