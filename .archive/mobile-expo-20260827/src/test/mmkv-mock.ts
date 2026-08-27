/**
 * jest 环境的 MMKV 内存替身
 * 原因：react-native-mmkv 是 Nitro 原生模块，jest 无原生运行时；
 * 仅实现项目用到的接口子集（见 src/lib/mmkv.ts 与 stores/）
 */

type Value = string | number | boolean;

export interface MockMMKV {
  set(key: string, value: Value): void;
  getString(key: string): string | undefined;
  getBoolean(key: string): boolean | undefined;
  getNumber(key: string): number | undefined;
  contains(key: string): boolean;
  remove(key: string): boolean;
  getAllKeys(): string[];
  clearAll(): void;
}

export function createMMKV(): MockMMKV {
  const map = new Map<string, Value>();
  return {
    set: (key, value) => void map.set(key, value),
    getString: (key) => {
      const v = map.get(key);
      return typeof v === 'string' ? v : undefined;
    },
    getBoolean: (key) => {
      const v = map.get(key);
      return typeof v === 'boolean' ? v : undefined;
    },
    getNumber: (key) => {
      const v = map.get(key);
      return typeof v === 'number' ? v : undefined;
    },
    contains: (key) => map.has(key),
    remove: (key) => map.delete(key),
    getAllKeys: () => [...map.keys()],
    clearAll: () => map.clear(),
  };
}
