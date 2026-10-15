import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ProgramStatus, Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { runTui } from "../src/tui.ts";

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	private input?: (data: string) => void;

	get columns(): number {
		return 100;
	}

	get rows(): number {
		return 30;
	}

	get kittyProtocolActive(): boolean {
		return true;
	}

	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}

	stop(): void {
		this.input = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(_status: ProgramStatus): void {}

	send(data: string): void {
		this.input?.(data);
	}
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("durable TUI conversation", () => {
	it("clears on the first Ctrl-C and exits on the second", async () => {
		const faux = fauxProvider({ models: [{ id: "test-model", contextWindow: 8192 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: {
				model: { provider: "faux", modelId: "test-model" },
				cwd: process.cwd(),
			},
		});
		harness.resume();
		const terminal = new RecordingTerminal();
		let exited = false;
		const tui = runTui(
			conversation,
			async () => true,
			harness,
			process.cwd(),
			undefined,
			[],
			undefined,
			terminal,
		).then((result) => {
			exited = true;
			return result;
		});

		try {
			await waitFor(
				() => terminal.writes.join("").includes("durable by design · resumable by default"),
				"TUI did not start",
			);
			terminal.send("unsent draft");
			terminal.send("\x03");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(exited).toBe(false);
			terminal.send("\x03");
			await expect(tui).resolves.toEqual({ kind: "exit" });
		} finally {
			if (!exited) terminal.send("\x04");
			await tui;
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("selects a durable conversation through slash resume", async () => {
		const faux = fauxProvider({ models: [{ id: "test-model", contextWindow: 8192 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: {
				model: { provider: "faux", modelId: "test-model" },
				cwd: process.cwd(),
			},
		});
		harness.resume();
		const terminal = new RecordingTerminal();
		let exited = false;
		const tui = runTui(
			conversation,
			async () => true,
			harness,
			process.cwd(),
			undefined,
			[{ name: "resume", description: "Resume a conversation" }],
			undefined,
			terminal,
			async () => [{ value: "42", label: "#42", description: "selected conversation" }],
		).then((result) => {
			exited = true;
			return result;
		});

		try {
			await waitFor(
				() => terminal.writes.join("").includes("durable by design · resumable by default"),
				"TUI did not start",
			);
			terminal.send("/resume");
			terminal.send("\r");
			await waitFor(
				() => terminal.writes.join("").includes("#42"),
				"resume selector did not open",
			);
			terminal.send("\r");
			await expect(tui).resolves.toEqual({ kind: "resume", conversationId: 42 });
		} finally {
			if (!exited) terminal.send("\x04");
			await tui;
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("renders the submitted message and durable response on the terminal screen", async () => {
		const faux = fauxProvider({ models: [{ id: "test-model", contextWindow: 8192 }] });
		faux.setResponses([fauxAssistantMessage("Faux durable response rendered in TUI.")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: {
				model: { provider: "faux", modelId: "test-model" },
				cwd: process.cwd(),
			},
		});
		harness.resume();
		const terminal = new RecordingTerminal();
		const tui = runTui(
			conversation,
			async (prompt) => {
				const submission = await conversation.submit(
					{ type: "input", content: prompt },
					BACKGROUND_CONTEXT,
				);
				const settled = await submission.wait(BACKGROUND_CONTEXT);
				return settled.status === "done";
			},
			harness,
			process.cwd(),
			undefined,
			[],
			undefined,
			terminal,
		);

		try {
			await waitFor(
				() => terminal.writes.join("").includes("durable by design · resumable by default"),
				"TUI did not start",
			);
			terminal.send("hello durable tui");
			terminal.send("\r");
			await waitFor(
				() => terminal.writes.join("").includes("Faux durable response rendered in TUI."),
				"assistant response was not rendered",
			);

			const output = terminal.writes.join("");
			expect(output).toContain("hello durable tui");
			expect(output).toContain("Faux durable response rendered in TUI.");
			expect(output).toMatch(/\x1b\[48;(?:2|5);/);
			expect(output).toContain("ever");
			expect(output).toContain("agent");
			expect(output).toContain("durable by design · resumable by default");

			terminal.send("/new");
			terminal.send("\r");
			await waitFor(
				() => terminal.writes.join("").includes("Started a new durable context"),
				"/new did not create a durable reset boundary",
			);
			const context = await conversation.context(BACKGROUND_CONTEXT);
			expect(context.entries.some((entry) => entry.kind === "pi.reset")).toBe(true);
			expect(context.messages).toHaveLength(0);

			const tool = new ToolExecutionComponent(
				"bash",
				"tool-call",
				{ command: "echo durable" },
				{ outputPad: 1 },
				undefined,
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			tool.markExecutionStarted();
			expect(tool.render(100).join("")).toMatch(/\x1b\[48;(?:2|5);/);
		} finally {
			terminal.send("\x04");
			await tui;
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
