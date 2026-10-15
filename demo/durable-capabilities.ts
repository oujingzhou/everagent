import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	watchEvents,
	type Task,
} from "@earendil-works/pi-durable";

type DemoState = {
	runs: number;
	lastEvent: string;
};

type DemoTaskInput = { steps: number };
type DemoTaskCheckpoint = { phase: "checkpoint"; step: number };
type DemoTaskResult = { completedSteps: number };

const demoState = defineDoc<DemoState>({
	kind: "everagent.demo.state",
	version: 1,
	scope: "session",
	initial: () => ({ runs: 0, lastEvent: "created" }),
});

const checkpointTask: Task<DemoTaskInput, DemoTaskCheckpoint, DemoTaskResult, object> = defineTask({
	name: "everagent.demo.checkpoint",
	version: 1,
	initial: () => ({ phase: "checkpoint", step: 0 }),
	phases: {
		checkpoint: async (task, runtime, context) => {
			const nextStep = task.state.checkpoint.step + 1;
			await runtime.commit(
				() =>
					nextStep >= task.input.steps
						? {
								status: "terminal",
								outcome: {
									status: "completed",
									result: { completedSteps: nextStep },
								},
							}
						: {
								status: "running",
								checkpoint: { phase: "checkpoint", step: nextStep },
							},
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({
				status: "terminal",
				outcome: { status: "aborted", reason: "demo aborted" },
			}),
			context,
		);
	},
});

const faux = fauxProvider({ models: [{ id: "demo-model", contextWindow: 8192 }] });
faux.setResponses([fauxAssistantMessage("Durable response committed to the transcript.")]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: "everagent-demo", tasks: [checkpointTask] }));

const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry },
	BACKGROUND_CONTEXT,
);
harness.resume();

try {
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "demo-model" } },
	});
	const events = await watchEvents(harness, root.id, BACKGROUND_CONTEXT);
	const eventTypes: string[] = ["snapshot"];
	events.start(async (batch) => {
		eventTypes.push(...batch.map((event) => event.type));
	});

	console.log("\nEverAgent durable capabilities demo");
	console.log("1. Atomic document commit...");
	await harness.commit(async (tx) => {
		const state = await tx.doc(demoState);
		state.runs += 1;
		state.lastEvent = "atomic commit";
	}, BACKGROUND_CONTEXT);
	console.log(`   document: ${JSON.stringify(await harness.snapshot(demoState, BACKGROUND_CONTEXT))}`);

	console.log("2. Durable input admission and requestId deduplication...");
	const first = await root.submit(
		{ type: "input", content: "demonstrate durable transcript", requestId: "demo-request-1" },
		BACKGROUND_CONTEXT,
	);
	const duplicate = await root.submit(
		{ type: "input", content: "demonstrate durable transcript", requestId: "demo-request-1" },
		BACKGROUND_CONTEXT,
	);
	console.log(`   submission ${first.id} == duplicate ${duplicate.id}`);
	await first.wait(BACKGROUND_CONTEXT);
	await root.waitForIdle(BACKGROUND_CONTEXT);

	console.log("3. Checkpointed task execution...");
	const taskId = await root.commit(
		(tx) =>
			tx.createTask(
				checkpointTask,
				{ steps: 3 },
				{ ownership: { kind: "conversation" } },
			),
		BACKGROUND_CONTEXT,
	);
	const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
	console.log(`   task ${taskId} -> ${task.state.status} (${task.state.outcome?.status ?? "running"})`);

	console.log("4. Forking durable history...");
	const entries = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
	const forkPoint = entries.items.find((entry) => entry.kind === "pi.user");
	if (!forkPoint) throw new Error("demo user entry was not found");
	const fork = await root.fork(
		forkPoint.id,
		{ ownership: { kind: "ownerless" } },
		BACKGROUND_CONTEXT,
	);
	console.log(`   root conversation ${root.id} -> fork ${fork.id} at entry ${forkPoint.id}`);

	console.log(`5. Live event watch: ${eventTypes.join(" -> ")}`);
	await events.stop();
	console.log("   transcript, document, task checkpoint, fork, and events are durable primitives.");
} finally {
	await harness.close(BACKGROUND_CONTEXT);
}
