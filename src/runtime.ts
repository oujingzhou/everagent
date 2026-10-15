import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
	AssistantEntry,
	type Conversation,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Harness,
	type SubmissionRecord,
	type TaskRecord,
} from "@earendil-works/pi-durable";

export type DurableSubmitOptions = {
	requestId?: string;
	whenBusy?: "steer" | "followUp" | "reject";
};

export type DurableAgentState = {
	conversationId: number;
	scheduling: "paused" | "running" | "closing";
	activeTaskCount: number;
	pendingSubmissionCount: number;
	tasks: Array<{
		id: number;
		conversationId: number;
		kind: string;
		status: string;
		schedulerStatus?: string;
		phase?: string;
		outcomeStatus?: string;
		startedAt?: number;
		endedAt?: number;
		ownerId?: number;
		background: boolean;
		abortRequested: boolean;
		input: JsonValue;
		checkpoint?: JsonValue;
		outcome?: unknown;
	}>;
	runs: Array<{
		id: string;
		conversationId: number;
		userEntryId?: number;
		prompt: string;
		answer?: string;
		status: "active" | "completed" | "failed";
		startedAt?: number;
		endedAt?: number;
		taskIds: number[];
		generationCount: number;
		toolCount: number;
	}>;
	submissions: SubmissionRecord[];
};

export type DurableTaskDetail = {
	task: DurableAgentState["tasks"][number];
	generation?: {
		entryId: number;
		text?: string;
		thinking?: string;
		stopReason?: string;
		toolCalls: Array<{
			id: string;
			name: string;
			arguments: unknown;
		}>;
	};
	tool?: {
		name: string;
		arguments: unknown;
		result?: unknown;
		callId: string;
		assistantEntryId: number;
		resultEntryId?: number;
	};
};

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function outcomeResult(record: AnyTaskRecord): Record<string, unknown> | undefined {
	if (
		record.state.status !== "completing" &&
		record.state.status !== "terminal"
	) return undefined;
	return objectRecord(record.state.outcome.result);
}

function checkpointPhase(record: AnyTaskRecord): string | undefined {
	if (
		record.state.status !== "pending" &&
		record.state.status !== "running" &&
		record.state.status !== "waiting"
	) return undefined;
	const checkpoint = record.state.checkpoint;
	if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
	return typeof checkpoint.phase === "string" ? checkpoint.phase : undefined;
}

function taskView(
	record: AnyTaskRecord,
	schedulerStatus: string | undefined,
): DurableAgentState["tasks"][number] {
	const live =
		record.state.status === "pending" ||
		record.state.status === "running" ||
		record.state.status === "waiting";
	return {
		id: record.id as number,
		conversationId: record.conversationId as number,
		kind: record.kind,
		status: record.state.status,
		...(schedulerStatus ? { schedulerStatus } : {}),
		...(checkpointPhase(record) ? { phase: checkpointPhase(record) } : {}),
		...(!live ? { outcomeStatus: record.state.outcome.status } : {}),
		...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
		...(record.owner === undefined ? {} : { ownerId: record.owner as number }),
		background: record.background,
		abortRequested: record.abortRequested,
		input: record.input,
		...(live ? { checkpoint: record.state.checkpoint } : { outcome: record.state.outcome }),
	};
}

function messageText(entry: EntryRecord, role: "user" | "assistant"): string | undefined {
	const message = entry.model?.find((candidate) => candidate.role === role);
	if (!message || message.role !== role) return undefined;
	const text = typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
	return text.trim() || undefined;
}

function taskOutputEntryId(task: DurableAgentState["tasks"][number]): number | undefined {
	const outcome = objectRecord(task.outcome);
	const result = objectRecord(outcome?.result);
	return typeof result?.entryId === "number" ? result.entryId : undefined;
}

function deriveRuns(
	tasks: DurableAgentState["tasks"],
	entriesByConversation: ReadonlyMap<number, readonly EntryRecord[]>,
): DurableAgentState["runs"] {
	const runs: DurableAgentState["runs"] = [];
	const taskRun = new Map<number, DurableAgentState["runs"][number]>();
	for (const [conversationId, entries] of entriesByConversation) {
		const boundaries = entries.filter((entry) =>
			entry.kind === "pi.user" || (entry.kind === "pi.reset" && messageText(entry, "user") !== undefined)
		);
		const conversationTasks = tasks
			.filter((task) => task.conversationId === conversationId)
			.sort((left, right) => left.id - right.id);
		const conversationRuns: DurableAgentState["runs"] = boundaries.map((entry, index) => {
			const next = boundaries[index + 1];
			const range = entries.filter((candidate) =>
				candidate.id >= entry.id && (next === undefined || candidate.id < next.id)
			);
			return {
				id: `${conversationId}:${entry.id as number}`,
				conversationId,
				userEntryId: entry.id as number,
				prompt: messageText(entry, "user") ?? "Conversation input",
				answer: [...range].reverse().map((candidate) => messageText(candidate, "assistant")).find(Boolean),
				status: "completed" as const,
				taskIds: [] as number[],
				generationCount: 0,
				toolCount: 0,
			};
		});
		if (conversationRuns.length === 0 && conversationTasks.length > 0) {
			conversationRuns.push({
				id: `${conversationId}:background`,
				conversationId,
				prompt: "Background runtime work",
				status: "completed",
				taskIds: [],
				generationCount: 0,
				toolCount: 0,
			});
		}
		for (const task of conversationTasks) {
			const outputEntryId = taskOutputEntryId(task);
			const run = outputEntryId === undefined
				? conversationRuns.at(-1)
				: [...conversationRuns].reverse().find(
						(candidate) => candidate.userEntryId === undefined || candidate.userEntryId <= outputEntryId,
					);
			if (!run) continue;
			run.taskIds.push(task.id);
			if (task.kind === "pi.generation") run.generationCount++;
			if (task.kind === "pi.tool") run.toolCount++;
			taskRun.set(task.id, run);
		}
		for (const task of conversationTasks) {
			if (taskRun.has(task.id) || task.ownerId === undefined) continue;
			const run = taskRun.get(task.ownerId);
			if (!run) continue;
			run.taskIds.push(task.id);
			if (task.kind === "pi.generation") run.generationCount++;
			if (task.kind === "pi.tool") run.toolCount++;
			taskRun.set(task.id, run);
		}
		for (const run of conversationRuns) {
			const runTasks = run.taskIds
				.map((id) => tasks.find((task) => task.id === id))
				.filter((task): task is DurableAgentState["tasks"][number] => task !== undefined);
			if (runTasks.length === 0) continue;
			run.startedAt = runTasks
				.map((task) => task.startedAt)
				.filter((value): value is number => value !== undefined)
				.sort((left, right) => left - right)[0];
			run.endedAt = runTasks.some((task) =>
				task.status === "pending" ||
				task.status === "running" ||
				task.status === "waiting" ||
				task.status === "completing"
			)
				? undefined
				: runTasks
						.map((task) => task.endedAt)
						.filter((value): value is number => value !== undefined)
						.sort((left, right) => right - left)[0];
			run.status = run.endedAt === undefined
				? "active"
				: runTasks.some((task) => ["failed", "faulted", "orphaned", "aborted"].includes(task.outcomeStatus ?? ""))
					? "failed"
					: "completed";
			runs.push(run);
		}
	}
	return runs.sort((left, right) =>
		(right.startedAt ?? right.userEntryId ?? 0) - (left.startedAt ?? left.userEntryId ?? 0)
	);
}

export class EverAgentRuntime {
	readonly harness: Harness;
	readonly conversation: Conversation;
	private runCache?: { signature: string; runs: DurableAgentState["runs"] };

	constructor(harness: Harness, conversation: Conversation) {
		this.harness = harness;
		this.conversation = conversation;
	}

	async submit(prompt: string, options: DurableSubmitOptions = {}) {
		return this.conversation.submit(
			{
				type: "input",
				content: prompt,
				...(options.requestId === undefined ? {} : { requestId: options.requestId }),
				...(options.whenBusy === undefined ? {} : { whenBusy: options.whenBusy }),
			},
			BACKGROUND_CONTEXT,
		);
	}

	async waitForAnswer(submissionId: number): Promise<EntryId | undefined> {
		const submission = await this.harness.submission(submissionId as never, BACKGROUND_CONTEXT);
		const settled = await submission?.wait(BACKGROUND_CONTEXT);
		return settled?.status === "done" && settled.type === "input" ? settled.answer : undefined;
	}

	async answerText(answerId: EntryId): Promise<string> {
		const answer = await this.conversation.commit(
			(tx) => tx.entry(AssistantEntry, answerId),
			BACKGROUND_CONTEXT,
		);
		const message = answer?.model?.[0];
		if (!message || message.role !== "assistant") return "";
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	async taskDetail(taskId: number): Promise<DurableTaskDetail | undefined> {
		const record = await this.harness.getTask(taskId as never, BACKGROUND_CONTEXT) as AnyTaskRecord | undefined;
		if (!record) return undefined;
		const scheduler = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
			(item) => item.record.id === record.id,
		)?.state.kind;
		const detail: DurableTaskDetail = { task: taskView(record, scheduler) };
		if (record.kind === "pi.generation") {
			const result = outcomeResult(record);
			const entryId = typeof result?.entryId === "number" ? result.entryId : undefined;
			if (entryId === undefined) return detail;
			const entry = await this.harness.commit((tx) => tx.entry(entryId as EntryId), BACKGROUND_CONTEXT);
			const assistant = entry?.model?.find((message) => message.role === "assistant");
			if (!assistant || assistant.role !== "assistant") return detail;
			const text = assistant.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			const thinking = assistant.content
				.filter((part) => part.type === "thinking")
				.map((part) => part.thinking)
				.join("")
				.trim();
			detail.generation = {
				entryId,
				...(text ? { text } : {}),
				...(thinking ? { thinking } : {}),
				...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}),
				toolCalls: assistant.content
					.filter((part) => part.type === "toolCall")
					.map((call) => ({
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					})),
			};
			return detail;
		}
		if (record.kind !== "pi.tool") return detail;

		const input = objectRecord(record.input);
		const assistantEntryId = typeof input?.assistant === "number" ? input.assistant : undefined;
		const callId = typeof input?.callId === "string" ? input.callId : undefined;
		if (assistantEntryId === undefined || callId === undefined) return detail;
		const result = outcomeResult(record);
		const resultEntryId = typeof result?.entryId === "number" ? result.entryId : undefined;
		const entries = await this.harness.commit(async (tx) => ({
			assistant: await tx.entry(assistantEntryId as EntryId),
			result: resultEntryId === undefined ? undefined : await tx.entry(resultEntryId as EntryId),
		}), BACKGROUND_CONTEXT);
		const assistant = entries.assistant?.model?.find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") return detail;
		const call = assistant.content.find((part) => part.type === "toolCall" && part.id === callId);
		if (!call || call.type !== "toolCall") return detail;
		const toolResult = entries.result?.model?.find(
			(message) => message.role === "toolResult" && message.toolCallId === callId,
		);
		detail.tool = {
			name: call.name,
			arguments: call.arguments,
			...(toolResult === undefined ? {} : { result: toolResult }),
			callId,
			assistantEntryId,
			...(resultEntryId === undefined ? {} : { resultEntryId }),
		};
		return detail;
	}

	async state(): Promise<DurableAgentState> {
		const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
		const taskRecords = await this.harness.commit(async (tx) => {
			const records: AnyTaskRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanTasks(
					{ order: "descending" },
					100,
					cursor,
				);
				records.push(...page.items);
				cursor = page.next;
			} while (cursor && records.length < 500);
			return records.slice(0, 500);
		}, BACKGROUND_CONTEXT);
		const schedulerStates = new Map(
			inspection.tasks.map(({ record, state }) => [record.id as number, state.kind]),
		);
		const tasks = taskRecords.map((record) => taskView(record, schedulerStates.get(record.id as number)));
		const signature = tasks.map((task) =>
			`${task.id}:${task.status}:${task.outcomeStatus ?? ""}:${task.endedAt ?? ""}`
		).join("|");
		let runs = this.runCache?.signature === signature ? this.runCache.runs : undefined;
		if (!runs) {
			const conversationIds = [...new Set(tasks.map((task) => task.conversationId))];
			const entriesByConversation = await this.harness.commit(async (tx) => {
				const result = new Map<number, EntryRecord[]>();
				for (const conversationId of conversationIds) {
					const entries: EntryRecord[] = [];
					let cursor: Cursor | undefined;
					do {
						const page = await tx.scanEntries(
							{ conversationId: conversationId as never, order: "ascending" },
							200,
							cursor,
						);
						entries.push(...page.items);
						cursor = page.next;
					} while (cursor);
					result.set(conversationId, entries);
				}
				return result;
			}, BACKGROUND_CONTEXT);
			runs = deriveRuns(tasks, entriesByConversation);
			this.runCache = { signature, runs };
		}
		return {
			conversationId: this.conversation.id as number,
			scheduling: inspection.scheduling,
			activeTaskCount: inspection.tasks.length,
			pendingSubmissionCount: inspection.submissions.length,
			tasks,
			runs,
			submissions: inspection.submissions.map((submission) => ({ ...submission })),
		};
	}
}
