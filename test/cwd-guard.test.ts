import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cwdGuard from "../src/index.ts";

type Handler = (event: any, ctx: any) => any;

function registerHandlers(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	cwdGuard({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	return handlers;
}

test("treats configured paths as permission exceptions", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-cwd-guard-test-"));
	const cwd = path.join(root, "project");
	const allowedPath = path.join(root, "outside-access");
	const allowedDestructivePath = path.join(root, "destructive-rm");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");

	try {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			path.join(cwd, ".pi", "pi-cwd-guard.json"),
			`${JSON.stringify(
				{
					allowedOutsideCwdPaths: [allowedPath],
					allowedDestructiveBashPaths: [allowedDestructivePath],
				},
				null,
				2,
			)}\n`,
		);

		const handlers = registerHandlers();
		const toolCallHandler = handlers.get("tool_call");
		const beforeAgentStartHandler = handlers.get("before_agent_start");
		assert.ok(toolCallHandler);
		assert.ok(beforeAgentStartHandler);

		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => {
					throw new Error("Configured exception should not request confirmation");
				},
			},
		};
		assert.equal(
			await toolCallHandler({ toolName: "read", input: { path: path.join(allowedPath, "file.ts") } }, ctx),
			undefined,
		);
		assert.equal(
			await toolCallHandler(
				{ toolName: "read", input: { path: path.relative(cwd, path.join(allowedPath, "relative.ts")) } },
				ctx,
			),
			undefined,
		);
		assert.equal(
			await toolCallHandler(
				{ toolName: "bash", input: { command: `rm -rf ${path.join(allowedDestructivePath, "cache")}` } },
				ctx,
			),
			undefined,
		);

		const guidanceResult = await beforeAgentStartHandler({ systemPrompt: "Base prompt" }, { cwd });
		assert.match(
			guidanceResult.systemPrompt,
			/Before requesting permission, compare outside-cwd access targets against active allowedOutsideCwdPaths/,
		);
		assert.match(
			guidanceResult.systemPrompt,
			/allowedOutsideCwdPaths are permission exceptions.*resolve relative file-tool paths against process\.cwd\(\).*when every outside-cwd target is covered/,
		);
		assert.match(
			guidanceResult.systemPrompt,
			/allowedDestructiveBashPaths are permission exceptions.*do not ask solely because such an extension-recognized rm is destructive/,
		);
		assert.match(
			guidanceResult.systemPrompt,
			/Only for allowedDestructiveBashPaths exemptions, relative, dynamic, ambiguous/,
		);
		assert.match(
			guidanceResult.systemPrompt,
			new RegExp(`^  - ${allowedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
		);
		assert.match(
			guidanceResult.systemPrompt,
			new RegExp(`^  - ${allowedDestructivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
		);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
