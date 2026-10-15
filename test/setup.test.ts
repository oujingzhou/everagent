import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function cleanEnvironment(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, EVERAGENT_HOME: home };
	for (const name of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"OPENROUTER_API_KEY",
		"GROQ_API_KEY",
		"MISTRAL_API_KEY",
		"XAI_API_KEY",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_BEARER_TOKEN_BEDROCK",
	]) {
		delete env[name];
	}
	return env;
}

describe("first-run model setup", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("directs non-interactive users to the setup command", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-first-run-"));
		directories.push(directory);
		const home = join(directory, ".everagent");
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "src/cli.ts", "hello"],
			{
				cwd: projectRoot,
				env: cleanEnvironment(home),
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Run `everagent setup`");
	});

	it("rejects setup without a TTY before opening durable storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-setup-"));
		directories.push(directory);
		const home = join(directory, ".everagent");
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "src/cli.ts", "setup"],
			{
				cwd: projectRoot,
				env: cleanEnvironment(home),
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("everagent setup requires an interactive terminal");
		expect(existsSync(join(home, "everagent.sqlite"))).toBe(false);
	});
});
