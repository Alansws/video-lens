# Video Lens

`Video Lens` 是一个面向视频理解任务的本地 Web 应用。它提供统一的浏览器界面，用于提交单个视频或整文件夹批量任务，并在同一个工作台中展示处理进度、逐文件日志和结构化分析结果。

项目当前支持两条分析链路：

- `Ollama + qwen3-vl:8b`
  适合本地运行、隐私优先和离线可用场景。
- `Gemini Video API`
  适合直接将视频文件提交给云端视频理解接口的场景。

与“单独写脚本调用模型”不同，这个项目把视频选择、任务调度、状态追踪和结果查看整合成了一个可直接使用的工具界面。

## 界面预览

<img src="docs/assets/video-lens-ui.png" alt="Video Lens UI screenshot" width="100%" />

## 核心能力

- 单视频分析
- 整文件夹批量分析
- 实时任务状态与处理日志
- 队列视图与单条结果详情
- 本地 `Ollama` 路线
- 云端 `Gemini` 路线
- 中文结构化输出

## 适用场景

- 对单个视频做画面级分析与总结
- 批量处理一组本地视频文件
- 对比本地模型与云端视频接口的结果差异
- 将“视频理解能力”包装成可操作的产品原型或内部工具

## 工作方式

### Ollama 路线

`Video Lens` 会先读取视频元数据，再自动抽取关键帧，并把这些帧按时间顺序提交给本地视觉模型。用户看到的是“直接上传视频”，但关键帧提取这一步由应用在内部自动完成。

### Gemini 路线

应用会直接把视频文件上传到 Gemini Files API，等待服务端完成处理后，再调用视频理解接口返回结果。

## 运行要求

### 基础环境

- `Python 3.11+`
- `ffmpeg`
- `ffprobe`

检查命令：

```bash
python3 --version
ffmpeg -version
ffprobe -version
```

### Ollama 路线额外要求

- 已安装并启动 `Ollama`
- 已拉取 `qwen3-vl:8b`

检查服务：

```bash
ollama list
```

或者：

```bash
curl http://127.0.0.1:11434/api/tags
```

拉取模型：

```bash
ollama pull qwen3-vl:8b
```

### Gemini 路线额外要求

- 有可用的 Gemini API Key

默认模型名：

- `gemini-2.5-pro`

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Alansws/video-lens.git
cd video-lens
```

### 2. 启动应用

```bash
python3 app.py
```

启动成功后会输出：

```text
Video Lens running at http://127.0.0.1:8765
```

### 3. 打开浏览器

访问：

```text
http://127.0.0.1:8765
```

### 4. 提交任务

#### 单视频

1. 选择 `单视频精查`
2. 选择 `Ollama` 或 `Gemini`
3. 选择一个视频文件
4. 可选填写补充分析要求
5. 点击 `开始分析`

#### 文件夹批量

1. 选择 `文件夹批量`
2. 选择 `Ollama` 或 `Gemini`
3. 选择一个包含多个视频的目录
4. 可选填写补充分析要求
5. 点击 `开始批量分析`

批量模式下，系统会按顺序处理目录中的视频文件，并为每个文件保留独立结果。

## 配置项

应用支持通过环境变量调整默认行为：

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_HOST` | `127.0.0.1` | 服务监听地址 |
| `APP_PORT` | `8765` | 服务端口 |
| `OLLAMA_API_BASE` | `http://127.0.0.1:11434/api` | Ollama API 地址 |
| `OLLAMA_MODEL` | `qwen3-vl:8b` | 默认本地模型 |
| `DEFAULT_OLLAMA_FPS` | `1` | Ollama 路线默认抽帧 FPS |
| `DEFAULT_OLLAMA_MAX_FRAMES` | `24` | Ollama 路线默认最大帧数 |
| `DEFAULT_GEMINI_MODEL` | `gemini-2.5-pro` | 默认 Gemini 模型 |
| `MAX_UPLOAD_MB` | `512` | 单次上传大小上限 |

示例：

```bash
APP_PORT=9000 OLLAMA_MODEL=qwen3-vl:8b python3 app.py
```

## 提示词示例

```text
请按时间顺序总结视频内容，列出出现的人物、场景、动作，并指出你不确定的地方。
```

```text
请重点分析视频中的产品展示、人物动作和镜头变化。
```

```text
请判断视频是否存在明显的广告感、摆拍感或场景不一致问题。
```

## 常见问题

### 页面显示 Ollama 未就绪

先检查 `Ollama` 服务是否在运行：

```bash
ollama list
```

如果服务未启动，先启动 `Ollama` 应用或本地服务。

### 找不到 `qwen3-vl:8b`

执行：

```bash
ollama pull qwen3-vl:8b
```

### 找不到 `ffmpeg` / `ffprobe`

说明系统未安装视频处理工具，请先完成安装。

### 批量分析为什么比较慢

当前版本采用顺序处理。这样做的目标是优先保证稳定性、日志可追踪性和单视频结果可定位性，而不是追求最高并发吞吐。

### 为什么文件夹上传在某些浏览器中不可用

目录上传依赖浏览器实现，建议优先使用较新的 Chromium 系浏览器。

## 项目结构

```text
.
├── app.py
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── docs
│   ├── TECH_STACK.md
│   └── assets
│       └── video-lens-ui.png
└── static
    ├── app.js
    ├── index.html
    └── styles.css
```

## 文档

- 技术栈与设计说明：[docs/TECH_STACK.md](docs/TECH_STACK.md)
- 贡献说明：[CONTRIBUTING.md](CONTRIBUTING.md)

## 开发检查

最基础的本地检查方式：

```bash
python3 -m py_compile app.py
node --check static/app.js
```

如果修改了任务提交流程、provider 逻辑或批量处理逻辑，建议再手动验证一次：

- 单视频分析
- 文件夹批量分析
- 对应 provider 的真实返回结果

## 贡献

欢迎 issue 和 PR。提交前建议先阅读：

- [CONTRIBUTING.md](CONTRIBUTING.md)

## 许可证

本项目使用 [MIT License](LICENSE)。
