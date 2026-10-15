import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	type EntryRecord,
	type Harness,
	type MessageChange,
	type SnapshotEvent,
} from "@earendil-works/pi-durable";
import {
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	AssistantMessage,
	Message,
	ModelThinkingLevel,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

type AgentState = SnapshotEvent["agent"];
type UsageState = SnapshotEvent["usage"];

export interface DurableTuiAdapterOptions {
	conversation: Conversation;
	harness: Harness;
	tui: TUI;
	chat: Container;
	pendingMessages: Container;
	editor: { addToHistory?(text: string): void };
	cwd: string;
	modelRuntime?: ModelRuntime;
	onIndicatorChange(message: string | undefined): void;
	onAgentChange?(agent: AgentState): void;
}

function userText(message: Extract<Message, { role: "user" }>): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
}

function toolResult(entry: EntryRecord | undefined): ToolResultMessage | undefined {
	const message = entry?.model?.[0];
	return message?.role === "toolResult" ? message : undefined;
}

function appendAtPath(value: unknown, path: readonly (string | number)[], delta: string): void {
	if (path.length === 0 || value === null || typeof value !== "object") return;
	let target = value as Record<string | number, unknown>;
	for (const part of path.slice(0, -1)) {
		const next = target[part];
		if (next === null || typeof next !== "object") return;
		target = next as Record<string | number, unknown>;
	}
	const key = path[path.length - 1];
	if (key === undefined) return;
	target[key] = `${typeof target[key] === "string" ? target[key] : ""}${delta}`;
}

export function applyMessageChanges(
	message: AssistantMessage,
	usage: Usage,
	changes: readonly MessageChange[],
): AssistantMessage {
	let next = structuredClone(message);
	for (const change of changes) {
		if (change.type === "message") {
			next = structuredClone(change.message);
			continue;
		}
		if (
			change.type === "text_start" ||
			change.type === "thinking_start" ||
			change.type === "toolcall_start" ||
			change.type === "block"
		) {
			next.content[change.contentIndex] = structuredClone(change.block);
			continue;
		}
		const block = next.content[change.contentIndex];
		if (!block) continue;
		if (change.type === "text_delta" && block.type === "text") {
			block.text += change.delta;
		} else if (change.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += change.delta;
		} else if (change.type === "toolcall_delta" && block.type === "toolCall") {
			appendAtPath(block.arguments, change.path, change.delta);
		}
	}
	next.usage = structuredClone(usage);
	return next;
}

function trimUtf8Prefix(value: string, bytes: number): string {
	if (bytes <= 0) return value;
	const buffer = Buffer.from(value);
	return buffer.subarray(Math.min(bytes, buffer.length)).toString("utf8");
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function shortCwd(cwd: string): string {
	const home = homedir();
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !relativeToHome.startsWith(".."));
	return insideHome ? (relativeToHome ? `~${sep}${relativeToHome}` : "~") : cwd;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

export class DurableFooter implements Component {
	private agent: AgentState = {};
	private usage: UsageState = { models: {}, tools: {} };
	private latestAssistant?: AssistantMessage;
	private readonly fallbackCwd: string;
	private readonly modelRuntime?: ModelRuntime;

	constructor(fallbackCwd: string, modelRuntime?: ModelRuntime) {
		this.fallbackCwd = fallbackCwd;
		this.modelRuntime = modelRuntime;
	}

	setState(agent: AgentState, usage: UsageState, entries?: readonly EntryRecord[]): void {
		this.agent = agent;
		this.usage = usage;
		if (entries) {
			this.latestAssistant = entries
				.flatMap((entry) => entry.model ?? [])
				.filter((message): message is AssistantMessage => message.role === "assistant")
				.at(-1);
		}
	}

	setLatestAssistant(message: AssistantMessage): void {
		this.latestAssistant = message;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const totals = emptyUsage();
		for (const usage of Object.values(this.usage.models)) addUsage(totals, usage as Usage);
		for (const usage of Object.values(this.usage.tools)) addUsage(totals, usage as Usage);

		const left: string[] = [];
		if (totals.input) left.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) left.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) left.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) left.push(`W${formatTokens(totals.cacheWrite)}`);
		if (totals.cost.total) left.push(`$${totals.cost.total.toFixed(3)}`);

		const model = this.agent.model
			? this.modelRuntime?.getModel(this.agent.model.provider, this.agent.model.modelId)
			: undefined;
		const contextWindow = model?.contextWindow ?? 0;
		const contextTokens = this.latestAssistant
			? this.latestAssistant.usage.input +
				this.latestAssistant.usage.cacheRead +
				this.latestAssistant.usage.cacheWrite
			: 0;
		left.push(
			contextWindow > 0
				? `${((contextTokens / contextWindow) * 100).toFixed(1)}%/${formatTokens(contextWindow)}`
				: "?",
		);

		const thinking = this.agent.thinkingLevel ?? "off";
		const right = this.agent.model
			? `${this.agent.model.modelId}${thinking === "off" ? " • thinking off" : ` • ${thinking}`}`
			: "no-model";
		const stats = left.join(" ");
		const availableRight = Math.max(0, width - visibleWidth(stats) - 2);
		const renderedRight = truncateToWidth(right, availableRight, "");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(stats) - visibleWidth(renderedRight)));
		return [
			truncateToWidth(shortCwd(this.agent.cwd ?? this.fallbackCwd), width, "..."),
			`${stats}${padding}${renderedRight}`,
		];
	}
}

export class DurablePiTuiAdapter {
	private readonly options: DurableTuiAdapterOptions;
	private stream?: AgentEventStream;
	private renderedEntries = new Set<number>();
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private toolOutputs = new Map<string, string>();
	private streamingComponent?: AssistantMessageComponent;
	private streamingMessage?: AssistantMessage;
	private agent: AgentState = {};
	private usage: UsageState = { models: {}, tools: {} };
	private runActive = false;
	private compactionActive = false;
	private retryAttempt?: number;
	private deferred = false;

	readonly footer: DurableFooter;

	constructor(options: DurableTuiAdapterOptions) {
		this.options = options;
		this.footer = new DurableFooter(options.cwd, options.modelRuntime);
	}

	async start(): Promise<void> {
		this.stream = await watchEvents(this.options.harness, this.options.conversation.id, BACKGROUND_CONTEXT);
		this.renderSnapshot(this.stream.snapshot);
		this.stream.start(async (events) => {
			for (const event of events) this.handleEvent(event);
			this.options.tui.requestRender();
		});
	}

	async stop(): Promise<void> {
		await this.stream?.stop();
	}

	showStatus(message: string): void {
		this.options.chat.addChild(new Spacer(1));
		this.options.chat.addChild(new Text(message.trim(), 1, 0));
		this.options.tui.requestRender();
	}

	showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.showStatus(`Error: ${message}`);
	}

	private renderSnapshot(snapshot: SnapshotEvent): void {
		this.options.chat.clear();
		this.options.pendingMessages.clear();
		this.renderedEntries.clear();
		this.pendingTools.clear();
		this.toolOutputs.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.agent = snapshot.agent;
		this.usage = snapshot.usage;
		this.runActive = snapshot.run !== undefined;
		this.compactionActive = snapshot.compactions.length > 0;
		this.retryAttempt = snapshot.generation?.retry ? snapshot.generation.attempt : undefined;
		this.deferred = snapshot.generation?.deferred !== undefined;
		this.footer.setState(snapshot.agent, snapshot.usage, snapshot.entries);
		this.options.onAgentChange?.(snapshot.agent);

		for (const entry of snapshot.entries) this.renderEntry(entry, true);
		if (snapshot.generation?.message) this.startAssistant(snapshot.generation.message);
		for (const tool of snapshot.tools) {
			const component = this.ensureTool(tool.callId, tool.name, {});
			if (tool.status === "running") component.markExecutionStarted();
			if (tool.output) {
				this.toolOutputs.set(tool.callId, tool.output);
				component.updateResult(
					{ content: [{ type: "text", text: tool.output }], details: tool.details, isError: false },
					true,
				);
			}
		}
		this.renderInbox(snapshot.inbox);
		this.updateIndicator();
	}

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "snapshot":
				this.renderSnapshot(event);
				break;
			case "run_start":
				this.runActive = true;
				this.updateIndicator();
				break;
			case "turn_start":
				this.updateIndicator();
				break;
			case "run_end":
				this.runActive = false;
				this.retryAttempt = undefined;
				this.deferred = false;
				this.updateIndicator();
				break;
			case "message_start":
				this.startMessage(event.message);
				break;
			case "message_update":
				if (!this.streamingMessage || !this.streamingComponent) break;
				this.streamingMessage = applyMessageChanges(this.streamingMessage, event.usage, event.changes);
				this.streamingComponent.updateContent(this.streamingMessage, true);
				this.syncToolCalls(this.streamingMessage);
				break;
			case "message_end":
				this.finishMessage(event.entry);
				break;
			case "tool_execution_start": {
				if (event.parentToolCallId) break;
				const component = this.ensureTool(event.toolCallId, event.toolName, event.args);
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update": {
				if (event.parentToolCallId) break;
				const component = this.ensureTool(event.toolCallId, event.toolName, {});
				let output = this.toolOutputs.get(event.toolCallId) ?? "";
				if (event.output) {
					if ("set" in event.output) output = event.output.set;
					else {
						if (event.output.trimStart) output = trimUtf8Prefix(output, event.output.trimStart);
						if (event.output.append) output += event.output.append;
					}
					this.toolOutputs.set(event.toolCallId, output);
				}
				component.updateResult(
					{ content: [{ type: "text", text: output }], details: event.details, isError: false },
					true,
				);
				break;
			}
			case "tool_execution_end": {
				if (event.parentToolCallId) break;
				const component = this.pendingTools.get(event.toolCallId);
				const result = toolResult(event.entry);
				if (component && result) component.updateResult(result);
				else if (component) {
					const diagnostics = event.result?.diagnostics.map((item) => item.message).join("\n") ?? "";
					component.updateResult({
						content: [{ type: "text", text: diagnostics || "Tool execution ended without a result" }],
						details: event.result?.details,
						isError: event.result?.isError ?? true,
						durationMs: event.result?.durationMs,
					});
				}
				this.pendingTools.delete(event.toolCallId);
				this.toolOutputs.delete(event.toolCallId);
				break;
			}
			case "entry_appended":
				this.renderEntry(event.entry, false);
				break;
			case "inbox_update":
				this.renderInbox(event.items);
				break;
			case "agent_changed":
				this.agent = event.agent;
				this.footer.setState(this.agent, this.usage);
				this.options.onAgentChange?.(event.agent);
				break;
			case "usage_changed":
				this.usage = event.usage;
				this.footer.setState(this.agent, this.usage);
				break;
			case "auto_retry_start":
				this.retryAttempt = event.attempt;
				this.updateIndicator();
				this.showStatus(event.errorMessage);
				break;
			case "auto_retry_end":
				this.retryAttempt = undefined;
				this.updateIndicator();
				break;
			case "deferred_poll":
				this.deferred = true;
				this.updateIndicator();
				break;
			case "compaction_start":
				this.compactionActive = true;
				this.updateIndicator();
				break;
			case "compaction_end":
				this.compactionActive = false;
				this.updateIndicator();
				if (event.error) this.showError(event.error);
				break;
			case "task_failed":
				this.showError(`${event.kind}: ${event.message}`);
				break;
			case "submission":
			case "turn_end":
				break;
		}
	}

	private updateIndicator(): void {
		if (this.compactionActive) this.options.onIndicatorChange("Compacting context");
		else if (this.retryAttempt !== undefined) this.options.onIndicatorChange(`Retrying attempt ${this.retryAttempt}`);
		else if (this.deferred) this.options.onIndicatorChange("Waiting for provider");
		else this.options.onIndicatorChange(this.runActive ? "Working" : undefined);
	}

	private startMessage(message: Message): void {
		if (message.role === "user") {
			this.addUser(message, false);
		} else if (message.role === "assistant") {
			this.startAssistant(message);
		}
	}

	private startAssistant(message: AssistantMessage): void {
		this.streamingMessage = structuredClone(message);
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			false,
			getMarkdownTheme(),
			"thinking",
			1,
		);
		this.options.chat.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.streamingMessage, true);
		this.syncToolCalls(this.streamingMessage);
	}

	private finishMessage(entry: EntryRecord): void {
		if (this.renderedEntries.has(entry.id)) return;
		const message = entry.model?.[0];
		if (!message) {
			this.renderedEntries.add(entry.id);
			return;
		}
		if (message.role === "assistant") {
			if (this.streamingComponent) {
				this.streamingComponent.updateContent(message, false);
				this.syncToolCalls(message);
				for (const content of message.content) {
					if (content.type === "toolCall") this.pendingTools.get(content.id)?.setArgsComplete();
				}
			} else {
				this.addAssistant(message);
			}
			this.footer.setLatestAssistant(message);
			this.streamingComponent = undefined;
			this.streamingMessage = undefined;
		} else if (message.role === "toolResult") {
			this.pendingTools.get(message.toolCallId)?.updateResult(message);
			this.pendingTools.delete(message.toolCallId);
			this.toolOutputs.delete(message.toolCallId);
		}
		this.renderedEntries.add(entry.id);
	}

	private renderEntry(entry: EntryRecord, populateHistory: boolean): void {
		if (this.renderedEntries.has(entry.id)) return;
		for (const message of entry.model ?? []) {
			if (message.role === "user") this.addUser(message, populateHistory);
			else if (message.role === "assistant") this.addAssistant(message);
			else if (message.role === "toolResult") {
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				} else {
					const fallback = this.ensureTool(message.toolCallId, message.toolName, {});
					fallback.setArgsComplete();
					fallback.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			}
		}
		this.renderedEntries.add(entry.id);
	}

	private addUser(message: Extract<Message, { role: "user" }>, populateHistory: boolean): void {
		const text = userText(message);
		if (!text) return;
		if (this.options.chat.children.length > 0) this.options.chat.addChild(new Spacer(1));
		this.options.chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), 1));
		if (populateHistory) this.options.editor.addToHistory?.(text);
	}

	private addAssistant(message: AssistantMessage): void {
		this.options.chat.addChild(
			new AssistantMessageComponent(message, false, getMarkdownTheme(), "thinking", 1),
		);
		this.syncToolCalls(message);
		for (const content of message.content) {
			if (content.type === "toolCall") this.pendingTools.get(content.id)?.setArgsComplete();
		}
		this.footer.setLatestAssistant(message);
	}

	private syncToolCalls(message: AssistantMessage): void {
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const component = this.ensureTool(content.id, content.name, content.arguments);
			component.updateArgs(content.arguments);
		}
	}

	private ensureTool(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): ToolExecutionComponent {
		const existing = this.pendingTools.get(toolCallId);
		if (existing) return existing;
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{ outputPad: 1 },
			undefined,
			this.options.tui,
			this.agent.cwd ?? this.options.cwd,
		);
		this.options.chat.addChild(component);
		this.pendingTools.set(toolCallId, component);
		return component;
	}

	private renderInbox(items: SnapshotEvent["inbox"]): void {
		this.options.pendingMessages.clear();
		if (items.length > 0) {
			this.options.pendingMessages.addChild(
				new Text(`${items.length} queued durable submission${items.length === 1 ? "" : "s"}`, 1, 0),
			);
		}
	}
}
