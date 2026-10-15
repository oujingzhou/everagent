# EverAgent

[English](README.md) | [简体中文](README.zh-CN.md)

EverAgent 是一个面向长时间 AI 任务的可持久化、可恢复 Agent Harness。

EverAgent 将 Agent 的执行生命周期纳入持久化 Harness：对话、模型轮次、工具调用、排队输入、checkpoint 和 Agent 状态都会先提交到 SQLite，再由 TUI 和 Web 任务控制台呈现。

## 它主要解决什么问题？

假设一个 AI Agent 需要：

1. 分析代码库。
2. 修改多个文件。
3. 执行测试。
4. 根据测试结果修复问题。
5. 最后生成总结。

普通的进程内 Agent 循环容易遇到以下问题：

- **进程崩溃**：对话和执行进度可能只存在于内存中。
- **任务中断**：重新启动后难以准确判断之前执行到了哪一步。
- **重复执行**：恢复时可能重复调用模型或工具。
- **状态不一致**：对话记录、工具结果和任务状态可能分别更新。

EverAgent 从执行层解决这些问题。它不只是保存聊天记录，而是持久化任务本身的完整执行生命周期。

## 核心能力

### 持久化对话和执行状态

EverAgent 将对话、Agent 配置、submission、模型轮次、工具结果、任务状态、checkpoint、上下文压缩状态和用量保存在 SQLite 中。

数据库是执行状态的唯一事实来源，TUI 和 Web UI 都是已提交状态的展示界面。

### 崩溃恢复与断点续跑

模型生成和工具调用都作为持久化任务运行。如果进程在执行中途退出，新的进程可以重新打开数据库，接管未完成的任务，并从最后一个已提交的 checkpoint 继续。

### 工具调用与任务管理

工具调用会作为独立的持久化任务记录，并保留父子关系。运行时会保存任务输入、进度、结果、失败状态，以及创建该工具任务的模型轮次。

### 控制重复执行风险

Submission 支持 `requestId` 去重。重复提交同一个已接收请求时，可以返回原有的持久化 submission，而不是创建重复工作。

工具恢复仍然取决于 replay 策略。涉及外部副作用的操作需要使用幂等键、事务或应用层去重。

### 长对话与多轮交互

EverAgent 支持排队的后续输入、对话恢复、reset 边界、上下文压缩、历史导出和 provider session identity。

## 工作原理

```text
用户请求
    │
    ▼
EverAgent Harness
接收输入并创建持久化任务
    │
    ▼
模型轮次
规划工作并请求工具
    │
    ├── 工具任务：读取或编辑文件
    ├── 工具任务：执行命令
    └── 工具任务：运行测试
    │
    ▼
原子持久化提交
对话 + checkpoint + 工具结果 + 任务状态
    │
    ▼
下一次模型轮次或最终回复
```

如果进程崩溃，EverAgent 会重新打开同一份存储并恢复未完成的任务。

相关的对话、文档和任务变更通过持久化提交机制协调，避免执行状态只更新了一部分。

## 与普通 Agent 循环的区别

| 能力 | 普通自定义 Agent 循环 | EverAgent |
| --- | --- | --- |
| 对话持久化 | 需要单独实现 | 内置 |
| 任务 checkpoint | 需要单独实现 | 持久化任务状态 |
| 进程重启恢复 | 需要自行设计 | 恢复未完成工作 |
| 工具执行跟踪 | 通常由应用管理 | 持久化子任务 |
| Submission 去重 | 需要单独实现 | 支持 `requestId` |
| 原子状态更新 | 由应用自行保证 | 协调持久化提交 |
| 执行过程查看 | 依赖自定义日志 | TUI 和 Web 工作流 |

普通 Agent 也可以通过数据库、队列和工作流引擎实现这些能力。EverAgent 的价值是将它们集成到一个 Agent 运行时中。

## 适用场景

- **AI 编程任务**：分析仓库、修改多个文件、运行测试和自动修复。
- **长时间自动化**：需要运行几分钟甚至数小时的任务。
- **可恢复工作流**：不能因终端退出或进程重启而丢失工作。
- **可审计执行**：查看模型轮次、工具调用、checkpoint 和结果。
- **Agent 运行时开发**：在持久化执行原语之上构建更高层工作流。

## 安装与配置

需要 Node.js 22.19 或更高版本：

```sh
npm install -g everagent
everagent
```

首次交互式启动时，EverAgent 会引导选择 provider、通过 API key 或支持的账号登录完成认证，并选择默认模型。

之后可以重新运行配置向导：

```sh
everagent setup
```

也可以通过环境变量提供凭证并直接指定模型：

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

运行 `everagent` 会创建新对话。使用 `--resume` 或 `/resume` 可以选择已有的持久化对话。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `/model provider/model-id` | 选择模型 |
| `/thinking level` | 修改思考等级 |
| `/resume` | 选择对话 |
| `/runtime` | 查看正在执行的持久化工作 |
| `/web [port]` | 为当前 conversation 打开 Web UI |
| `/web stop` | 停止 Web UI |
| `/compact` | 压缩当前上下文 |
| `/new` | 创建新的上下文边界 |
| `/export [path]` | 导出对话 |
| `/quit` | 退出 |

`Escape` 会中止当前运行。`Ctrl-C` 第一次清空编辑器，在 500 毫秒内再次按下会退出。编辑器为空时，`Ctrl-D` 会退出。

## Web 任务控制台

直接启动：

```sh
everagent --web
```

打开 `http://127.0.0.1:3210`。

在已经运行的 TUI 中输入 `/web`，EverAgent 会自动打开浏览器并选择当前 conversation。

Web UI 会将持久化执行状态还原为：

```text
Run request
├── Model turn
│   ├── Tool
│   └── Tool
├── Model turn
└── Final response
```

Run 默认折叠并分页展示。较长的工作流会压缩中间轮次，Tool 分支按需展开。可以按照状态、时间范围、任务类型、conversation 和关键词筛选。

## 恢复演示

```sh
npm run build
npm run demo:durable
```

该演示会在 submission 持久化后杀死进程，再重新打开同一个数据库、恢复原任务并等待完成。

更完整的能力演示覆盖文档、请求去重、checkpoint、历史分支和生命周期事件：

```sh
npm run demo:capabilities
```

两套演示都使用 fake provider，不需要 API 凭证。

## 技术基础

EverAgent 使用 `@earendil-works/pi-durable`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 和 `@earendil-works/chord`。其持久化模型遵循 [Pi Durable](https://earendil.com/posts/pi-durable/) 中阐述的设计思路。
