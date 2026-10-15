import type { Conversation, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { readAllConversationEntries } from "../src/conversation-entries.ts";

describe("readAllConversationEntries", () => {
	it("follows every durable pagination cursor", async () => {
		const entries = [1, 2, 3].map((id) => ({
			id,
			conversationId: 1,
			kind: "test",
		})) as unknown as EntryRecord[];
		const cursors: Array<Cursor | undefined> = [];
		const conversation = {
			entries: async (_query: unknown, _limit: number, cursor: Cursor | undefined) => {
				cursors.push(cursor);
				if (!cursor) return { items: entries.slice(0, 2), next: { offset: 2 } };
				return { items: entries.slice(2) };
			},
		} as unknown as Conversation;

		expect(await readAllConversationEntries(conversation, "ascending", 2)).toEqual(entries);
		expect(cursors).toEqual([undefined, { offset: 2 }]);
	});
});
