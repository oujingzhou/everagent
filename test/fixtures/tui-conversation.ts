import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { runTui } from "../../src/tui.ts";

const faux = fauxProvider({ models: [{ id: "test-model", contextWindow: 8192 }] });
faux.setResponses([fauxAssistantMessage("Faux durable response rendered in TUI.")]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
const conversation = await harness.root(BACKGROUND_CONTEXT, {
	agent: {
		model: { provider: "faux", modelId: "test-model" },
		cwd: process.cwd(),
	},
});
harness.resume();

try {
	await runTui(
		conversation,
		async (prompt) => {
			const submission = await conversation.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			return settled.status === "done";
		},
		harness,
		process.cwd(),
	);
} finally {
	await harness.close(BACKGROUND_CONTEXT);
}
