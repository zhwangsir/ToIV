# ToIV 本地生图 Comfy 接口

## 创建

`POST /api/generate/txt2img`（相对 ToIV API baseUrl，默认 `http://127.0.0.1:8090`）。

## 轮询

`GET /api/jobs/lookup`（`prompt_id` 或 `job_id` 二选一）。

## Worker

出图默认 Comfy **:8196**（由 ToIV WorkerPool + NAS 绑定模型可达性选机；禁试验口 :8195/:8205/:8261）。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "toiv-comfy-image",
  "name": "ToIV 本地生图 Comfy",
  "version": "0.1.0",
  "author": "ToIV",
  "description": "BeefTV 生图 → ToIV POST /api/generate/txt2img → Workstation Comfy :8196（LB :8188）；轮询 /api/jobs/lookup。",
  "permissions": [
    "generation.run",
    "media.read"
  ],
  "configuration": {
    "fields": [
      {
        "name": "apiKey",
        "type": "secret",
        "label": "ToIV Token (JWT)",
        "required": true,
        "description": "ToIV 用户令牌：POST /api/auth/login 返回的 token。"
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "toiv-comfy-image",
        "label": "ToIV 本地生图 (Comfy :8196)",
        "capabilities": [
          "image"
        ],
        "scopes": [
          "admin.system-channel",
          "user.custom-channel",
          "canvas",
          "creation",
          "agent"
        ],
        "baseUrl": "http://127.0.0.1:8090",
        "requiresPublicMediaUrls": false,
        "auth": {
          "type": "bearer",
          "field": "apiKey"
        },
        "parameters": [
          {
            "name": "model",
            "type": "string",
            "required": true,
            "mapping": "ckpt_name",
            "description": "NAS 绑定后的 checkpoint/UNET 文件名；占位 local-checkpoint 时走服务端默认底模。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "positive",
            "description": "生图提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "暂未走 img2img（本刀 txt2img）",
            "description": "参考图：本版忽略，后续接 /api/generate/img2img。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "width/height",
            "description": "1:1 / 16:9 / 9:16 或 WxH。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "width/height",
            "description": "可选分辨率提示。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.toiv-comfy-image.*",
            "description": "ckpt_name/negative/steps/cfg/seed/width/height 等。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/generate/txt2img",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "positive": {
                  "$ref": "request.prompt"
                },
                "negative": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-image.negative"
                    },
                    ""
                  ]
                },
                "ckpt_name": {
                  "$if": {
                    "condition": {
                      "$in": [
                        {
                          "$ref": "request.model"
                        },
                        [
                          "local-checkpoint",
                          ""
                        ]
                      ]
                    },
                    "then": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.toiv-comfy-image.ckpt_name"
                        },
                        null
                      ]
                    },
                    "else": {
                      "$ref": "request.model"
                    }
                  }
                },
                "width": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-image.width"
                    },
                    {
                      "$if": {
                        "condition": {
                          "$gt": [
                            {
                              "$len": {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        ""
                                      ]
                                    }
                                  },
                                  "x"
                                ]
                              }
                            },
                            1
                          ]
                        },
                        "then": {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$ref": "request.aspectRatio"
                                    }
                                  },
                                  "x"
                                ]
                              },
                              0
                            ]
                          }
                        },
                        "else": {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "1:1"
                                  ]
                                },
                                "then": 1024
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "16:9"
                                  ]
                                },
                                "then": 1536
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "9:16"
                                  ]
                                },
                                "then": 1024
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "4:3"
                                  ]
                                },
                                "then": 1536
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "3:4"
                                  ]
                                },
                                "then": 1152
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "3:2"
                                  ]
                                },
                                "then": 1536
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2:3"
                                  ]
                                },
                                "then": 1024
                              }
                            ],
                            "default": 1024
                          }
                        }
                      }
                    }
                  ]
                },
                "height": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-image.height"
                    },
                    {
                      "$if": {
                        "condition": {
                          "$gt": [
                            {
                              "$len": {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$coalesce": [
                                        {
                                          "$ref": "request.aspectRatio"
                                        },
                                        ""
                                      ]
                                    }
                                  },
                                  "x"
                                ]
                              }
                            },
                            1
                          ]
                        },
                        "then": {
                          "$toInt": {
                            "$at": [
                              {
                                "$split": [
                                  {
                                    "$lower": {
                                      "$ref": "request.aspectRatio"
                                    }
                                  },
                                  "x"
                                ]
                              },
                              1
                            ]
                          }
                        },
                        "else": {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "1:1"
                                  ]
                                },
                                "then": 1024
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "16:9"
                                  ]
                                },
                                "then": 1024
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "9:16"
                                  ]
                                },
                                "then": 1536
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "4:3"
                                  ]
                                },
                                "then": 1152
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "3:4"
                                  ]
                                },
                                "then": 1536
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "3:2"
                                  ]
                                },
                                "then": 1024
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "2:3"
                                  ]
                                },
                                "then": 1536
                              }
                            ],
                            "default": 1024
                          }
                        }
                      }
                    }
                  ]
                },
                "steps": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-image.steps"
                    },
                    20
                  ]
                },
                "cfg": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-image.cfg"
                    },
                    7
                  ]
                },
                "seed": {
                  "$ref": "request.providerOptions.toiv-comfy-image.seed"
                },
                "engine": "comfyui"
              }
            ]
          }
        },
        "poll": {
          "method": "GET",
          "path": "/api/jobs/lookup",
          "originPath": true,
          "query": {
            "job_id": {
              "$if": {
                "condition": {
                  "$gt": [
                    {
                      "$len": {
                        "$split": [
                          {
                            "$ref": "taskId"
                          },
                          "~"
                        ]
                      }
                    },
                    1
                  ]
                },
                "then": {
                  "$at": [
                    {
                      "$split": [
                        {
                          "$ref": "taskId"
                        },
                        "~"
                      ]
                    },
                    0
                  ]
                },
                "else": {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$len": {
                            "$split": [
                              {
                                "$ref": "taskId"
                              },
                              "-"
                            ]
                          }
                        },
                        1
                      ]
                    },
                    "then": null,
                    "else": {
                      "$ref": "taskId"
                    }
                  }
                }
              }
            },
            "prompt_id": {
              "$if": {
                "condition": {
                  "$gt": [
                    {
                      "$len": {
                        "$split": [
                          {
                            "$ref": "taskId"
                          },
                          "~"
                        ]
                      }
                    },
                    1
                  ]
                },
                "then": null,
                "else": {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$len": {
                            "$split": [
                              {
                                "$ref": "taskId"
                              },
                              "-"
                            ]
                          }
                        },
                        1
                      ]
                    },
                    "then": {
                      "$ref": "taskId"
                    },
                    "else": null
                  }
                }
              }
            }
          },
          "fallback": {
            "method": "GET",
            "path": "/api/jobs/lookup",
            "originPath": true,
            "query": {
              "prompt_id": {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$len": {
                          "$split": [
                            {
                              "$ref": "taskId"
                            },
                            "~"
                          ]
                        }
                      },
                      1
                    ]
                  },
                  "then": {
                    "$at": [
                      {
                        "$split": [
                          {
                            "$ref": "taskId"
                          },
                          "~"
                        ]
                      },
                      1
                    ]
                  },
                  "else": {
                    "$ref": "taskId"
                  }
                }
              }
            }
          }
        },
        "cancel": {
          "method": "POST",
          "path": "/api/jobs/{{taskId}}/cancel",
          "pathTemplate": {
            "$concat": [
              "/api/jobs/",
              {
                "$at": [
                  {
                    "$split": [
                      {
                        "$ref": "taskId"
                      },
                      "~"
                    ]
                  },
                  0
                ]
              },
              "/cancel"
            ]
          },
          "originPath": true
        },
        "response": {
          "taskId": {
            "$if": {
              "condition": {
                "$and": [
                  {
                    "$gt": [
                      {
                        "$len": {
                          "$coalesce": [
                            {
                              "$ref": "response.job_id"
                            },
                            {
                              "$ref": "response.id"
                            },
                            ""
                          ]
                        }
                      },
                      0
                    ]
                  },
                  {
                    "$gt": [
                      {
                        "$len": {
                          "$coalesce": [
                            {
                              "$ref": "response.prompt_id"
                            },
                            ""
                          ]
                        }
                      },
                      0
                    ]
                  }
                ]
              },
              "then": {
                "$concat": [
                  {
                    "$coalesce": [
                      {
                        "$ref": "response.job_id"
                      },
                      {
                        "$ref": "response.id"
                      },
                      ""
                    ]
                  },
                  "~",
                  {
                    "$ref": "response.prompt_id"
                  }
                ]
              },
              "else": {
                "$coalesce": [
                  {
                    "$ref": "response.prompt_id"
                  },
                  {
                    "$ref": "taskId"
                  }
                ]
              }
            }
          },
          "status": {
            "$switch": {
              "cases": [
                {
                  "when": {
                    "$eq": [
                      {
                        "$ref": "response.status"
                      },
                      "error"
                    ]
                  },
                  "then": "failed"
                },
                {
                  "when": {
                    "$in": [
                      {
                        "$ref": "response.status"
                      },
                      [
                        "canceled",
                        "cancelled"
                      ]
                    ]
                  },
                  "then": "canceled"
                },
                {
                  "when": {
                    "$and": [
                      {
                        "$eq": [
                          {
                            "$ref": "response.status"
                          },
                          "done"
                        ]
                      },
                      {
                        "$ne": [
                          {
                            "$ref": "response.post_status"
                          },
                          "processing"
                        ]
                      }
                    ]
                  },
                  "then": "succeeded"
                },
                {
                  "when": {
                    "$eq": [
                      {
                        "$ref": "response.prompt_id"
                      },
                      null
                    ]
                  },
                  "then": "failed"
                }
              ],
              "default": "processing"
            }
          },
          "message": {
            "$coalesce": [
              {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$len": {
                          "$ref": "response.error"
                        }
                      },
                      0
                    ]
                  },
                  "then": {
                    "$concat": [
                      "ToIV 作业失败：",
                      {
                        "$ref": "response.error"
                      }
                    ]
                  },
                  "else": null
                }
              },
              {
                "$if": {
                  "condition": {
                    "$eq": [
                      {
                        "$ref": "response.post_status"
                      },
                      "processing"
                    ]
                  },
                  "then": "ToIV 正在精确裁切/后处理",
                  "else": null
                }
              },
              {
                "$if": {
                  "condition": {
                    "$gt": [
                      {
                        "$len": {
                          "$ref": "response.hold_reason"
                        }
                      },
                      0
                    ]
                  },
                  "then": {
                    "$concat": [
                      "ToIV 排队：",
                      {
                        "$ref": "response.hold_reason"
                      }
                    ]
                  },
                  "else": null
                }
              },
              {
                "$ref": "response.detail"
              }
            ]
          },
          "images": {
            "$if": {
              "condition": {
                "$and": [
                  {
                    "$eq": [
                      {
                        "$ref": "response.status"
                      },
                      "done"
                    ]
                  },
                  {
                    "$ne": [
                      {
                        "$ref": "response.post_status"
                      },
                      "processing"
                    ]
                  }
                ]
              },
              "then": {
                "$ref": "response.results"
              },
              "else": null
            }
          },
          "resultEphemeral": true
        }
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
