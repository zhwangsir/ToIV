/** 测试入口预载:注册自定义解析钩子(用法:node --import ./tests/register.mjs --test tests/)。
 *  与 apps/web 同模式(2026-09-22 D7 平移)。 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
