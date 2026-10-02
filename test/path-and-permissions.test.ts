import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { createWriteTool, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cwdGuard from "../src/index.ts";

type Handler = (event: any, ctx: any) => any;

async function piWriteTarget(cwd: string, inputPath: string): Promise<string> {
	let target: string | undefined;
	const tool = createWriteTool(cwd, {
		operations: {
			mkdir: async () => {},
			writeFile: async (absolutePath) => { target = absolutePath; },
		},
	});
	await tool.execute("path-probe", { path: inputPath, content: "" });
	assert.ok(target);
	return target;
}

function fixture(t: TestContext) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-cwd-guard-paths-"));
	const cwd = path.join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});
	mkdirSync(cwd);

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	cwdGuard({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI);
	const toolCall = handlers.get("tool_call");
	const command = commands.get("cwd-guard");
	assert.ok(toolCall);
	assert.ok(command);
	return { root, cwd, toolCall, command };
}

test("normalizes home, @, file URLs, and Unicode spaces before outside-cwd checks", async (t) => {
	const { root, cwd, toolCall } = fixture(t);
	const home = path.join(root, "home");
	t.mock.method(os, "homedir", () => home);
	const dialogs: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			confirm: async (_title: string, message: string) => {
				dialogs.push(message);
				return false;
			},
		},
	};
	const outside = path.join(root, "outside access", "file.ts");
	const cases: [string, string][] = [
		["~", home],
		["@~", home],
		["~/file.ts", path.join(home, "file.ts")],
		["@~/file.ts", path.join(home, "file.ts")],
		["@../file.ts", path.join(root, "file.ts")],
		[`@${outside}`, outside],
		[pathToFileURL(outside).href, outside],
		[`@${pathToFileURL(outside).href}`, outside],
	];
	if (process.platform === "win32") {
		cases.push(["~\\file.ts", path.join(home, "file.ts")], ["@~\\file.ts", path.join(home, "file.ts")]);
	}
	for (const space of "\u00A0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000") {
		cases.push([outside.replace("outside access", `outside${space}access`), outside]);
	}
	// URL decoding comes after Unicode-space replacement in Pi.
	const encodedSpace = path.join(root, "outside\u00A0access", "file.ts");
	cases.push([pathToFileURL(encodedSpace).href, encodedSpace]);
	for (const [inputPath, resolved] of cases) {
		for (const toolName of ["read", "write", "edit"]) {
			const result = await toolCall({ toolName, input: { path: inputPath } }, ctx);
			assert.equal(result.block, true, inputPath);
			assert.ok(dialogs.at(-1)?.includes(`Resolved: ${resolved}\n`), inputPath);
		}
	}
	assert.equal(dialogs.length, cases.length * 3);

	// Do not trim paths, decode ordinary filenames, or strip more than one @.
	for (const inputPath of ["@@../file.ts", "%2Eenv", " file://not-a-url", ...(process.platform === "win32" ? [] : ["~\\file.ts"])]) {
		assert.equal(await toolCall({ toolName: "write", input: { path: inputPath } }, ctx), undefined);
	}
	assert.equal(dialogs.length, cases.length * 3);
});

test("checks protected names after tilde expansion and file URL decoding, before exceptions", async (t) => {
	const { root, cwd, toolCall } = fixture(t);
	const home = path.join(root, "home");
	t.mock.method(os, "homedir", () => home);
	mkdirSync(path.join(cwd, ".pi"));
	writeFileSync(path.join(cwd, ".pi", "pi-cwd-guard.json"), JSON.stringify({ allowedOutsideCwdPaths: [root] }));
	const ctx = {
		cwd,
		hasUI: false,
		ui: { confirm: async () => { throw new Error("Protected paths must not open dialogs"); } },
	};
	const cases: [string, string][] = [
		["@~/.env", "environment file"],
		[pathToFileURL(path.join(cwd, ".env.local")).href.replace(".env", "%2Eenv"), "environment file"],
		[`@${pathToFileURL(path.join(cwd, "secrets", "value.ts")).href.replace("/secrets/", "/%73ecrets/")}`, "protected directory: secrets"],
		[pathToFileURL(path.join(cwd, "credentials.json")).href.replace("credentials.json", "%63redentials.json"), "credential file"],
		[pathToFileURL(path.join(home, "private.key")).href.replace(".key", "%2Ekey"), "credential file extension"],
	];
	for (const [inputPath, reason] of cases) {
		for (const toolName of ["write", "edit"]) {
			const result = await toolCall({ toolName, input: { path: inputPath } }, ctx);
			assert.equal(result.block, true, inputPath);
			assert.ok(result.reason.includes(reason), inputPath);
		}
	}
	assert.equal(await toolCall({ toolName: "read", input: { path: "@~/.env" } }, ctx), undefined);
	assert.equal(await toolCall({ toolName: "read", input: { path: pathToFileURL(path.join(home, "file.ts")).href } }, ctx), undefined);
});

test("matches installed Pi Windows shell targets with portable Windows resolution", async (t) => {
	const cwd = "C:\\project";
	// Mock filesystem checks before Windows simulation. No real files are accessed.
	t.mock.method(fs, "existsSync", () => false);
	t.mock.property(process, "platform", "win32");
	t.mock.method(process, "cwd", () => cwd);
	for (const name of ["resolve", "normalize", "isAbsolute", "join", "relative", "dirname", "basename", "extname", "parse", "format"] as const) {
		t.mock.method(path, name, path.win32[name]);
	}
	t.mock.property(path, "sep", path.win32.sep);
	t.mock.property(path, "delimiter", path.win32.delimiter);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});

	const handlers = new Map<string, Handler>();
	cwdGuard({
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	const toolCall = handlers.get("tool_call");
	assert.ok(toolCall);
	let message = "";
	const ctx = {
		cwd,
		hasUI: true,
		ui: { confirm: async (_title: string, prompt: string) => { message = prompt; return false; } },
	};
	for (const inputPath of ["/c/project/file.txt", "@/c/project/file.txt", "/mnt/c/project/file.txt", "/cygdrive/c/project/file.txt", "/c/other/file.txt", "/d/project/file.txt"]) {
		const target = await piWriteTarget(cwd, inputPath);
		const relative = path.win32.relative(cwd, target);
		const outside = relative === ".." || relative.startsWith("..\\") || path.win32.isAbsolute(relative);
		message = "";
		for (const toolName of ["read", "write", "edit"]) {
			const result = await toolCall({ toolName, input: { path: inputPath } }, ctx);
			assert.equal(Boolean(result?.block), outside, `${VERSION}: ${inputPath} -> ${target}`);
			if (outside) assert.ok(message.includes(`Resolved: ${target}\n`), `${VERSION}: ${message}`);
			else assert.equal(message, "");
		}
	}
});

test("matches installed Pi Windows shell targets on native Windows", { skip: process.platform !== "win32" }, async (t) => {
	const { root, cwd, toolCall } = fixture(t);
	const drive = path.parse(root).root[0].toLowerCase();
	const resolvedPath = path.join(root, "outside.ts");
	const suffix = resolvedPath.slice(3).replaceAll("\\", "/");
	let message = "";
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			confirm: async (_title: string, prompt: string) => { message = prompt; return false; },
			notify: () => {},
		},
	};
	for (const prefix of [`/${drive}/`, `/mnt/${drive}/`, `/cygdrive/${drive}/`]) {
		message = "";
		const result = await toolCall({ toolName: "read", input: { path: `@${prefix}${suffix}` } }, ctx);
		assert.equal(result.block, true);
		const target = await piWriteTarget(cwd, `@${prefix}${suffix}`);
		assert.ok(message.includes(`Resolved: ${target}\n`));
		const protectedResult = await toolCall({ toolName: "edit", input: { path: `${prefix}${suffix}/.env` } }, ctx);
		assert.equal(protectedResult.block, true);
		assert.match(protectedResult.reason, /environment file/);
	}

	// A shell path that newer Pi resolves inside cwd must stay outside on 0.80.3.
	const inputPath = `/${drive}/${path.join(cwd, "file.txt").slice(3).replaceAll("\\", "/")}`;
	const target = await piWriteTarget(cwd, inputPath);
	const relative = path.relative(cwd, target);
	const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	message = "";
	const result = await toolCall({ toolName: "write", input: { path: inputPath } }, ctx);
	assert.equal(Boolean(result?.block), outside, `${VERSION}: ${inputPath} -> ${target}`);
	if (outside) assert.ok(message.includes(`Resolved: ${target}\n`));
	else assert.equal(message, "");
});

test("serializes file, bash, and global-config confirmations and returns each decision to its caller", { timeout: 5000 }, async (t) => {
	const { cwd, toolCall, command } = fixture(t);
	const dialogs: { title: string; message: string; resolve: (value: boolean) => void }[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			confirm: (title: string, message: string) => new Promise<boolean>((resolve) => dialogs.push({ title, message, resolve })),
			notify: () => {},
		},
	};
	const first = toolCall({ toolName: "read", input: { path: "../first.ts" } }, ctx);
	const second = toolCall({ toolName: "write", input: { path: "../second.ts" } }, ctx);
	const third = toolCall({ toolName: "bash", input: { command: "rm -rf cache" } }, ctx);
	const fourth = command.handler("allow /tmp --global", ctx);
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 1);
	assert.match(dialogs[0].message, /first\.ts/);
	dialogs[0].resolve(false);
	assert.match((await first).reason, /read outside cwd/);
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 2);
	assert.match(dialogs[1].message, /second\.ts/);
	dialogs[1].resolve(true);
	assert.equal(await second, undefined);
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 3);
	assert.match(dialogs[2].title, /destructive bash/);
	dialogs[2].resolve(false);
	assert.match((await third).reason, /destructive bash command blocked/);
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 4);
	assert.match(dialogs[3].title, /global pi-cwd-guard config/);
	dialogs[3].resolve(false);
	await fourth;
});

test("continues the confirmation queue after a dialog rejects", { timeout: 5000 }, async (t) => {
	const { cwd, toolCall } = fixture(t);
	const dialogs: { resolve: (value: boolean) => void; reject: (error: Error) => void }[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { confirm: () => new Promise<boolean>((resolve, reject) => dialogs.push({ resolve, reject })) },
	};
	const first = toolCall({ toolName: "read", input: { path: "../first.ts" } }, ctx);
	const rejected = assert.rejects(first, /Dialog failed/);
	const second = toolCall({ toolName: "read", input: { path: "../second.ts" } }, ctx);
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 1);
	dialogs[0].reject(new Error("Dialog failed"));
	await rejected;
	await new Promise(setImmediate);
	assert.equal(dialogs.length, 2);
	dialogs[1].resolve(true);
	assert.equal(await second, undefined);
});

test("blocks concurrent no-UI requests without opening confirmations", async (t) => {
	const { cwd, toolCall, command } = fixture(t);
	const ctx = {
		cwd,
		hasUI: false,
		ui: {
			confirm: async () => { throw new Error("No-UI calls must not confirm"); },
			notify: () => {},
		},
	};
	const results = await Promise.all([
		toolCall({ toolName: "read", input: { path: "../first.ts" } }, ctx),
		toolCall({ toolName: "write", input: { path: "../second.ts" } }, ctx),
		toolCall({ toolName: "bash", input: { command: "rm -rf cache" } }, ctx),
	]);
	for (const result of results) {
		assert.equal(result.block, true);
		assert.match(result.reason, /no UI for confirmation/);
	}
	await command.handler("allow /tmp --global", ctx);
});
