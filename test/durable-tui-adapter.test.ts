import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DurableFooter, DurablePiTuiAdapter, applyMessageChanges } from "../src/durable-tui-adapter.ts";

const usage = (output: number): Usage => ({
	input: 10,
	output,
	cacheRead: 5,
	cacheWrite: 0,
	totalTokens: 15 + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("durable Pi TUI adapter", () => {
	it("applies durable text and thinking deltas to the streaming assistant message", () => {
		const message = fauxAssistantMessage("");
		message.content = [
			{ type: "thinking", thinking: "plan", thinkingSignature: undefined },
			{ type: "text", text: "hello" },
		];

		const updated = applyMessageChanges(message, usage(4), [
			{ type: "thinking_delta", contentIndex: 0, delta: " more" },
			{ type: "text_delta", contentIndex: 1, delta: " world" },
		]);

		expect(updated.content).toEqual([
			{ type: "thinking", thinking: "plan more", thinkingSignature: undefined },
			{ type: "text", text: "hello world" },
		]);
		expect(updated.usage.output).toBe(4);
		expect(message.content[1]).toEqual({ type: "text", text: "hello" });
	});

	it("applies durable tool-call argument deltas", () => {
		const message = fauxAssistantMessage("");
		message.content = [
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "/tmp/" },
			},
		];

		const updated = applyMessageChanges(message, usage(1), [
			{ type: "toolcall_delta", contentIndex: 0, path: ["path"], delta: "file.txt" },
		]);

		expect(updated.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { path: "/tmp/file.txt" },
		});
	});

	it("renders a Pi-shaped durable footer without the custom everagent session line", () => {
		const footer = new DurableFooter("/Users/test/project");
		footer.setState(
			{
				cwd: "/Users/test/project",
				model: { provider: "faux", modelId: "test-model" },
				thinkingLevel: "low",
			},
			{ models: { "faux/test-model": usage(20) }, tools: {} },
		);

		const lines = footer.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("test-model • low");
		expect(lines.join("\n")).not.toContain("durable session");
		expect(lines.join("\n")).not.toContain("everagent ·");
	});

	it("renders a submitted user message and durable assistant response", async () => {
		initTheme(undefined, false);
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([fauxAssistantMessage("rendered durable answer")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "test-model" } },
		});
		harness.resume();
		const chat = new Container();
		const adapter = new DurablePiTuiAdapter({
			conversation,
			harness,
			tui: { requestRender() {} } as unknown as TUI,
			chat,
			pendingMessages: new Container(),
			editor: {},
			cwd: process.cwd(),
			onIndicatorChange() {},
		});

		try {
			await adapter.start();
			const submission = await conversation.submit(
				{ type: "input", content: "hello adapter" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			await conversation.waitForIdle(BACKGROUND_CONTEXT);
			await new Promise((resolve) => setTimeout(resolve, 0));

			const rendered = chat.render(100).join("\n");
			expect(rendered).toContain("hello adapter");
			expect(rendered).toContain("rendered durable answer");
		} finally {
			await adapter.stop();
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
