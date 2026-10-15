import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	CompactionEntry,
	createRegistry,
	defineTool,
	Harness,
	MemoryStorage,
	type Conversation,
	type EntryRecord,
	type SubmissionId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { startWebServer } from "../src/web.ts";
import { EverAgentRuntime } from "../src/runtime.ts";

const openHarness = async (storage: Parameters<typeof Harness.open>[0], response: string) => {
	const faux = fauxProvider({ models: [{ id: "test-model" }] });
	faux.setResponses([fauxAssistantMessage(response)]);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "test-model" } },
	});
	harness.resume();
	return { harness, conversation };
};

describe("everagent durable integration", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("runs a durable agent turn and records its task and answer", async () => {
		const { harness, conversation } = await openHarness(new MemoryStorage(), "durable answer");
		try {
			const submission = await conversation.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");
			if (settled.status !== "done" || settled.type !== "input") throw new Error("submission did not finish");

			const answer = await conversation.commit(
				(tx) => tx.entry(AssistantEntry, settled.answer),
				BACKGROUND_CONTEXT,
			);
			expect(answer?.model?.[0]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "durable answer" }],
			});
			const tasks = await harness.commit(
				(tx) => tx.scanTasks({ conversationId: conversation.id }, 20),
				BACKGROUND_CONTEXT,
			);
			expect(tasks.items.some((task) => task.kind === "pi.generation")).toBe(true);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("reopens the same SQLite session with its transcript intact", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-"));
		temporaryDirectories.push(directory);
		const database = join(directory, "session.sqlite");

		const firstStorage = await openNodeSqliteStorage(database);
		const first = await openHarness(firstStorage, "persisted answer");
		const firstSubmission = await first.conversation.submit({ type: "input", content: "persist this" }, BACKGROUND_CONTEXT);
		await firstSubmission.wait(BACKGROUND_CONTEXT);
		await first.harness.close(BACKGROUND_CONTEXT);

		const secondStorage = await openNodeSqliteStorage(database);
		const second = await openHarness(secondStorage, "unused response");
		try {
			const page = await second.conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
			expect(page.items.map((entry) => entry.kind)).toContain("pi.assistant");
			expect(page.items.some((entry) => JSON.stringify(entry.model).includes("persisted answer"))).toBe(true);
		} finally {
			await second.harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("reattaches to the stable durable root and keeps reset as a context boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-root-"));
		temporaryDirectories.push(directory);
		const database = join(directory, "agent.sqlite");

		const firstStorage = await openNodeSqliteStorage(database);
		const first = await openHarness(firstStorage, "before reset");
		const rootId = first.conversation.id;
		await (await first.conversation.submit({ type: "input", content: "first context" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		await first.conversation.reset("second context", BACKGROUND_CONTEXT);
		await first.harness.close(BACKGROUND_CONTEXT);

		const secondStorage = await openNodeSqliteStorage(database);
		const second = await openHarness(secondStorage, "after restart");
		try {
			expect(second.conversation.id).toBe(rootId);
			const context = await second.conversation.context(BACKGROUND_CONTEXT);
			expect(context.entries.some((entry) => entry.kind === "pi.reset")).toBe(true);
			expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "second context" });
		} finally {
			await second.harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("recovers an in-flight generation after a process crash", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-crash-"));
		temporaryDirectories.push(directory);
		const database = join(directory, "session.sqlite");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "crash-during-generation.ts");
		const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
			env: { ...process.env, EVERAGENT_TEST_DB: database },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let errorOutput = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			errorOutput += chunk;
		});
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`crash fixture timed out: ${errorOutput}`)), 5000);
			child.once("error", reject);
			child.stdout.on("data", (chunk) => {
				output += chunk;
				if (output.includes("PROVIDER_STARTED") && output.includes("SUBMISSION:")) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		await ready;
		const submissionId = Number(output.match(/SUBMISSION:(\d+)/)?.[1]);
		expect(Number.isInteger(submissionId)).toBe(true);
		child.kill("SIGKILL");
		await new Promise<void>((resolve, reject) => {
			child.once("exit", () => resolve());
			child.once("error", reject);
		});

		const storage = await openNodeSqliteStorage(database);
		const recovered = await openHarness(storage, "recovered answer");
		try {
			const submission = await recovered.harness.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT);
			expect(submission).toBeDefined();
			expect((await submission?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
			const entries = (await recovered.conversation.entries(
				{ order: "ascending" },
				100,
				undefined,
				BACKGROUND_CONTEXT,
			)).items;
			expect(entries.some((entry) => JSON.stringify(entry.model).includes("recovered answer"))).toBe(true);
		} finally {
			await recovered.harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("admits idempotent Web submissions and exposes durable state", async () => {
		const opened = await openHarness(new MemoryStorage(), "web answer");
		const runtime = new EverAgentRuntime(opened.harness, opened.conversation);
		const server = await startWebServer(runtime, 0, "127.0.0.1", {
			defaultConversationId: opened.conversation.id as number,
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind to a port");
			const base = `http://127.0.0.1:${address.port}`;
			const page = await fetch(`${base}/`);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain("Agent runs");
			expect(html).toContain("Requests grouped with their model turns, tool calls, checkpoints, and outcomes");
			expect(html).toContain("task-detail");
			expect(html).toContain("Search request, task, ID");
			expect(html).toContain("Last 24 hours");
			expect(html).toContain("Custom range");
			expect(html).not.toContain("Submit work to EverAgent");
			const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
			expect(script).toBeDefined();
			expect(() => new Function(script!)).not.toThrow();
			const initial = await (await fetch(`${base}/api/state`)).json() as {
				messages: unknown[];
				tasks: unknown[];
				submissions: unknown[];
				conversationId: number;
				activeTaskCount: number;
				pendingSubmissionCount: number;
				runs: unknown[];
				defaultConversationId: number;
			};
			expect(initial.messages).toEqual([]);
			expect(initial.tasks).toEqual([]);
			expect(initial.activeTaskCount).toBe(0);
			expect(initial.pendingSubmissionCount).toBe(0);
			expect(initial.runs).toEqual([]);
			expect(initial.conversationId).toBe(opened.conversation.id);
			expect(initial.defaultConversationId).toBe(opened.conversation.id);
			const response = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "hello web", requestId: "web-request-1" }),
			});
			expect(response.status).toBe(202);
			const admitted = await response.json() as { submissionId: number };
			const duplicate = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "hello web", requestId: "web-request-1" }),
			});
			expect((await duplicate.json() as { submissionId: number }).submissionId).toBe(admitted.submissionId);
			const invalidJson = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			});
			expect(invalidJson.status).toBe(400);
			expect(await invalidJson.json()).toEqual({ error: "invalid JSON request body" });
			const tooLarge = await fetch(`${base}/api/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: "x".repeat(1024 * 1024) }),
			});
			expect(tooLarge.status).toBe(413);
			const submission = await opened.harness.submission(admitted.submissionId as SubmissionId, BACKGROUND_CONTEXT);
			expect((await submission?.wait(BACKGROUND_CONTEXT))?.status).toBe("done");
			const state = await (await fetch(`${base}/api/state`)).json() as {
				messages: unknown[];
				tasks: Array<{
					kind: string;
					status: string;
					outcomeStatus?: string;
					startedAt?: number;
					endedAt?: number;
					outcome?: { status?: string };
				}>;
				activeTaskCount: number;
				pendingSubmissionCount: number;
				runs: Array<{
					prompt: string;
					status: string;
					generationCount: number;
					taskIds: number[];
				}>;
			};
			expect(state.messages).toEqual([
				{ role: "user", text: "hello web" },
				{ role: "assistant", text: "web answer" },
			]);
			expect(state.activeTaskCount).toBe(0);
			expect(state.pendingSubmissionCount).toBe(0);
			expect(state.tasks).toEqual(expect.arrayContaining([
				expect.objectContaining({
					kind: "pi.generation",
					status: "terminal",
					outcomeStatus: "completed",
					outcome: expect.objectContaining({ status: "completed" }),
				}),
			]));
			const completed = state.tasks.find((task) => task.kind === "pi.generation");
			expect(completed?.startedAt).toEqual(expect.any(Number));
			expect(completed?.endedAt).toEqual(expect.any(Number));
			expect(state.runs).toEqual(expect.arrayContaining([
				expect.objectContaining({
					prompt: "hello web",
					status: "completed",
					generationCount: 1,
				}),
			]));
			expect(state.runs[0]?.taskIds.length).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("deduplicates request IDs and publishes durable lifecycle events", async () => {
		const { harness, conversation } = await openHarness(new MemoryStorage(), "event answer");
		const eventStream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
		const eventTypes: string[] = ["snapshot"];
		let resolveRunEnd: (() => void) | undefined;
		const runEnded = new Promise<void>((resolve) => {
			resolveRunEnd = resolve;
		});
		eventStream.start(async (events) => {
			eventTypes.push(...events.map((event) => event.type));
			if (events.some((event) => event.type === "run_end")) resolveRunEnd?.();
		});

		try {
			const first = await conversation.submit(
				{ type: "input", content: "once", requestId: "request-once" },
				BACKGROUND_CONTEXT,
			);
			const duplicate = await conversation.submit(
				{ type: "input", content: "once", requestId: "request-once" },
				BACKGROUND_CONTEXT,
			);
			expect(duplicate.id).toBe(first.id);
			const settled = await first.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");
			await conversation.waitForIdle(BACKGROUND_CONTEXT);
			await runEnded;

			expect(eventTypes).toEqual(expect.arrayContaining([
				"submission",
				"run_start",
				"message_end",
				"run_end",
			]));
			expect((await harness.inspect(BACKGROUND_CONTEXT)).submissions).toHaveLength(0);
		} finally {
			await eventStream.stop();
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("persists agent configuration and resets the active context", async () => {
		const { harness, conversation } = await openHarness(new MemoryStorage(), "configured answer");
		try {
			await conversation.configure({ thinkingLevel: "low", cwd: "/tmp/everagent-test" }, BACKGROUND_CONTEXT);
			const configured = await conversation.agent(BACKGROUND_CONTEXT);
			expect(configured.thinkingLevel).toBe("low");
			expect(configured.cwd).toBe("/tmp/everagent-test");

			const submission = await conversation.submit({ type: "input", content: "before reset" }, BACKGROUND_CONTEXT);
			await submission.wait(BACKGROUND_CONTEXT);
			await conversation.reset("continue later", BACKGROUND_CONTEXT);
			const context = await conversation.context(BACKGROUND_CONTEXT);
			expect(context.entries.some((entry) => entry.kind === "pi.reset")).toBe(true);
			expect(context.messages.at(-1)).toMatchObject({
				role: "user",
				content: "continue later",
			});
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("queues a follow-up input and aborts it durably", async () => {
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("second answer"),
		]);
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
		try {
			const first = await conversation.submit({ type: "input", content: "first" }, BACKGROUND_CONTEXT);
			const second = await conversation.submit({ type: "input", content: "cancel me" }, BACKGROUND_CONTEXT);
			const abortResult = await second.abort(BACKGROUND_CONTEXT);
			expect(abortResult).toBe("aborted");
			expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			await conversation.waitForIdle(BACKGROUND_CONTEXT);
			expect((await harness.inspect(BACKGROUND_CONTEXT)).submissions).toHaveLength(0);
			const context = await conversation.context(BACKGROUND_CONTEXT);
			expect(context.messages.some((message) => message.role === "user" && message.content === "cancel me")).toBe(false);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("executes a model tool call and records the durable tool result", async () => {
		const tool = defineTool({
			name: "echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
			async execute({ value }) {
				return { output: [{ type: "text", text: `echo:${value}` }] };
			},
		});
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool complete"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install({ name: "test-tools", tools: [tool] });
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "test-model" } },
		});
		harness.resume();
		try {
			const submission = await conversation.submit({ type: "input", content: "use echo" }, BACKGROUND_CONTEXT);
			expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
			const toolResult = entries.find((entry) => entry.kind === "pi.tool-result");
			expect(toolResult?.model?.[0]).toMatchObject({
				role: "toolResult",
				toolName: "echo",
				content: [{ type: "text", text: "echo:hello" }],
				isError: false,
			});
			expect(entries.some((entry) => JSON.stringify(entry.model).includes("tool complete"))).toBe(true);
			const toolTask = (await harness.commit(
				(tx) => tx.scanTasks({ conversationId: conversation.id, kind: "pi.tool" }, 10),
				BACKGROUND_CONTEXT,
			)).items[0];
			expect(toolTask).toBeDefined();
			const detail = await new EverAgentRuntime(harness, conversation).taskDetail(toolTask!.id as number);
			expect(detail?.tool).toMatchObject({
				name: "echo",
				arguments: { value: "hello" },
			});
			expect(detail?.tool?.result).toMatchObject({
				role: "toolResult",
				toolName: "echo",
				content: [{ type: "text", text: "echo:hello" }],
			});
			const generationTasks = (await harness.commit(
				(tx) => tx.scanTasks({ conversationId: conversation.id, kind: "pi.generation", order: "ascending" }, 10),
				BACKGROUND_CONTEXT,
			)).items;
			expect(generationTasks).toHaveLength(2);
			const firstTurn = await new EverAgentRuntime(harness, conversation).taskDetail(generationTasks[0]!.id as number);
			expect(firstTurn?.generation).toMatchObject({
				stopReason: "toolUse",
				toolCalls: [expect.objectContaining({
					name: "echo",
					arguments: { value: "hello" },
				})],
			});
			const finalTurn = await new EverAgentRuntime(harness, conversation).taskDetail(generationTasks[1]!.id as number);
			expect(finalTurn?.generation).toMatchObject({
				text: "tool complete",
				stopReason: "stop",
				toolCalls: [],
			});
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("runs manual compaction and keeps the compacted context readable", async () => {
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([
			fauxAssistantMessage("answer one"),
			fauxAssistantMessage("answer two"),
			fauxAssistantMessage("summary of earlier work"),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry: createRegistry(),
				settings: { compaction: { keepRecentTokens: 1 } },
			},
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: { provider: "faux", modelId: "test-model" } },
		});
		harness.resume();
		try {
			await (await conversation.submit({ type: "input", content: "first context" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			await (await conversation.submit({ type: "input", content: "second context" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			const taskId = await conversation.compact("retain the important decisions", BACKGROUND_CONTEXT);
			const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
			expect(task.state.status).toBe("terminal");
			expect(task.state.outcome.status).toBe("completed");
			const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
			expect(entries.some((entry) => CompactionEntry.is(entry))).toBe(true);
			const context = await conversation.context(BACKGROUND_CONTEXT);
			expect(context.messages.some((message) => JSON.stringify(message).includes("summary of earlier work"))).toBe(true);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
