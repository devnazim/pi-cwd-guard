import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDangerousBashMatches } from "../src/destructive-bash.ts";

const labels = (command: string, allowedPaths: string[] = []) =>
	getDangerousBashMatches(command, allowedPaths).map(({ label }) => label);

test("allows forced rm when every target is recursively covered", () => {
	assert.deepEqual(labels("rm -f /tmp/pi-web-video2/frames/*.png", ["/tmp/pi-web-video2"]), []);
});

test("allows a covered rm within a compound command", () => {
	const command = [
		"mkdir -p /tmp/pi-web-video2/frames && rm -f /tmp/pi-web-video2/frames/*.png",
		"ffmpeg -i input.mov /tmp/pi-web-video2/frames/frame-%03d.png >/dev/null 2>&1",
		"ls /tmp/pi-web-video2/frames | tail",
	].join("\n");

	assert.deepEqual(labels(command, ["/tmp/pi-web-video2"]), []);
});

test("still confirms when any rm target is outside the allow-list", () => {
	assert.deepEqual(labels("rm -rf /tmp/safe /etc/unsafe", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf /tmp/safe && rm -rf /etc/unsafe", ["/tmp"]), ["recursive/forced rm"]);
});

test("uses component-aware descendant matching", () => {
	assert.deepEqual(labels("rm -rf /tmp-safe/file", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf /tmp/..cache/file", ["/tmp"]), []);
});

test("allows quoted absolute and home-relative static targets", () => {
	assert.deepEqual(labels("rm -rf '/tmp/safe folder/files'", ["/tmp/safe folder"]), []);
	assert.deepEqual(labels("rm -rf ~/safe/files", [path.join(os.homedir(), "safe")]), []);
});

test("keeps confirmation for relative targets and prior working-directory changes", () => {
	assert.deepEqual(labels("rm -rf cache/files", ["/workspace/cache"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("cd /etc && rm -rf cache", ["/workspace/cache"]), ["recursive/forced rm"]);
});

test("keeps confirmation for dynamic or ambiguous rm targets", () => {
	assert.deepEqual(labels("rm -rf $TARGET", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf$FLAGS /tmp/safe", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf /tmp/{safe,../unsafe}", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf /tmp/safe >/dev/null", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("eval 'rm -rf /tmp/safe'", ["/tmp"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("ln -s /etc /tmp/safe/link && rm -rf /tmp/safe/link/victim", ["/tmp/safe"]), [
		"recursive/forced rm",
	]);
	assert.deepEqual(labels("rm -rf ~root/secret", ["/workspace"]), ["recursive/forced rm"]);
	assert.deepEqual(labels('rm -rf ~"/victim"', [os.homedir()]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf ~\\/victim", [os.homedir()]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf ~/safe/link/../victim", [path.join(os.homedir(), "safe")]), [
		"recursive/forced rm",
	]);
	assert.deepEqual(labels("rm -rf /tmp/safe/.\\\n./victim", ["/tmp/safe"]), ["recursive/forced rm"]);
	assert.deepEqual(labels('rm -rf "/tmp/safe\\\\/victim"', ["/tmp/safe"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("/tmp/helpers/rm -rf /tmp/safe", ["/tmp/safe"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("/tmp/helpers/mkdir -p /tmp/safe/prep && rm -rf /tmp/safe/link/victim", ["/tmp/safe"]), [
		"recursive/forced rm",
	]);
	assert.deepEqual(labels("rm -rf /tmp/safe &>/tmp/outside/victim", ["/tmp/safe"]), ["recursive/forced rm"]);
	assert.deepEqual(labels("rm -rf /tmp/safe/tree /tmp/safe/link/victim & ln -s /tmp/outside /tmp/safe/link", ["/tmp/safe"]), [
		"recursive/forced rm",
	]);
});

test("keeps confirmation when an existing ancestor escapes through a symlink", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-cwd-guard-test-"));
	const allowedPath = path.join(root, "allowed");
	const outsidePath = path.join(root, "outside");
	mkdirSync(allowedPath);
	mkdirSync(outsidePath);
	const linkPath = path.join(allowedPath, "link");
	symlinkSync(outsidePath, linkPath);

	try {
		assert.deepEqual(labels(`rm -f ${path.join(linkPath, "victim")}`, [allowedPath]), ["recursive/forced rm"]);
		assert.deepEqual(labels(`rm -f ${linkPath}/../victim`, [allowedPath]), ["recursive/forced rm"]);
		assert.deepEqual(labels(`rm -rf ${linkPath}/`, [allowedPath]), ["recursive/forced rm"]);
		assert.deepEqual(labels(`rm -rf ${linkPath}/.`, [allowedPath]), ["recursive/forced rm"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not exclude unrelated destructive matches", () => {
	assert.deepEqual(labels("sudo rm -rf /tmp/safe", ["/tmp"]), ["recursive/forced rm", "sudo"]);
	assert.deepEqual(labels("rm -rf /tmp/safe && git reset --hard", ["/tmp"]), ["git reset --hard"]);
});
