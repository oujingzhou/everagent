import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEveragentSessionsDir } from "../src/paths.ts";
import { piSessionMirrorPath, syncPiSessionMirror } from "../src/pi-session-mirror.ts";

describe("Pi-compatible session mirror", () => {
	const directories: string[] = [];
	const originalEveragentHome = process.env.EVERAGENT_HOME;

	afterEach(async () => {
		if (originalEveragentHome === undefined) delete process.env.EVERAGENT_HOME;
		else process.env.EVERAGENT_HOME = originalEveragentHome;
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("mirrors Durable messages into a Pi-readable JSONL session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-session-mirror-"));
		directories.push(directory);
		process.env.EVERAGENT_HOME = join(directory, ".everagent");
		const cwd = join(directory, "project");
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([fauxAssistantMessage("durable response")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: {
				cwd,
				model: { provider: "faux", modelId: "test-model" },
				thinkingLevel: "low",
			},
		});
		harness.resume();
		try {
			await (await conversation.submit({ type: "input", content: "durable prompt" }, BACKGROUND_CONTEXT)).wait(
				BACKGROUND_CONTEXT,
			);
			const path = await syncPiSessionMirror(conversation);
			expect(path).toBe(piSessionMirrorPath(cwd, conversation.id as number));
			expect(path.startsWith(process.env.EVERAGENT_HOME)).toBe(true);
			expect(path).not.toContain(".pi/agent");

			const session = SessionManager.open(path, getEveragentSessionsDir(cwd));
			expect(session.getHeader()).toMatchObject({
				id: `everagent-${conversation.id}`,
				cwd,
				version: 3,
			});
			expect(session.buildSessionContext()).toMatchObject({
				model: { provider: "faux", modelId: "test-model" },
				thinkingLevel: "low",
			});
			expect(session.buildSessionContext().messages).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "durable prompt" }),
				expect.objectContaining({ role: "assistant" }),
			]));
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("represents a Durable reset as a new Pi branch root", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-session-reset-"));
		directories.push(directory);
		process.env.EVERAGENT_HOME = join(directory, ".everagent");
		const faux = fauxProvider({ models: [{ id: "test-model" }] });
		faux.setResponses([fauxAssistantMessage("before reset")]);
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
			await (await conversation.submit({ type: "input", content: "old context" }, BACKGROUND_CONTEXT)).wait(
				BACKGROUND_CONTEXT,
			);
			await conversation.reset("new context", BACKGROUND_CONTEXT);
			const session = SessionManager.open(await syncPiSessionMirror(conversation));
			const roots = session.getTree();
			expect(roots.length).toBeGreaterThan(1);
			expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "user",
				content: "new context",
			});
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
