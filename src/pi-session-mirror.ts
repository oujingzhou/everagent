import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
	watchEvents,
	type AgentEventStream,
	type Conversation,
	type EntryRecord,
	type Harness,
} from "@earendil-works/pi-durable";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAllConversationEntries } from "./conversation-entries.ts";
import { getEveragentSessionsDir } from "./paths.ts";

function entryId(entry: EntryRecord, messageIndex?: number): string {
	return messageIndex === undefined ? `durable-${entry.id}` : `durable-${entry.id}-${messageIndex}`;
}

function textContent(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function timestamp(base: number, offset: number): string {
	return new Date(base + offset).toISOString();
}

async function existingHeader(path: string): Promise<SessionHeader | undefined> {
	try {
		const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
		if (!firstLine) return undefined;
		const value = JSON.parse(firstLine) as Partial<SessionHeader>;
		return value.type === "session" && typeof value.timestamp === "string"
			? value as SessionHeader
			: undefined;
	} catch {
		return undefined;
	}
}

export function piSessionMirrorPath(cwd: string, conversationId: number): string {
	return join(getEveragentSessionsDir(cwd), `everagent-conversation-${conversationId}.jsonl`);
}

export function buildPiSessionEntries(
	conversationId: number,
	cwd: string,
	agent: Awaited<ReturnType<Conversation["agent"]>>,
	entries: readonly EntryRecord[],
	createdAt = new Date().toISOString(),
): FileEntry[] {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: `everagent-${conversationId}`,
		timestamp: createdAt,
		cwd,
	};
	const result: FileEntry[] = [header];
	let parentId: string | null = null;
	let offset = 1;
	const append = (entry: SessionEntry): void => {
		result.push(entry);
		parentId = entry.id;
	};

	if (agent.model) {
		append({
			type: "model_change",
			id: "everagent-model",
			parentId,
			timestamp: timestamp(Date.parse(createdAt), offset++),
			provider: agent.model.provider,
			modelId: agent.model.modelId,
		});
	}
	append({
		type: "thinking_level_change",
		id: "everagent-thinking",
		parentId,
		timestamp: timestamp(Date.parse(createdAt), offset++),
		thinkingLevel: agent.thinkingLevel,
	});

	for (const durableEntry of entries) {
		if (durableEntry.kind === "pi.reset" || durableEntry.head !== undefined) {
			parentId = null;
			append({
				type: "custom",
				customType: "everagent.durable-boundary",
				id: entryId(durableEntry),
				parentId,
				timestamp: timestamp(Date.parse(createdAt), offset++),
				data: { durableEntryId: durableEntry.id, kind: durableEntry.kind },
			});
		}
		for (const [messageIndex, message] of (durableEntry.model ?? []).entries()) {
			const id = entryId(durableEntry, messageIndex);
			const entryTimestamp = timestamp(Date.parse(createdAt), offset++);
			if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
				append({
					type: "message",
					id,
					parentId,
					timestamp: entryTimestamp,
					message,
				});
			} else {
				append({
					type: "custom",
					customType: "everagent.durable-message",
					id,
					parentId,
					timestamp: entryTimestamp,
					data: {
						durableEntryId: durableEntry.id,
						kind: durableEntry.kind,
						role: message.role,
						content: textContent(message),
					},
				});
			}
		}
		if ((durableEntry.model?.length ?? 0) === 0 && durableEntry.kind !== "pi.reset") {
			append({
				type: "custom",
				customType: "everagent.durable-entry",
				id: entryId(durableEntry),
				parentId,
				timestamp: timestamp(Date.parse(createdAt), offset++),
				data: {
					durableEntryId: durableEntry.id,
					kind: durableEntry.kind,
					data: durableEntry.data,
				},
			});
		}
	}
	return result;
}

export async function syncPiSessionMirror(conversation: Conversation): Promise<string> {
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const cwd = agent.cwd ?? process.cwd();
	const path = piSessionMirrorPath(cwd, conversation.id as number);
	const header = await existingHeader(path);
	const entries = await readAllConversationEntries(conversation);
	const fileEntries = buildPiSessionEntries(
		conversation.id as number,
		cwd,
		agent,
		entries,
		header?.timestamp,
	);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${fileEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporaryPath, path);
	return path;
}

export class PiSessionMirror {
	private readonly conversation: Conversation;
	private stream?: AgentEventStream;
	private pending: Promise<unknown> = Promise.resolve();

	private constructor(conversation: Conversation) {
		this.conversation = conversation;
	}

	static async start(harness: Harness, conversation: Conversation): Promise<PiSessionMirror> {
		const mirror = new PiSessionMirror(conversation);
		mirror.stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
		mirror.stream.start(async () => {
			await mirror.sync();
		});
		await mirror.sync();
		return mirror;
	}

	sync(): Promise<string> {
		const next = this.pending.then(() => syncPiSessionMirror(this.conversation));
		this.pending = next.catch(() => undefined);
		return next;
	}

	async stop(): Promise<void> {
		await this.stream?.stop();
		await this.pending;
	}
}
