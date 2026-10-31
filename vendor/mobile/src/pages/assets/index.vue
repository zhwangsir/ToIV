<script setup lang="ts">
/**
 * 参考资产库管理页（MP13）：kind 过滤 chips + 卡片网格 + 同页弹层新建/编辑 + 删除
 * - 列表一次拉全量，chips 本地过滤（filterAssetsByKind），下拉刷新重拉
 * - 缩略图走 assetImageUrl（token 由 mediaUrl 拼）；nsfw 资产 R18 徽标（对齐引擎芯片实现）
 * - 图片 1-4 张：uni.chooseImage + uploadImage，第 2 张起钉第 1 张 worker（同 ref-image-field 互钉）
 * - NSFW 开关仅 settings.nsfwIntent 为 true 时渲染（对齐创作页 R18 上下文模式）
 * - 编辑保存走 buildAssetPatch 差量（后端 PATCH 仅非 null 字段生效）
 * MP27 批量管理：多选模式（长按卡片/「选择」钮进入，编辑弹层打开时守卫拦截）
 * + 批量删除（二次确认 → runBatch 并发限速 ≤3 循环单删 → 部分失败保留勾选停留）
 * MP28 产物联动：?prefill= query 进页自动开新建弹层预填（详情页「存为资产」链路，选择态先退出）
 */
import { computed, ref, watch } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';

import {
  assetImageUrl,
  createAsset,
  deleteAsset,
  listAssets,
  updateAsset,
  uploadImage,
} from '@/api';
import Button from '@/components/ui/button.vue';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import Sheet from '@/components/ui/sheet.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import { useSettingsStore } from '@/stores/settings';
import type { AssetItem, AssetKind, UploadedRefImage } from '@/types/api';
import { assetPrefillToForm, parseAssetPrefill } from '@/utils/asset-prefill';
import {
  ASSET_DESCRIPTION_MAX,
  ASSET_IMAGES_MAX,
  ASSET_KINDS,
  ASSET_NAME_MAX,
  assetKindLabel,
  assetToDraft,
  buildAssetPatch,
  filterAssetsByKind,
  validateAssetDraft,
} from '@/utils/assets';
import {
  applyAssetBatchDelete,
  assetSelectIdle,
  enterAssetSelecting,
  exitAssetSelecting,
  longPressAssetCard,
  removeDeletedAssets,
  selectAllAssets,
  tapAssetCard,
  type AssetSelectState,
} from '@/utils/assets-batch';
import { runBatch } from '@/utils/library-batch';
import { validateRefImage } from '@/utils/build-request';

const { themeVars, palette } = useAppTheme();
const { requireAuth } = useAuthGuard();
const settings = useSettingsStore();

// ── 列表 ──
const assets = ref<AssetItem[]>([]);
const loading = ref(true);
const error = ref('');
const kindFilter = ref<AssetKind | 'all'>('all');

const filtered = computed(() => filterAssetsByKind(assets.value, kindFilter.value));

async function load() {
  error.value = '';
  try {
    assets.value = await listAssets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onShow(() => {
  if (!requireAuth()) return;
  void load();
});

onPullDownRefresh(async () => {
  exitSelecting();
  await load();
  uni.stopPullDownRefresh();
});

// ── 新建 / 编辑弹层 ──
const editorVisible = ref(false);
const editing = ref<AssetItem | null>(null);
const formName = ref('');
const formKind = ref<AssetKind>('character');
const formDesc = ref('');
const formNsfw = ref(false);
const formImages = ref<UploadedRefImage[]>([]);
const formError = ref('');
const saving = ref(false);
const uploading = ref(false);

function openCreate() {
  editing.value = null;
  formName.value = '';
  formKind.value = 'character';
  formDesc.value = '';
  formNsfw.value = false;
  formImages.value = [];
  formError.value = '';
  editorVisible.value = true;
}

/** 编辑回显：句柄原样保留（不重新上传），预览走资产图代理 */
function openEdit(asset: AssetItem) {
  editing.value = asset;
  const draft = assetToDraft(asset);
  formKind.value = draft.kind;
  formName.value = draft.name;
  formDesc.value = draft.description;
  formNsfw.value = draft.nsfw;
  formImages.value = draft.images.map((img, i) => ({
    ...img,
    previewUri: assetImageUrl(asset.id, i),
    name: img.filename,
  }));
  formError.value = '';
  editorVisible.value = true;
}

function chooseImage() {
  if (uploading.value || saving.value) return;
  if (formImages.value.length >= ASSET_IMAGES_MAX) return;
  formError.value = '';
  uni.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    success: (res) => {
      const filePath = res.tempFilePaths[0];
      // tempFiles 声明为单/数组联合类型，归一化后取 size（同 ref-image-field）
      const rawFiles = res.tempFiles as unknown;
      const files = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
      const size = (files[0] as { size?: number } | undefined)?.size;
      void uploadOne(filePath, size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
}

async function uploadOne(filePath: string, size?: number) {
  const invalid = validateRefImage(filePath, size);
  if (invalid) {
    formError.value = invalid;
    return;
  }
  uploading.value = true;
  try {
    // 第 2 张起钉第 1 张落点 worker，保证同一资产全部参考图同机
    const pin = formImages.value.length > 0 ? formImages.value[0].worker : undefined;
    const result = await uploadImage(filePath, 'img2img', pin);
    formImages.value = [
      ...formImages.value,
      {
        filename: result.filename,
        worker: result.worker,
        previewUri: filePath,
        name: filePath.split('/').pop() ?? 'ref',
      },
    ];
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '上传失败，请重试';
  } finally {
    uploading.value = false;
  }
}

function removeImage(index: number) {
  formError.value = '';
  formImages.value = formImages.value.filter((_, i) => i !== index);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onNsfwToggle(e: any) {
  formNsfw.value = !!e?.detail?.value;
}

async function saveAsset() {
  formError.value = validateAssetDraft({ name: formName.value, images: formImages.value });
  if (formError.value) return;
  if (uploading.value) return;

  const draft = {
    kind: formKind.value,
    name: formName.value,
    description: formDesc.value,
    nsfw: formNsfw.value,
    images: formImages.value.map(({ filename, worker }) => ({ filename, worker })),
  };

  saving.value = true;
  try {
    if (editing.value) {
      const patch = buildAssetPatch(editing.value, draft);
      if (Object.keys(patch).length > 0) {
        await updateAsset(editing.value.id, patch);
      }
      uni.showToast({ title: '已保存', icon: 'none' });
    } else {
      await createAsset({
        kind: draft.kind,
        name: draft.name.trim(),
        description: draft.description.trim(),
        images: draft.images,
        nsfw: draft.nsfw,
      });
      uni.showToast({ title: '已创建', icon: 'none' });
    }
    editorVisible.value = false;
    await load();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

// ── 删除 ──
function confirmDelete(asset: AssetItem) {
  uni.showModal({
    title: '删除资产',
    content: `删除「${asset.name}」后不可恢复（worker 上的图片文件保留）`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return;
      void (async () => {
        try {
          await deleteAsset(asset.id);
          assets.value = assets.value.filter((a) => a.id !== asset.id);
          uni.showToast({ title: '已删除', icon: 'none' });
        } catch (err) {
          uni.showToast({
            title: err instanceof Error ? err.message : '删除失败，请重试',
            icon: 'none',
          });
        }
      })();
    },
  });
}

// ── 多选与批量管理（MP27） ──
// 状态机迁移全部经 utils/assets-batch.ts 纯函数（vitest 直测）；选择集为当前过滤可见项语义，
// 切 kind 过滤/下拉刷新清空并退出（对齐 library 页 MP25 模式；本页无震动反馈，与作品库一致）

const selState = ref<AssetSelectState>(assetSelectIdle());
const selecting = computed(() => selState.value.selecting);
const selected = computed(() => selState.value.selected);
/** 批量执行中（防重复点；操作条转进度态） */
const acting = ref(false);
const progress = ref<{ done: number; total: number } | null>(null);

const hasSelection = computed(() => selected.value.size > 0);

/** 微信原生 longpress 触发后松开仍会合成 tap：守卫吞咽紧随的这一次 tap，防刚选中又被 toggle 掉 */
let longPressGuard = false;

function applySel(next: AssetSelectState | null) {
  if (next === null || next === selState.value) return;
  selState.value = next;
}

function enterSelecting() {
  applySel(
    enterAssetSelecting(selState.value, {
      editorOpen: editorVisible.value,
      acting: acting.value,
    }),
  );
}

function exitSelecting() {
  if (acting.value) return;
  applySel(exitAssetSelecting());
  progress.value = null;
}

/** 切 kind 过滤桶：清空选择并退出选择模式（选择集为当前可见项语义，跨桶残留不可见勾选会误删） */
watch(kindFilter, () => {
  exitSelecting();
});

function onCardLongPress(item: AssetItem) {
  const next = longPressAssetCard(
    selState.value,
    { editorOpen: editorVisible.value, acting: acting.value },
    item.id,
  );
  if (next === null) return;
  longPressGuard = true;
  setTimeout(() => {
    longPressGuard = false;
  }, 350);
  applySel(next);
}

function onCardTap(item: AssetItem) {
  if (longPressGuard) return;
  const next = tapAssetCard(selState.value, item.id);
  if (next !== null) {
    applySel(next);
    return;
  }
  openEdit(item);
}

/** 全选当前过滤可见项 */
function selectAllFiltered() {
  if (acting.value) return;
  selState.value = { selecting: true, selected: selectAllAssets(filtered.value) };
}

/** 批量删除：二次确认 → 并发限速 ≤3 循环单删 → 进度态 → 汇总 toast → 本地列表移除成功项 */
function confirmBatchDelete() {
  const targets = assets.value.filter((a) => selected.value.has(a.id));
  if (acting.value || targets.length === 0) return;
  uni.showModal({
    title: `删除 ${targets.length} 件资产？`,
    content: `删除 ${targets.length} 件资产后不可恢复（worker 上的图片文件保留）`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) void runBatchDelete(targets);
    },
  });
}

async function runBatchDelete(targets: AssetItem[]) {
  acting.value = true;
  progress.value = { done: 0, total: targets.length };
  const results = await runBatch(targets, (a) => deleteAsset(a.id), {
    onProgress: (done, total) => {
      progress.value = { done, total };
    },
  });
  const outcome = applyAssetBatchDelete(results);
  progress.value = null;
  acting.value = false;
  // 失败项保留勾选（含全败）停留选择模式待重试；全成退出；成功项从本地列表移除
  selState.value = { selecting: outcome.selecting, selected: outcome.selected };
  assets.value = removeDeletedAssets(assets.value, outcome.removedIds);
  uni.showToast({ title: outcome.toast, icon: 'none' });
}

// ── 产物存为资产（MP28）：?prefill= 进页自动开新建弹层并预填 ──
// 详情页已把产物字节上传 pool worker，prefill 携带 {images:[{filename,worker,preview}],name,nsfw}；
// 解析失败/畸形一律静默忽略（防御 parseAssetPrefill 返回 null）
onLoad((query) => {
  const prefill = parseAssetPrefill(typeof query?.prefill === 'string' ? query.prefill : null);
  if (!prefill) return;
  if (selState.value.selecting) exitSelecting(); // 与 MP27 多选态无冲突：先退出选择模式
  const form = assetPrefillToForm(prefill);
  editing.value = null;
  formName.value = form.name;
  formKind.value = 'character';
  formDesc.value = '';
  formNsfw.value = form.nsfw;
  formImages.value = form.images;
  formError.value = '';
  editorVisible.value = true;
});
</script>

<template>
  <view
    class="assets"
    :style="themeVars"
  >
    <!-- 顶行：kind 过滤 chips（本地过滤，一次拉全量）+ 多选入口（MP27） -->
    <view class="assets__topbar">
      <scroll-view
        scroll-x
        class="assets__filters"
        :show-scrollbar="false"
        enhanced
      >
        <view class="assets__filters-row">
          <view
            class="assets__chip"
            :class="{ 'assets__chip--active': kindFilter === 'all' }"
            hover-class="assets__chip--pressed"
            @tap="kindFilter = 'all'"
          >
            <text
              class="assets__chip-label"
              :class="{ 'assets__chip-label--active': kindFilter === 'all' }"
            >
              全部
            </text>
          </view>
          <view
            v-for="k in ASSET_KINDS"
            :key="k.key"
            class="assets__chip"
            :class="{ 'assets__chip--active': kindFilter === k.key }"
            hover-class="assets__chip--pressed"
            @tap="kindFilter = k.key"
          >
            <text
              class="assets__chip-label"
              :class="{ 'assets__chip-label--active': kindFilter === k.key }"
            >
              {{ k.label }}
            </text>
          </view>
        </view>
      </scroll-view>
      <view
        v-if="!selecting && filtered.length > 0"
        class="assets__select-toggle"
        hover-class="assets__select-toggle--pressed"
        data-action="enter-select"
        @tap="enterSelecting"
      >
        <text class="assets__select-toggle-text">
          选择
        </text>
      </view>
    </view>

    <!-- 首次加载 -->
    <view
      v-if="loading && assets.length === 0"
      class="assets__center"
    >
      <text class="assets__hint">
        加载中…
      </text>
    </view>

    <!-- 加载失败 -->
    <view
      v-else-if="error && assets.length === 0"
      class="assets__center"
    >
      <Empty
        icon="circle-alert"
        title="加载失败"
        :description="error"
      >
        <template #action>
          <view
            class="assets__cta"
            hover-class="assets__cta--pressed"
            @tap="load"
          >
            <text class="assets__cta-text">
              重新加载
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 空态（含分类过滤空态）+ 新建引导 -->
    <view
      v-else-if="filtered.length === 0"
      class="assets__center"
    >
      <Empty
        icon="folder"
        :title="kindFilter === 'all' ? '还没有参考资产' : '该分类暂无资产'"
        :description="
          kindFilter === 'all'
            ? '把常用角色/场景/道具/风格图存成资产卡，创作时一键引用，不用反复上传'
            : '换个分类看看，或新建一张资产卡'
        "
      >
        <template #action>
          <view
            class="assets__cta"
            hover-class="assets__cta--pressed"
            @tap="openCreate"
          >
            <text class="assets__cta-text">
              新建资产
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 卡片网格（选择态：点按 toggle 选中；编辑/删除小钮隐藏，多选圈接管左上） -->
    <view
      v-else
      class="assets__grid"
    >
      <view
        v-for="item in filtered"
        :key="item.id"
        class="assets__card"
        :class="{ 'assets__card--selected': selecting && selected.has(item.id) }"
        :data-asset-id="item.id"
        hover-class="assets__card--pressed"
        @tap="onCardTap(item)"
        @longpress="onCardLongPress(item)"
      >
        <image
          v-if="item.images.length > 0"
          class="assets__thumb"
          :src="assetImageUrl(item.id, 0)"
          mode="aspectFill"
          lazy-load
        />
        <view
          v-else
          class="assets__thumb assets__thumb--empty"
        >
          <Icon
            name="image"
            :size="64"
            color="var(--color-text-secondary)"
            :stroke-width="1.5"
          />
        </view>

        <text
          v-if="item.nsfw"
          class="assets__r18"
          :class="{ 'assets__r18--selecting': selecting }"
        >
          R18
        </text>

        <!-- 多选圈（MP27）：选择模式常驻左上；未选空心圈，已选 accent 实心 + check -->
        <view
          v-if="selecting"
          class="assets__card-selector"
          :class="{ 'assets__card-selector--selected': selected.has(item.id) }"
          :data-selected="selected.has(item.id) ? '1' : '0'"
        >
          <Icon
            v-if="selected.has(item.id)"
            name="check"
            :size="28"
            color="#FFFFFF"
          />
        </view>

        <view
          v-if="!selecting"
          class="assets__actions"
        >
          <view
            class="assets__action"
            hover-class="assets__action--pressed"
            @tap.stop="openEdit(item)"
          >
            <Icon
              name="pencil"
              :size="28"
              color="#FFFFFF"
            />
          </view>
          <view
            class="assets__action assets__delete"
            hover-class="assets__action--pressed"
            @tap.stop="confirmDelete(item)"
          >
            <Icon
              name="trash-2"
              :size="28"
              color="#FFFFFF"
            />
          </view>
        </view>

        <view class="assets__info">
          <text
            class="assets__name"
            number-of-lines="1"
          >
            {{ item.name }}
          </text>
          <view class="assets__meta">
            <text class="assets__kind">
              {{ assetKindLabel(item.kind) }}
            </text>
            <text class="assets__count">
              {{ item.images.length }} 张
            </text>
          </view>
        </view>
      </view>
    </view>

    <!-- 底部新建入口（fixed，对齐 tab-bar 悬浮模式）；选择态让位批量操作条 -->
    <view class="assets__footer-gap" />
    <view
      v-if="!selecting"
      class="assets__footer"
    >
      <Button
        label="新建资产"
        icon="plus"
        block
        @click="openCreate"
      />
    </view>

    <!-- 批量操作条（MP27）：fixed 底部与 assets__footer 同槽位（z-index 50 低于 ui-sheet 90，
         编辑弹层打开时遮罩盖住操作条不挡弹层）；执行中转进度态「删除中 x/N」防重复点 -->
    <view
      v-if="selecting"
      class="assets__batch-bar"
    >
      <text class="assets__batch-count">
        {{ progress ? `删除中 ${progress.done}/${progress.total}` : `已选 ${selected.size} 项` }}
      </text>
      <view class="assets__batch-actions">
        <view
          class="assets__batch-btn"
          :class="{ 'assets__batch-btn--disabled': acting }"
          hover-class="assets__batch-btn--pressed"
          data-action="select-all"
          @tap="selectAllFiltered"
        >
          <text class="assets__batch-btn-text">
            全选
          </text>
        </view>
        <view
          class="assets__batch-btn assets__batch-btn--danger"
          :class="{ 'assets__batch-btn--disabled': acting || !hasSelection }"
          hover-class="assets__batch-btn--pressed"
          data-action="batch-delete"
          @tap="confirmBatchDelete"
        >
          <text class="assets__batch-btn-text assets__batch-btn-text--danger">
            删除
          </text>
        </view>
        <view
          class="assets__batch-btn"
          :class="{ 'assets__batch-btn--disabled': acting }"
          hover-class="assets__batch-btn--pressed"
          data-action="exit-select"
          @tap="exitSelecting"
        >
          <text class="assets__batch-btn-text">
            取消
          </text>
        </view>
      </view>
    </view>

    <!-- 新建/编辑弹层 -->
    <Sheet
      :visible="editorVisible"
      :title="editing ? '编辑资产' : '新建资产'"
      @close="editorVisible = false"
    >
      <view class="asset-form">
        <text class="asset-form__label">
          名称
        </text>
        <input
          v-model="formName"
          class="asset-form__input asset-form__name-input"
          placeholder="如：主角三视图 / 雨夜霓虹街区"
          placeholder-class="asset-form__placeholder"
          :maxlength="ASSET_NAME_MAX"
        >

        <text class="asset-form__label">
          类别
        </text>
        <view class="asset-form__kinds">
          <view
            v-for="k in ASSET_KINDS"
            :key="k.key"
            class="asset-form__kind"
            :class="{ 'asset-form__kind--active': formKind === k.key }"
            hover-class="asset-form__kind--pressed"
            @tap="formKind = k.key"
          >
            <text
              class="asset-form__kind-label"
              :class="{ 'asset-form__kind-label--active': formKind === k.key }"
            >
              {{ k.label }}
            </text>
          </view>
        </view>

        <text class="asset-form__label">
          描述（可选）
        </text>
        <textarea
          v-model="formDesc"
          class="asset-form__textarea"
          placeholder="外观特征 / 画风关键词，创作引用时自己看得懂即可"
          placeholder-class="asset-form__placeholder"
          :maxlength="ASSET_DESCRIPTION_MAX"
        />

        <view class="asset-form__images-head">
          <text class="asset-form__label">
            参考图
          </text>
          <text class="asset-form__images-count">
            {{ formImages.length }}/{{ ASSET_IMAGES_MAX }}
          </text>
        </view>
        <view class="asset-form__images">
          <view
            v-for="(img, index) in formImages"
            :key="img.filename"
            class="asset-form__preview"
          >
            <image
              class="asset-form__preview-img"
              :src="img.previewUri"
              mode="aspectFill"
            />
            <view
              class="asset-form__remove"
              @tap="removeImage(index)"
            >
              <Icon
                name="x"
                :size="32"
                color="#FFFFFF"
              />
            </view>
          </view>
          <view
            v-if="formImages.length < ASSET_IMAGES_MAX"
            class="asset-form__picker"
            hover-class="asset-form__picker--pressed"
            @tap="chooseImage"
          >
            <Icon
              v-if="!uploading"
              name="image-plus"
              :size="48"
              color="var(--color-text-secondary)"
            />
            <Icon
              v-else
              name="loader-circle"
              :size="48"
              color="var(--color-accent)"
              class="asset-form__spin"
            />
            <text class="asset-form__picker-hint">
              {{ uploading ? '上传中…' : '添加图片' }}
            </text>
          </view>
        </view>

        <!-- NSFW 开关：仅 R18 意图上下文渲染（对齐创作页模式） -->
        <view
          v-if="settings.nsfwIntent"
          class="asset-form__nsfw"
        >
          <view class="asset-form__nsfw-main">
            <text class="asset-form__nsfw-label">
              NSFW 资产
            </text>
            <text class="asset-form__nsfw-sub">
              仅在 NSFW 意图开启时可见与引用
            </text>
          </view>
          <switch
            :checked="formNsfw"
            :color="palette.accent"
            @change="onNsfwToggle"
          />
        </view>

        <view
          v-if="formError"
          class="asset-form__error"
        >
          <Icon
            name="circle-alert"
            :size="28"
            color="var(--color-danger)"
          />
          <text class="asset-form__error-text">
            {{ formError }}
          </text>
        </view>
      </view>

      <template #footer>
        <Button
          :label="editing ? '保存' : '创建'"
          icon="check"
          :loading="saving"
          :disabled="uploading"
          block
          @click="saveAsset"
        />
      </template>
    </Sheet>
  </view>
</template>

<style scoped lang="scss">
.assets {
  min-height: 100vh;
  background: var(--color-bg);

  &__topbar {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  &__filters {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }

  &__select-toggle {
    flex-shrink: 0;
    margin-right: var(--space-4);
    margin-left: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: 999rpx;
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__select-toggle-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 600;
  }

  &__filters-row {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
  }

  &__chip {
    display: flex;
    flex-direction: row;
    align-items: center;
    min-height: 64rpx;
    padding: 0 var(--space-4);
    border-radius: 999rpx;
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--active {
      border-color: var(--color-accent);
      background: var(--color-accent-soft);
    }

    &--pressed {
      opacity: 0.85;
    }
  }

  &__chip-label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
      font-weight: 600;
    }
  }

  &__center {
    min-height: 60vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  &__hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__cta {
    padding: var(--space-3) var(--space-8);
    border-radius: var(--radius-md);
    background: var(--color-accent);

    &--pressed {
      opacity: 0.88;
    }
  }

  &__cta-text {
    font-size: var(--font-body);
    color: #ffffff;
    font-weight: 500;
  }

  &__grid {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 24rpx;
    padding: 0 var(--space-4);
  }

  &__card {
    position: relative;
    width: calc((100% - 24rpx) / 2);
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    transition: border-color 0.18s ease;

    &--pressed {
      opacity: 0.85;
    }

    &--selected {
      border-color: var(--color-accent);
    }
  }

  /* 多选圈（MP27）：选择态常驻左上；R18 徽标同侧时让位下移 */
  &__card-selector {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    width: 44rpx;
    height: 44rpx;
    border-radius: 999rpx;
    border: 2rpx solid var(--color-border);
    background: rgba(255, 255, 255, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;

    &--selected {
      border-color: var(--color-accent);
      background: var(--color-accent);
    }
  }

  &__thumb {
    width: 100%;
    height: 320rpx;
    display: block;

    &--empty {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  &__r18 {
    position: absolute;
    left: var(--space-2);
    top: var(--space-2);
    font-size: 18rpx;
    font-weight: 600;
    line-height: 1.4;
    color: var(--color-danger);
    border: 1rpx solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 2rpx 10rpx;
    background: var(--color-surface);

    /* 选择态让位左上角多选圈（44rpx 圈 + 间距） */
    &--selecting {
      top: calc(var(--space-2) + 56rpx);
    }
  }

  &__actions {
    position: absolute;
    right: var(--space-2);
    top: var(--space-2);
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
  }

  &__action {
    width: 56rpx;
    height: 56rpx;
    border-radius: 28rpx;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.8;
    }
  }

  &__info {
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  &__name {
    font-size: var(--font-body);
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
  }

  &__meta {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__kind {
    font-size: var(--font-caption);
    color: var(--color-accent);
    border: 1rpx solid var(--color-accent);
    border-radius: var(--radius-sm);
    padding: 0 10rpx;
    line-height: 1.6;
  }

  &__count {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__footer-gap {
    height: calc(144rpx + env(safe-area-inset-bottom));
  }

  &__footer {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    /* 低于 ui-sheet（z-index:90）：弹层打开时遮罩须盖住底栏，否则底栏按钮拦截弹层点击 */
    z-index: 50;
    padding: var(--space-3) var(--space-6);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--color-surface);
    border-top: 1rpx solid var(--color-border);
  }

  /* 批量操作条（MP27）：与 footer 同槽位同层级（z-index 50 低于 ui-sheet 90，不挡弹层） */
  &__batch-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--color-surface);
    border-top: 1rpx solid var(--color-border);
  }

  &__batch-count {
    flex-shrink: 0;
    font-size: var(--font-caption);
    color: var(--color-text);
    font-weight: 600;
  }

  &__batch-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__batch-btn {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-bg);

    &--pressed {
      opacity: 0.85;
    }

    &--danger {
      border-color: var(--color-danger);
    }

    &--disabled {
      opacity: 0.45;
    }
  }

  &__batch-btn-text {
    font-size: var(--font-caption);
    color: var(--color-text);

    &--danger {
      color: var(--color-danger);
    }
  }
}

.asset-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  padding-bottom: var(--space-4);

  &__label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    font-weight: 500;
    margin-top: var(--space-2);
  }

  &__input {
    min-height: 88rpx;
    background: var(--color-bg);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 var(--space-3);
    font-size: var(--font-body);
    color: var(--color-text);
  }

  &__textarea {
    width: auto;
    min-height: 144rpx;
    background: var(--color-bg);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    font-size: var(--font-body);
    color: var(--color-text);
  }

  &__placeholder {
    color: var(--color-text-secondary);
  }

  &__kinds {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
  }

  &__kind {
    flex: 1;
    min-height: 72rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--active {
      border-color: var(--color-accent);
      background: var(--color-accent-soft);
    }

    &--pressed {
      opacity: 0.85;
    }
  }

  &__kind-label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
      font-weight: 600;
    }
  }

  &__images-head {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
  }

  &__images-count {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__images {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  &__preview {
    position: relative;
    width: 200rpx;
    height: 200rpx;
  }

  &__preview-img {
    width: 200rpx;
    height: 200rpx;
    border-radius: var(--radius-md);
  }

  &__remove {
    position: absolute;
    top: -16rpx;
    right: -16rpx;
    width: 56rpx;
    height: 56rpx;
    border-radius: 28rpx;
    background: var(--color-danger);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__picker {
    width: 200rpx;
    height: 200rpx;
    border: 2rpx dashed var(--color-border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);

    &--pressed {
      background: var(--color-accent-soft);
    }
  }

  &__picker-hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__spin {
    animation: asset-form-spin 1s linear infinite;
  }

  &__nsfw {
    margin-top: var(--space-2);
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    min-height: 96rpx;
    padding: var(--space-2) var(--space-3);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
  }

  &__nsfw-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2rpx;
  }

  &__nsfw-label {
    font-size: var(--font-body);
    color: var(--color-text);
  }

  &__nsfw-sub {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__error {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
  }

  &__error-text {
    font-size: var(--font-caption);
    color: var(--color-danger);
  }
}

@keyframes asset-form-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
