import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EVERAGENT_THEME_NAME = "everagent";

export const EVERAGENT_THEME = {
	$schema: "https://pi.dev/schemas/theme.schema.json",
	name: EVERAGENT_THEME_NAME,
	appearance: "dark",
	vars: {
		text: "#e7e2dd",
		muted: "#808b96",
		coral: "#e48a7a",
		gold: "#eab65d",
		blue: "#4f8eb3",
		green: "#72b596",
		red: "#e4776b",
		userBg: "#382727",
		selectBg: "#263844",
		customBg: "#352f24",
		toolPending: "#26333b",
		toolSuccess: "#25372f",
		toolError: "#3b2929",
	},
	colors: {
		accent: "coral",
		border: "blue",
		borderAccent: "gold",
		borderMuted: "#536b78",
		success: "green",
		error: "red",
		warning: "gold",
		muted: "muted",
		dim: "#69737c",
		text: "text",
		thinkingText: "#a9a29c",
		selectedBg: "selectBg",
		scrollbarTrack: "#30383d",
		scrollbarThumb: "blue",
		searchMatchBg: "customBg",
		searchMatchText: "gold",
		userMessageBg: "userBg",
		userMessageText: "text",
		customMessageBg: "customBg",
		customMessageText: "text",
		customMessageLabel: "gold",
		toolPendingBg: "toolPending",
		toolSuccessBg: "toolSuccess",
		toolErrorBg: "toolError",
		toolTitle: "gold",
		toolOutput: "#b4aca5",
		mdHeading: "gold",
		mdLink: "blue",
		mdLinkUrl: "muted",
		mdCode: "coral",
		mdCodeBlock: "#9bc4ad",
		mdCodeBlockBorder: "#536b78",
		mdQuote: "#a9a29c",
		mdQuoteBorder: "blue",
		mdHr: "#536b78",
		mdListBullet: "coral",
		toolDiffAdded: "green",
		toolDiffRemoved: "red",
		toolDiffContext: "muted",
		syntaxComment: "muted",
		syntaxKeyword: "coral",
		syntaxFunction: "gold",
		syntaxVariable: "#83b6d1",
		syntaxString: "#b6c991",
		syntaxNumber: "green",
		syntaxType: "blue",
		syntaxOperator: "#b4aca5",
		syntaxPunctuation: "muted",
		thinkingOff: "#69737c",
		thinkingMinimal: "#62869a",
		thinkingLow: "blue",
		thinkingMedium: "#8f9eae",
		thinkingHigh: "gold",
		thinkingXhigh: "coral",
		thinkingMax: "red",
		bashMode: "green",
	},
	export: {
		pageBg: "#17191a",
		cardBg: "#202326",
		infoBg: "#352f24",
	},
} as const;

export function ensureEveragentTheme(agentDir: string): string {
	const themesDir = join(agentDir, "themes");
	const path = join(themesDir, `${EVERAGENT_THEME_NAME}.json`);
	if (!existsSync(path)) {
		mkdirSync(themesDir, { recursive: true, mode: 0o700 });
		writeFileSync(path, `${JSON.stringify(EVERAGENT_THEME, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
	return path;
}

export function initializeEveragentTheme(
	agentDir: string,
	themeName: string | undefined,
	initTheme: (name?: string, enableWatcher?: boolean) => void,
): string {
	ensureEveragentTheme(agentDir);
	const selectedTheme = themeName ?? EVERAGENT_THEME_NAME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		initTheme(selectedTheme, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	return selectedTheme;
}
