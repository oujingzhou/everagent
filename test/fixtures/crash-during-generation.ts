import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const database = process.env.EVERAGENT_TEST_DB;
if (!database) throw new Error("EVERAGENT_TEST_DB is required");

const faux = fauxProvider({ models: [{ id: "test-model" }] });
faux.setResponses([
	async () => {
		console.log("PROVIDER_STARTED");
		await new Promise(() => undefined);
		return fauxAssistantMessage("unreachable");
	},
]);
const models = createModels();
models.setProvider(faux.provider);
const storage = await openNodeSqliteStorage(database);
const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
const conversation = await harness.root(BACKGROUND_CONTEXT, {
	agent: { model: { provider: "faux", modelId: "test-model" } },
});
harness.resume();
const submission = await conversation.submit({ type: "input", content: "recover after crash" }, BACKGROUND_CONTEXT);
console.log(`SUBMISSION:${String(submission.id)}`);
await new Promise(() => undefined);
