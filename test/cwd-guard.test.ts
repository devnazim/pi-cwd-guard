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
			/Before changing actual application configuration, runtime configuration, or deployment configuration.*ask the user for permission unless the user's current request explicitly authorizes that exact change/,
		);
		assert.match(
			guidanceResult.systemPrompt,
			/Do not ask merely because a file, directory, or symbol contains config, settings, or env/,
		);
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

test("leaves application configuration semantics to agent guidance instead of path heuristics", async () => {
	const toolCallHandler = registerHandlers().get("tool_call");
	assert.ok(toolCallHandler);

	const ctx = {
		cwd: path.join(os.tmpdir(), "project"),
		hasUI: false,
		ui: {
			confirm: async () => {
				throw new Error("In-cwd configuration paths should not request tool confirmation");
			},
		},
	};
	const writes = [
		{
			path: "src/features/settings/page.tsx",
			content: "export function SettingsPage() { return null; }",
		},
		{
			path: "src/config/user-preferences.ts",
			content: "export const API_URL = process.env.PUBLIC_API_URL;",
		},
		{
			path: "docker-compose.yml",
			content: "services:\n  app:\n    image: example/app",
		},
	];

	for (const input of writes) {
		assert.equal(await toolCallHandler({ toolName: "write", input }, ctx), undefined);
	}
	assert.equal(
		await toolCallHandler(
			{
				toolName: "edit",
				input: {
					path: "src/config/user-preferences.ts",
					edits: [
						{
							oldText: "export const API_URL = process.env.PUBLIC_API_URL;",
							newText: "export const API_URL = process.env.PUBLIC_API_ENDPOINT;",
						},
					],
				},
			},
			ctx,
		),
		undefined,
	);
});

test("retains unambiguous tool-level protections", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-cwd-guard-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");

	try {
		const toolCallHandler = registerHandlers().get("tool_call");
		assert.ok(toolCallHandler);

		const cwd = path.join(root, "project");
		const ctx = {
			cwd,
			hasUI: false,
			ui: {
				confirm: async () => {
					throw new Error("No-UI guards should block without confirmation");
				},
			},
		};

		const protectedResult = await toolCallHandler(
			{ toolName: "write", input: { path: ".env", content: "API_KEY=secret" } },
			ctx,
		);
		assert.equal(protectedResult.block, true);
		assert.match(protectedResult.reason, /environment file/);

		const outsideResult = await toolCallHandler(
			{
				toolName: "write",
				input: { path: path.join(root, "outside", "app-config.ts"), content: "export default {};" },
			},
			ctx,
		);
		assert.equal(outsideResult.block, true);
		assert.match(outsideResult.reason, /write outside cwd/);

		const destructiveResult = await toolCallHandler(
			{ toolName: "bash", input: { command: "rm -rf cache" } },
			ctx,
		);
		assert.equal(destructiveResult.block, true);
		assert.match(destructiveResult.reason, /Potentially destructive bash command blocked/);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
});