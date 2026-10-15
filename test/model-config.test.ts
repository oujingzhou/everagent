import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEveragentConfigPath, getEveragentDir } from "../src/paths.ts";

describe("EverAgent model configuration", () => {
	const directories: string[] = [];
	const originalEveragentHome = process.env.EVERAGENT_HOME;
	const originalPiAgentDirectory = process.env.PI_CODING_AGENT_DIR;

	afterEach(async () => {
		if (originalEveragentHome === undefined) delete process.env.EVERAGENT_HOME;
		else process.env.EVERAGENT_HOME = originalEveragentHome;
		if (originalPiAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiAgentDirectory;
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("loads Pi-compatible models from EVERAGENT_HOME", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-config-"));
		directories.push(directory);
		await writeFile(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					"local-test": {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "durable-test-model", name: "Durable Test Model" }],
					},
				},
			}),
		);
		process.env.EVERAGENT_HOME = directory;

		const models = await ModelRuntime.create({
			authPath: getEveragentConfigPath("auth.json"),
			modelsPath: getEveragentConfigPath("models.json"),
			modelsStorePath: getEveragentConfigPath("models-store.json"),
			refreshOnCreate: false,
		});
		const model = models.getModel("local-test", "durable-test-model");
		expect(model).toMatchObject({
			provider: "local-test",
			id: "durable-test-model",
			name: "Durable Test Model",
		});
		expect(models.getModels("local-test")).toContainEqual(model);
		expect(getEveragentDir()).toBe(directory);
	});

	it("does not read PI_CODING_AGENT_DIR", async () => {
		const everagentDirectory = await mkdtemp(join(tmpdir(), "everagent-home-"));
		const piDirectory = await mkdtemp(join(tmpdir(), "pi-agent-home-"));
		directories.push(everagentDirectory, piDirectory);
		await writeFile(join(everagentDirectory, "models.json"), JSON.stringify({ providers: {} }));
		await writeFile(join(piDirectory, "models.json"), JSON.stringify({
			providers: {
				"pi-only": {
					baseUrl: "http://127.0.0.1:1/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "should-not-load" }],
				},
			},
		}));
		process.env.EVERAGENT_HOME = everagentDirectory;
		process.env.PI_CODING_AGENT_DIR = piDirectory;

		const models = await ModelRuntime.create({
			authPath: getEveragentConfigPath("auth.json"),
			modelsPath: getEveragentConfigPath("models.json"),
			modelsStorePath: getEveragentConfigPath("models-store.json"),
			refreshOnCreate: false,
		});
		expect(models.getModel("pi-only", "should-not-load")).toBeUndefined();
	});
});
