export type EveragentArgs = {
	database?: string;
	model?: string;
	cwd?: string;
	tui: boolean;
	web: boolean;
	resume: boolean;
	port?: number;
	prompt?: string;
	help: boolean;
	version: boolean;
};

export function parseEveragentArgs(args: readonly string[]): EveragentArgs {
	const options: EveragentArgs = { help: false, version: false, tui: false, web: false, resume: false };
	const prompt: string[] = [];
	let positionalOnly = false;

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === undefined) continue;
		if (positionalOnly) {
			prompt.push(argument);
			continue;
		}
		if (argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--version" || argument === "-v") {
			options.version = true;
			continue;
		}
		if (argument === "--web") {
			options.web = true;
			continue;
		}
		if (argument === "--tui") {
			options.tui = true;
			continue;
		}
		if (argument === "--resume") {
			options.resume = true;
			continue;
		}
		if (
			argument === "--db" ||
			argument === "--database" ||
			argument === "--model" ||
			argument === "--cwd" ||
			argument === "--port"
		) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
			if (argument === "--db" || argument === "--database") options.database = value;
			else if (argument === "--model") options.model = value;
			else if (argument === "--cwd") options.cwd = value;
			else {
				const port = Number(value);
				if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
				options.port = port;
			}
			continue;
		}
		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		prompt.push(argument);
	}

	if (prompt.length > 0) options.prompt = prompt.join(" ");
	return options;
}
