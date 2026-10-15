import { describe, expect, it } from "vitest";
import { browserCommand } from "../src/browser.ts";

describe("browserCommand", () => {
	it("opens URLs with the macOS open command", () => {
		expect(browserCommand("http://127.0.0.1:3210", "darwin")).toEqual({
			command: "open",
			args: ["http://127.0.0.1:3210"],
		});
	});

	it("opens URLs with xdg-open on Linux", () => {
		expect(browserCommand("http://127.0.0.1:3210", "linux")).toEqual({
			command: "xdg-open",
			args: ["http://127.0.0.1:3210"],
		});
	});

	it("opens URLs with the Windows start command", () => {
		expect(browserCommand("http://127.0.0.1:3210", "win32")).toEqual({
			command: "cmd",
			args: ["/c", "start", "", "http://127.0.0.1:3210"],
		});
	});
});
