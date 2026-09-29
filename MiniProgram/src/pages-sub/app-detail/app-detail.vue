<script setup lang="ts">
/**
 * 应用详情运行器（U10b）：封面/元信息 + 参数表单 + POST /api/apps/{id}/run + 轮询出片
 * 手机端「左参右预」= 参数区在上、预览/结果在下
 */
import { computed, ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';

import { getMarketApp, listJobs, runApp, uploadImage } from '@/api';
import { mediaUrl } from '@/api/client';
import Button from '@/components/ui/button.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import {
  cancelPoll,
  createPollHandle,
  PollAbortedError,
  pollUntil,
  type PollHandle,
} from '@/composables/use-poll';
import type { AppParam, JobItem, MarketAppDetail, UploadedRefImage } from '@/types/api';
import {
  appUploadKind,
  buildRunValues,
  hasDualContentModes,
  isDeferredParam,
  isEditableParam,
  normalizeParamsSchema,
  requiredParamLabel,
  schemaInitialValues,
} from '@/utils/app-runner';
import { isTerminalStatus } from '@/utils/format';
import { isVideoPath } from '@/utils/library';
import { formatSmokeVerifiedAt } from '@/utils/market';

const { themeVars, palette } = useAppTheme();
const { requireAuth } = useAuthGuard();

const appId = ref('');
const app = ref<MarketAppDetail | null>(null);
const params = ref<AppParam[]>([]);
const values = ref<Record<string, unknown>>({});
const contentMode = ref<'sfw' | 'nsfw'>('sfw');
const loading = ref(true);
const error = ref('');
const running = ref(false);
const runStatus = ref('');
const runError = ref('');
const resultPaths = ref<string[]>([]);
const activeJobId = ref('');
const uploadingKey = ref('');

let pollHandle: PollHandle | undefined;

const cover = computed(() => {
  const u = (app.value?.cover_url || '').trim();
  return u ? mediaUrl(u) : '';
});

const smokeText = computed(() => {
  const a = app.value;
  if (!a) return '';
  if (a.smoke_status === 'pass') {
    const when = formatSmokeVerifiedAt(a.smoke_at);
    return when ? `实测可用 · ${when}` : '实测可用';
  }
  if (a.smoke_status === 'fail' || a.smoke_status === 'timeout') return '待修复';
  if (a.smoke_status === 'running') return '测中…';
  return '未测';
});

const dualMode = computed(() => hasDualContentModes(app.value?.content_modes));

const editableParams = computed(() => params.value.filter(isEditableParam));
const deferredParams = computed(() => params.value.filter(isDeferredParam));

const missingLabel = computed(() => requiredParamLabel(params.value, values.value));

const canSubmit = computed(
  () => !!app.value && !running.value && !loading.value && !missingLabel.value && !uploadingKey.value,
);

const resultUrls = computed(() => resultPaths.value.map((p) => mediaUrl(p)));

function setValue(key: string, value: unknown) {
  values.value = { ...values.value, [key]: value };
}

function displayValue(key: string): string {
  const v = values.value[key];
  return v === null || v === undefined ? '' : String(v);
}

function isSwitchOn(key: string): boolean {
  return values.value[key] === true;
}

function imageHandles(key: string): UploadedRefImage[] {
  const v = values.value[key];
  return Array.isArray(v) ? (v as UploadedRefImage[]) : [];
}

function onNumberInput(key: string, e: { detail: { value: string } }) {
  const raw = e.detail.value;
  setValue(key, raw === '' ? '' : Number(raw));
}

function pickSelect(param: AppParam) {
  const opts = param.options ?? [];
  if (!opts.length) return;
  uni.showActionSheet({
    itemList: opts.map((o) => o.label || o.value),
    success: (res) => {
      const opt = opts[res.tapIndex];
      if (opt) setValue(param.key, opt.value);
    },
  });
}

function selectLabel(param: AppParam): string {
  const cur = values.value[param.key];
  const hit = (param.options ?? []).find((o) => o.value === cur);
  return hit?.label || (cur != null && cur !== '' ? String(cur) : `请选择${param.label}`);
}

async function pickImage(param: AppParam) {
  if (uploadingKey.value || running.value) return;
  const max = typeof param.max === 'number' && param.max > 0 ? Math.min(param.max, 4) : 1;
  const current = imageHandles(param.key);
  if (current.length >= max) {
    uni.showToast({ title: `最多 ${max} 张`, icon: 'none' });
    return;
  }
  uni.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    success: (res) => {
      const filePath = res.tempFilePaths[0];
      if (!filePath) return;
      void uploadPicked(param, filePath);
    },
  });
}

async function uploadPicked(param: AppParam, filePath: string) {
  uploadingKey.value = param.key;
  runError.value = '';
  try {
    const kind = appUploadKind(appId.value);
    const current = imageHandles(param.key);
    const pin = current[0]?.worker;
    const result = await uploadImage(filePath, kind, pin);
    const handle: UploadedRefImage = {
      filename: result.filename,
      worker: result.worker,
      previewUri: filePath,
      name: filePath.split('/').pop() ?? 'ref',
    };
    setValue(param.key, [...current, handle]);
  } catch (e) {
    runError.value = e instanceof Error ? e.message : '上传失败';
  } finally {
    uploadingKey.value = '';
  }
}

function removeImage(param: AppParam, index: number) {
  const next = imageHandles(param.key).filter((_, i) => i !== index);
  setValue(param.key, next);
}

async function load(id: string) {
  if (!(await requireAuth())) return;
  loading.value = true;
  error.value = '';
  runError.value = '';
  resultPaths.value = [];
  runStatus.value = '';
  try {
    const detail = await getMarketApp(id);
    app.value = detail;
    const schema = normalizeParamsSchema(detail.params_schema);
    params.value = schema;
    values.value = schemaInitialValues(schema);
    if (hasDualContentModes(detail.content_modes)) {
      contentMode.value = 'sfw';
    } else if ((detail.content_modes || []).includes('nsfw') || detail.is_nsfw) {
      contentMode.value = 'nsfw';
    } else {
      contentMode.value = 'sfw';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function findJob(receiptJobId: string, promptId: string): Promise<JobItem | null> {
  const rows = await listJobs({ limit: 50 });
  return (
    rows.find((j) => j.id === receiptJobId) ||
    rows.find((j) => j.prompt_id === promptId) ||
    null
  );
}

async function submitRun() {
  if (!app.value || !canSubmit.value) {
    if (missingLabel.value) {
      uni.showToast({ title: `请填写「${missingLabel.value}」`, icon: 'none' });
    }
    return;
  }
  cancelPoll(pollHandle);
  pollHandle = createPollHandle();
  running.value = true;
  runError.value = '';
  resultPaths.value = [];
  runStatus.value = '提交中…';
  activeJobId.value = '';
  try {
    const payload = buildRunValues(params.value, values.value);
    const opts =
      dualMode.value || contentMode.value === 'nsfw'
        ? { content_mode: contentMode.value }
        : undefined;
    const receipt = await runApp(app.value.id, payload, opts);
    activeJobId.value = receipt.job_id || receipt.prompt_id;
    runStatus.value = '排队中…';

    const job = await pollUntil<JobItem | null>({
      handle: pollHandle,
      intervals: [1500, 2000, 3000, 5000],
      maxConsecutiveErrors: 8,
      fetcher: () => findJob(receipt.job_id, receipt.prompt_id),
      shouldStop: (j) => !!j && isTerminalStatus(j.status),
      onUpdate: (j) => {
        if (!j) {
          runStatus.value = '等待作业入列…';
          return;
        }
        if (j.status === 'queued') runStatus.value = '排队中…';
        else if (j.status === 'running') runStatus.value = '生成中…';
        else if (j.status === 'done') runStatus.value = '已完成';
        else if (j.status === 'error') runStatus.value = '失败';
        else if (j.status === 'canceled') runStatus.value = '已中止';
      },
    });

    if (!job) {
      runError.value = '未找到作业，请到作品库查看';
      return;
    }
    if (job.status === 'done') {
      resultPaths.value = job.results || [];
      runStatus.value = resultPaths.value.length ? '已完成' : '已完成（无产物路径）';
    } else if (job.status === 'error') {
      runError.value = '生成失败，请重试或换参数';
    } else if (job.status === 'canceled') {
      runError.value = '作业已中止';
    }
  } catch (e) {
    if (e instanceof PollAbortedError) {
      runStatus.value = '已取消轮询';
      return;
    }
    runError.value = e instanceof Error ? e.message : '运行失败';
    runStatus.value = '';
  } finally {
    running.value = false;
  }
}

function previewResult(index: number) {
  const sources = resultPaths.value.map((p) => ({
    url: mediaUrl(p),
    type: (isVideoPath(p) ? 'video' : 'image') as 'video' | 'image',
  }));
  if (!sources.length) return;
  uni.previewMedia({
    current: index,
    sources,
  });
}

onLoad((query) => {
  const id = typeof query?.id === 'string' ? decodeURIComponent(query.id) : '';
  appId.value = id;
  if (!id) {
    error.value = '缺少应用 id';
    loading.value = false;
    return;
  }
  void load(id);
});

onUnload(() => {
  cancelPoll(pollHandle);
});
</script>

<template>
  <view class="detail" :style="themeVars">
    <NavBar title="应用详情" show-back />
    <view v-if="loading" class="detail__state">加载中…</view>
    <view v-else-if="error" class="detail__state detail__state--err" @tap="load(appId)">{{ error }}</view>
    <scroll-view v-else-if="app" class="detail__scroll" scroll-y>
      <view class="detail__body">
        <image v-if="cover" class="detail__cover" :src="cover" mode="widthFix" />
        <view v-else class="detail__cover detail__cover--fallback">
          <text>{{ (app.icon || app.name || '?').slice(0, 1) }}</text>
        </view>
        <view class="detail__head">
          <text class="detail__name">{{ app.name }}</text>
          <text class="detail__author">{{ app.author || 'ToIV' }}</text>
          <view class="detail__tags">
            <text
              v-if="smokeText"
              class="detail__tag"
              :class="{ 'is-pass': app.smoke_status === 'pass' }"
            >{{ smokeText }}</text>
            <text class="detail__tag">{{ app.output_kind === 'video' ? '视频' : '图片' }}</text>
            <text
              v-for="m in app.content_modes || []"
              :key="m"
              class="detail__tag"
            >{{ m.toUpperCase() }}</text>
          </view>
        </view>
        <text class="detail__desc">{{ app.description || '暂无简介' }}</text>

        <!-- SFW / NSFW -->
        <view v-if="dualMode" class="detail__modes">
          <text class="detail__section-title">内容模式</text>
          <view class="detail__mode-row">
            <view
              class="detail__mode"
              :class="{ 'is-active': contentMode === 'sfw' }"
              @tap="contentMode = 'sfw'"
            >SFW</view>
            <view
              class="detail__mode"
              :class="{ 'is-active': contentMode === 'nsfw' }"
              @tap="contentMode = 'nsfw'"
            >NSFW</view>
          </view>
        </view>

        <!-- 参数区 -->
        <view class="detail__section">
          <text class="detail__section-title">参数</text>
          <view
            v-for="param in editableParams"
            :key="param.key"
            class="param"
          >
            <view class="param__head">
              <text class="param__label">{{ param.label }}</text>
              <text v-if="param.hint" class="param__hint">{{ param.hint }}</text>
            </view>

            <input
              v-if="param.type === 'text'"
              class="param__input"
              :value="displayValue(param.key)"
              :placeholder="`请输入${param.label}`"
              placeholder-class="param__placeholder"
              @input="(e: any) => setValue(param.key, e.detail.value)"
            >

            <textarea
              v-else-if="param.type === 'textarea'"
              class="param__textarea"
              :value="displayValue(param.key)"
              :placeholder="`请输入${param.label}`"
              placeholder-class="param__placeholder"
              auto-height
              @input="(e: any) => setValue(param.key, e.detail.value)"
            />

            <input
              v-else-if="param.type === 'number' || param.type === 'slider'"
              class="param__input"
              type="digit"
              :value="displayValue(param.key)"
              :placeholder="
                param.min !== undefined && param.max !== undefined
                  ? `${param.min} ~ ${param.max}`
                  : `请输入${param.label}`
              "
              placeholder-class="param__placeholder"
              @input="(e: any) => onNumberInput(param.key, e)"
            >

            <view
              v-else-if="param.type === 'select'"
              class="param__select"
              @tap="pickSelect(param)"
            >
              <text class="param__select-text">{{ selectLabel(param) }}</text>
              <Icon name="chevron-down" :size="28" color="var(--color-text-secondary)" />
            </view>

            <switch
              v-else-if="param.type === 'switch'"
              :checked="isSwitchOn(param.key)"
              :color="palette.accent"
              @change="(e: any) => setValue(param.key, e.detail.value)"
            />

            <view v-else-if="param.type === 'images'" class="param__images">
              <view
                v-for="(img, idx) in imageHandles(param.key)"
                :key="img.filename + idx"
                class="param__thumb"
              >
                <image class="param__thumb-img" :src="img.previewUri" mode="aspectFill" />
                <view class="param__thumb-x" @tap="removeImage(param, idx)">×</view>
              </view>
              <view
                v-if="imageHandles(param.key).length < (param.max && param.max > 0 ? Math.min(param.max, 4) : 1)"
                class="param__add"
                @tap="pickImage(param)"
              >
                <text v-if="uploadingKey === param.key">上传中…</text>
                <text v-else>+ 选图</text>
              </view>
            </view>
          </view>

          <view v-if="deferredParams.length" class="detail__deferred">
            <Icon name="info" :size="28" color="var(--color-text-secondary)" />
            <text>
              以下参数请在 Web 端填写：{{ deferredParams.map((p) => p.label).join('、') }}
            </text>
          </view>
        </view>

        <!-- 预览 / 结果 -->
        <view class="detail__section">
          <text class="detail__section-title">预览</text>
          <view v-if="runStatus" class="detail__progress">{{ runStatus }}</view>
          <view v-if="runError" class="detail__run-err">{{ runError }}</view>
          <view v-if="resultUrls.length" class="detail__results">
            <block v-for="(url, idx) in resultUrls" :key="url + idx">
              <video
                v-if="isVideoPath(resultPaths[idx] || '')"
                class="detail__result"
                :src="url"
                controls
                object-fit="contain"
              />
              <image
                v-else
                class="detail__result"
                :src="url"
                mode="widthFix"
                @tap="previewResult(idx)"
              />
            </block>
          </view>
          <view v-else class="detail__preview-empty">
            <text>填写参数后点「生成」，结果将显示在这里</text>
          </view>
        </view>

        <view class="detail__actions">
          <Button
            :label="running ? '生成中…' : '生成'"
            variant="primary"
            block
            :loading="running"
            :disabled="!canSubmit"
            @click="submitRun"
          />
          <text v-if="missingLabel && !running" class="detail__missing">
            请填写「{{ missingLabel }}」
          </text>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<style scoped lang="scss">
.detail {
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
}

.detail__scroll {
  height: calc(100vh - 88rpx);
}

.detail__state {
  padding: 80rpx 32rpx;
  text-align: center;
  color: var(--color-text-secondary);
}

.detail__state--err {
  color: var(--color-danger);
}

.detail__cover {
  width: 100%;
  display: block;
  background: var(--color-accent-soft);

  &--fallback {
    min-height: 360rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 80rpx;
    color: var(--color-text-secondary);
  }
}

.detail__body {
  padding: 28rpx 28rpx 120rpx;
  display: flex;
  flex-direction: column;
  gap: 24rpx;
}

.detail__head {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.detail__name {
  font-size: var(--font-heading);
  font-weight: 700;
}

.detail__author {
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
}

.detail__tags {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 10rpx;
  margin-top: 8rpx;
}

.detail__tag {
  padding: 6rpx 14rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);

  &.is-pass {
    color: #17181a;
    background: rgba(201, 242, 79, 0.92);
    border-color: transparent;
  }
}

.detail__desc {
  font-size: var(--font-body);
  line-height: 1.55;
  color: var(--color-text);
  white-space: pre-wrap;
}

.detail__section {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
  padding: 20rpx;
  border-radius: 16rpx;
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);
}

.detail__section-title {
  font-size: var(--font-caption);
  font-weight: 600;
  color: var(--color-text-secondary);
  letter-spacing: 0.04em;
}

.detail__modes {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.detail__mode-row {
  display: flex;
  flex-direction: row;
  gap: 12rpx;
}

.detail__mode {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  border-radius: 12rpx;
  border: 1rpx solid var(--color-border);
  background: var(--color-surface);
  font-size: var(--font-body);
  color: var(--color-text-secondary);

  &.is-active {
    color: var(--color-text);
    border-color: var(--color-text);
    font-weight: 600;
  }
}

.param {
  display: flex;
  flex-direction: column;
  gap: 10rpx;
}

.param__head {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}

.param__label {
  font-size: var(--font-body);
  font-weight: 500;
}

.param__hint {
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
}

.param__input,
.param__textarea,
.param__select {
  width: 100%;
  box-sizing: border-box;
  padding: 18rpx 20rpx;
  border-radius: 12rpx;
  border: 1rpx solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-body);
}

.param__textarea {
  min-height: 140rpx;
}

.param__placeholder {
  color: var(--color-text-secondary);
}

.param__select {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.param__select-text {
  flex: 1;
  color: var(--color-text);
}

.param__images {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 12rpx;
}

.param__thumb {
  position: relative;
  width: 140rpx;
  height: 140rpx;
  border-radius: 12rpx;
  overflow: hidden;
  border: 1rpx solid var(--color-border);
}

.param__thumb-img {
  width: 100%;
  height: 100%;
}

.param__thumb-x {
  position: absolute;
  top: 4rpx;
  right: 4rpx;
  width: 36rpx;
  height: 36rpx;
  border-radius: 999rpx;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 24rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.param__add {
  width: 140rpx;
  height: 140rpx;
  border-radius: 12rpx;
  border: 1rpx dashed var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: var(--font-caption);
  background: var(--color-bg);
}

.detail__deferred {
  display: flex;
  flex-direction: row;
  gap: 10rpx;
  align-items: flex-start;
  padding: 14rpx;
  border-radius: 12rpx;
  background: var(--color-bg);
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
  line-height: 1.45;
}

.detail__progress {
  font-size: var(--font-body);
  color: var(--color-text);
}

.detail__run-err {
  font-size: var(--font-caption);
  color: var(--color-danger);
}

.detail__results {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.detail__result {
  width: 100%;
  border-radius: 12rpx;
  background: var(--color-bg);
}

.detail__preview-empty {
  padding: 40rpx 16rpx;
  text-align: center;
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
}

.detail__actions {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
  padding-top: 8rpx;
}

.detail__missing {
  text-align: center;
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
}
</style>
