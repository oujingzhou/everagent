import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export function initialThinkingLevel(settings: SettingsManager, model: Model<Api>): ModelThinkingLevel {
	return clampThinkingLevel(
		model,
		settings.getModelThinkingLevel(model.provider, model.id) ??
			settings.getDefaultThinkingLevel() ??
			"medium",
	);
}
