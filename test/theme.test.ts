import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EVERAGENT_THEME,
	EVERAGENT_THEME_NAME,
	ensureEveragentTheme,
	initializeEveragentTheme,
} from "../src/theme.ts";

describe("EverAgent theme", () => {
	it("creates a Pi-compatible theme under the EverAgent directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-theme-"));
		try {
			const path = ensureEveragentTheme(directory);
			expect(path).toBe(join(directory, "themes", "everagent.json"));
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(EVERAGENT_THEME);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("uses EverAgent by default and preserves an explicit theme override", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-theme-select-"));
		const originalPiAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		const calls: Array<{ name?: string; directory?: string }> = [];
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/pi-should-not-be-used";
			expect(initializeEveragentTheme(directory, undefined, (name) => {
				calls.push({ name, directory: process.env.PI_CODING_AGENT_DIR });
			})).toBe(EVERAGENT_THEME_NAME);
			expect(initializeEveragentTheme(directory, "light", (name) => {
				calls.push({ name, directory: process.env.PI_CODING_AGENT_DIR });
			})).toBe("light");
			expect(calls).toEqual([
				{ name: "everagent", directory },
				{ name: "light", directory },
			]);
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/tmp/pi-should-not-be-used");
		} finally {
			if (originalPiAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalPiAgentDirectory;
			await rm(directory, { recursive: true, force: true });
		}
	});
});
