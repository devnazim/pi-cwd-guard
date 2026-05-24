import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const guardedTools = new Set(["read", "write", "edit"]);
const scriptGuidance =
	"When using bash, Python, Node.js, or other scripts, ask the user before intentionally reading, writing, creating, moving, or deleting files outside process.cwd().";

function normalizeToolPath(inputPath: string): string {
	// Built-in file tools strip a leading @ before resolving paths.
	// Match that behavior so @/tmp/foo and @../foo are guarded correctly.
	return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

function isOutsideCwd(cwd: string, target: string): boolean {
	const relative = path.relative(cwd, target);
	return relative.startsWith("..") || path.isAbsolute(relative);
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${scriptGuidance}`,
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (!guardedTools.has(event.toolName)) return;

		const inputPath = (event.input as { path?: unknown }).path;
		if (typeof inputPath !== "string") return;

		const cwd = ctx.cwd;
		const normalizedPath = normalizeToolPath(inputPath);
		const resolvedPath = path.resolve(cwd, normalizedPath);

		if (!isOutsideCwd(cwd, resolvedPath)) return;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `${event.toolName} blocked outside cwd: ${resolvedPath}`,
			};
		}

		const ok = await ctx.ui.confirm(
			`Allow ${event.toolName} outside cwd?`,
			[
				`Path: ${inputPath}`,
				...(normalizedPath === inputPath ? [] : [`Normalized: ${normalizedPath}`]),
				`Resolved: ${resolvedPath}`,
				`CWD: ${cwd}`,
			].join("\n"),
		);

		if (!ok) {
			return {
				block: true,
				reason: `Blocked by user: ${event.toolName} outside cwd`,
			};
		}
	});
}
