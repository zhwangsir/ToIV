# ToIV H3 文生视频接口字段

## 协议身份

- 插件 ID：`toiv-h3`；Provider ID：`toiv-h3`；能力：`video`。
- 默认 Base URL：`http://127.0.0.1:8090`（渠道里填 ToIV API 地址）。
- 鉴权：`bearer`，令牌为用户自己的 ToIV JWT（`POST /api/auth/login`）。
- 创建：`POST /api/h3/t2v`。
- 查询：`GET /api/jobs/lookup?job_id=`；旧部署返回 4xx 时回退 `?prompt_id=`。
- 取消：`POST /api/jobs/{job_id}/cancel`。

## 任务键

- ToIV ≥ 472d69b 的提交响应带 `job_id`：任务键直接为 `<job_id>~<prompt_id>`，第一次轮询起就按 job_id 续跟，后端重启也能恢复。
- 旧部署只返回 `prompt_id`：任务键先是 `prompt_id`，第一次 lookup 响应带回 `id` 后升级为 `<id>~<prompt_id>`。

## 结果

`status=done` 且 `post_status` 不为 `processing` 时成功；产物为 ToIV 返回的 mp4，宿主下载后持久化。`error` 映射为失败消息，`hold_reason` 显示为排队原因。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "toiv-h3",
  "name": "ToIV H3 视频",
  "version": "0.3.0",
  "author": "ToIV",
  "description": "通过 ToIV 平台 API (/api/h3/*) 调用 H3 视频管线；凭据为 ToIV 用户 JWT (Bearer)，产物按用户隔离。 v0.3: 提交响应带 job_id 时（ToIV ≥472d69b）任务键直接为 <job_id>~<prompt_id>，从第一次轮询起按 job_id 续跟；旧部署没有 job_id 时回退 prompt_id（首个 lookup 响应补上 id）。",
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
        "description": "ToIV 用户令牌：POST /api/auth/login 返回的 token。每个用户使用自己的令牌，作业与产物按令牌所属用户隔离。"
      }
    ]
  },
  "contributes": {
    "providers": [
      {
        "id": "toiv-h3",
        "label": "ToIV H3 文生视频",
        "capabilities": [
          "video"
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
            "mapping": "(固定) h3-t2v",
            "description": "渠道模型 ID，填 h3-t2v。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "positive",
            "description": "视频提示词（≤4000 字）。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "duration_sec",
            "description": "时长秒数，缺省 5；>单段上限由 ToIV 自动分段续写并裁切（≤600）。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "width/height",
            "description": "16:9 / 9:16 / 1:1 / 4:3 / 3:4 或自定义 WxH（原样透传，ToIV 校验 32 对齐、256~1344、9:16~16:9，越界返回 422）。"
          },
          {
            "name": "resolution",
            "type": "string",
            "required": false,
            "mapping": "width/height",
            "description": "480p → 小尺寸（如 832x480）；其他 → ToIV 默认档（如 1344x768）。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.toiv-h3.{negative,seed,steps,speed_tier,acceleration,loras,width,height}",
            "description": "ToIV H3 扩展字段（直接透传同名字段）。"
          }
        ],
        "validations": [
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                0
              ]
            },
            "message": "ToIV H3 插件 v0.1 仅支持文生视频：图生/首尾帧/多参考需要先经 ToIV /api/upload 取得上传句柄，当前声明式插件无法两步提交，请移除参考图。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$ref": "request.videos"
                  }
                },
                0
              ]
            },
            "message": "ToIV H3 文生视频不接受参考视频。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/h3/t2v",
          "originPath": true,
          "contentType": "application/json",
          "body": {
            "$merge": [
              {
                "positive": {
                  "$ref": "request.prompt"
                },
                "width": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-h3.width"
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
                                    "16:9"
                                  ]
                                },
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 832,
                                    "else": 1344
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 480,
                                    "else": 768
                                  }
                                }
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "1:1"
                                  ]
                                },
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 512,
                                    "else": 1024
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 640,
                                    "else": 1024
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 480,
                                    "else": 768
                                  }
                                }
                              }
                            ],
                            "default": {
                              "$if": {
                                "condition": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.resolution"
                                          },
                                          ""
                                        ]
                                      }
                                    },
                                    [
                                      "480p",
                                      "360p",
                                      "540p",
                                      "sd"
                                    ]
                                  ]
                                },
                                "then": 832,
                                "else": 1344
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                },
                "height": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-h3.height"
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
                                    "16:9"
                                  ]
                                },
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 480,
                                    "else": 768
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 832,
                                    "else": 1344
                                  }
                                }
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.aspectRatio"
                                    },
                                    "1:1"
                                  ]
                                },
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 512,
                                    "else": 1024
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 480,
                                    "else": 768
                                  }
                                }
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
                                "then": {
                                  "$if": {
                                    "condition": {
                                      "$in": [
                                        {
                                          "$lower": {
                                            "$coalesce": [
                                              {
                                                "$ref": "request.resolution"
                                              },
                                              ""
                                            ]
                                          }
                                        },
                                        [
                                          "480p",
                                          "360p",
                                          "540p",
                                          "sd"
                                        ]
                                      ]
                                    },
                                    "then": 640,
                                    "else": 1024
                                  }
                                }
                              }
                            ],
                            "default": {
                              "$if": {
                                "condition": {
                                  "$in": [
                                    {
                                      "$lower": {
                                        "$coalesce": [
                                          {
                                            "$ref": "request.resolution"
                                          },
                                          ""
                                        ]
                                      }
                                    },
                                    [
                                      "480p",
                                      "360p",
                                      "540p",
                                      "sd"
                                    ]
                                  ]
                                },
                                "then": 480,
                                "else": 768
                              }
                            }
                          }
                        }
                      }
                    }
                  ]
                },
                "duration_sec": {
                  "$if": {
                    "condition": {
                      "$gt": [
                        {
                          "$ref": "request.duration"
                        },
                        0
                      ]
                    },
                    "then": {
                      "$ref": "request.duration"
                    },
                    "else": 5
                  }
                },
                "negative": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.negative"
                  }
                },
                "seed": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.seed"
                  }
                },
                "steps": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.steps"
                  }
                },
                "speed_tier": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.speed_tier"
                  }
                },
                "acceleration": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.acceleration"
                  }
                },
                "loras": {
                  "$omitEmpty": {
                    "$ref": "request.providerOptions.toiv-h3.loras"
                  }
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.toiv-h3.body"
                  },
                  {}
                ]
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
          "videos": {
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
                "$filter": {
                  "from": {
                    "$ref": "response.results"
                  },
                  "as": "item",
                  "where": {
                    "$or": [
                      {
                        "$gt": [
                          {
                            "$len": {
                              "$split": [
                                {
                                  "$lower": {
                                    "$ref": "item"
                                  }
                                },
                                ".mp4"
                              ]
                            }
                          },
                          1
                        ]
                      },
                      {
                        "$gt": [
                          {
                            "$len": {
                              "$split": [
                                {
                                  "$lower": {
                                    "$ref": "item"
                                  }
                                },
                                ".webm"
                              ]
                            }
                          },
                          1
                        ]
                      },
                      {
                        "$gt": [
                          {
                            "$len": {
                              "$split": [
                                {
                                  "$lower": {
                                    "$ref": "item"
                                  }
                                },
                                ".mov"
                              ]
                            }
                          },
                          1
                        ]
                      }
                    ]
                  }
                }
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
