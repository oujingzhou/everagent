# EverAgent

[English](README.md) | [简体中文](README.zh-CN.md)

EverAgent is a durable, recoverable Agent Harness for long-running AI work.

EverAgent puts the Agent execution lifecycle inside a durable Harness: conversations, model turns, tool calls, queued input, checkpoints, and Agent state are committed to SQLite first, then presented through the TUI and Web task console.

## What Problem Does It Solve?

Consider an AI Agent asked to:

1. Analyze a repository.
2. Modify multiple files.
3. Run tests.
4. Fix failures based on the results.
5. Produce a final summary.

A conventional in-process Agent loop can fail in several ways:

- **Process failure**: conversation and execution progress may exist only in memory.
- **Interrupted work**: restarting may require reconstructing where the Agent stopped.
- **Duplicate execution**: recovery may repeat model or tool operations.
- **Inconsistent state**: transcript entries, tool results, and task state may be committed separately.

EverAgent addresses these problems at the execution layer. It does more than save chat history: it persists the lifecycle of the work itself.

## Core Capabilities

### Durable Conversation And Execution State

EverAgent stores conversations, Agent configuration, submissions, model turns, tool results, task state, checkpoints, compaction state, and usage in SQLite.

The database is the execution source of truth. TUI and Web views are projections of committed state.

### Crash Recovery

Generation and tool calls run as durable tasks. If the process exits mid-turn, another process can reopen the database, reclaim unfinished work, and continue from the last committed checkpoint.

### Tool And Task Management

Tool calls are represented as independent durable tasks with parent-child relationships. The runtime records their input, progress, result, failure, and ownership by the model turn that created them.

### Duplicate Execution Control

Submissions support `requestId` deduplication. Retrying the same admitted request can return the existing durable submission instead of creating duplicate work.

Tool recovery still depends on replay policy. Operations with external side effects must use idempotency keys, transactions, or application-level deduplication.

### Long Conversations

EverAgent supports queued follow-up input, conversation recovery, reset boundaries, context compaction, history export, and provider session identity.

## How It Works

```text
User request
    │
    ▼
EverAgent Harness
admit input and create durable tasks
    │
    ▼
Model turn
plan work and request tools
    │
    ├── Tool task: read or edit files
    ├── Tool task: run commands
    └── Tool task: execute tests
    │
    ▼
Atomic durable commits
transcript + checkpoints + tool results + task state
    │
    ▼
Next model turn or final response
```

If the process fails, EverAgent reopens the same storage and resumes unfinished tasks.

State changes are coordinated through durable commits. Related transcript, document, and task mutations can be committed together instead of leaving partially updated execution state.

## Compared With A Basic Agent Loop

| Capability | Basic custom Agent loop | EverAgent |
| --- | --- | --- |
| Conversation persistence | Implement separately | Built in |
| Task checkpoints | Implement separately | Durable task state |
| Process restart recovery | Custom recovery logic | Resumes unfinished work |
| Tool execution tracking | Usually application-managed | Durable child tasks |
| Submission deduplication | Implement separately | `requestId` support |
| Atomic state changes | Application-specific | Coordinated durable commits |
| Execution inspection | Custom logging | TUI and Web task workflow |

A custom Agent can build these capabilities with databases, queues, and workflow engines. EverAgent packages them into one Agent runtime.

## Suitable Use Cases

- **AI coding work**: repository analysis, multi-file changes, test and repair loops.
- **Long-running automation**: work that may continue for minutes or hours.
- **Recoverable workflows**: processes that must survive terminal exits or restarts.
- **Auditable execution**: inspect model turns, tool calls, checkpoints, and results.
- **Agent runtime development**: build higher-level workflows on durable execution primitives.

## Install And Configure

Requires Node.js 22.19 or newer:

```sh
npm install -g everagent
everagent
```

On the first interactive launch, EverAgent guides you through provider selection, API key or supported account authentication, and default model selection.

Run setup again:

```sh
everagent setup
```

You can also provide credentials through environment variables and select a model directly:

```sh
OPENAI_API_KEY="..." everagent --model openai/gpt-5
ANTHROPIC_API_KEY="..." everagent --model anthropic/claude-sonnet-4
```

## TUI

```sh
everagent
everagent --cwd /path/to/project
everagent --resume
```

Running `everagent` starts a new conversation. Use `--resume` or `/resume` to select an existing durable conversation.

Common commands:

| Command | Purpose |
| --- | --- |
| `/model provider/model-id` | Select a model |
| `/thinking level` | Change the thinking level |
| `/resume` | Select a conversation |
| `/runtime` | Inspect active durable work |
| `/web [port]` | Open the Web UI for the current conversation |
| `/web stop` | Stop the Web UI |
| `/compact` | Compact the current context |
| `/new` | Start a new context boundary |
| `/export [path]` | Export the conversation |
| `/quit` | Exit |

`Escape` aborts an active run. `Ctrl-C` clears the editor and exits when pressed again within 500 ms. `Ctrl-D` exits when the editor is empty.

## Web Task Console

Start directly:

```sh
everagent --web
```

Open `http://127.0.0.1:3210`.

From an active TUI, run `/web`. EverAgent opens the browser and selects the current conversation automatically.

The Web UI reconstructs persisted execution as:

```text
Run request
├── Model turn
│   ├── Tool
│   └── Tool
├── Model turn
└── Final response
```

Runs are paginated and collapsed by default. Long workflows compact intermediate turns, and tool branches expand on demand. Filters cover status, time range, task type, conversation, and text search.

## Recovery Demo

```sh
npm run build
npm run demo:durable
```

The demo kills a process after a submission becomes durable, reopens the same database, resumes the original work, and waits for completion.

The broader capability demo covers documents, deduplication, checkpoints, history forks, and lifecycle events:

```sh
npm run demo:capabilities
```

Both demos use a fake provider and require no API credentials.

## Technical Foundation

EverAgent uses `@earendil-works/pi-durable`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `@earendil-works/chord`. Its durability model follows the design rationale described in [Pi Durable](https://earendil.com/posts/pi-durable/).
