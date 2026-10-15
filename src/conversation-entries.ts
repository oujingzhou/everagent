import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryRecord } from "@earendil-works/pi-durable";

const DEFAULT_PAGE_SIZE = 1000;

export async function readAllConversationEntries(
	conversation: Conversation,
	order: "ascending" | "descending" = "ascending",
	pageSize = DEFAULT_PAGE_SIZE,
): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order }, pageSize, cursor, BACKGROUND_CONTEXT);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return entries;
}
