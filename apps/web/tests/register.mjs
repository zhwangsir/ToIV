/** 测试入口预载:注册自定义解析钩子(用法:node --import ./tests/register.mjs --test tests/)。 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
