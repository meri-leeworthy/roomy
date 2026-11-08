#!/usr/bin/env node
/**
 * Asserts the collector config never guesses its own environment.
 *
 * `env` names the deployment that produced a series or a browser record, so it
 * must be a value the collector was given (`ALLOY_ENV`) and never a default the
 * config falls back to. Two collectors that share a label set interleave their
 * scrapes onto the same series: `changes(roomy_process_boot_timestamp_seconds[1h])`
 * then counts two processes as restarts, and a counter read from the smaller
 * process reads as a reset. A default makes that failure silent, so it is
 * checked here rather than remembered.
 *
 *   node deploy/alloy/check-config.mjs [config.alloy]
 *
 * Exits non-zero on the first violation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? join(here, "config.alloy");
const dockerfilePath = join(dirname(configPath), "Dockerfile");

/** The one accepted expression: ALLOY_ENV trimmed, lowercased, no fallback. */
const REQUIRED_ENV_EXPR = 'string.to_lower(string.trim_space(sys.env("ALLOY_ENV")))';

/** Blank out `//` comments, which never execute — while leaving `//` inside a
 * string alone (URLs such as "http://127.0.0.1:1"). Newlines are preserved so
 * reported line numbers stay true. Also returns the [start, end) offsets of
 * every string literal, in the coordinates of the returned text. */
function stripComments(src) {
	const spans = [];
	let out = "";
	let inString = false;
	let stringStart = -1;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += src[i + 1] ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
				spans.push([stringStart, out.length - 1]);
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			stringStart = out.length;
			out += ch;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += ch;
	}
	return { code: out, spans };
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** True when `index` sits inside a quoted string literal — a label matcher such
 * as `{env=""}` is not an assignment. */
const inString = (spans, index) => spans.some(([start, end]) => index > start && index < end);

/** The body of `label { ... }`, brace-matched, from the first opening brace. */
function blockBody(src, startIndex) {
	const open = src.indexOf("{", startIndex);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return src.slice(open + 1);
}

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

function checkConfig() {
	const raw = readFileSync(configPath, "utf8");
	const { code, spans } = stripComments(raw);

	// 1. Every `env = ...` assignment is the required expression. A fallback
	//    (coalesce, a literal, a different variable) fails here.
	const assignments = [...code.matchAll(/\benv\s*=\s*([^,\n}]+)/g)].filter(
		(match) => !inString(spans, match.index),
	);
	if (assignments.length < 2) {
		fail(
			`expected at least 2 \`env =\` assignments (one per signal that carries it), found ${assignments.length}`,
		);
	}
	for (const match of assignments) {
		const expr = match[1].trim();
		if (expr !== REQUIRED_ENV_EXPR) {
			fail(
				`line ${lineOf(code, match.index)}: \`env = ${expr}\` — env must be exactly ${REQUIRED_ENV_EXPR} with no default; an unset ALLOY_ENV must leave env empty, never assume an environment`,
			);
		}
	}

	// 2. The scrape target is dropped when that expression comes out empty, so
	//    an unset ALLOY_ENV publishes no series at all instead of a series whose
	//    label set it guessed.
	const relabelAt = code.search(/discovery\.relabel\s+"appserver"\s*\{/);
	if (relabelAt === -1) {
		fail('no `discovery.relabel "appserver"` block');
	} else {
		const body = blockBody(code, relabelAt);
		const dropsEmptyEnv = [...body.matchAll(/rule\s*\{([^}]*)\}/g)].some(([, rule]) => {
			const sources = /source_labels\s*=\s*\[([^\]]*)\]/.exec(rule)?.[1] ?? "";
			const regex = /regex\s*=\s*"([^"]*)"/.exec(rule)?.[1];
			const action = /action\s*=\s*"([^"]*)"/.exec(rule)?.[1];
			return (
				/["']env["']/.test(sources) &&
				regex === "^$" &&
				action === "drop"
			);
		});
		if (!dropsEmptyEnv) {
			fail(
				'`discovery.relabel "appserver"` has no rule dropping the target when `env` is empty (source_labels = ["env"], regex = "^$", action = "drop")',
			);
		}
	}

	// 3. The Faro path cannot drop a record, so it drops the empty label.
	const faroStage = code.search(/stage\.static_labels\s*\{/);
	if (faroStage !== -1) {
		const after = code.slice(faroStage);
		const dropsEmptyEnvLabel = /stage\.label_drop\s*\{[^}]*values\s*=\s*\[[^\]]*["']env["'][^\]]*\]/.test(
			after,
		);
		if (!dropsEmptyEnvLabel) {
			fail(
				"`stage.static_labels` sets env but no `stage.label_drop` removes it when empty — a browser record would carry an empty `env` rather than none",
			);
		}
	}

	notes.push(`${configPath}: ${assignments.length} \`env\` assignments, all from ALLOY_ENV`);
}

function checkDockerfile() {
	let raw;
	try {
		raw = readFileSync(dockerfilePath, "utf8");
	} catch {
		return; // a Dockerfile is optional here
	}
	for (const [i, line] of raw.split("\n").entries()) {
		if (/^\s*(ENV|ARG)\s+.*\bALLOY_ENV\b/.test(line)) {
			fail(
				`${dockerfilePath}:${i + 1}: the image sets ALLOY_ENV — a baked value is the same silent default; the collector's environment is a deploy-time variable`,
			);
		}
	}
	notes.push(`${dockerfilePath}: no ENV/ARG sets ALLOY_ENV`);
}

checkConfig();
checkDockerfile();

if (problems.length > 0) {
	for (const problem of problems) console.error(`error: ${problem}`);
	process.exit(1);
}
for (const note of notes) console.log(note);
