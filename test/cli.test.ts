import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { EVERAGENT_VERSION, parseEveragentArgs } from "../src/cli.ts";

describe("parseEveragentArgs", () => {
	it("parses options and joins a positional prompt", () => {
		expect(parseEveragentArgs(["--model", "openai/gpt-5", "--db", "chat.sqlite", "hello", "there"])).toEqual({
			model: "openai/gpt-5",
			database: "chat.sqlite",
			prompt: "hello there",
			tui: false,
			web: false,
			resume: false,
			help: false,
			version: false,
		});
	});

	it("keeps option-like prompt text after --", () => {
		expect(parseEveragentArgs(["--", "--help", "please"])).toEqual({
			prompt: "--help please",
			tui: false,
			web: false,
			resume: false,
			help: false,
			version: false,
		});
	});

	it("rejects missing option values", () => {
		expect(() => parseEveragentArgs(["--db"])).toThrow("Missing value for --db");
	});

	it("parses the persistent web UI options", () => {
		expect(parseEveragentArgs(["--web", "--port", "4321"])).toEqual({
			tui: false,
			web: true,
			resume: false,
			port: 4321,
			help: false,
			version: false,
		});
	});

	it("parses TUI mode", () => {
		expect(parseEveragentArgs(["--tui"])).toEqual({
			tui: true,
			web: false,
			resume: false,
			help: false,
			version: false,
		});
	});

	it("opts into reattaching the durable root", () => {
		expect(parseEveragentArgs(["--resume"])).toMatchObject({
			resume: true,
			tui: false,
			web: false,
			help: false,
			version: false,
		});
	});

	it("parses the version flag", () => {
		expect(parseEveragentArgs(["--version"])).toMatchObject({
			version: true,
			help: false,
		});
	});

	it("keeps the CLI version aligned with package.json", () => {
		expect(EVERAGENT_VERSION).toBe(packageJson.version);
	});

	it("rejects Pi file-session options that do not map to the durable harness", () => {
		expect(() => parseEveragentArgs(["--session", "42"])).toThrow("Unknown option: --session");
		expect(() => parseEveragentArgs(["--new"])).toThrow("Unknown option: --new");
	});
});
