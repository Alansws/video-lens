# Contributing

感谢你对 `Video Lens` 的兴趣。

这个项目目前刻意保持轻量，因此提交改动时请优先遵循“简单、直接、可读”的原则，而不是过早引入更重的框架或基础设施。

## 开发环境

建议准备：

- `Python 3.11+`
- `ffmpeg`
- `ffprobe`
- 可选：本地 `Ollama` 与 `qwen3-vl:8b`

## 本地启动

```bash
python3 app.py
```

默认地址：

```text
http://127.0.0.1:8765
```

## 提交前检查

至少执行以下检查：

```bash
python3 -m py_compile app.py
node --check static/app.js
```

如果你的改动影响了本地视频分析链路，建议再手动验证一次：

1. 单视频分析
2. 文件夹批量分析
3. `Ollama` 路线或你修改到的 provider 路线

## 代码风格

- 保持依赖最小化
- 后端优先使用 Python 标准库，除非新增依赖有明显收益
- 前端优先保持原生 `HTML / CSS / JavaScript`
- 不要为了“小问题”引入整套大型框架
- 新增文档时，优先写清楚“为什么这样做”

## 提交建议

- 一次提交尽量只解决一类问题
- 提交信息尽量清楚说明改动目的
- 如果修改了用户可见行为，请同步更新 `README.md`
- 如果修改了架构或技术方向，请同步更新 `docs/TECH_STACK.md`

## Issue / PR 建议

如果你准备提交 issue 或 PR，最好包含：

- 你使用的系统环境
- 是否使用 `Ollama` 或 `Gemini`
- 复现步骤
- 预期行为
- 实际行为

这样更容易快速定位问题。
