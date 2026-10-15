import { spawn } from "node:child_process";

export function browserCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
	const { command, args } = browserCommand(url);
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});
	child.once("error", () => {});
	child.unref();
}
