import { downloadAndSaveToLibrary, downloadToCache } from '@/lib/media.web';

describe('media.web（Web 平台存根：下载/保存属原生能力，统一抛人话 Error）', () => {
  it('downloadToCache → 抛「Web 端不支持下载」', async () => {
    await expect(downloadToCache('https://api.test/outputs/a.png')).rejects.toThrow(
      'Web 端不支持下载',
    );
  });

  it('downloadAndSaveToLibrary → 抛「Web 端不支持保存到相册」', async () => {
    await expect(downloadAndSaveToLibrary('https://api.test/outputs/a.png')).rejects.toThrow(
      'Web 端不支持保存到相册',
    );
  });
});
