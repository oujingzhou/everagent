import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import {
	CustomEditor,
	DynamicBorder,
	ModelSelectorComponent,
	SettingsManager,
	ThinkingSelectorComponent,
	getSelectListTheme,
	initTheme,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	CombinedAutocompleteProvider,
	KeybindingsManager,
	Loader,
	ProcessTerminal,
	ScrollView,
	SelectList,
	setKeybindings,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	truncateToWidth,
	VStack,
	type AutocompleteItem,
	type KeybindingsConfig,
	type KeybindingDefinitions,
	type SlashCommand,
	type SelectItem,
	type Terminal,
	type TUI,
} from "@earendil-works/pi-tui";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DurablePiTuiAdapter } from "./durable-tui-adapter.ts";
import { getEveragentDir } from "./paths.ts";
import { initializeEveragentTheme } from "./theme.ts";

export type TuiCommandHandler = (input: string) => Promise<string | undefined>;
export type TuiCommand = SlashCommand;
export type TuiExitReason =
	| { kind: "exit" }
	| { kind: "resume"; conversationId?: number };

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const RESET = "\x1b[0m";
const EVER = "\x1b[38;2;228;138;122m";
const AGENT = "\x1b[38;2;234;182;93m";
const LOOP = "\x1b[38;2;79;142;179m";
const MUTED = "\x1b[38;2;128;139;150m";

const PI_APP_KEYBINDINGS = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
	"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
	"app.model.cycleBackward": {
		defaultKeys: process.platform === "win32" ? "alt+p" : "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.message.copy": { defaultKeys: "ctrl+x", description: "Copy last assistant message" },
} as const satisfies KeybindingDefinitions;

function loadPiKeybindings(agentDir: string): KeybindingsConfig {
	try {
		const value = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				([key, binding]) =>
					key !== "$schema" &&
					(typeof binding === "string" ||
						(Array.isArray(binding) && binding.every((item) => typeof item === "string"))),
			),
		) as KeybindingsConfig;
	} catch {
		return {};
	}
}

function loadPiTheme(cwd: string, agentDir: string): string | undefined {
	try {
		return SettingsManager.create(cwd, agentDir).getTheme();
	} catch {
		return undefined;
	}
}

function createBanner(): Text {
	return new Text(
		[
			`${LOOP}╭─╮${RESET}  ${EVER}ever${AGENT}agent${RESET}`,
			`${LOOP}╰∞╯${RESET}  ${MUTED}durable by design · resumable by default${RESET}`,
		].join("\n"),
		1,
		1,
	);
}

class EmbeddedWorkingIndicator extends Loader {
	readonly kind = "working";

	constructor(tui: TUI, message: string) {
		super(tui, (text) => text, (text) => text, message);
	}

	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}

export async function runTui(
	conversation: Conversation,
	submitPrompt: (prompt: string) => Promise<boolean>,
	harness?: Harness,
	cwd = process.cwd(),
	handleCommand?: TuiCommandHandler,
	commands: readonly TuiCommand[] = [],
	modelRuntime?: ModelRuntime,
	terminal: Terminal = new ProcessTerminal(),
	listConversations?: () => Promise<readonly SelectItem[]>,
	agentDir = getEveragentDir(),
): Promise<TuiExitReason> {
	if (!harness) throw new Error("The durable TUI requires a Harness");
	initializeEveragentTheme(agentDir, loadPiTheme(cwd, agentDir), initTheme);
	const tui = new TuiAltScreen(
		terminal,
		true,
		join(agentDir, "logs"),
	);
	const chat = new Container();
	const document = new Container();
	document.addChild(createBanner());
	document.addChild(new DynamicBorder((text) => text));
	document.addChild(chat);
	const pendingMessages = new Container();
	const status = new Container();
	const keybindings = new KeybindingsManager(
		{ ...TUI_KEYBINDINGS, ...PI_APP_KEYBINDINGS },
		loadPiKeybindings(agentDir),
	);
	setKeybindings(keybindings);
	const editor = new CustomEditor(
		tui,
		{
			borderColor: (text) => text,
			selectList: getSelectListTheme(),
		},
		keybindings as never,
		{
			paddingX: 1,
			autocompleteMaxVisible: 8,
			embedWorkingStatus: true,
		},
	);
	const modelCommand = commands.find((command) => command.name === "model");
	if (modelCommand && modelRuntime) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.toLowerCase();
			const matches = modelRuntime
				.getAvailableSnapshot()
				.map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: model.id,
					description: model.provider,
				}))
				.filter((item) => `${item.value} ${item.label}`.toLowerCase().includes(normalized));
			return matches.length > 0 ? matches : null;
		};
	}
	const thinkingCommand = commands.find((command) => command.name === "thinking");
	if (thinkingCommand) {
		thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const matches = THINKING_LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({
				value: level,
				label: level,
			}));
			return matches.length > 0 ? matches : null;
		};
	}
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands], cwd));
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let busy = false;
	let workingIndicator: EmbeddedWorkingIndicator | undefined;
	const setIndicator = (message: string | undefined): void => {
		busy = message !== undefined;
		workingIndicator?.dispose();
		workingIndicator = message ? new EmbeddedWorkingIndicator(tui, message) : undefined;
		editor.setWorkingStatusIndicator(workingIndicator as never);
		tui.requestRender();
	};
	const adapter = new DurablePiTuiAdapter({
		conversation,
		harness,
		tui,
		chat,
		pendingMessages,
		editor,
		cwd,
		modelRuntime,
		onIndicatorChange: setIndicator,
	});
	const transcriptViewport = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const dock = new VStack([
		{ component: pendingMessages, shrink: 1, minSize: 0 },
		{ component: status, shrink: 1, minSize: 0 },
		{ component: editorContainer, shrink: 1, minSize: 3 },
		{ component: adapter.footer, shrink: 1, minSize: 0 },
	]);
	const viewport = new VStack([
		{ component: transcriptViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);

	let stopped = false;
	let resolveExit: (() => void) | undefined;
	let finishSignal: (() => void) | undefined;
	let lastCtrlC = 0;
	let selectorDispose: (() => void) | undefined;
	let resumeRequested = false;
	let resumeConversationId: number | undefined;

	const refresh = async (message?: string): Promise<void> => {
		if (message) adapter.showStatus(message);
	};

	const stop = (reason: "exit" | "resume" = "exit"): void => {
		if (stopped) return;
		resumeRequested = reason === "resume";
		stopped = true;
		workingIndicator?.dispose();
		void adapter.stop();
		selectorDispose?.();
		tui.stop();
		if (finishSignal) {
			process.off("SIGINT", finishSignal);
			process.off("SIGTERM", finishSignal);
		}
		resolveExit?.();
	};

	const restoreEditor = (): void => {
		selectorDispose?.();
		selectorDispose = undefined;
		editorContainer.clear();
		editorContainer.addChild(editor);
		tui.setFocus(editor);
		tui.requestRender();
	};

	const showConversationSelector = async (): Promise<void> => {
		if (!listConversations) {
			stop("resume");
			return;
		}
		const items = await listConversations();
		if (items.length === 0) {
			await refresh("  no durable conversations found");
			return;
		}
		const selector = new SelectList([...items], Math.min(10, items.length), getSelectListTheme());
		selector.onSelect = (item) => {
			resumeConversationId = Number(item.value);
			restoreEditor();
			stop("resume");
		};
		selector.onCancel = restoreEditor;
		selectorDispose = () => {};
		editorContainer.clear();
		editorContainer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
	};

	const showModelSelector = async (search?: string): Promise<void> => {
		if (!modelRuntime) {
			await refresh("  model selector unavailable");
			return;
		}
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const currentModel = agent.model
			? modelRuntime.getModel(agent.model.provider, agent.model.modelId)
			: undefined;
		const selector = new ModelSelectorComponent(
			tui,
			currentModel,
			modelRuntime,
			[],
			(model) => {
				void conversation
					.agent(BACKGROUND_CONTEXT)
					.then((agent) => conversation.configure({
						model: { provider: model.provider, modelId: model.id },
						thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel),
					}, BACKGROUND_CONTEXT))
					.then(async () => {
						restoreEditor();
						await refresh(`  Model: ${model.provider}/${model.id}`);
					});
			},
			restoreEditor,
			search,
		);
		selectorDispose = () => selector.dispose();
		editorContainer.clear();
		editorContainer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
	};

	const showThinkingSelector = async (): Promise<void> => {
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const model = agent.model && modelRuntime?.getModel(agent.model.provider, agent.model.modelId);
		const levels = model ? getSupportedThinkingLevels(model) : ["off"] as const;
		const selector = new ThinkingSelectorComponent(
			agent.thinkingLevel,
			[...levels],
			(level) => {
				void conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT).then(async () => {
					restoreEditor();
					await refresh(`  Thinking: ${level}`);
				});
			},
			restoreEditor,
		);
		editorContainer.clear();
		editorContainer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
	};

	const cycleThinking = async (): Promise<void> => {
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const model = agent.model && modelRuntime?.getModel(agent.model.provider, agent.model.modelId);
		const levels = model ? getSupportedThinkingLevels(model) : ["off"] as const;
		const index = levels.indexOf(agent.thinkingLevel as never);
		const level = levels[(index + 1) % levels.length] as ModelThinkingLevel;
		await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
		await refresh(`  Thinking: ${level}`);
	};

	const cycleModel = async (direction: 1 | -1): Promise<void> => {
		if (!modelRuntime) return;
		const models = modelRuntime.getAvailableSnapshot();
		if (models.length < 2) {
			await refresh("  Only one model available");
			return;
		}
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		const currentIndex = models.findIndex(
			(model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
		);
		const nextIndex = (Math.max(0, currentIndex) + direction + models.length) % models.length;
		const model = models[nextIndex];
		if (!model) return;
		await conversation.configure({
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel: clampThinkingLevel(model, agent.thinkingLevel),
		}, BACKGROUND_CONTEXT);
		await refresh(`  Model: ${model.provider}/${model.id}`);
	};

	editor.onEscape = () => {
		if (!busy) return;
		adapter.showStatus("Aborting durable run...");
		void conversation.abort(BACKGROUND_CONTEXT).then(async () => {
			await refresh("  Run aborted");
		});
	};
	editor.onAction("app.clear", () => {
		const now = Date.now();
		if (now - lastCtrlC < 500) {
			stop();
			return;
		}
		editor.setText("");
		lastCtrlC = now;
		tui.requestRender();
	});
	editor.onCtrlD = stop;
	editor.onAction("app.model.select", () => void showModelSelector());
	editor.onAction("app.model.cycleForward", () => void cycleModel(1));
	editor.onAction("app.model.cycleBackward", () => void cycleModel(-1));
	editor.onAction("app.thinking.cycle", () => void cycleThinking());
	editor.onAction("app.message.copy", () => {
		if (handleCommand) void handleCommand("/copy").then((message) => refresh(message));
	});

	editor.onSubmit = (value) => {
		const prompt = value.trim();
		if (!prompt) return;
		if (prompt === "/quit") {
			stop();
			return;
		}
		if (prompt === "/resume") {
			editor.setText("");
			void showConversationSelector().catch((error: unknown) => adapter.showError(error));
			return;
		}
		if (prompt === "/new") {
			editor.setText("");
			void conversation
				.reset(undefined, BACKGROUND_CONTEXT)
				.then(async () => refresh("  Started a new durable context"))
				.catch((error: unknown) => adapter.showError(error));
			return;
		}
		if (prompt === "/model" && modelRuntime) {
			editor.setText("");
			void showModelSelector();
			return;
		}
		if (prompt === "/thinking") {
			editor.setText("");
			void showThinkingSelector();
			return;
		}
		if (prompt.startsWith("/") && handleCommand) {
			editor.setText("");
			void handleCommand(prompt)
				.then(async (result) => {
					await refresh(result);
				})
				.catch(async (error: unknown) => {
					await refresh(error instanceof Error ? error.message : String(error));
				});
			return;
		}
		editor.setText("");
		editor.addToHistory(prompt);
		void submitPrompt(prompt)
			.then(async (completed) => {
				await refresh(completed ? undefined : "  Durable work remains recoverable");
			})
			.catch(async (error: unknown) => {
				adapter.showError(error);
			});
	};

	tui.setLayoutRoot(viewport);
	tui.setFocus(editor);
	await adapter.start();

	tui.start();
	await new Promise<void>((resolve) => {
		resolveExit = resolve;
		const finish = (): void => stop();
		finishSignal = finish;
		process.on("SIGINT", finish);
		process.on("SIGTERM", finish);
	});
	return resumeRequested
		? { kind: "resume", conversationId: resumeConversationId }
		: { kind: "exit" };
}
