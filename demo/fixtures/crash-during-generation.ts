import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const database = process.env.EVERAGENT_TEST_DB;
if (!database) throw new Error("EVERAGENT_TEST_DB is required");

const faux = fauxProvider({ models: [{ id: "test-model" }] });
faux.setResponses([
	async () => {
		console.log("PROVIDER_STARTED");
		await new Promise(() => {});
		throw new Error("unreachable");
	},
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(
	await openNodeSqliteStorage(database),
	{ models, registry: createRegistry() },
	BACKGROUND_CONTEXT,
);
const conversation = await harness.root(BACKGROUND_CONTEXT, {
	agent: { model: { provider: "faux", modelId: "test-model" } },
});
harness.resume();
const submission = await conversation.submit(
	{ type: "input", content: "survive this process" },
	BACKGROUND_CONTEXT,
);
console.log(`SUBMISSION:${submission.id}`);
await new Promise(() => {});
