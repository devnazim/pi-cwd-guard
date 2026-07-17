import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface DangerousBashPattern {
	label: string;
	pattern: RegExp;
	pathScoped?: "rm";
}

interface ShellWord {
	value: string;
	dynamic: boolean;
	expandHome: boolean;
}

interface ShellSegment {
	text: string;
	terminator?: "sequence" | "and" | "or" | "pipe" | "background";
}

const destructiveRmPattern = /\brm\s+(?:-[^\s;|&]*[rf][^\s;|&]*|--recursive|--force)\b/i;

const dangerousBashPatterns: DangerousBashPattern[] = [
	{ label: "recursive/forced rm", pattern: destructiveRmPattern, pathScoped: "rm" },
	{ label: "sudo", pattern: /\bsudo\b/i },
	{ label: "dangerous chmod", pattern: /\bchmod\b[^\n;|&]*(?:\b777\b|-\S*R\S*)/ },
	{ label: "recursive chown", pattern: /\bchown\b[^\n;|&]*-\S*R\S*/ },
	{ label: "git reset --hard", pattern: /\bgit\s+reset\b[^\n;|&]*--hard\b/i },
	{ label: "git clean -fd", pattern: /\bgit\s+clean\b(?=[^\n;|&]*-[^\s;|&]*f)(?=[^\n;|&]*-[^\s;|&]*d)/i },
];

function isOutsidePath(basePath: string, targetPath: string): boolean {
	const relative = path.relative(basePath, targetPath);
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function splitShellSegments(command: string): ShellSegment[] | undefined {
	const segments: ShellSegment[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];

		if (escaping) {
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			if (command[index + 1] === "\n") return undefined;
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (char === "(" || char === ")") return undefined;

		let terminator: ShellSegment["terminator"];
		let operatorLength = 1;
		if (char === ";" || char === "\n") {
			terminator = "sequence";
		} else if (char === "&" && command[index + 1] === "&") {
			terminator = "and";
			operatorLength = 2;
		} else if (char === "|" && command[index + 1] === "|") {
			terminator = "or";
			operatorLength = 2;
		} else if (char === "&" && command[index + 1] !== ">" && command[index - 1] !== ">") {
			terminator = "background";
		} else if (char === "|") {
			terminator = "pipe";
		}

		if (terminator) {
			segments.push({ text: command.slice(start, index), terminator });
			index += operatorLength - 1;
			start = index + 1;
		}
	}

	if (quote || escaping) return undefined;
	segments.push({ text: command.slice(start) });
	return segments;
}

function parseShellWords(segment: string): ShellWord[] | undefined {
	const words: ShellWord[] = [];
	let value = "";
	let quote: "'" | '"' | undefined;
	let dynamic = false;
	let expandHome = false;
	let wordStarted = false;

	const pushWord = () => {
		if (!wordStarted) return;
		words.push({ value, dynamic, expandHome });
		value = "";
		dynamic = false;
		expandHome = false;
		wordStarted = false;
	};

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index];

		if (quote === "'") {
			if (char === "'") {
				quote = undefined;
			} else {
				value += char;
			}
			wordStarted = true;
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
				wordStarted = true;
				continue;
			}
			if (char === "\\") {
				const next = segment[index + 1];
				if (next === undefined || next === "\n") return undefined;
				value += ["$", "`", '"', "\\"].includes(next) ? next : `\\${next}`;
				index += 1;
				wordStarted = true;
				continue;
			}
			if (char === "$" || char === "`") dynamic = true;
			value += char;
			wordStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			pushWord();
			continue;
		}

		if (char === "#" && !wordStarted) break;
		if (char === "<" || char === ">") return undefined;

		if (char === "'" || char === '"') {
			if (expandHome && value === "~") dynamic = true;
			quote = char;
			wordStarted = true;
			continue;
		}

		if (char === "\\") {
			const next = segment[index + 1];
			if (next === undefined || next === "\n") return undefined;
			if (expandHome && value === "~") dynamic = true;
			value += next;
			index += 1;
			wordStarted = true;
			continue;
		}

		if (!wordStarted && char === "~") expandHome = true;
		if (char === "$" || char === "`" || char === "{" || char === "}") dynamic = true;
		value += char;
		wordStarted = true;
	}

	if (quote) return undefined;
	pushWord();
	return words;
}

function resolveStaticTarget(target: ShellWord, allowFinalGlob: boolean): string | undefined {
	if (target.dynamic || target.value.length === 0) return undefined;

	const rawParts = target.value.split(/[\\/]/);
	if (rawParts.includes("..") || rawParts.at(-1) === "." || /[\\/]$/.test(target.value)) return undefined;

	let targetPath = target.value;
	if (target.expandHome) {
		if (target.value !== "~" && !target.value.startsWith("~/")) return undefined;
		targetPath = target.value === "~" ? os.homedir() : path.join(os.homedir(), target.value.slice(2));
	}
	if (!path.isAbsolute(targetPath)) return undefined;

	const resolvedPath = path.resolve(targetPath);
	if (/[?*[\]]/.test(allowFinalGlob ? path.dirname(resolvedPath) : resolvedPath)) return undefined;
	return resolvedPath;
}

function resolveThroughExistingPrefix(inputPath: string): string | undefined {
	let existingPath = inputPath;
	const missingParts: string[] = [];

	while (true) {
		try {
			return path.resolve(realpathSync.native(existingPath), ...missingParts);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;

			const parentPath = path.dirname(existingPath);
			if (parentPath === existingPath) return undefined;
			missingParts.unshift(path.basename(existingPath));
			existingPath = parentPath;
		}
	}
}

function isAllowedTarget(resolvedPath: string, allowedPaths: string[]): boolean {
	return allowedPaths.some((allowedPath) => {
		if (isOutsidePath(allowedPath, resolvedPath)) return false;
		if (resolvedPath === allowedPath) return true;

		const resolvedAllowedPath = resolveThroughExistingPrefix(allowedPath);
		const resolvedParentPath = resolveThroughExistingPrefix(path.dirname(resolvedPath));
		return Boolean(
			resolvedAllowedPath && resolvedParentPath && !isOutsidePath(resolvedAllowedPath, resolvedParentPath),
		);
	});
}

function isDangerousRmOption(option: string): boolean {
	if (option === "--recursive" || option === "--force") return true;
	return /^-[^-]*[rf]/i.test(option);
}

function isAllowedRmSegment(segment: string, allowedPaths: string[]): boolean {
	const words = parseShellWords(segment);
	if (!words || words.length < 3 || words.some(({ dynamic }) => dynamic) || words[0].value !== "rm") {
		return false;
	}

	let hasDangerousOption = false;
	let parsingOptions = true;
	const targets: ShellWord[] = [];

	for (const word of words.slice(1)) {
		if (parsingOptions && word.value === "--") {
			parsingOptions = false;
			continue;
		}
		if (parsingOptions && word.value.startsWith("-") && word.value !== "-") {
			if (isDangerousRmOption(word.value)) hasDangerousOption = true;
			continue;
		}
		targets.push(word);
	}

	if (!hasDangerousOption || targets.length === 0) return false;
	return targets.every((target) => {
		const resolvedPath = resolveStaticTarget(target, true);
		return Boolean(resolvedPath && isAllowedTarget(resolvedPath, allowedPaths));
	});
}

function isAllowedMkdirSegment(segment: string, allowedPaths: string[]): boolean {
	const words = parseShellWords(segment);
	if (!words || words.length < 3 || words.some(({ dynamic }) => dynamic) || words[0].value !== "mkdir") {
		return false;
	}

	let hasParentsOption = false;
	let parsingOptions = true;
	const targets: ShellWord[] = [];

	for (const word of words.slice(1)) {
		if (parsingOptions && word.value === "--") {
			parsingOptions = false;
			continue;
		}
		if (parsingOptions && word.value.startsWith("-") && word.value !== "-") {
			if (word.value === "--parents" || /^-[pv]*p[pv]*$/.test(word.value)) {
				hasParentsOption = true;
				continue;
			}
			if (word.value === "--verbose" || /^-v+$/.test(word.value)) continue;
			return false;
		}
		targets.push(word);
	}

	if (!hasParentsOption || targets.length === 0) return false;
	return targets.every((target) => {
		const resolvedPath = resolveStaticTarget(target, false);
		return Boolean(resolvedPath && isAllowedTarget(resolvedPath, allowedPaths));
	});
}

function areDestructiveRmSegmentsAllowed(command: string, allowedPaths: string[]): boolean {
	if (allowedPaths.length === 0) return false;

	const segments = splitShellSegments(command);
	if (!segments) return false;

	let foundDestructiveRm = false;
	let priorSegmentsSafe = true;

	for (const { text, terminator } of segments) {
		if (!text.trim()) continue;
		if (destructiveRmPattern.test(text)) {
			foundDestructiveRm = true;
			if (
				!priorSegmentsSafe ||
				terminator === "pipe" ||
				terminator === "background" ||
				!isAllowedRmSegment(text, allowedPaths)
			) {
				return false;
			}
			continue;
		}
		priorSegmentsSafe =
			priorSegmentsSafe &&
			terminator !== "pipe" &&
			terminator !== "background" &&
			isAllowedMkdirSegment(text, allowedPaths);
	}

	return foundDestructiveRm;
}

export function getDangerousBashMatches(command: string, allowedPaths: string[]): DangerousBashPattern[] {
	return dangerousBashPatterns.filter(
		({ pattern, pathScoped }) =>
			pattern.test(command) && !(pathScoped === "rm" && areDestructiveRmSegmentsAllowed(command, allowedPaths)),
	);
}
