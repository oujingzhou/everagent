#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { runEveragent } = await import(resolve(projectRoot, "dist/src/cli.js"));
await runEveragent(process.argv.slice(2)).catch((error) => {
	console.error(`everagent: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
