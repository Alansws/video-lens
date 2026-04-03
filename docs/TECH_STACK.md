# Technical Stack

## Overview

`Video Lens` is a local-first video analysis application with a browser UI and two interchangeable inference paths:

- a local path built around `Ollama + qwen3-vl:8b`
- a cloud path built around the `Gemini Files API`

The project is intentionally lightweight. It is designed to be easy to run on a single machine, easy to inspect, and easy to extend without introducing unnecessary framework complexity.

This document explains:

- which technologies the project uses
- why those technologies were selected
- how the main runtime flows work
- which tradeoffs were accepted in the current architecture

## System Architecture

At a high level, the application has four layers:

1. Browser UI
2. Local HTTP server
3. Video processing pipeline
4. Model provider integrations

The end-to-end request flow is:

```text
Browser UI
  -> uploads one or more video files
  -> local Python server creates a job
  -> server chooses provider-specific pipeline
  -> video is either frame-sampled locally or uploaded directly
  -> provider returns analysis text
  -> server stores per-item status/result
  -> browser polls job state and renders queue/detail views
```

## Stack Summary

### Application server

- `Python 3`
- `http.server`
- `threading`
- `subprocess`
- `urllib.request`

### Frontend

- `HTML`
- `CSS`
- `Vanilla JavaScript`

### Video tooling

- `ffprobe`
- `ffmpeg`

### Model integrations

- `Ollama HTTP API`
- `Google Gemini Files API`

## Why Python Standard Library

The backend is implemented with Python standard library components instead of a larger web framework.

That decision is deliberate.

The current server responsibilities are:

- serve static frontend files
- accept multipart video uploads
- maintain in-memory job state
- invoke local tools such as `ffmpeg` and `ffprobe`
- call external HTTP APIs

For this scope, Python standard library is sufficient and has several advantages:

- minimal dependency surface
- easier setup for users cloning the repository
- simpler operational model
- low cognitive load for contributors
- direct integration with local CLI tooling

Frameworks such as `FastAPI` or `Django` would make sense only if the project grows into a larger multi-user service with authentication, persistent storage, richer API contracts, or background worker infrastructure.

## Why Vanilla Frontend

The frontend uses plain `HTML`, `CSS`, and `JavaScript` rather than React, Vue, or another SPA framework.

That choice keeps the application aligned with its current product shape:

- one browser page
- limited navigation complexity
- mostly form submission, queue rendering, and polling
- no client-side routing
- no shared state that justifies a component framework

Advantages of this approach:

- no frontend build step is required to run the project
- contributors can inspect the UI directly from source files
- fewer toolchain failures
- lower maintenance cost
- easier onboarding for small-project contributors

The cost of this decision is that complex UI refactors are less structured than they would be in a component system. For the current scope, that tradeoff is acceptable.

## Why ffmpeg and ffprobe

Video analysis requires two low-level capabilities before a model can be called reliably:

- extract metadata such as duration, codec, dimensions, and stream structure
- derive ordered visual samples from the original video when using a local VLM path

`ffprobe` is used for metadata inspection.

`ffmpeg` is used for frame extraction.

These tools were selected because they are:

- cross-platform
- stable
- widely adopted
- format-flexible
- well suited to automation

For a local video workflow, there is no practical alternative with a better stability-to-complexity ratio.

## Provider Design

The project supports two provider families, but the scheduling model is unified.

### Ollama path

The Ollama integration is designed for local inference.

Processing steps:

1. inspect the uploaded video with `ffprobe`
2. compute effective frame sampling parameters
3. extract frames with `ffmpeg`
4. encode frames as base64 image payloads
5. submit them to `Ollama /api/generate`
6. store structured result data and per-item timings

This path exists because current Ollama vision interfaces are image-oriented at the API layer. The application hides that complexity from the end user.

### Gemini path

The Gemini integration is designed for direct video submission.

Processing steps:

1. upload the video file to the Gemini Files API
2. poll until the file becomes ready
3. call `generateContent`
4. collect and normalize the returned text
5. delete the remote temporary file when possible

This path exists because some users want a direct video API experience without local model runtime requirements.

## Job Model

One of the key architectural decisions in the project is the unified job model.

The backend treats:

- a single-video task
- a folder batch task

as the same abstraction: a `job` containing one or more `items`.

Benefits of this approach:

- single polling contract for the frontend
- uniform progress accounting
- simpler queue rendering
- easier extension to additional providers
- cleaner failure handling at per-item granularity

This is more maintainable than building separate code paths for “single mode” and “batch mode”.

## State Management Strategy

The server keeps job state in memory.

This means the current architecture is optimized for:

- local use
- single-process runtime
- short-lived analysis sessions
- minimal setup cost

It is not designed for:

- multi-user persistence
- long-term historical job storage
- distributed execution
- restart-safe recovery

This is an intentional constraint, not an oversight. Persistence can be added later if the product grows into a longer-lived service.

## Why Polling Instead of WebSockets

The browser currently polls job status rather than maintaining a persistent realtime connection.

That decision reduces implementation complexity and works well for the current workload because:

- jobs are relatively long-running
- UI update frequency does not need sub-second precision
- the app is single-user and local by default
- the server should remain simple

WebSockets would be a reasonable upgrade only if the application later needs:

- more frequent state updates
- concurrent users
- push-based notifications
- richer live operational dashboards

## Performance and Execution Tradeoffs

Batch analysis is intentionally sequential.

Reasons:

- local VLM inference is resource-intensive
- sequential execution gives clearer logs
- per-item failure diagnosis is simpler
- system load is more predictable on end-user hardware

This sacrifices throughput in exchange for:

- stability
- easier debugging
- easier user comprehension

Parallel execution can be added later, but it should be introduced as a controlled concurrency model rather than as an ad hoc optimization.

## Security and Exposure Model

The application is built for local execution and defaults to:

- `127.0.0.1` binding
- local Ollama API access
- user-supplied Gemini API keys at runtime

This is an acceptable baseline for a local tool, but it also implies clear boundaries:

- the server is not production-hardened as an internet-facing service
- the app assumes a trusted local environment
- provider credentials and network exposure should be handled carefully before any remote deployment

If the project is later deployed beyond localhost, additional work would be required around:

- authentication
- secrets management
- upload validation
- rate limiting
- persistent job storage

## Current Strengths

From an engineering perspective, the current stack is strong in the following areas:

- low setup friction
- easy local reproducibility
- straightforward source inspection
- clean separation between scheduling and provider-specific execution
- practical support for both local and cloud video analysis paths

## Current Limits

The stack also has explicit limits:

- no durable storage
- no background worker process model
- no authentication or multi-user isolation
- no resumable local job persistence
- no frontend component system for large-scale UI evolution

These are acceptable for the current product stage, but they define the boundary of what this architecture should be expected to handle.

## Reasonable Next Steps

If the project continues to grow, the most credible next improvements would be:

- `SQLite` or `PostgreSQL` for persisted job records
- a dedicated task queue for long-running processing
- WebSocket-based progress updates
- export formats such as Markdown or JSON
- stronger validation around uploads and provider configuration
- optional API framework migration if endpoint complexity grows substantially

Those upgrades should be driven by actual product requirements, not by framework preference.

## Summary

The technical stack behind `Video Lens` is intentionally conservative.

It prioritizes:

- operational simplicity
- local usability
- small dependency surface
- direct access to practical video tooling
- a clear path for incremental extension

For the current scope of the project, that is the correct tradeoff.
