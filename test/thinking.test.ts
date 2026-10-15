import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialThinkingLevel } from "../src/thinking.ts";

const models = createModels();
models.setProvider(fauxProvider({ models: [{ id: "reasoner", reasoning: true }] }).provider);
const model = models.getModel("faux", "reasoner")!;

describe("startup thinking", () => {
	it("uses Pi's medium default and honors explicit off and model overrides", () => {
		expect(initialThinkingLevel(SettingsManager.inMemory(), model)).toBe("medium");
		expect(initialThinkingLevel(SettingsManager.inMemory({ defaultThinkingLevel: "off" }), model)).toBe("off");
		expect(initialThinkingLevel(SettingsManager.inMemory({
			defaultThinkingLevel: "high",
			modelThinkingLevels: { "faux/reasoner": "low" },
		}), model)).toBe("low");
	});

	it("clamps to the model's supported levels using Pi AI", () => {
		const settings = SettingsManager.inMemory({ defaultThinkingLevel: "max" });
		expect(initialThinkingLevel(settings, model)).toBe("high");
		expect(initialThinkingLevel(settings, { ...model, reasoning: false })).toBe("off");
	});

	it("persists CLI startup defaults, preserves resumed off, and applies changed settings only to new conversations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-thinking-"));
		const database = join(directory, "agent.sqlite");
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const launch = (resume = false) => new Promise<void>((resolve, reject) => {
			const child = execFile(process.execPath, [
				"--experimental-strip-types", cli, "--db", database, "--cwd", directory,
				"--model", "local-test/reasoner", ...(resume ? ["--resume"] : []),
			], { env: { ...process.env, EVERAGENT_HOME: directory }, timeout: 15_000 }, (error, _stdout, stderr) => {
				if (error && stderr.includes("No prompt was provided on stdin.")) resolve();
				else reject(error ?? new Error("Expected empty stdin to end the CLI after initialization"));
			});
			child.stdin?.end();
		});
		const open = async () => Harness.open(await openNodeSqliteStorage(database), {
			models, registry: createRegistry(),
		}, BACKGROUND_CONTEXT);
		try {
			await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
				"local-test": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test",
					models: [{ id: "reasoner", reasoning: true }] },
			} }));
			await writeFile(join(directory, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
			await launch();
			const first = await open();
			try {
				const root = await first.root(BACKGROUND_CONTEXT);
				expect((await root.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
				const page = await first.commit((tx) => tx.scanConversations({ order: "descending" }, 10), BACKGROUND_CONTEXT);
				const fresh = await first.conversation(page.items[0]!.id, BACKGROUND_CONTEXT);
				expect((await fresh!.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
				await root.configure({ thinkingLevel: "off" }, BACKGROUND_CONTEXT);
			} finally { await first.close(BACKGROUND_CONTEXT); }
			await writeFile(join(directory, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
			await launch(true);
			await launch();
			const reopened = await open();
			try {
				expect((await (await reopened.root(BACKGROUND_CONTEXT)).agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("off");
				const page = await reopened.commit((tx) => tx.scanConversations({ order: "descending" }, 10), BACKGROUND_CONTEXT);
				const fresh = await reopened.conversation(page.items[0]!.id, BACKGROUND_CONTEXT);
				expect((await fresh!.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("low");
			} finally { await reopened.close(BACKGROUND_CONTEXT); }
		} finally { await rm(directory, { recursive: true, force: true }); }
	}, 30_000);
});
