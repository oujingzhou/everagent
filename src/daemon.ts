import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getEveragentConfigPath } from "./paths.ts";

export type DaemonRecord = {
	pid: number;
	port: number;
	database: string;
	cwd: string;
	startedAt: string;
	log: string;
	token: string;
};

export type DaemonStartOptions = {
	port: number;
	database: string;
	cwd: string;
	model?: string;
	stateFile?: string;
	logFile?: string;
	entrypoint?: string;
	entrypointArgs?: readonly string[];
};

export function defaultDaemonStateFile(): string {
	return resolve(process.env.EVERAGENT_DAEMON_STATE ?? getEveragentConfigPath("daemon.json"));
}

export async function readDaemonRecord(stateFile = defaultDaemonStateFile()): Promise<DaemonRecord | undefined> {
	try {
		return JSON.parse(await readFile(stateFile, "utf8")) as DaemonRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function daemonAlive(record: DaemonRecord): boolean {
	try {
		process.kill(record.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function daemonResponding(record: DaemonRecord): Promise<boolean> {
	if (!daemonAlive(record)) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${record.port}/api/health`);
		if (!response.ok) return false;
		const body = await response.json() as { token?: string };
		return body.token === record.token;
	} catch {
		return false;
	}
}

async function waitUntilReady(record: DaemonRecord, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!daemonAlive(record)) throw new Error(`daemon exited during startup; inspect ${record.log}`);
		if (await daemonResponding(record)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`daemon did not become ready; inspect ${record.log}`);
}

export async function startDaemon(options: DaemonStartOptions): Promise<DaemonRecord> {
	const stateFile = resolve(options.stateFile ?? defaultDaemonStateFile());
	const existing = await readDaemonRecord(stateFile);
	if (existing && await daemonResponding(existing)) return existing;
	if (existing) await rm(stateFile, { force: true });

	await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
	const lock = await open(`${stateFile}.lock`, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "EEXIST") throw new Error("another daemon start is already in progress");
		throw error;
	});
	try {
		const log = resolve(options.logFile ?? `${dirname(stateFile)}/daemon.log`);
		await mkdir(dirname(log), { recursive: true, mode: 0o700 });
		const output = openSync(log, "a", 0o600);
		const defaultEntrypoint = import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js";
		const entrypoint = resolve(options.entrypoint ?? new URL(defaultEntrypoint, import.meta.url).pathname);
		const entrypointArgs = options.entrypointArgs ??
			(entrypoint.endsWith(".ts") ? ["--experimental-strip-types", entrypoint] : [entrypoint]);
		const token = randomUUID();
		const args = [
			...entrypointArgs,
			"--web",
			"--port",
			String(options.port),
			"--db",
			resolve(options.database),
			"--cwd",
			resolve(options.cwd),
			"--resume",
			...(options.model ? ["--model", options.model] : []),
		];
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: ["ignore", output, output],
			env: { ...process.env, EVERAGENT_DAEMON_CHILD: "1", EVERAGENT_DAEMON_TOKEN: token },
		});
		child.unref();
		closeSync(output);
		const record: DaemonRecord = {
			pid: child.pid!,
			port: options.port,
			database: resolve(options.database),
			cwd: resolve(options.cwd),
			startedAt: new Date().toISOString(),
			log,
			token,
		};
		await writeFile(stateFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		try {
			await waitUntilReady(record);
			return record;
		} catch (error) {
			if (daemonAlive(record)) process.kill(record.pid, "SIGTERM");
			await rm(stateFile, { force: true });
			throw error;
		}
	} finally {
		await lock.close();
		await rm(`${stateFile}.lock`, { force: true });
	}
}

export async function stopDaemon(stateFile = defaultDaemonStateFile()): Promise<boolean> {
	const record = await readDaemonRecord(stateFile);
	if (!record) return false;
	if (await daemonResponding(record)) {
		process.kill(record.pid, "SIGTERM");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && daemonAlive(record)) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		if (daemonAlive(record)) throw new Error(`daemon ${record.pid} did not stop`);
	} else if (daemonAlive(record)) {
		throw new Error(`daemon record points to unrelated process ${record.pid}; refusing to stop it`);
	}
	await rm(stateFile, { force: true });
	return true;
}

export async function submitToDaemon(
	prompt: string,
	options: { stateFile?: string; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" } = {},
): Promise<{ submissionId: number; status: unknown }> {
	const record = await readDaemonRecord(options.stateFile);
	if (!record || !(await daemonResponding(record))) throw new Error("everagent daemon is not running");
	const response = await fetch(`http://127.0.0.1:${record.port}/api/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			prompt,
			requestId: options.requestId ?? `cli-${Date.now()}-${process.pid}`,
			whenBusy: options.whenBusy ?? "followUp",
		}),
	});
	const body = await response.json() as { submissionId?: number; status?: unknown; error?: string };
	if (!response.ok || body.submissionId === undefined) throw new Error(body.error ?? `daemon request failed: ${response.status}`);
	return { submissionId: body.submissionId, status: body.status };
}
