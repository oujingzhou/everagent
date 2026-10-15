import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const directory = await mkdtemp(join(tmpdir(), "everagent-demo-"));
const database = join(directory, "everagent.sqlite");
const compiled = import.meta.url.endsWith(".js");
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", `crash-during-generation.${compiled ? "js" : "ts"}`);

console.log("\nEverAgent durable recovery demo");
console.log("1. Starting an agent request in another process...");
const child = spawn(process.execPath, [...(compiled ? [] : ["--experimental-strip-types"]), fixture], {
	env: { ...process.env, EVERAGENT_TEST_DB: database },
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output += chunk; });
while (!output.includes("PROVIDER_STARTED") || !output.includes("SUBMISSION:")) {
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
}
const submissionId = Number(output.match(/SUBMISSION:(\d+)/)?.[1]) as SubmissionId;
console.log(`2. Submission ${submissionId} is durable. Simulating SIGKILL now.`);
child.kill("SIGKILL");
if (child.exitCode === null && child.signalCode === null) {
	await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

console.log("3. Opening the same SQLite database in a fresh process runtime...");
const faux = fauxProvider({ models: [{ id: "test-model" }] });
faux.setResponses([fauxAssistantMessage("Recovered after the crash. The durable task continued from its checkpoint.")]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(
	await openNodeSqliteStorage(database),
	{ models, registry: createRegistry() },
	BACKGROUND_CONTEXT,
);
harness.resume();
const root = await harness.root(BACKGROUND_CONTEXT);
const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
const settled = await submission?.wait(BACKGROUND_CONTEXT);
const entries = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
const answer = entries.items
	.flatMap((entry) => entry.model ?? [])
	.findLast((message) => message.role === "assistant");
const text = answer?.role === "assistant"
	? answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
	: "";

console.log(`4. Recovered settlement: ${settled?.status ?? "missing"}`);
console.log(`5. Agent answer: ${text}`);
console.log("\nThe UI process died; the durable submission, transcript, and task checkpoint did not.\n");

await harness.close(BACKGROUND_CONTEXT);
await rm(directory, { recursive: true, force: true });
