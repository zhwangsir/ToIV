import { describe, expect, it } from 'vitest';

import type { JobItem } from '@/types/api';
import {
  cardSizePx,
  collectArtifacts,
  columnCount,
  countByFilter,
  isVideoPath,
  kindLabel,
  kindToFilter,
  LIBRARY_PAGE_SIZE,
} from '@/utils/library';

function job(partial: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: 'a cat',
    seed: 42,
    created_at: '2026-08-13T10:00:00',
    results: ['outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: true,
    ...partial,
  };
}

describe('kindToFilter', () => {
  it('已知 kind 进对应桶', () => {
    expect(kindToFilter('txt2img')).toBe('image');
    expect(kindToFilter('wan_t2v')).toBe('video');
    expect(kindToFilter('ace_audio')).toBe('audio');
    expect(kindToFilter('hunyuan3d')).toBe('3d');
  });

  it('未识别 kind 返回 null（只进全部）', () => {
    expect(kindToFilter('some_new_kind')).toBeNull();
    expect(kindToFilter('')).toBeNull();
  });
});

describe('kindToFilter 追上网页 libraryQuery', () => {
  it('图像桶：qwen_edit + 短剧图像产物', () => {
    expect(kindToFilter('qwen_edit')).toBe('image');
    expect(kindToFilter('drama_grid_storyboard')).toBe('image');
    expect(kindToFilter('drama_scene_layout')).toBe('image');
  });

  it('视频桶：多镜头/转场/编辑/关键帧链/超分/短剧视频/通用对口型', () => {
    expect(kindToFilter('h3_multishot')).toBe('video');
    expect(kindToFilter('video_upscale')).toBe('video');
    expect(kindToFilter('transition')).toBe('video');
    expect(kindToFilter('video_edit')).toBe('video');
    expect(kindToFilter('keyframe_chain')).toBe('video');
    expect(kindToFilter('drama_shot_video')).toBe('video');
    expect(kindToFilter('drama_shot_video_i2v')).toBe('video');
    expect(kindToFilter('drama_shot_video_v2')).toBe('video');
    expect(kindToFilter('drama_shot_lipsync')).toBe('video');
    expect(kindToFilter('lipsync')).toBe('video');
  });

  it('音频桶：manju_voice', () => {
    expect(kindToFilter('manju_voice')).toBe('audio');
  });

  it('3D 桶：threed_*', () => {
    expect(kindToFilter('threed_material')).toBe('3d');
    expect(kindToFilter('threed_render')).toBe('3d');
    expect(kindToFilter('threed_texture')).toBe('3d');
  });

  it('前缀规则：cad_* → 3d，drama_char_reference_* → image', () => {
    expect(kindToFilter('cad_front')).toBe('3d');
    expect(kindToFilter('drama_char_reference_hero')).toBe('image');
  });

  it('引擎 id（连字符）不是 Job.kind，保持未识别', () => {
    expect(kindToFilter('qwen-image-edit')).toBeNull();
    expect(kindToFilter('h3-multishot')).toBeNull();
    expect(kindToFilter('wan-transition')).toBeNull();
    expect(kindToFilter('keyframe-chain')).toBeNull();
    expect(kindToFilter('vace-edit')).toBeNull();
    expect(kindToFilter('wan-animate-2')).toBeNull();
    expect(kindToFilter('wan-nsfw-i2v')).toBeNull();
  });

  it('网页 libraryQuery 未收录的 kind 仍为 null', () => {
    expect(kindToFilter('chromakey')).toBeNull();
    expect(kindToFilter('i2l')).toBeNull();
    expect(kindToFilter('motion_brush')).toBeNull();
    expect(kindToFilter('wan_animate')).toBeNull();
    expect(kindToFilter('wan_animate2')).toBeNull();
  });
});

describe('kindLabel', () => {
  it('已知 kind 中文标签', () => {
    expect(kindLabel('txt2img')).toBe('文生图');
    expect(kindLabel('img2img')).toBe('图生图');
  });

  it('未知兜底「其他」', () => {
    expect(kindLabel('xyz')).toBe('其他');
  });

  it('新 kind 中文短名对齐网页', () => {
    expect(kindLabel('qwen_edit')).toBe('智能编辑');
    expect(kindLabel('h3_multishot')).toBe('多镜头');
    expect(kindLabel('transition')).toBe('首尾帧转场');
    expect(kindLabel('video_edit')).toBe('视频编辑');
    expect(kindLabel('keyframe_chain')).toBe('关键帧链');
    expect(kindLabel('video_upscale')).toBe('视频超分');
    expect(kindLabel('manju_voice')).toBe('配音');
    expect(kindLabel('threed_material')).toBe('3D 材质');
    expect(kindLabel('threed_render')).toBe('3D 渲染');
    expect(kindLabel('threed_texture')).toBe('3D 纹理');
    expect(kindLabel('drama_grid_storyboard')).toBe('分镜');
    expect(kindLabel('drama_scene_layout')).toBe('场景布局');
    expect(kindLabel('drama_shot_video')).toBe('镜头视频');
    expect(kindLabel('drama_shot_video_i2v')).toBe('镜头视频');
    expect(kindLabel('drama_shot_video_v2')).toBe('镜头视频');
    expect(kindLabel('drama_shot_lipsync')).toBe('镜头对口型');
    expect(kindLabel('cad_front')).toBe('CAD');
    expect(kindLabel('drama_char_reference_hero')).toBe('角色参考');
  });
});

describe('collectArtifacts', () => {
  it('只留 done 且有产物的作业', () => {
    const jobs = [
      job({ id: 'a' }),
      job({ id: 'b', status: 'running' }),
      job({ id: 'c', status: 'done', results: [] }),
      job({ id: 'd', status: 'error' }),
    ];
    expect(collectArtifacts(jobs).map((j) => j.id)).toEqual(['a']);
  });

  it('undefined/空数组 → 空', () => {
    expect(collectArtifacts(undefined)).toEqual([]);
    expect(collectArtifacts([])).toEqual([]);
  });
});

describe('countByFilter', () => {
  it('分桶计数，未识别只进 all', () => {
    const artifacts = [
      job({ id: 'a', kind: 'txt2img' }),
      job({ id: 'b', kind: 'img2img' }),
      job({ id: 'c', kind: 'wan_t2v' }),
      job({ id: 'd', kind: 'unknown_kind' }),
    ];
    expect(countByFilter(artifacts)).toEqual({
      all: 4,
      image: 2,
      video: 1,
      audio: 0,
      '3d': 0,
    });
  });

  it('新 kind 计入对应桶，未知仍只进 all', () => {
    const artifacts = [
      job({ id: 'a', kind: 'qwen_edit' }),
      job({ id: 'b', kind: 'h3_multishot' }),
      job({ id: 'c', kind: 'manju_voice' }),
      job({ id: 'd', kind: 'threed_texture' }),
      job({ id: 'e', kind: 'cad_front' }),
      job({ id: 'f', kind: 'chromakey' }),
    ];
    expect(countByFilter(artifacts)).toEqual({
      all: 6,
      image: 1,
      video: 1,
      audio: 1,
      '3d': 2,
    });
  });
});

describe('columnCount / cardSizePx', () => {
  it('断点：phone 2 列 / 大屏 3 列 / 平板 4 列', () => {
    expect(columnCount(390)).toBe(2);
    expect(columnCount(431)).toBe(3);
    expect(columnCount(768)).toBe(4);
  });

  it('卡边长均分屏宽', () => {
    // (390 - 32 - 12) / 2 = 173
    expect(cardSizePx(390, 2)).toBe(173);
    // (768 - 32 - 36) / 4 = 175
    expect(cardSizePx(768, 4)).toBe(175);
  });
});

describe('isVideoPath', () => {
  it('视频扩展名', () => {
    expect(isVideoPath('a/b.mp4')).toBe(true);
    expect(isVideoPath('a/b.WEBM')).toBe(true);
    expect(isVideoPath('a/b.png')).toBe(false);
  });
});

describe('LIBRARY_PAGE_SIZE（MP15）', () => {
  it('页大小为 2/3/4 列公倍数，满页任意断点恰好整行填满', () => {
    expect(LIBRARY_PAGE_SIZE % 2).toBe(0);
    expect(LIBRARY_PAGE_SIZE % 3).toBe(0);
    expect(LIBRARY_PAGE_SIZE % 4).toBe(0);
  });

  it('落在后端 limit 契约 1-200 内', () => {
    expect(LIBRARY_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(LIBRARY_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});
