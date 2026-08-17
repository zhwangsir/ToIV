<script setup lang="ts">
/**
 * LoRA 叠加字段（loras 类型参数，H3 引擎）：多选（≤3）+ 单项强度滑杆
 * 语义对齐 Web ParamField loras 分支：选中追加 {name, strength:0.6}，滑杆调强度
 * 强度区间/步进取注册表 param.min/max/step（后端 H3LoraInput 0.5-1.0，缺省 0.6）
 * options 为空 = H3 实例不可达/无 LoRA（注册表声明态兜底），显式提示不静默吞掉
 */
import { computed } from 'vue';

import Icon from '@/components/ui/icon.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import type { EngineParam, LoraValue } from '@/types/api';
import { LORA_DEFAULT_STRENGTH } from '@/utils/build-request';

/** 后端 h3_studio.py _MAX_LORAS 同一约束 */
const MAX_LORAS = 3;

const props = defineProps<{
  param: EngineParam;
  modelValue: unknown;
}>();

const emit = defineEmits<{
  change: [value: LoraValue[]];
}>();

const { palette } = useAppTheme();

const options = computed(() => props.param.options ?? []);
const selected = computed<LoraValue[]>(() =>
  Array.isArray(props.modelValue) ? (props.modelValue as LoraValue[]) : [],
);

const strengthMin = computed(() => props.param.min ?? 0.5);
const strengthMax = computed(() => props.param.max ?? 1.0);
const strengthStep = computed(() => props.param.step ?? 0.05);

function isOn(name: string): boolean {
  return selected.value.some((l) => l.name === name);
}

function strengthOf(name: string): number {
  return selected.value.find((l) => l.name === name)?.strength ?? LORA_DEFAULT_STRENGTH;
}

/** 已达上限且未选中的项禁止再选（后端 max_length=3 → 422 兜底） */
function isCapped(name: string): boolean {
  return !isOn(name) && selected.value.length >= MAX_LORAS;
}

function toggle(name: string) {
  if (isOn(name)) {
    emit(
      'change',
      selected.value.filter((l) => l.name !== name),
    );
    return;
  }
  if (selected.value.length >= MAX_LORAS) return;
  emit('change', [...selected.value, { name, strength: LORA_DEFAULT_STRENGTH }]);
}

function onStrength(name: string, e: { detail: { value: number } }) {
  const strength = Number(e.detail.value);
  if (!Number.isFinite(strength)) return;
  emit(
    'change',
    selected.value.map((l) => (l.name === name ? { ...l, strength } : l)),
  );
}
</script>

<template>
  <view class="loras-field">
    <text
      v-if="options.length === 0"
      class="loras-field__empty"
    >
      引擎实例上暂无可用 LoRA
    </text>

    <template v-else>
      <view
        v-for="opt in options"
        :key="opt.value"
        class="loras-field__item"
      >
        <view
          class="loras-field__row"
          :class="{
            'loras-field__row--active': isOn(opt.value),
            'loras-field__row--capped': isCapped(opt.value),
          }"
          hover-class="loras-field__row--pressed"
          @tap="toggle(opt.value)"
        >
          <view
            class="loras-field__check"
            :class="{ 'loras-field__check--active': isOn(opt.value) }"
          >
            <Icon
              v-if="isOn(opt.value)"
              name="check"
              :size="28"
              color="var(--color-accent)"
            />
          </view>
          <text
            class="loras-field__name"
            number-of-lines="1"
          >
            {{ opt.label }}
          </text>
          <text
            v-if="opt.nsfw"
            class="loras-field__nsfw"
          >
            R18
          </text>
        </view>

        <view
          v-if="isOn(opt.value)"
          class="loras-field__strength"
        >
          <slider
            class="loras-field__slider"
            :min="strengthMin"
            :max="strengthMax"
            :step="strengthStep"
            :value="strengthOf(opt.value)"
            :active-color="palette.accent"
            :block-size="20"
            @change="(e: any) => onStrength(opt.value, e)"
            @changing="(e: any) => onStrength(opt.value, e)"
          />
          <text class="loras-field__strength-val">
            {{ strengthOf(opt.value).toFixed(2) }}
          </text>
        </view>
      </view>

      <text class="loras-field__count">
        已选 {{ selected.length }}/{{ MAX_LORAS }}
      </text>
    </template>
  </view>
</template>

<style scoped lang="scss">
.loras-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__empty {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  &__row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    min-height: 64rpx;
    padding: 0 var(--space-3);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);

    &--active {
      border-color: var(--color-accent);
      background: var(--color-accent-soft);
    }

    &--capped {
      opacity: 0.5;
    }

    &--pressed {
      opacity: 0.8;
    }
  }

  &__check {
    width: 36rpx;
    height: 36rpx;
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;

    &--active {
      border-color: var(--color-accent);
    }
  }

  &__name {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-text);
    overflow: hidden;
  }

  &__nsfw {
    font-size: 20rpx;
    color: var(--color-danger);
    border: 1rpx solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-1);
  }

  &__strength {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-2);
  }

  &__slider {
    flex: 1;
    margin: 0;
  }

  &__strength-val {
    min-width: 72rpx;
    text-align: right;
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__count {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    opacity: 0.75;
  }
}
</style>
