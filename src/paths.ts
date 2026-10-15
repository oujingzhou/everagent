import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getEveragentDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.EVERAGENT_HOME ?? join(homedir(), ".everagent"));
}

export function getEveragentConfigPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(getEveragentDir(env), name);
}

export function getEveragentSessionsDir(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getEveragentDir(env), "sessions", safePath);
}
