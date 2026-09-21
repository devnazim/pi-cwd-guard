import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

for (const entry of ["../", "../index.ts"]) {
	test(`loads ${entry} through Pi's extension loader`, async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-cwd-guard-compat-"));
		try {
			const result = await discoverAndLoadExtensions(
				[fileURLToPath(new URL(entry, import.meta.url))],
				root,
				path.join(root, "agent"),
			);
			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const extension = result.extensions[0];
			assert.equal(extension.handlers.get("tool_call")?.length, 1);
			assert.equal(extension.handlers.get("before_agent_start")?.length, 1);

			const command = extension.commands.get("cwd-guard");
			assert.ok(command);
			assert.equal(typeof command.handler, "function");
			assert.deepEqual(
				(await command.getArgumentCompletions?.("allow /tmp --p"))?.map(({ value }) => value),
				["allow /tmp --project"],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
