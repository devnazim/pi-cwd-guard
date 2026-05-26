import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const fileTools = new Set(["read", "write", "edit"]);
const mutatingFileTools = new Set(["write", "edit"]);

const scriptGuidance = [
	"When using bash, Python, Node.js, or other scripts, ask the user before intentionally reading, writing, creating, moving, or deleting files outside process.cwd() unless the path is covered by configured pi-cwd-guard allowedOutsideCwdPaths.",
	"This extension blocks protected write/edit paths and asks before common destructive bash commands; bash/script checks are intentionally heuristic and are not a sandbox.",
].join(" ");

const configFileName = "pi-cwd-guard.json";
const piCmuxNotifySymbol = Symbol.for("pi.cmux.notify.v1");

const cwdGuardCommandUsage = [
	"Usage:",
	"  /cwd-guard",
	"  /cwd-guard show",
	"  /cwd-guard allow <path...> --project",
	"  /cwd-guard allow <path...> --global",
].join("\n");

const cwdGuardSubcommandCompletions = [
	{ value: "show", label: "show", description: "Display merged pi-cwd-guard configuration" },
	{ value: "allow ", label: "allow <path...>", description: "Add outside-cwd exceptions" },
];

const cwdGuardScopeFlagCompletions = [
	{ flag: "--project", description: "Save exception in this project's .pi config" },
	{ flag: "--global", description: "Save exception in the global pi config" },
];

const cwdGuardMenuChoices = {
	show: "Show active configuration",
	allowProject: "Allow outside-cwd path(s) for this project",
	allowGlobal: "Allow outside-cwd path(s) globally",
} as const;

interface CwdGuardConfig {
	allowedOutsideCwdPaths: string[];
}

interface PiCmuxNotification {
	title: string;
	subtitle?: string;
	body?: string;
	source?: string;
	type?: string;
	level?: "info" | "success" | "warning" | "error" | "warn";
	notify?: boolean;
	log?: boolean;
	status?:
		| {
				action?: "set";
				key?: string;
				text: string;
				icon?: string;
				color?: string;
			}
		| {
				action: "clear";
				key?: string;
			};
}

type PiCmuxNotifier = (notification: PiCmuxNotification) => void | Promise<void>;
type PiCmuxGlobal = { [piCmuxNotifySymbol]?: PiCmuxNotifier };

const hardProtectedDirectoryNames = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	"generated",
	".generated",
	"secrets",
	".secrets",
	"credentials",
	".credentials",
]);

const hardProtectedFileNames = new Set([
	".npmrc",
	".pypirc",
	"id_rsa",
	"id_ed25519",
	"kubeconfig",
	".kubeconfig",
]);

const hardProtectedExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".kubeconfig"]);

const runtimeConfigFileNames = new Set([
	"env.ts",
	"env.tsx",
	"env.js",
	"env.jsx",
	"env.mts",
	"env.cts",
	"env.mjs",
	"env.cjs",
	"runtime-config.ts",
	"runtime-config.js",
	"app-config.ts",
	"app-config.js",
]);

const runtimeConfigContentPatterns = [
	/\bBASE_URL\b/,
	/\bAPI_URL\b/,
	/\bPUBLIC_[A-Z0-9_]+\b/,
	/\b[A-Z0-9_]+_(?:API_)?KEY\b/,
	/\b[A-Z0-9_]+_TOKEN\b/,
	/\bCLIENT_ID\b/,
	/\bCLIENT_SECRET\b/,
	/\bprocess\.env\b/,
	/\bznv\b/i,
];

const dangerousBashPatterns = [
	{ label: "recursive/forced rm", pattern: /\brm\s+(?:-[^\s;|&]*[rf][^\s;|&]*|--recursive|--force)\b/i },
	{ label: "sudo", pattern: /\bsudo\b/i },
	{ label: "dangerous chmod", pattern: /\bchmod\b[^\n;|&]*(?:\b777\b|-\S*R\S*)/ },
	{ label: "recursive chown", pattern: /\bchown\b[^\n;|&]*-\S*R\S*/ },
	{ label: "git reset --hard", pattern: /\bgit\s+reset\b[^\n;|&]*--hard\b/i },
	{ label: "git clean -fd", pattern: /\bgit\s+clean\b(?=[^\n;|&]*-[^\s;|&]*f)(?=[^\n;|&]*-[^\s;|&]*d)/i },
];

function normalizeToolPath(inputPath: string): string {
	// Built-in file tools strip a leading @ before resolving paths.
	// Match that behavior so @/tmp/foo and @../foo are guarded correctly.
	return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

function isOutsideCwd(cwd: string, target: string): boolean {
	const relative = path.relative(cwd, target);
	return relative.startsWith("..") || path.isAbsolute(relative);
}

function expandHome(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) return path.join(os.homedir(), inputPath.slice(2));
	return inputPath;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

function getConfigPaths(cwd: string) {
	const globalConfigPath = path.join(getAgentDir(), "extensions", configFileName);
	const projectConfigPath = path.join(cwd, ".pi", configFileName);
	return { globalConfigPath, projectConfigPath };
}

function resolveConfiguredPath(configuredPath: string, baseDir: string): string {
	return path.resolve(baseDir, expandHome(configuredPath.trim()));
}

function getConfiguredPaths(configPath: string, baseDir: string): string[] {
	if (!existsSync(configPath)) return [];

	try {
		const rawConfig = JSON.parse(readFileSync(configPath, "utf-8")) as { allowedOutsideCwdPaths?: unknown };
		if (!Array.isArray(rawConfig.allowedOutsideCwdPaths)) return [];

		return rawConfig.allowedOutsideCwdPaths
			.filter((configuredPath): configuredPath is string => typeof configuredPath === "string" && configuredPath.trim().length > 0)
			.map((configuredPath) => resolveConfiguredPath(configuredPath, baseDir));
	} catch (error) {
		console.error(`Warning: Could not parse ${configPath}: ${error}`);
		return [];
	}
}

function loadConfig(cwd: string): CwdGuardConfig {
	const { globalConfigPath, projectConfigPath } = getConfigPaths(cwd);

	return {
		allowedOutsideCwdPaths: uniquePaths([
			...getConfiguredPaths(globalConfigPath, path.dirname(globalConfigPath)),
			...getConfiguredPaths(projectConfigPath, cwd),
		]),
	};
}

function isAllowedOutsideCwd(resolvedPath: string, config: CwdGuardConfig): boolean {
	return config.allowedOutsideCwdPaths.some((allowedPath) => !isOutsideCwd(allowedPath, resolvedPath));
}

function readConfigForWrite(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) return {};

	const rawConfig = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
	if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
		throw new Error("Config must be a JSON object");
	}
	return rawConfig as Record<string, unknown>;
}

function existingAllowedPaths(config: Record<string, unknown>): string[] {
	const allowedOutsideCwdPaths = config.allowedOutsideCwdPaths;
	if (!Array.isArray(allowedOutsideCwdPaths)) return [];
	return allowedOutsideCwdPaths.filter(
		(configuredPath): configuredPath is string => typeof configuredPath === "string" && configuredPath.trim().length > 0,
	);
}

function parseCommandArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	let tokenStarted = false;

	for (const char of args) {
		if (escaping) {
			current += char;
			escaping = false;
			tokenStarted = true;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			tokenStarted = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (tokenStarted) {
				tokens.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (escaping) throw new Error("Trailing escape in command arguments");
	if (quote) throw new Error("Unterminated quote in command arguments");
	if (tokenStarted) tokens.push(current);

	return tokens;
}

function scopedPath(cwd: string, resolvedPath: string): string {
	return isOutsideCwd(cwd, resolvedPath) ? resolvedPath : path.relative(cwd, resolvedPath);
}

function completeCwdGuardArgs(prefix: string) {
	const trimmedPrefix = prefix.trimStart();
	const leadingWhitespace = prefix.slice(0, prefix.length - trimmedPrefix.length);

	if (!trimmedPrefix.includes(" ")) {
		const completions = cwdGuardSubcommandCompletions.filter(({ value }) => value.startsWith(trimmedPrefix));
		return completions.length > 0
			? completions.map((completion) => ({ ...completion, value: `${leadingWhitespace}${completion.value}` }))
			: null;
	}

	if (!trimmedPrefix.startsWith("allow ")) return null;
	if (/\s--(?:project|global)(?:\s|$)/.test(prefix)) return null;

	const currentToken = prefix.match(/(?:^|\s)(\S*)$/)?.[1] ?? "";
	if (currentToken && !currentToken.startsWith("--")) return null;

	const beforeCurrentToken = prefix.slice(0, prefix.length - currentToken.length);
	const hasPathBeforeFlag = beforeCurrentToken
		.slice(beforeCurrentToken.indexOf("allow") + "allow".length)
		.trim().length > 0;
	if (!hasPathBeforeFlag) return null;

	const completions = cwdGuardScopeFlagCompletions.filter(({ flag }) => flag.startsWith(currentToken));
	return completions.length > 0
		? completions.map(({ flag, description }) => ({
				value: `${beforeCurrentToken}${flag}`,
				label: flag,
				description,
			}))
		: null;
}

function pathParts(targetPath: string): string[] {
	return targetPath.split(path.sep).filter(Boolean).map((part) => part.toLowerCase());
}

function isEnvFile(fileName: string): boolean {
	return fileName === ".env" || fileName.startsWith(".env.");
}

function getHardProtectedReason(cwd: string, resolvedPath: string): string | undefined {
	const checkedPath = scopedPath(cwd, resolvedPath);
	const parts = pathParts(checkedPath);
	const fileName = path.basename(checkedPath).toLowerCase();
	const extension = path.extname(fileName);

	if (isEnvFile(fileName)) return "environment file";
	if (hardProtectedFileNames.has(fileName)) return "credential file";
	if (hardProtectedExtensions.has(extension)) return "credential file extension";

	const protectedDirectory = parts.find((part) => hardProtectedDirectoryNames.has(part));
	if (protectedDirectory) return `protected directory: ${protectedDirectory}`;

	return undefined;
}

function isRuntimeConfigPath(cwd: string, resolvedPath: string): boolean {
	const checkedPath = scopedPath(cwd, resolvedPath);
	const parts = pathParts(checkedPath);
	const fileName = path.basename(checkedPath).toLowerCase();

	if (runtimeConfigFileNames.has(fileName)) return true;
	if (parts.includes("config") && /(?:^|[-_.])env\.(?:[cm]?[jt]sx?)$/.test(fileName)) return true;
	if (/(?:^|[-_.])runtime[-_.]?config\.(?:[cm]?[jt]sx?)$/.test(fileName)) return true;

	return false;
}

function getMutationText(toolName: string, input: unknown): string {
	if (!input || typeof input !== "object") return "";

	if (toolName === "write") {
		const content = (input as { content?: unknown }).content;
		return typeof content === "string" ? content : "";
	}

	if (toolName === "edit") {
		const edits = (input as { edits?: unknown }).edits;
		if (!Array.isArray(edits)) return "";

		return edits
			.map((edit) => {
				if (!edit || typeof edit !== "object") return "";
				const { oldText, newText } = edit as { oldText?: unknown; newText?: unknown };
				return [oldText, newText].filter((text): text is string => typeof text === "string").join("\n");
			})
			.join("\n");
	}

	return "";
}

function getRuntimeConfigReason(cwd: string, toolName: string, resolvedPath: string, input: unknown): string | undefined {
	if (isRuntimeConfigPath(cwd, resolvedPath)) return "runtime config path";

	const mutationText = getMutationText(toolName, input);
	if (!mutationText) return undefined;

	const matchedPattern = runtimeConfigContentPatterns.find((pattern) => pattern.test(mutationText));
	return matchedPattern ? "runtime config-like content" : undefined;
}

function getPiCmuxNotifier(): PiCmuxNotifier | undefined {
	return (globalThis as unknown as PiCmuxGlobal)[piCmuxNotifySymbol];
}

function sendPiCmuxNotification(notification: PiCmuxNotification): void {
	const notify = getPiCmuxNotifier();
	if (typeof notify !== "function") return;

	void Promise.resolve(notify(notification)).catch(() => {
		// Optional cmux notifications must never affect guard behavior.
	});
}

function notifyPermissionRequest(title: string): void {
	sendPiCmuxNotification({
		source: "cwd-guard",
		type: "permission_request",
		title: "pi-cwd-guard needs permission",
		subtitle: title,
		body: "Check pi to approve or deny.",
		level: "warning",
		status: { key: "cwd-guard", text: "permission", icon: "shield", color: "#f59e0b" },
	});
}

function clearPermissionNotification(): void {
	sendPiCmuxNotification({
		source: "cwd-guard",
		type: "permission_request_resolved",
		title: "pi-cwd-guard permission resolved",
		notify: false,
		log: false,
		status: { action: "clear", key: "cwd-guard" },
	});
}

async function confirmWithNotification(
	ctx: { ui: { confirm(title: string, message?: string): Promise<boolean> } },
	title: string,
	message: string,
): Promise<boolean> {
	notifyPermissionRequest(title);
	try {
		return await ctx.ui.confirm(title, message);
	} finally {
		clearPermissionNotification();
	}
}

async function confirmOrBlock(
	ctx: { hasUI: boolean; ui: { confirm(title: string, message?: string): Promise<boolean> } },
	title: string,
	message: string,
	blockReason: string,
) {
	if (!ctx.hasUI) {
		return { block: true, reason: `${blockReason} (no UI for confirmation)` };
	}

	const ok = await confirmWithNotification(ctx, title, message);
	if (!ok) return { block: true, reason: blockReason };
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${scriptGuidance}`,
	}));

	pi.registerCommand("cwd-guard", {
		description: "Show or configure pi-cwd-guard outside-cwd exceptions",
		getArgumentCompletions: completeCwdGuardArgs,
		handler: async (args, ctx) => {
			let tokens: string[];
			try {
				tokens = parseCommandArgs(args);
			} catch (error) {
				ctx.ui.notify(`${error instanceof Error ? error.message : error}\n\n${cwdGuardCommandUsage}`, "warning");
				return;
			}

			if (tokens.length === 0) {
				if (!ctx.hasUI) {
					tokens = ["show"];
				} else {
					const selected = await ctx.ui.select("pi-cwd-guard", Object.values(cwdGuardMenuChoices));
					if (!selected) return;

					if (selected === cwdGuardMenuChoices.show) {
						tokens = ["show"];
					} else {
						const paths = await ctx.ui.input("Outside-cwd path(s)", "e.g. /tmp ~/shared-workspace");
						if (!paths?.trim()) return;

						let requestedPaths: string[];
						try {
							requestedPaths = parseCommandArgs(paths);
						} catch (error) {
							ctx.ui.notify(`${error instanceof Error ? error.message : error}\n\n${cwdGuardCommandUsage}`, "warning");
							return;
						}

						tokens = [
							"allow",
							...requestedPaths,
							selected === cwdGuardMenuChoices.allowProject ? "--project" : "--global",
						];
					}
				}
			}

			if (tokens[0] === "show") {
				const { globalConfigPath, projectConfigPath } = getConfigPaths(ctx.cwd);
				const config = loadConfig(ctx.cwd);
				ctx.ui.notify(
					[
						"pi-cwd-guard configuration:",
						"",
						`Project config: ${projectConfigPath}`,
						`Global config: ${globalConfigPath}`,
						"",
						"Allowed outside-cwd paths:",
						...(config.allowedOutsideCwdPaths.length > 0
							? config.allowedOutsideCwdPaths.map((allowedPath) => `  - ${allowedPath}`)
							: ["  (none)"]),
					].join("\n"),
					"info",
				);
				return;
			}

			if (tokens[0] !== "allow") {
				ctx.ui.notify(cwdGuardCommandUsage, "warning");
				return;
			}

			const useProjectConfig = tokens.includes("--project");
			const useGlobalConfig = tokens.includes("--global");
			const unknownFlags = tokens.slice(1).filter((token) => token.startsWith("--") && token !== "--project" && token !== "--global");
			const requestedPaths = tokens.slice(1).filter((token) => !token.startsWith("--") && token.trim().length > 0);

			if (unknownFlags.length > 0 || useProjectConfig === useGlobalConfig || requestedPaths.length === 0) {
				ctx.ui.notify(cwdGuardCommandUsage, "warning");
				return;
			}

			const { globalConfigPath, projectConfigPath } = getConfigPaths(ctx.cwd);
			const configPath = useGlobalConfig ? globalConfigPath : projectConfigPath;
			const resolvedPaths = requestedPaths.map((requestedPath) => resolveConfiguredPath(requestedPath, ctx.cwd));

			if (useGlobalConfig) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Global pi-cwd-guard config updates require UI confirmation.", "warning");
					return;
				}

				const ok = await confirmWithNotification(
					ctx,
					"Update global pi-cwd-guard config?",
					[
						`Config: ${configPath}`,
						"Paths:",
						...resolvedPaths.map((resolvedPath) => `  - ${resolvedPath}`),
					].join("\n"),
				);
				if (!ok) return;
			}

			try {
				const config = readConfigForWrite(configPath);
				config.allowedOutsideCwdPaths = uniquePaths([...existingAllowedPaths(config), ...resolvedPaths]);
				mkdirSync(path.dirname(configPath), { recursive: true });
				writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

				ctx.ui.notify(
					[
						`Updated ${useGlobalConfig ? "global" : "project"} pi-cwd-guard config: ${configPath}`,
						"Added paths:",
						...resolvedPaths.map((resolvedPath) => `  - ${resolvedPath}`),
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Could not update pi-cwd-guard config: ${error instanceof Error ? error.message : error}`, "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return;

			const matches = dangerousBashPatterns.filter(({ pattern }) => pattern.test(command));
			if (matches.length === 0) return;

			return confirmOrBlock(
				ctx,
				"Allow potentially destructive bash command?",
				[`Matched: ${matches.map(({ label }) => label).join(", ")}`, "", command].join("\n"),
				"Potentially destructive bash command blocked",
			);
		}

		if (!fileTools.has(event.toolName)) return;

		const inputPath = (event.input as { path?: unknown }).path;
		if (typeof inputPath !== "string") return;

		const cwd = ctx.cwd;
		const normalizedPath = normalizeToolPath(inputPath);
		const resolvedPath = path.resolve(cwd, normalizedPath);

		if (mutatingFileTools.has(event.toolName)) {
			const hardProtectedReason = getHardProtectedReason(cwd, resolvedPath);
			if (hardProtectedReason) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked ${event.toolName} to protected path: ${inputPath}`, "warning");
				}
				return {
					block: true,
					reason: `${event.toolName} blocked for protected path (${hardProtectedReason}): ${resolvedPath}`,
				};
			}

			const runtimeConfigReason = getRuntimeConfigReason(cwd, event.toolName, resolvedPath, event.input);
			if (runtimeConfigReason) {
				const result = await confirmOrBlock(
					ctx,
					`Allow ${event.toolName} to runtime config?`,
					[
						`Reason: ${runtimeConfigReason}`,
						`Path: ${inputPath}`,
						...(normalizedPath === inputPath ? [] : [`Normalized: ${normalizedPath}`]),
						`Resolved: ${resolvedPath}`,
					].join("\n"),
					`${event.toolName} to runtime config blocked`,
				);
				if (result) return result;
			}
		}

		if (!isOutsideCwd(cwd, resolvedPath)) return;
		if (isAllowedOutsideCwd(resolvedPath, loadConfig(cwd))) return;

		return confirmOrBlock(
			ctx,
			`Allow ${event.toolName} outside cwd?`,
			[
				`Path: ${inputPath}`,
				...(normalizedPath === inputPath ? [] : [`Normalized: ${normalizedPath}`]),
				`Resolved: ${resolvedPath}`,
				`CWD: ${cwd}`,
			].join("\n"),
			`Blocked by user: ${event.toolName} outside cwd`,
		);
	});
}
