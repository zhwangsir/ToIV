# ToIV 本地视频 Comfy 接口

## 创建

`POST /api/generate/txt2video`（相对 ToIV API baseUrl，默认 `http://127.0.0.1:8090`）。

## 轮询

`GET /api/jobs/lookup`（`prompt_id` 或 `job_id` 二选一）。

## Worker

出视频默认 Comfy **:8197**（由 ToIV WorkerPool + NAS 绑定模型可达性选机；禁试验口 :8195/:8205/:8261）。

<!-- BEEFTV_PLUGIN_MANIFEST_START -->
## Manifest 完整接口定义

以下 JSON 与插件包内实际 `manifest.json` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。`documentation` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

```json
{
  "apiVersion": "beeftv.plugin/v2",
  "id": "toiv-comfy-video",
  "name": "ToIV 本地视频 Comfy",
  "version": "0.2.0",
  "author": "ToIV",
  "description": "BeefTV 视频 → ToIV：Wan /api/generate/txt2video；LongCat /api/longcat/{t2v,i2v}；VACE /api/wan/vace → Workstation Comfy :8197；轮询 /api/jobs/lookup。",
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
        "id": "toiv-comfy-video",
        "label": "ToIV 本地视频 (Comfy :8197 Wan/LongCat/VACE)",
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
            "mapping": "engine 路由：local-wan|local-longcat|local-vace 或权重名含 longcat/vace",
            "description": "local-wan / 默认 → Wan T2V；local-longcat 或名含 longcat → LongCat t2v/i2v；local-vace 或名含 vace → Wan VACE。亦可 providerOptions.toiv-comfy-video.engine。"
          },
          {
            "name": "prompt",
            "type": "string",
            "required": true,
            "mapping": "positive",
            "description": "视频提示词。"
          },
          {
            "name": "images",
            "type": "media[]",
            "required": false,
            "mapping": "LongCat i2v / VACE：prepare → /api/upload(kind=wan_vace)",
            "description": "LongCat：0 张 t2v、≥1 张 i2v；VACE：≥1 张参考图（最多 4）。Wan T2V 忽略。"
          },
          {
            "name": "duration",
            "type": "integer",
            "required": false,
            "mapping": "length≈duration*fps",
            "description": "秒数，折合帧数（fps 默认 16）。"
          },
          {
            "name": "aspectRatio",
            "type": "string",
            "required": false,
            "mapping": "width/height",
            "description": "16:9 / 9:16 / 1:1 或 WxH。"
          },
          {
            "name": "providerOptions",
            "type": "object",
            "required": false,
            "mapping": "providerOptions.toiv-comfy-video.*",
            "description": "engine/negative/seed/length/fps/accel/width/height/steps/duration_sec/cfg/shift。"
          }
        ],
        "create": {
          "method": "POST",
          "path": "/api/generate/txt2video",
          "originPath": true,
          "contentType": "application/json",
          "pathTemplate": {
            "$switch": {
              "cases": [
                {
                  "when": {
                    "$eq": [
                      {
                        "$ref": "prepared.route"
                      },
                      "longcat/i2v"
                    ]
                  },
                  "then": "/api/longcat/i2v"
                },
                {
                  "when": {
                    "$eq": [
                      {
                        "$ref": "prepared.route"
                      },
                      "longcat/t2v"
                    ]
                  },
                  "then": "/api/longcat/t2v"
                },
                {
                  "when": {
                    "$eq": [
                      {
                        "$ref": "prepared.route"
                      },
                      "vace"
                    ]
                  },
                  "then": "/api/wan/vace"
                }
              ],
              "default": "/api/generate/txt2video"
            }
          },
          "body": {
            "$merge": [
              {
                "positive": {
                  "$ref": "request.prompt"
                },
                "negative": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-video.negative"
                    },
                    ""
                  ]
                },
                "width": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-video.width"
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
                                "then": 480
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
                                "then": 832
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
                                "then": 480
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
                                "then": 640
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
                                "then": 480
                              }
                            ],
                            "default": 832
                          }
                        }
                      }
                    }
                  ]
                },
                "height": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-video.height"
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
                                "then": 480
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
                                "then": 480
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
                                "then": 832
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
                                "then": 480
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
                                "then": 640
                              }
                            ],
                            "default": 480
                          }
                        }
                      }
                    }
                  ]
                },
                "fps": {
                  "$coalesce": [
                    {
                      "$ref": "request.providerOptions.toiv-comfy-video.fps"
                    },
                    16
                  ]
                },
                "seed": {
                  "$ref": "request.providerOptions.toiv-comfy-video.seed"
                }
              },
              {
                "$switch": {
                  "cases": [
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "prepared.route"
                          },
                          "longcat/i2v"
                        ]
                      },
                      "then": {
                        "duration_sec": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.duration_sec"
                            },
                            {
                              "$ref": "request.duration"
                            }
                          ]
                        },
                        "steps": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.steps"
                            },
                            {
                              "$if": {
                                "condition": {
                                  "$eq": [
                                    {
                                      "$ref": "prepared.engine"
                                    },
                                    "longcat"
                                  ]
                                },
                                "then": 10,
                                "else": 20
                              }
                            }
                          ]
                        },
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
                            "$ref": "prepared.route"
                          },
                          "longcat/t2v"
                        ]
                      },
                      "then": {
                        "duration_sec": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.duration_sec"
                            },
                            {
                              "$ref": "request.duration"
                            }
                          ]
                        },
                        "steps": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.steps"
                            },
                            {
                              "$if": {
                                "condition": {
                                  "$eq": [
                                    {
                                      "$ref": "prepared.engine"
                                    },
                                    "longcat"
                                  ]
                                },
                                "then": 10,
                                "else": 20
                              }
                            }
                          ]
                        }
                      }
                    },
                    {
                      "when": {
                        "$eq": [
                          {
                            "$ref": "prepared.route"
                          },
                          "vace"
                        ]
                      },
                      "then": {
                        "duration_sec": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.duration_sec"
                            },
                            {
                              "$ref": "request.duration"
                            }
                          ]
                        },
                        "steps": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.steps"
                            },
                            {
                              "$if": {
                                "condition": {
                                  "$eq": [
                                    {
                                      "$ref": "prepared.engine"
                                    },
                                    "longcat"
                                  ]
                                },
                                "then": 10,
                                "else": 20
                              }
                            }
                          ]
                        },
                        "cfg": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.cfg"
                            },
                            5
                          ]
                        },
                        "shift": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.shift"
                            },
                            8
                          ]
                        },
                        "accel": {
                          "$coalesce": [
                            {
                              "$ref": "request.providerOptions.toiv-comfy-video.accel"
                            },
                            "off"
                          ]
                        },
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
                                  "$coalesce": [
                                    {
                                      "$ref": "prepared.refs"
                                    },
                                    []
                                  ]
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
                  "default": {
                    "length": {
                      "$coalesce": [
                        {
                          "$ref": "request.providerOptions.toiv-comfy-video.length"
                        },
                        {
                          "$switch": {
                            "cases": [
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    2
                                  ]
                                },
                                "then": 33
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    3
                                  ]
                                },
                                "then": 49
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    4
                                  ]
                                },
                                "then": 65
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    5
                                  ]
                                },
                                "then": 81
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    6
                                  ]
                                },
                                "then": 97
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    7
                                  ]
                                },
                                "then": 113
                              },
                              {
                                "when": {
                                  "$eq": [
                                    {
                                      "$ref": "request.duration"
                                    },
                                    8
                                  ]
                                },
                                "then": 121
                              }
                            ],
                            "default": 49
                          }
                        }
                      ]
                    },
                    "accel": {
                      "$ref": "request.providerOptions.toiv-comfy-video.accel"
                    }
                  }
                }
              },
              {
                "$coalesce": [
                  {
                    "$ref": "request.providerOptions.toiv-comfy-video.body"
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
                "$ref": "response.results"
              },
              "else": null
            }
          },
          "resultEphemeral": true
        },
        "prepare": [
          {
            "id": "engine",
            "value": {
              "$if": {
                "condition": {
                  "$or": [
                    {
                      "$in": [
                        {
                          "$ref": "request.model"
                        },
                        [
                          "local-longcat",
                          "longcat"
                        ]
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$lower": {
                            "$coalesce": [
                              {
                                "$ref": "request.providerOptions.toiv-comfy-video.engine"
                              },
                              ""
                            ]
                          }
                        },
                        "longcat"
                      ]
                    },
                    {
                      "$contains": [
                        {
                          "$lower": {
                            "$coalesce": [
                              {
                                "$ref": "request.model"
                              },
                              ""
                            ]
                          }
                        },
                        "longcat"
                      ]
                    }
                  ]
                },
                "then": "longcat",
                "else": {
                  "$if": {
                    "condition": {
                      "$or": [
                        {
                          "$in": [
                            {
                              "$ref": "request.model"
                            },
                            [
                              "local-vace",
                              "vace"
                            ]
                          ]
                        },
                        {
                          "$eq": [
                            {
                              "$lower": {
                                "$coalesce": [
                                  {
                                    "$ref": "request.providerOptions.toiv-comfy-video.engine"
                                  },
                                  ""
                                ]
                              }
                            },
                            "vace"
                          ]
                        },
                        {
                          "$contains": [
                            {
                              "$lower": {
                                "$coalesce": [
                                  {
                                    "$ref": "request.model"
                                  },
                                  ""
                                ]
                              }
                            },
                            "vace"
                          ]
                        }
                      ]
                    },
                    "then": "vace",
                    "else": "wan"
                  }
                }
              }
            }
          },
          {
            "id": "mode",
            "value": {
              "$if": {
                "condition": {
                  "$eq": [
                    {
                      "$ref": "prepared.engine"
                    },
                    "vace"
                  ]
                },
                "then": "vace",
                "else": {
                  "$if": {
                    "condition": {
                      "$eq": [
                        {
                          "$ref": "prepared.engine"
                        },
                        "longcat"
                      ]
                    },
                    "then": {
                      "$if": {
                        "condition": {
                          "$gt": [
                            {
                              "$len": {
                                "$ref": "request.images"
                              }
                            },
                            0
                          ]
                        },
                        "then": "i2v",
                        "else": "t2v"
                      }
                    },
                    "else": "t2v"
                  }
                }
              }
            }
          },
          {
            "id": "route",
            "value": {
              "$switch": {
                "cases": [
                  {
                    "when": {
                      "$and": [
                        {
                          "$eq": [
                            {
                              "$ref": "prepared.engine"
                            },
                            "longcat"
                          ]
                        },
                        {
                          "$eq": [
                            {
                              "$ref": "prepared.mode"
                            },
                            "i2v"
                          ]
                        }
                      ]
                    },
                    "then": "longcat/i2v"
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "prepared.engine"
                        },
                        "longcat"
                      ]
                    },
                    "then": "longcat/t2v"
                  },
                  {
                    "when": {
                      "$eq": [
                        {
                          "$ref": "prepared.engine"
                        },
                        "vace"
                      ]
                    },
                    "then": "vace"
                  }
                ],
                "default": "wan"
              }
            }
          },
          {
            "id": "first_image",
            "when": {
              "$or": [
                {
                  "$eq": [
                    {
                      "$ref": "prepared.route"
                    },
                    "longcat/i2v"
                  ]
                },
                {
                  "$eq": [
                    {
                      "$ref": "prepared.route"
                    },
                    "vace"
                  ]
                }
              ]
            },
            "value": {
              "$coalesce": [
                {
                  "$first": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "first_frame"
                          ]
                        ]
                      }
                    }
                  }
                },
                {
                  "$first": {
                    "$filter": {
                      "from": {
                        "$sortByOrder": {
                          "$ref": "request.images"
                        }
                      },
                      "as": "media",
                      "where": {
                        "$in": [
                          {
                            "$ref": "media.role"
                          },
                          [
                            "reference_image",
                            "edit_source",
                            ""
                          ]
                        ]
                      }
                    }
                  }
                },
                {
                  "$first": {
                    "$sortByOrder": {
                      "$ref": "request.images"
                    }
                  }
                }
              ]
            }
          },
          {
            "id": "ref_images",
            "when": {
              "$eq": [
                {
                  "$ref": "prepared.route"
                },
                "vace"
              ]
            },
            "value": {
              "$filter": {
                "from": {
                  "$sortByOrder": {
                    "$ref": "request.images"
                  }
                },
                "as": "media",
                "where": {
                  "$ne": [
                    {
                      "$ref": "media"
                    },
                    {
                      "$ref": "prepared.first_image"
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "first",
            "when": {
              "$and": [
                {
                  "$ne": [
                    {
                      "$ref": "prepared.first_image"
                    },
                    null
                  ]
                },
                {
                  "$or": [
                    {
                      "$eq": [
                        {
                          "$ref": "prepared.route"
                        },
                        "longcat/i2v"
                      ]
                    },
                    {
                      "$eq": [
                        {
                          "$ref": "prepared.route"
                        },
                        "vace"
                      ]
                    }
                  ]
                }
              ]
            },
            "operation": {
              "method": "POST",
              "path": "/api/upload",
              "originPath": true,
              "contentType": "multipart/form-data",
              "query": {
                "kind": "wan_vace"
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
            "id": "refs",
            "when": {
              "$eq": [
                {
                  "$ref": "prepared.route"
                },
                "vace"
              ]
            },
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
                "kind": "wan_vace",
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
