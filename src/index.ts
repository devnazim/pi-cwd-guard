import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const fileTools = new Set(["read", "write", "edit"]);
const mutatingFileTools = new Set(["write", "edit"]);

const scriptGuidance = [
	"When using bash, Python, Node.js, or other scripts, ask the user before intentionally reading, writing, creating, moving, or deleting files outside process.cwd().",
	"This extension blocks protected write/edit paths and asks before common destructive bash commands; bash/script checks are intentionally heuristic and are not a sandbox.",
].join(" ");

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

function scopedPath(cwd: string, resolvedPath: string): string {
	return isOutsideCwd(cwd, resolvedPath) ? resolvedPath : path.relative(cwd, resolvedPath);
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

async function confirmOrBlock(
	ctx: { hasUI: boolean; ui: { confirm(title: string, message?: string): Promise<boolean> } },
	title: string,
	message: string,
	blockReason: string,
) {
	if (!ctx.hasUI) {
		return { block: true, reason: `${blockReason} (no UI for confirmation)` };
	}

	const ok = await ctx.ui.confirm(title, message);
	if (!ok) return { block: true, reason: blockReason };
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${scriptGuidance}`,
	}));

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
