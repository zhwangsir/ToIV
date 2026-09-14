"""ToIV RH shims — RunningHub 平台内部节点的本地等价实现(2026-09-15)。

RH 导出图引用平台私有节点(无公开包),本地 fleet 永远缺节点。这里按语义
写最小等价实现,让这类应用可本地执行。当前覆盖:
- RHHiddenNodes: 图片透传(pwd 平台签名,忽略;可选多图,返回第一个)
"""

class _RHHiddenNodes:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image_1": ("IMAGE",)},
            "optional": {
                "image_2": ("IMAGE",),
                "image_3": ("IMAGE",),
                "image_4": ("IMAGE",),
                "pwd": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "passthrough"
    CATEGORY = "RH"

    def passthrough(self, image_1, image_2=None, image_3=None, image_4=None, pwd=""):
        return (image_1,)


NODE_CLASS_MAPPINGS = {
    "RHHiddenNodes": _RHHiddenNodes,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RHHiddenNodes": "RH Hidden Nodes (ToIV shim)",
}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
