# Contributing

Thank you for contributing to `Video Lens`.

This repository is intentionally lightweight. Changes should preserve that quality unless there is a clear technical reason to introduce more infrastructure.

## Contribution Principles

Prefer changes that are:

- easy to understand
- easy to run locally
- consistent with the current architecture
- justified by actual product needs

Avoid changes that add substantial complexity without improving reliability, usability, or maintainability.

## Local Development Setup

Recommended environment:

- `Python 3.11+`
- `ffmpeg`
- `ffprobe`
- optional: local `Ollama` with `qwen3-vl:8b`

Start the application:

```bash
python3 app.py
```

Default local URL:

```text
http://127.0.0.1:8765
```

## Project Layout

- `app.py`: local HTTP server, upload handling, job lifecycle, provider pipelines
- `static/index.html`: UI structure
- `static/styles.css`: UI styling
- `static/app.js`: UI behavior, polling, queue rendering
- `docs/TECH_STACK.md`: architecture and technical decisions
- `README.md`: user-facing setup and usage documentation

## Before You Submit Changes

At minimum, run:

```bash
python3 -m py_compile app.py
node --check static/app.js
```

If your change affects execution flow, also run a real manual check for the impacted path:

- single-video analysis
- folder batch analysis
- Ollama path or Gemini path, depending on your change

## Coding Guidelines

### Backend

- Prefer Python standard library unless an additional dependency is clearly justified.
- Keep provider-specific logic isolated from generic job orchestration logic.
- Preserve the current job model unless a structural change is necessary.
- Do not introduce persistence, queues, or framework migrations casually.

### Frontend

- Keep the UI compatible with the existing backend contract.
- Avoid adding a build-heavy frontend framework unless the product scope clearly requires it.
- Prefer maintainable DOM and event logic over clever abstractions.

### Documentation

- Update `README.md` when user-visible behavior changes.
- Update `docs/TECH_STACK.md` when architectural decisions or technical direction change.
- Keep documentation factual and repository-grade; avoid placeholder language.

## API and Behavior Compatibility

If you change request or response behavior, treat it as a compatibility-sensitive change.

In particular, review the impact on:

- `/api/config`
- `/api/analyze`
- `/api/jobs/<id>`

The frontend depends directly on these contracts.

## Pull Requests

A good pull request should explain:

- what changed
- why the change was needed
- what was verified locally
- whether any documentation was updated

If the change affects provider behavior, include enough detail for reviewers to understand whether:

- the Ollama path still works
- the Gemini path still works
- batch behavior still works

## Issues

If you open an issue, include:

- operating system
- Python version
- whether you used Ollama or Gemini
- reproduction steps
- expected behavior
- actual behavior

This repository is small enough that precise reproduction details matter more than volume of commentary.

## Scope Discipline

Please avoid turning a focused change into a framework migration or a broad refactor unless that is the explicit goal of the work.

Examples of changes that should usually be split into separate pull requests:

- UI redesign plus backend pipeline rewrite
- provider integration change plus documentation overhaul
- architectural migration plus feature work

Smaller, well-scoped changes are easier to review and safer to merge.
