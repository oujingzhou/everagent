import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

const workspace = await mkdtemp(join(tmpdir(), "everagent-package-"));
const installDirectory = join(workspace, "install");

try {
	const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
	const packOutput = JSON.parse(run("npm", [
		"pack",
		"--json",
		"--ignore-scripts",
		"--pack-destination",
		workspace,
	]));
	const packed = packOutput[0];
	if (!packed?.filename || !Array.isArray(packed.files)) throw new Error("npm pack returned no package metadata");

	const filePaths = packed.files.map((file) => file.path);
	const invalidFiles = filePaths.filter((path) =>
		!path.startsWith("bin/") &&
		!path.startsWith("dist/") &&
		path !== "README.md" &&
		path !== "README.zh-CN.md" &&
		path !== "package.json"
	);
	if (invalidFiles.length > 0) throw new Error(`unexpected files in package: ${invalidFiles.join(", ")}`);
	for (const required of ["README.md", "README.zh-CN.md", "package.json", "bin/everagent.mjs", "dist/src/cli.js"]) {
		if (!filePaths.includes(required)) throw new Error(`required package file is missing: ${required}`);
	}

	const tarball = join(workspace, packed.filename);
	await mkdir(installDirectory, { recursive: true });
	run("npm", ["install", "--ignore-scripts", "--prefix", installDirectory, tarball]);
	const executable = join(installDirectory, "node_modules", ".bin", "everagent");
	const version = run(executable, ["--version"]);
	if (version !== packageJson.version) {
		throw new Error(`installed CLI version ${version} does not match package version ${packageJson.version}`);
	}
	const help = run(executable, ["--help"]);
	if (!help.includes("a durable agent harness")) throw new Error("installed CLI help did not run");

	console.log(`package smoke test passed: ${packed.filename} (${filePaths.length} files)`);
} finally {
	await rm(workspace, { recursive: true, force: true });
}
