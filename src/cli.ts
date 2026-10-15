#!/usr/bin/env node
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	loadProjectContextFiles,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createRegistry,
	defineExtension,
	Harness,
	section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseEveragentArgs } from "./args.ts";
import { openBrowser } from "./browser.ts";
import { EverAgentRuntime } from "./runtime.ts";
import { runTui } from "./tui.ts";
import { startWebServer } from "./web.ts";
import { initialThinkingLevel } from "./thinking.ts";
import { getEveragentConfigPath, getEveragentDir } from "./paths.ts";
import { PiSessionMirror } from "./pi-session-mirror.ts";
import { readAllConversationEntries } from "./conversation-entries.ts";
import { runModelSetup } from "./setup.ts";

export const EVERAGENT_VERSION = "0.1.1";
import {
	daemonAlive,
	defaultDaemonStateFile,
	readDaemonRecord,
	startDaemon,
	stopDaemon,
	submitToDaemon,
} from "./daemon.ts";

function printHelp(): void {
	console.log(`everagent - a durable agent harness

Usage:
  everagent [options] [prompt]
  everagent [options]                 Start the TUI
  everagent setup                     Configure a provider and default model

Options:
  --model PROVIDER/ID  Select a model (defaults to the first configured model)
  --db PATH            SQLite database (default: ~/.everagent/everagent.sqlite)
  --cwd PATH           Working directory for coding tools (default: current directory)
  --tui                Start the terminal UI
  --resume             Reattach to the durable root conversation
  --web                Start a Web surface attached to the durable agent
  --port PORT          Web UI port (default: 3210)
  -v, --version        Show the installed version

Daemon:
  everagent daemon start [options]   Start the durable host in the background
  everagent daemon status            Show host process and endpoint
  everagent daemon stop              Stop the durable host cleanly
  everagent daemon submit PROMPT     Admit an idempotent background request
  -h, --help           Show this help

EverAgent stores its configuration under ~/.everagent. Set EVERAGENT_HOME to override
that directory. Conversation history and in-flight work are stored in SQLite.`);
}

function optionValue(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

async function runDaemonCommand(args: readonly string[]): Promise<void> {
	const command = args[1] ?? "status";
	const stateFile = resolve(optionValue(args, "--state") ?? defaultDaemonStateFile());
	if (command === "start") {
		const portValue = optionValue(args, "--port") ?? process.env.EVERAGENT_DAEMON_PORT ?? "3211";
		const port = Number(portValue);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${portValue}`);
		const record = await startDaemon({
			port,
			database: optionValue(args, "--db") ?? process.env.EVERAGENT_DB ?? getEveragentConfigPath("everagent.sqlite"),
			cwd: optionValue(args, "--cwd") ?? process.cwd(),
			model: optionValue(args, "--model") ?? process.env.EVERAGENT_MODEL,
			stateFile,
		});
		console.log(`everagent daemon ${record.pid} listening at http://127.0.0.1:${record.port}`);
		return;
	}
	if (command === "status") {
		const record = await readDaemonRecord(stateFile);
		if (!record || !daemonAlive(record)) {
			console.log("everagent daemon is not running");
			return;
		}
		const state = await (await fetch(`http://127.0.0.1:${record.port}/api/state`)).json() as {
			activeTaskCount: number;
			pendingSubmissionCount: number;
		};
		console.log(`everagent daemon ${record.pid} · ${state.activeTaskCount} live tasks · ${state.pendingSubmissionCount} queued/placed · http://127.0.0.1:${record.port}`);
		return;
	}
	if (command === "stop") {
		console.log((await stopDaemon(stateFile)) ? "everagent daemon stopped" : "everagent daemon is not running");
		return;
	}
	if (command === "submit") {
		const prompt = args.slice(2).filter((value, index, values) => value !== "--state" && values[index - 1] !== "--state").join(" ").trim();
		if (!prompt) throw new Error("daemon submit requires a prompt");
		const result = await submitToDaemon(prompt, { stateFile });
		console.log(`durable submission ${result.submissionId} admitted`);
		return;
	}
	throw new Error(`Unknown daemon command: ${command}`);
}

function modelRef(value: string): { provider: string; modelId: string } {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error("Model must use provider/model-id format, for example openai/gpt-5");
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

async function submitPrompt(
	runtime: EverAgentRuntime,
	prompt: string,
	print = true,
): Promise<boolean> {
	const submission = await runtime.submit(prompt);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	if (settled.status !== "done" || settled.type !== "input") {
		console.error("everagent: the request did not complete; its durable state is available for recovery.");
		return false;
	}
	if (print) {
		const text = await runtime.answerText(settled.answer);
		if (text) console.log(`everagent> ${text}`);
	}
	return true;
}

async function runInteractive(
	runtime: EverAgentRuntime,
): Promise<void> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	console.log("everagent ready. Enter /exit to quit.");
	try {
		while (true) {
			const prompt = (await readline.question("you> ")).trim();
			if (prompt === "/exit" || prompt === "/quit") return;
			if (!prompt) continue;
			if (!(await submitPrompt(runtime, prompt))) return;
		}
	} finally {
		readline.close();
	}
}

async function readPipedPrompt(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8").trim();
}

export async function runEveragent(args: readonly string[] = process.argv.slice(2)): Promise<void> {
	if (args[0] === "daemon") {
		await runDaemonCommand(args);
		return;
	}
	const setupRequested = args[0] === "setup";
	const options = parseEveragentArgs(setupRequested ? args.slice(1) : args);
	if (options.help) {
		printHelp();
		return;
	}
	if (options.version) {
		console.log(EVERAGENT_VERSION);
		return;
	}

	const cwd = resolve(options.cwd ?? process.cwd());
	const agentDir = getEveragentDir();
	const database = resolve(options.database ?? process.env.EVERAGENT_DB ?? getEveragentConfigPath("everagent.sqlite"));
	const port = options.port ?? Number(process.env.EVERAGENT_PORT ?? 3210);
	const registry = createRegistry();
	registry.install(CodingTools);
	const everagentExtension = defineExtension({
		name: "everagent-coding",
		sections: [
			section(
				"preamble",
				() =>
					"You are EverAgent, running inside a durable agent harness for software engineering. Work directly in the user's project, inspect before editing, preserve existing conventions, use tools to make requested changes, and verify your work. Your execution may resume after a process restart, so rely on committed project state and durable task state rather than assumptions about process memory.",
				{ tag: false },
			),
			section("working_directory", (input) => input.env?.cwd),
			section("project_context", (input) => {
				const projectCwd = input.env?.cwd;
				if (!projectCwd) return undefined;
				const files = loadProjectContextFiles({ cwd: projectCwd, agentDir });
				if (files.length === 0) return undefined;
				return files.map((file) => `Instructions from ${file.path}:\n${file.content}`).join("\n\n");
			}),
		],
	});
	registry.install(everagentExtension);

	const models = await ModelRuntime.create({
		authPath: getEveragentConfigPath("auth.json"),
		modelsPath: getEveragentConfigPath("models.json"),
		modelsStorePath: getEveragentConfigPath("models-store.json"),
	});
	const settings = SettingsManager.create(cwd, agentDir);
	if (setupRequested) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("everagent setup requires an interactive terminal");
		}
		const selected = await runModelSetup(models, settings, agentDir);
		if (selected) console.log(`everagent: configured ${selected.provider}/${selected.id}`);
		return;
	}
	let availableModels = models.getAvailableSnapshot();
	if (
		availableModels.length === 0 &&
		process.stdin.isTTY &&
		process.stdout.isTTY
	) {
		const selected = await runModelSetup(models, settings, agentDir);
		availableModels = models.getAvailableSnapshot();
		if (!selected && availableModels.length === 0) {
			throw new Error("Model setup was cancelled. Run `everagent setup` to configure a provider.");
		}
	}
	await mkdir(dirname(database), { recursive: true, mode: 0o700 });
	const storage = await openNodeSqliteStorage(database);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
		},
		BACKGROUND_CONTEXT,
	);
	const sessionMirrors = new Map<number, PiSessionMirror>();
	const ensureSessionMirror = async (conversation: Parameters<typeof PiSessionMirror.start>[1]): Promise<void> => {
		const id = conversation.id as number;
		if (!sessionMirrors.has(id)) sessionMirrors.set(id, await PiSessionMirror.start(harness, conversation));
	};
	try {
		harness.resume();
		const requestedModel = options.model ?? process.env.EVERAGENT_MODEL;
		const explicitModel = requestedModel
			? models.getModel(modelRef(requestedModel).provider, modelRef(requestedModel).modelId)
			: undefined;
		if (requestedModel && !explicitModel) throw new Error(`Model not found: ${requestedModel}`);

		const durableRoot = await harness.root(BACKGROUND_CONTEXT);
		const storedAgent = await durableRoot.agent(BACKGROUND_CONTEXT);
		const settingsModel = settings.getDefaultProvider() && settings.getDefaultModel()
			? models.getModel(settings.getDefaultProvider()!, settings.getDefaultModel()!)
			: undefined;
		const configuredModel = explicitModel ??
			(storedAgent.model ? models.getModel(storedAgent.model.provider, storedAgent.model.modelId) : undefined) ??
			settingsModel ??
			availableModels[0];
		if (!configuredModel) {
			throw new Error(
				storedAgent.model
					? `Stored model not found: ${storedAgent.model.provider}/${storedAgent.model.modelId}`
					: "No configured model is available. Run `everagent setup` in a terminal, configure provider credentials, or pass --model provider/model-id.",
			);
		}
		const agentChange = {
			cwd,
			model: { provider: configuredModel.provider, modelId: configuredModel.id },
			thinkingLevel: initialThinkingLevel(settings, configuredModel),
			extensions: [CodingTools, everagentExtension],
		} as const;
		const conversation = options.resume
			? durableRoot
			: await harness.createConversation(
					{ ownership: { kind: "ownerless" }, agent: agentChange },
					BACKGROUND_CONTEXT,
				);
		const runtime = new EverAgentRuntime(harness, conversation);
		await ensureSessionMirror(conversation);
		const selectedExtensions = storedAgent.extensions.map((extension) => extension.name);
		const codingExtensionsCurrent =
			selectedExtensions.includes(CodingTools.name) && selectedExtensions.includes(everagentExtension.name);
		if (!storedAgent.model || options.model !== undefined || options.cwd !== undefined || !codingExtensionsCurrent) {
			await durableRoot.configure(
				{
					...(!storedAgent.model || options.cwd !== undefined ? { cwd } : {}),
					...(!storedAgent.model || options.model !== undefined
						? { model: { provider: configuredModel.provider, modelId: configuredModel.id } }
						: {}),
					...(!storedAgent.model ? { thinkingLevel: agentChange.thinkingLevel } : {}),
					...(!codingExtensionsCurrent ? { extensions: [CodingTools, everagentExtension] } : {}),
				},
				BACKGROUND_CONTEXT,
			);
		}

		const shouldStartTui =
			!options.web &&
			(options.tui || (options.prompt === undefined && process.stdin.isTTY && process.stdout.isTTY));
		let webServer: Awaited<ReturnType<typeof startWebServer>> | undefined;
		if (options.web) {
			webServer = await startWebServer(runtime, port);
			console.log(`everagent Web UI: http://127.0.0.1:${port}`);
		}

		if (shouldStartTui || (options.web && options.tui)) {
			const commandDefinitions = [
				{ name: "settings", description: "Show everagent settings and durable runtime configuration" },
				{ name: "model", description: "Select a model", argumentHint: "<provider/model>" },
				{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
				{ name: "scoped-models", description: "Show all configured models" },
				{ name: "export", description: "Export the durable root transcript", argumentHint: "[path]" },
				{ name: "copy", description: "Copy the last assistant message" },
				{ name: "runtime", description: "Show durable harness information and live work" },
				{ name: "web", description: "Start or stop the Web task console", argumentHint: "[port|stop]" },
				{ name: "hotkeys", description: "Show active TUI shortcuts" },
				{ name: "new", description: "Start a new context in the same durable conversation" },
				{ name: "compact", description: "Manually compact the durable context", argumentHint: "[instructions]" },
				{ name: "reload", description: "Reload runtime configuration" },
				{ name: "resume", description: "Select a durable conversation to resume" },
				{ name: "quit", description: "Quit everagent" },
			] as const;
			let tuiConversation = conversation;
			let tuiResult: Awaited<ReturnType<typeof runTui>>;
			const listConversations = async () => {
				const page = await harness.commit(
					(tx) => tx.scanConversations({ order: "descending" }, 100),
					BACKGROUND_CONTEXT,
				);
				return Promise.all(
					page.items.map(async (record) => {
						const candidate = await harness.conversation(record.id, BACKGROUND_CONTEXT);
						const entries = candidate
							? await candidate.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT)
							: { items: [] };
						const latest = entries.items.find((entry) => {
							const message = entry.model?.[0];
							return message?.role === "user" || message?.role === "assistant";
						});
						const message = latest?.model?.[0];
						const raw = message
							? typeof message.content === "string"
								? message.content
								: message.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("")
							: "empty conversation";
						const label = record.id === durableRoot.id ? `#${record.id} · durable root` : `#${record.id}`;
						return {
							value: String(record.id),
							label,
							description: raw.replace(/\s+/g, " ").slice(0, 100),
						};
					}),
				);
			};
			do {
				const tuiRuntime = new EverAgentRuntime(harness, tuiConversation);
				const activeAgent = await tuiConversation.agent(BACKGROUND_CONTEXT);
				tuiResult = await runTui(
					tuiConversation,
					async (value) => {
						return submitPrompt(tuiRuntime, value, false);
					},
					harness,
					activeAgent.cwd ?? cwd,
					async (input) => {
					const [command, ...argumentsList] = input.trim().split(/\s+/);
					const current = await tuiConversation.agent(BACKGROUND_CONTEXT);
					if (command === "/help") {
						return `  ${commandDefinitions.map((item) => `/${item.name}`).join(" · ")}`;
					}
					if (command === "/status" || command === "/runtime" || command === "/settings") {
						const current = await tuiConversation.agent(BACKGROUND_CONTEXT);
						const model = current.model ? `${current.model.provider}/${current.model.modelId}` : "none";
						const state = await tuiRuntime.state();
						return `  root: ${tuiConversation.id} · ${state.activeTaskCount} live tasks · ${state.pendingSubmissionCount} queued/placed · model: ${model} · thinking: ${current.thinkingLevel} · cwd: ${current.cwd ?? cwd} · database: ${database}`;
					}
					if (command === "/web") {
						const action = argumentsList[0];
						if (action === "stop") {
							if (!webServer) return "  Web UI is not running";
							await new Promise<void>((resolveClose, rejectClose) => {
								webServer?.close((error) => error ? rejectClose(error) : resolveClose());
							});
							webServer = undefined;
							return "  Web UI stopped";
						}
						if (webServer) {
							const address = webServer.address();
							const activePort = address && typeof address !== "string" ? address.port : port;
							const url = `http://127.0.0.1:${activePort}`;
							openBrowser(url);
							return `  Web UI: ${url}`;
						}
						const requestedPort = action === undefined ? port : Number(action);
						if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
							throw new Error(`Invalid port: ${action}`);
						}
						webServer = await startWebServer(
							tuiRuntime,
							requestedPort,
							"127.0.0.1",
							{ defaultConversationId: tuiConversation.id as number },
						);
						const url = `http://127.0.0.1:${requestedPort}`;
						openBrowser(url);
						return `  Web UI: ${url}`;
					}
					if (command === "/clear") {
						await tuiConversation.reset(undefined, BACKGROUND_CONTEXT);
						return "  durable context reset";
					}
					if (command === "/model") {
						const value = argumentsList[0];
						if (!value) {
							return `  ${models
								.getAvailableSnapshot()
								.map((model) => `${model.provider}/${model.id}`)
								.join(" · ")}`;
						}
						const selected = models.getModel(modelRef(value).provider, modelRef(value).modelId);
						if (!selected) throw new Error(`Model not found: ${value}`);
						await tuiConversation.configure(
							{
								model: { provider: selected.provider, modelId: selected.id },
								thinkingLevel: clampThinkingLevel(selected, current.thinkingLevel),
							},
							BACKGROUND_CONTEXT,
						);
						return `  model changed to ${selected.provider}/${selected.id}`;
					}
					if (command === "/scoped-models") {
						return `  ${models
							.getAvailableSnapshot()
							.map((model) => `${model.provider}/${model.id}`)
							.join(" · ")}`;
					}
					if (command === "/thinking") {
						const value = argumentsList[0];
						const model = current.model && models.getModel(current.model.provider, current.model.modelId);
						if (!model) throw new Error("No model selected");
						const levels = getSupportedThinkingLevels(model);
						if (!value) return `  thinking: ${current.thinkingLevel} (${levels.join(", ")})`;
						if (!levels.includes(value as (typeof levels)[number])) {
							throw new Error(`Unsupported thinking level: ${value}. Available: ${levels.join(", ")}`);
						}
						await tuiConversation.configure({ thinkingLevel: value as (typeof levels)[number] }, BACKGROUND_CONTEXT);
						return `  thinking level changed to ${value}`;
					}
					if (command === "/compact") {
						const taskId = await tuiConversation.compact(argumentsList.join(" ") || undefined, BACKGROUND_CONTEXT);
						const result = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
						return result.state.status === "terminal" && result.state.outcome?.status === "completed"
							? "  context compacted"
							: "  compaction did not produce a summary";
					}
					if (command === "/copy") {
						const entries = await tuiConversation.entries({ order: "descending" }, 100, undefined, BACKGROUND_CONTEXT);
						const assistant = entries.items.find((entry) => entry.model?.[0]?.role === "assistant")?.model?.[0];
						if (!assistant || assistant.role !== "assistant") return "  no assistant message to copy";
						const text = assistant.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
						await copyToClipboard(text);
						return "  copied last assistant message";
					}
					if (command === "/export") {
						const path = resolve(argumentsList[0] ?? `${cwd}/everagent-${Date.now()}.jsonl`);
						const entries = await readAllConversationEntries(tuiConversation);
						await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
						return `  exported ${entries.length} entries to ${path}`;
					}
					if (command === "/reload") return "  runtime configuration is loaded at startup; restart everagent to reload it";
					if (command === "/hotkeys") return "  Escape aborts · Ctrl-C clears (twice exits) · Ctrl-D exits when empty · Ctrl+L model · Shift+Tab thinking";
					return `  unknown command: ${command}. Use /help`;
					},
					commandDefinitions,
					models,
					undefined,
					listConversations,
					agentDir,
				);
				if (tuiResult.kind === "resume") {
					const target = await harness.conversation(
						(tuiResult.conversationId ?? durableRoot.id) as never,
						BACKGROUND_CONTEXT,
					);
					if (!target) throw new Error("Selected durable conversation no longer exists");
					tuiConversation = target;
					await ensureSessionMirror(target);
				}
			} while (tuiResult.kind === "resume");
			webServer?.close();
			return;
		}

		if (options.web) {
			await new Promise<void>((resolve) => {
				const shutdown = (): void => resolve();
				process.once("SIGINT", shutdown);
				process.once("SIGTERM", shutdown);
			});
			webServer?.close();
			return;
		}

		const prompt = options.prompt ?? (process.stdin.isTTY ? undefined : await readPipedPrompt());
		if (prompt === undefined) {
			await runInteractive(runtime);
		} else if (!prompt) {
			throw new Error("No prompt was provided on stdin.");
		} else if (!(await submitPrompt(runtime, prompt))) {
			process.exitCode = 1;
		}
	} finally {
		await Promise.all([...sessionMirrors.values()].map((mirror) => mirror.stop()));
		await harness.close(BACKGROUND_CONTEXT);
	}
}

export { parseEveragentArgs } from "./args.ts";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runEveragent().catch((error: unknown) => {
		console.error(`everagent: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
