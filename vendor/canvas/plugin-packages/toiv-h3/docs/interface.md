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
  "version": "0.4.0",
  "author": "ToIV",
  "description": "通过 ToIV 平台 API (/api/h3/*) 调用 H3 视频管线；凭据为 ToIV 用户 JWT (Bearer)，产物按用户隔离。 v0.4: 按输入自动选择 t2v / i2v（首帧）/ fl2v（首尾帧）/ r2v（多参考，Ref2VA），参考图先经 ToIV /api/upload 上传（宿主 prepare 步骤，同一 worker），再提交；任务键与续跑、取消同 v0.3（<job_id>~<prompt_id>）。",
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
        "label": "ToIV H3 视频",
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
            "mapping": "h3（自动）或 h3-t2v（兼容）",
            "description": "渠道模型 ID：h3 按输入自动选择 t2v/i2v/fl2v/r2v；h3-t2v 为旧配置，行为相同。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "positive",
            "description": "视频提示词（≤4000 字）。"
          },
          {
            "name": "images",
            "type": "array",
            "required": false,
            "mapping": "prepare → /api/upload(kind=h3_i2v) → image / last_frame / images[] + worker",
            "description": "0 张：文生；1 张或指定首帧：图生；首帧+尾帧（或 2 张未指定角色）：首尾帧；全模态参考或 ≥3 张：多参考 r2v（≤9）。"
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
              "$lte": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                9
              ]
            },
            "message": "ToIV H3 最多支持 9 张参考图。"
          },
          {
            "assert": {
              "$not": {
                "$and": [
                  {
                    "$gt": [
                      {
                        "$len": {
                          "$filter": {
                            "from": {
                              "$ref": "request.images"
                            },
                            "as": "im",
                            "where": {
                              "$eq": [
                                {
                                  "$ref": "im.role"
                                },
                                "last_frame"
                              ]
                            }
                          }
                        }
                      },
                      0
                    ]
                  },
                  {
                    "$eq": [
                      {
                        "$len": {
                          "$ref": "request.images"
                        }
                      },
                      1
                    ]
                  }
                ]
              }
            },
            "message": "ToIV H3 首尾帧需要同时指定首帧。"
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
            "message": "ToIV H3 暂不接受参考视频。"
          },
          {
            "assert": {
              "$eq": [
                {
                  "$len": {
                    "$ref": "request.audios"
                  }
                },
                0
              ]
            },
            "message": "ToIV H3 暂不接受参考音频。"
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
                "$switch": {
                  "cases": [
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "prepared.mode"
                          },
                          "i2v"
                        ]
                      },
                      "then": {
                        "image": {
                          "$ref": "prepared.first.filename"
                        },
                        "worker": {
                          "$ref": "prepared.first.worker"
                        }
                      }
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "prepared.mode"
                          },
                          "fl2v"
                        ]
                      },
                      "then": {
                        "image": {
                          "$ref": "prepared.first.filename"
                        },
                        "last_frame": {
                          "$ref": "prepared.last.filename"
                        },
                        "worker": {
                          "$ref": "prepared.first.worker"
                        }
                      }
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "prepared.mode"
                          },
                          "r2v"
                        ]
                      },
                      "then": {
                        "images": {
                          "$concatArrays": [
                            [
                              {
                                "$ref": "prepared.first.filename"
                              }
                            ],
                            {
                              "$map": {
                                "from": {
                                  "$ref": "prepared.refs"
                                },
                                "as": "u",
                                "in": {
                                  "$ref": "u.filename"
                                }
                              }
                            }
                          ]
                        },
                        "worker": {
                          "$ref": "prepared.first.worker"
                        }
                      }
                    }
                  ],
                  "default": {}
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
          },
          "pathTemplate": {
            "$concat": [
              "/api/h3/",
              {
                "$coalesce": [
                  {
                    "$ref": "prepared.mode"
                  },
                  "t2v"
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
        },
        "prepare": [
          {
            "id": "mode",
            "value": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$len": {
                        "$ref": "request.images"
                      }
                    },
                    0
                  ]
                },
                "then": "t2v",
                "else": {
                  "$if": {
                    "condition": {
                      "$eq": [
                        {
                          "$ref": "request.operation"
                        },
                        "reference_to_video"
                      ]
                    },
                    "then": "r2v",
                    "else": {
                      "$if": {
                        "condition": {
                          "$gt": [
                            {
                              "$len": {
                                "$filter": {
                                  "from": {
                                    "$ref": "request.images"
                                  },
                                  "as": "im",
                                  "where": {
                                    "$eq": [
                                      {
                                        "$ref": "im.role"
                                      },
                                      "last_frame"
                                    ]
                                  }
                                }
                              }
                            },
                            0
                          ]
                        },
                        "then": "fl2v",
                        "else": {
                          "$if": {
                            "condition": {
                              "$gt": [
                                {
                                  "$len": {
                                    "$filter": {
                                      "from": {
                                        "$ref": "request.images"
                                      },
                                      "as": "im",
                                      "where": {
                                        "$eq": [
                                          {
                                            "$ref": "im.role"
                                          },
                                          "first_frame"
                                        ]
                                      }
                                    }
                                  }
                                },
                                0
                              ]
                            },
                            "then": "i2v",
                            "else": {
                              "$switch": {
                                "cases": [
                                  {
                                    "when": {
                                      "$eq": [
                                        {
                                          "$len": {
                                            "$ref": "request.images"
                                          }
                                        },
                                        1
                                      ]
                                    },
                                    "then": "i2v"
                                  },
                                  {
                                    "when": {
                                      "$eq": [
                                        {
                                          "$len": {
                                            "$ref": "request.images"
                                          }
                                        },
                                        2
                                      ]
                                    },
                                    "then": "fl2v"
                                  }
                                ],
                                "default": "r2v"
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          {
            "id": "first_image",
            "when": {
              "$gt": [
                {
                  "$len": {
                    "$ref": "request.images"
                  }
                },
                0
              ]
            },
            "value": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$ref": "prepared.mode"
                    },
                    "r2v"
                  ]
                },
                "then": {
                  "$first": {
                    "$ref": "request.images"
                  }
                },
                "else": {
                  "$coalesce": [
                    {
                      "$first": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "im",
                          "where": {
                            "$eq": [
                              {
                                "$ref": "im.role"
                              },
                              "first_frame"
                            ]
                          }
                        }
                      }
                    },
                    {
                      "$first": {
                        "$filter": {
                          "from": {
                            "$ref": "request.images"
                          },
                          "as": "im",
                          "where": {
                            "$ne": [
                              {
                                "$ref": "im.role"
                              },
                              "last_frame"
                            ]
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "last_image",
            "when": {
              "$eq": [
                {
                  "$ref": "prepared.mode"
                },
                "fl2v"
              ]
            },
            "value": {
              "$coalesce": [
                {
                  "$first": {
                    "$filter": {
                      "from": {
                        "$ref": "request.images"
                      },
                      "as": "im",
                      "where": {
                        "$eq": [
                          {
                            "$ref": "im.role"
                          },
                          "last_frame"
                        ]
                      }
                    }
                  }
                },
                {
                  "$at": [
                    {
                      "$ref": "request.images"
                    },
                    1
                  ]
                }
              ]
            }
          },
          {
            "id": "ref_images",
            "when": {
              "$eq": [
                {
                  "$ref": "prepared.mode"
                },
                "r2v"
              ]
            },
            "value": {
              "$filter": {
                "from": {
                  "$ref": "request.images"
                },
                "as": "im",
                "where": {
                  "$gt": [
                    {
                      "$ref": "imIndex"
                    },
                    0
                  ]
                }
              }
            }
          },
          {
            "id": "first",
            "when": {
              "$ne": [
                {
                  "$ref": "prepared.first_image"
                },
                null
              ]
            },
            "operation": {
              "method": "POST",
              "path": "/api/upload",
              "originPath": true,
              "contentType": "multipart/form-data",
              "query": {
                "kind": "h3_i2v"
              },
              "files": [
                {
                  "name": "image",
                  "source": {
                    "$ref": "prepared.first_image"
                  },
                  "filename": "toiv-ref"
                }
              ]
            }
          },
          {
            "id": "last",
            "when": {
              "$ne": [
                {
                  "$ref": "prepared.last_image"
                },
                null
              ]
            },
            "operation": {
              "method": "POST",
              "path": "/api/upload",
              "originPath": true,
              "contentType": "multipart/form-data",
              "query": {
                "kind": "h3_i2v",
                "worker": {
                  "$ref": "prepared.first.worker"
                }
              },
              "files": [
                {
                  "name": "image",
                  "source": {
                    "$ref": "prepared.last_image"
                  },
                  "filename": "toiv-ref"
                }
              ]
            }
          },
          {
            "id": "refs",
            "forEach": {
              "$ref": "prepared.ref_images"
            },
            "as": "ref",
            "operation": {
              "method": "POST",
              "path": "/api/upload",
              "originPath": true,
              "contentType": "multipart/form-data",
              "query": {
                "kind": "h3_i2v",
                "worker": {
                  "$ref": "prepared.first.worker"
                }
              },
              "files": [
                {
                  "name": "image",
                  "source": {
                    "$ref": "ref"
                  },
                  "filename": "toiv-ref"
                }
              ]
            }
          }
        ]
      }
    ]
  },
  "documentation": "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>"
}
```
<!-- BEEFTV_PLUGIN_MANIFEST_END -->
