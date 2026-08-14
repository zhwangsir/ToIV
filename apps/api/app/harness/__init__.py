"""ToIV harness:插件化底层驱动内核(参照 deepseek-harness Cordis 思想)。

H1 范围:共享 ctx(服务注册 + 可逆效应)、类型化事件总线(emit/waterfall)、
插件协议与注册表、LLM 适配缝(ctx.llm)。对外 API 契约零变更。
"""
