/// <reference types="vite/client" />

declare module '*.vue' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>
  export default component
}

/** uni-app 编译期常量（条件编译/平台分支用，见 utils/platform.ts） */
declare const process: {
  env: {
    UNI_PLATFORM?: string;
    NODE_ENV?: string;
  };
};
