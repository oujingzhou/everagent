import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	daemonAlive,
	readDaemonRecord,
	daemonResponding,
	startDaemon,
	stopDaemon,
	submitToDaemon,
} from "../src/daemon.ts";

describe("everagent daemon", () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			const stateFile = join(directory, "daemon.json");
			await stopDaemon(stateFile).catch(() => false);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("owns a background process, exposes status, deduplicates requests, and stops cleanly", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-daemon-"));
		directories.push(directory);
		const stateFile = join(directory, "daemon.json");
		const logFile = join(directory, "daemon.log");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-daemon.ts");
		const record = await startDaemon({
			port: 43219,
			database: join(directory, "agent.sqlite"),
			cwd: directory,
			stateFile,
			logFile,
			entrypoint: fixture,
		});

		expect(daemonAlive(record)).toBe(true);
		expect(await daemonResponding(record)).toBe(true);
		expect(await readDaemonRecord(stateFile)).toMatchObject({ pid: record.pid, port: 43219 });
		const repeated = await startDaemon({
			port: 43219,
			database: join(directory, "agent.sqlite"),
			cwd: directory,
			stateFile,
			logFile,
			entrypoint: fixture,
		});
		expect(repeated.pid).toBe(record.pid);
		const first = await submitToDaemon("background work", { stateFile, requestId: "same-request" });
		const duplicate = await submitToDaemon("background work", { stateFile, requestId: "same-request" });
		expect(duplicate.submissionId).toBe(first.submissionId);
		expect(await stopDaemon(stateFile)).toBe(true);
		expect(await readDaemonRecord(stateFile)).toBeUndefined();
		expect(await readFile(logFile, "utf8")).toBeDefined();
	});

	it("replaces a stale daemon record on the next start", async () => {
		const directory = await mkdtemp(join(tmpdir(), "everagent-daemon-stale-"));
		directories.push(directory);
		const stateFile = join(directory, "daemon.json");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-daemon.ts");
		await import("node:fs/promises").then(({ writeFile }) => writeFile(stateFile, JSON.stringify({
			pid: 999999,
			port: 43220,
			database: join(directory, "old.sqlite"),
			cwd: directory,
			startedAt: new Date(0).toISOString(),
			log: join(directory, "old.log"),
			token: "stale-token",
		})));

		const record = await startDaemon({
			port: 43220,
			database: join(directory, "agent.sqlite"),
			cwd: directory,
			stateFile,
			entrypoint: fixture,
		});
		expect(record.pid).not.toBe(999999);
		expect(daemonAlive(record)).toBe(true);
	});
});
