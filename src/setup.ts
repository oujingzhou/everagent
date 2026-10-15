import type { AuthEvent, AuthPrompt, Model } from "@earendil-works/pi-ai";
import {
	ExtensionSelectorComponent,
	initTheme,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ProcessTerminal,
	Text,
	TuiAltScreen,
	type Component,
	type Terminal,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { initializeEveragentTheme } from "./theme.ts";

type LoginProvider = ConstructorParameters<typeof OAuthSelectorComponent>[1][number];

function loginProviders(models: ModelRuntime): LoginProvider[] {
	const options: LoginProvider[] = [];
	for (const provider of models.getProviders()) {
		const status = models.getProviderAuthStatus(provider.id);
		const configured = status.configured
			? {
					type: models.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: status.label ?? status.source,
				}
			: undefined;
		if (provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				...(configured ? { status: configured } : {}),
				subscription: provider.auth.oauth.isSubscription === true,
			});
		}
		if (provider.auth.apiKey?.login) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				...(configured ? { status: configured } : {}),
				subscription: provider.auth.oauth?.isSubscription === true,
			});
		}
	}
	return options.sort((left, right) => left.name.localeCompare(right.name));
}

function notifyDialog(dialog: LoginDialogComponent, event: AuthEvent): void {
	if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
	else if (event.type === "device_code") {
		dialog.showDeviceCode(event);
		dialog.showWaiting("Waiting for authentication...");
	} else if (event.type === "info") dialog.showInfo(event.message, event.links);
	else dialog.showProgress(event.message);
}

export async function runModelSetup(
	models: ModelRuntime,
	settings: SettingsManager,
	agentDir: string,
	terminal: Terminal = new ProcessTerminal(),
): Promise<Model<any> | undefined> {
	initializeEveragentTheme(agentDir, settings.getTheme(), initTheme);
	const tui = new TuiAltScreen(terminal, true, join(agentDir, "logs"));
	const root = new Container();
	tui.setLayoutRoot(root);

	let settle: ((model: Model<any> | undefined) => void) | undefined;
	const result = new Promise<Model<any> | undefined>((resolve) => {
		settle = resolve;
	});
	let finished = false;

	const finish = (model: Model<any> | undefined): void => {
		if (finished) return;
		finished = true;
		tui.stop();
		settle?.(model);
	};
	const show = (component: Container, focus: Component, message?: string): void => {
		root.clear();
		if (message) root.addChild(new Text(message, 1, 1));
		root.addChild(component);
		tui.setFocus(focus);
		tui.requestRender();
	};
	const showPrompt = (
		dialog: LoginDialogComponent,
		prompt: AuthPrompt,
		restore: () => void,
	): Promise<string> => {
		if (prompt.type !== "select") {
			return prompt.type === "manual_code"
				? dialog.showManualInput(prompt.message)
				: dialog.showPrompt(prompt.message, prompt.placeholder);
		}
		return new Promise((resolve, reject) => {
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				prompt.options.map((option) => option.label),
				(label) => {
					restore();
					const selected = prompt.options.find((option) => option.label === label);
					if (selected) resolve(selected.id);
					else reject(new Error("Login cancelled"));
				},
				() => {
					restore();
					reject(new Error("Login cancelled"));
				},
			);
			show(selector, selector);
		});
	};

	const showModelSelector = (): void => {
		const available = models.getAvailableSnapshot();
		if (available.length === 0) {
			showProviderSelector("Authentication completed, but no models are available for that provider.");
			return;
		}
		const selector = new ModelSelectorComponent(
			tui,
			undefined,
			models,
			[],
			(model) => {
				void (async () => {
					settings.setDefaultModelAndProvider(model.provider, model.id);
					await settings.flush();
					selector.dispose();
					finish(model);
				})();
			},
			() => {
				selector.dispose();
				showProviderSelector();
			},
		);
		show(selector, selector, "Select the default model for EverAgent.");
	};

	const startLogin = async (provider: LoginProvider): Promise<void> => {
		const dialog = new LoginDialogComponent(tui, provider.id, () => {}, provider.name);
		const restoreDialog = (): void => show(dialog, dialog);
		show(dialog, dialog);
		try {
			await models.login(
				provider.id,
				provider.authType,
				{
					signal: dialog.signal,
					prompt: (prompt) => showPrompt(dialog, prompt, restoreDialog),
					notify: (event) => notifyDialog(dialog, event),
				},
				{ getDeviceId: () => settings.getOrCreateDeviceId() },
			);
			showModelSelector();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showProviderSelector(message === "Login cancelled" ? undefined : `Login failed: ${message}`);
		}
	};

	const showProviderSelector = (message?: string): void => {
		const providers = loginProviders(models);
		if (providers.length === 0) {
			finish(undefined);
			return;
		}
		const selector = new OAuthSelectorComponent(
			"login",
			providers,
			(providerId, authType) => {
				const provider = providers.find(
					(candidate) => candidate.id === providerId && candidate.authType === authType,
				);
				if (provider) void startLogin(provider);
			},
			() => finish(undefined),
		);
		show(selector, selector, message ?? "Welcome to EverAgent. Configure a model provider to continue.");
	};

	tui.start();
	showProviderSelector();
	return result;
}
