<script setup lang="ts">
/**
 * 作品详情页（MP5，pages-sub 子包）
 * - 数据：eventChannel 收 job 对象（主路径）；query.id + listJobs 兜底（分享/重进场景）
 * - 舞台：图像大图（点按预览）/ 视频内嵌播放 / 音频·3D 图标占位；多产物缩略条切换
 * - 版本链：同根 >1 版本横滑条带，点按切换（对齐 Mobile ArtifactDetail M7.3）
 * - 操作：复用提示词（draft 回填创作页）/ 重新生成（has_params，seed 策略）/ 下载（保存相册）/ 删除（二次确认）
 *       + 存为资产（MP28，仅 image 类产物渲染：下载→上传→prefill 跳资产页自动开新建弹层）
 */
import { computed, getCurrentInstance, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { deleteJob, fetchVersions, listJobs, rerunJob } from '@/api';
import { mediaUrl } from '@/api/client';
import Icon from '@/components/ui/icon.vue';
import Tag from '@/components/ui/tag.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useDraftStore } from '@/stores/draft';
import type { JobItem, SeedMode } from '@/types/api';
import { canSaveArtifactAsAsset, saveArtifactAsAsset } from '@/utils/asset-prefill';
import { formatRelative, jobStatusMeta } from '@/utils/format';
import { isVideoPath, kindLabel, kindToFilter } from '@/utils/library';

const { themeVars } = useAppTheme();
const draft = useDraftStore();

const job = ref<JobItem | null>(null);
const notFound = ref(false);
const index = ref(0);
const versions = ref<JobItem[]>([]);
const acting = ref(false);

const group = computed(() => (job.value ? kindToFilter(job.value.kind) : null));
const isVideo = computed(() => (job.value ? isVideoPath(job.value.results[index.value] ?? '') : false));
const isAudioOr3d = computed(() => group.value === 'audio' || group.value === '3d');
const currentUrl = computed(() => {
  const j = job.value;
  if (!j || j.results.length === 0) return '';
  const path = j.results[Math.min(index.value, j.results.length - 1)];
  return path ? mediaUrl(path) : '';
});
const statusMeta = computed(() => (job.value ? jobStatusMeta(job.value.status) : null));
/** MP28：仅 image 类产物显示「存为资产」入口（多产物按当前 index 各自独立可存） */
const canSaveAsset = computed(() => canSaveArtifactAsAsset(job.value, index.value));

function applyJob(next: JobItem) {
  job.value = next;
  index.value = 0;
  void loadVersions(next);
}

async function loadVersions(j: JobItem) {
  try {
    versions.value = await fetchVersions(j.root_id || j.id);
  } catch {
    versions.value = [];
  }
}

/** query.id 兜底：eventChannel 没收到时自己拉列表找 */
async function recoverById(id: string) {
  try {
    const jobs = await listJobs({ limit: 200 });
    const found = jobs.find((j) => j.id === id || j.prompt_id === id);
    if (found) applyJob(found);
    else notFound.value = true;
  } catch {
    notFound.value = true;
  }
}

onLoad((query) => {
  const id = typeof query?.id === 'string' ? query.id : '';
  const proxy = getCurrentInstance()?.proxy as unknown as {
    getOpenerEventChannel?: () => {
      once?: (channel: string, cb: (data: { job: JobItem }) => void) => void;
    };
  };
  const channel = proxy?.getOpenerEventChannel?.();
  let received = false;
  channel?.once?.('job', (data) => {
    if (data?.job) {
      received = true;
      applyJob(data.job);
    }
  });
  if (!received && id) void recoverById(id);
  else if (!received && !id) notFound.value = true;
});

// ── 操作 ──

/** 复用提示词：草稿回填创作页（一次性消费） */
function reuse() {
  const j = job.value;
  if (!j || !j.prompt.trim()) return;
  draft.fill({ prompt: j.prompt, fromJobId: j.id });
  uni.reLaunch({ url: '/pages/index/index' });
}

/** 重新生成：seed 策略三选（ActionSheet），指定种子走可输入 modal */
function rerun() {
  const j = job.value;
  if (!j || acting.value) return;
  uni.showActionSheet({
    itemList: ['保持种子微调', '换随机种子', '指定种子'],
    success: ({ tapIndex }) => {
      if (tapIndex === 0) void doRerun('keep');
      else if (tapIndex === 1) void doRerun('random');
      else if (tapIndex === 2) {
        uni.showModal({
          title: '指定种子',
          editable: true,
          placeholderText: `当前 seed ${j.seed}`,
          success: (res) => {
            if (!res.confirm) return;
            const seed = Number(res.content);
            if (!Number.isInteger(seed) || seed < 0) {
              uni.showToast({ title: '请输入非负整数种子', icon: 'none' });
              return;
            }
            void doRerun('explicit', seed);
          },
        });
      }
    },
  });
}

async function doRerun(mode: SeedMode, seed?: number) {
  const j = job.value;
  if (!j) return;
  acting.value = true;
  try {
    await rerunJob(j.id, { seed_mode: mode, ...(mode === 'explicit' ? { seed } : {}) });
    uni.showToast({ title: '已提交，前往作业查看', icon: 'none' });
    uni.reLaunch({ url: '/pages/jobs/jobs' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '重新生成失败',
      icon: 'none',
    });
  } finally {
    acting.value = false;
  }
}

/**
 * 下载到相册：downloadFile（需后台配 downloadFile 合法域名）→ save*ToPhotosAlbum
 * 视频走 saveVideoToPhotosAlbum，其余按图片保存
 */
function download() {
  const url = currentUrl.value;
  if (!url || acting.value) return;
  acting.value = true;
  uni.showLoading({ title: '下载中…', mask: true });
  uni.downloadFile({
    url,
    success: (dl) => {
      if (dl.statusCode !== 200) {
        uni.hideLoading();
        uni.showToast({ title: '下载失败，请重试', icon: 'none' });
        return;
      }
      const save = isVideo.value
        ? uni.saveVideoToPhotosAlbum
        : uni.saveImageToPhotosAlbum;
      save({
        filePath: dl.tempFilePath,
        success: () => {
          uni.hideLoading();
          uni.showToast({ title: '已保存到相册', icon: 'none' });
        },
        fail: () => {
          uni.hideLoading();
          uni.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
        },
      });
    },
    fail: () => {
      uni.hideLoading();
      uni.showToast({ title: '下载失败，请检查网络', icon: 'none' });
    },
    complete: () => {
      acting.value = false;
    },
  });
}

/**
 * 存为资产（MP28）：下载产物字节 → 上传 pool worker → 携 prefill 跳资产页自动开新建弹层
 * 失败 toast 停留原页；流程主体在 utils/asset-prefill.ts（vitest 直测）
 */
function saveAsAsset() {
  const j = job.value;
  if (!j || acting.value || !canSaveAsset.value) return;
  const path = j.results[Math.min(index.value, j.results.length - 1)];
  acting.value = true;
  void saveArtifactAsAsset({ path, prompt: j.prompt, nsfw: j.nsfw }).finally(() => {
    acting.value = false;
  });
}

/** 删除：二次确认 → 返回上一页（列表 onShow 自动刷新） */
function confirmDelete() {
  const j = job.value;
  if (!j || acting.value) return;
  uni.showModal({
    title: '删除这件作品？',
    content: '删除后不可恢复，产物文件将由系统另行清理',
    confirmText: '删除',
    cancelText: '取消',
    success: async (res) => {
      if (!res.confirm) return;
      acting.value = true;
      try {
        await deleteJob(j.id);
        uni.showToast({ title: '已删除', icon: 'none' });
        uni.navigateBack({ delta: 1 });
      } catch (err) {
        uni.showToast({
          title: err instanceof Error ? err.message : '删除失败',
          icon: 'none',
        });
      } finally {
        acting.value = false;
      }
    },
  });
}

function previewCurrent() {
  const j = job.value;
  if (!j || j.results.length === 0) return;
  uni.previewMedia({
    sources: j.results.map((r) => ({
      url: mediaUrl(r),
      type: (isVideoPath(r) ? 'video' : 'image') as 'video' | 'image',
    })),
    current: index.value,
  });
}
</script>

<template>
  <view
    class="artifact"
    :style="themeVars"
  >
    <!-- 数据缺失兜底 -->
    <view
      v-if="notFound"
      class="artifact__center"
    >
      <text class="artifact__hint">
        作品不存在或已被清理
      </text>
    </view>
    <view
      v-else-if="!job"
      class="artifact__center"
    >
      <text class="artifact__hint">
        加载中…
      </text>
    </view>

    <template v-else>
      <!-- 类型 + 状态徽章行 -->
      <view class="artifact__badges">
        <Tag
          tone="neutral"
          :label="kindLabel(job.kind)"
        />
        <Tag
          v-if="statusMeta"
          :tone="statusMeta.tone"
          :label="statusMeta.label"
        />
      </view>

      <!-- 舞台 -->
      <view class="artifact__stage">
        <view
          v-if="isAudioOr3d"
          class="artifact__media artifact__media--empty"
        >
          <Icon
            :name="group === 'audio' ? 'music' : 'box'"
            :size="96"
            color="var(--color-text-secondary)"
            :stroke-width="1.5"
          />
        </view>
        <video
          v-else-if="isVideo && currentUrl"
          class="artifact__media"
          :src="currentUrl"
          controls
          object-fit="contain"
        />
        <image
          v-else-if="currentUrl"
          class="artifact__media"
          :src="currentUrl"
          mode="aspectFit"
          @tap="previewCurrent"
        />
        <view
          v-else
          class="artifact__media artifact__media--empty"
        >
          <Icon
            name="image"
            :size="96"
            color="var(--color-text-secondary)"
            :stroke-width="1.5"
          />
        </view>
      </view>

      <!-- 多产物缩略条 -->
      <scroll-view
        v-if="job.results.length > 1"
        scroll-x
        class="artifact__thumbs"
        :show-scrollbar="false"
        enhanced
      >
        <view class="artifact__thumbs-row">
          <view
            v-for="(path, i) in job.results"
            :key="`${job.id}-${i}`"
            class="artifact__thumb"
            :class="{ 'artifact__thumb--active': i === index }"
            @tap="index = i"
          >
            <image
              v-if="!isVideoPath(path)"
              class="artifact__thumb-img"
              :src="mediaUrl(path)"
              mode="aspectFill"
            />
            <view
              v-else
              class="artifact__thumb-icon"
            >
              <Icon
                name="film"
                :size="32"
                color="var(--color-text-secondary)"
              />
            </view>
          </view>
        </view>
      </scroll-view>

      <!-- 版本链（同根 >1 版本显示） -->
      <scroll-view
        v-if="versions.length > 1"
        scroll-x
        class="artifact__versions"
        :show-scrollbar="false"
        enhanced
      >
        <view class="artifact__versions-row">
          <view
            v-for="(v, i) in versions"
            :key="v.id"
            class="artifact__version"
            @tap="v.id !== job!.id && applyJob(v)"
          >
            <view
              class="artifact__version-box"
              :class="{ 'artifact__version-box--active': v.id === job!.id }"
            >
              <image
                v-if="v.status === 'done' && v.results[0] && !isVideoPath(v.results[0])"
                class="artifact__thumb-img"
                :src="mediaUrl(v.results[0])"
                mode="aspectFill"
              />
              <view
                v-else
                class="artifact__thumb-icon"
              >
                <Icon
                  :name="v.status === 'error' ? 'circle-alert' : 'image'"
                  :size="32"
                  :color="v.status === 'error' ? 'var(--color-danger)' : 'var(--color-text-secondary)'"
                />
              </view>
            </view>
            <text
              class="artifact__version-label"
              :class="{ 'artifact__version-label--active': v.id === job!.id }"
            >
              v{{ i + 1 }}
            </text>
          </view>
        </view>
      </scroll-view>

      <!-- 参数区 -->
      <view class="artifact__meta">
        <text class="artifact__prompt">
          {{ job.prompt || '（无提示词）' }}
        </text>
        <text class="artifact__sub">
          seed {{ job.seed }} · {{ formatRelative(job.created_at) }}
          {{ job.results.length > 1 ? ` · 共 ${job.results.length} 张` : '' }}
        </text>
      </view>

      <!-- 操作行：复用（主）+ 重生 + 下载 + 删除 -->
      <view class="artifact__actions">
        <view
          class="artifact__reuse"
          hover-class="artifact__reuse--pressed"
          @tap="reuse"
        >
          <Icon
            name="wand-sparkles"
            :size="36"
            color="#FFFFFF"
          />
          <text class="artifact__reuse-text">
            复用提示词
          </text>
        </view>
        <view
          v-if="job.has_params"
          class="artifact__icon-btn"
          hover-class="artifact__icon-btn--pressed"
          @tap="rerun"
        >
          <Icon
            name="refresh-cw"
            :size="36"
            color="var(--color-text)"
          />
        </view>
        <view
          class="artifact__icon-btn"
          hover-class="artifact__icon-btn--pressed"
          @tap="download"
        >
          <Icon
            name="download"
            :size="36"
            color="var(--color-text)"
          />
        </view>
        <view
          v-if="canSaveAsset"
          class="artifact__icon-btn"
          hover-class="artifact__icon-btn--pressed"
          data-action="save-asset"
          @tap="saveAsAsset"
        >
          <Icon
            name="image-plus"
            :size="36"
            color="var(--color-text)"
          />
        </view>
        <view
          class="artifact__icon-btn artifact__icon-btn--danger"
          hover-class="artifact__icon-btn--pressed"
          @tap="confirmDelete"
        >
          <Icon
            name="trash-2"
            :size="36"
            color="var(--color-danger)"
          />
        </view>
      </view>
    </template>
  </view>
</template>

<style scoped lang="scss">
.artifact {
  min-height: 100vh;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;

  &__center {
    min-height: 70vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__badges {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) 0;
  }

  &__stage {
    flex: 1;
    min-height: 50vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__media {
    width: 100%;
    height: 100%;
    min-height: 50vh;

    &--empty {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  &__thumbs,
  &__versions {
    white-space: nowrap;
  }

  &__thumbs-row,
  &__versions-row {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
  }

  &__thumb {
    width: 96rpx;
    height: 96rpx;
    border-radius: var(--radius-sm);
    border: 2rpx solid var(--color-border);
    overflow: hidden;

    &--active {
      border-color: var(--color-accent);
    }
  }

  &__thumb-img {
    width: 100%;
    height: 100%;
  }

  &__thumb-icon {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface);
  }

  &__version {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4rpx;
  }

  &__version-box {
    width: 96rpx;
    height: 96rpx;
    border-radius: var(--radius-sm);
    border: 2rpx solid var(--color-border);
    overflow: hidden;

    &--active {
      border-color: var(--color-accent);
    }
  }

  &__version-label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
    }
  }

  &__meta {
    padding: var(--space-2) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  &__prompt {
    font-size: var(--font-body);
    color: var(--color-text);
    line-height: 1.5;
  }

  &__sub {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom));
  }

  &__reuse {
    flex: 1;
    height: 96rpx;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    &--pressed {
      opacity: 0.88;
    }
  }

  &__reuse-text {
    font-size: var(--font-body);
    color: #ffffff;
    font-weight: 600;
  }

  &__icon-btn {
    width: 96rpx;
    height: 96rpx;
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);
    display: flex;
    align-items: center;
    justify-content: center;

    &--danger {
      border-color: var(--color-danger);
    }

    &--pressed {
      opacity: 0.85;
    }
  }
}
</style>
