#!/usr/bin/env node
// Bootstrap stand-in for the bun CLI so bun 1.4 can be compiled without a
// pre-existing bun binary (Thompson-trust / offline ABF builds).
//
// bun 1.4's configure already knows how to drive TypeScript under
// `node --experimental-strip-types`. Codegen ninja rules still invoke
// `cfg.bun run script.ts ...` and `cfg.bun install`. This wrapper is
// dropped onto PATH as `bun` (and also $HOME/.bun/bin/bun, which
// findBun() prefers) and translates those two cases to node/npm.
//
// It is a build-time tool only. The package we produce is a real bun.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);

// Configure-time bindgenv2 --command=list-outputs. The real script uses
// import.meta.require + a "bindgenv2" path alias (Bun-only). Unions emit
// a header; dictionaries and enumerations emit header+source.
function bindgenv2ListOutputs(argv) {
	let codegenPath = "";
	let sources = [];
	for (const a of argv) {
		if (a.startsWith("--codegen-path=")) codegenPath = a.slice("--codegen-path=".length);
		else if (a.startsWith("--sources=")) sources = a.slice("--sources=".length).split(",").filter(Boolean);
	}
	if (!codegenPath || sources.length === 0) return false;
	const out = [];
	const unionRe = /\.union\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g;
	const enumRe = /\.enumeration\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g;
	const dictRe = /\.dictionary\(\s*\{[^}]*?\bname:\s*"([A-Za-z][A-Za-z0-9_]*)"/gs;
	for (const file of sources) {
		const text = readFileSync(file, "utf8");
		for (const re of [unionRe]) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(text))) out.push(`${codegenPath}/Generated${m[1]}.h`);
		}
		for (const re of [enumRe, dictRe]) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(text))) {
				out.push(`${codegenPath}/Generated${m[1]}.h`);
				out.push(`${codegenPath}/Generated${m[1]}.cpp`);
			}
		}
	}
	if (out.length === 0) return false;
	process.stdout.write(out.join(";"));
	return true;
}

function runNodeOn(scriptAndArgs) {
	const r = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", ...scriptAndArgs],
		{ stdio: "inherit", env: process.env },
	);
	process.exit(r.status ?? 1);
}

if (args.length === 0) {
	process.stderr.write("omv-bun-bootstrap: no arguments (this is a build-time stub, not bun)\n");
	process.exit(1);
}

if (args[0] === "install") {
	// Prefer a pre-vendored node_modules. Fall back to npm --offline.
	if (existsSync("node_modules")) {
		process.exit(0);
	}
	const npm = process.env.NPM_EXECUTABLE || "npm";
	const r = spawnSync(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
		stdio: "inherit",
		env: process.env,
	});
	process.exit(r.status ?? 1);
}

if (args[0] === "run") {
	args.shift();
}

// `bun <file.ts> ...` or leftover after stripping `run`
if (args[0] && (args[0].endsWith(".ts") || args[0].endsWith(".mjs") || args[0].endsWith(".js"))) {
	if (args.some(a => a === "--command=list-outputs" || a.startsWith("--command=list-outputs"))) {
		if (bindgenv2ListOutputs(args)) process.exit(0);
	}
	runNodeOn(args);
}

// `bun --version` etc. used as a smoke check during configure
if (args[0] === "--version" || args[0] === "-v") {
	process.stdout.write("1.4.0-bootstrap\n");
	process.exit(0);
}

if (args[0] === "--revision") {
	process.stdout.write("1.4.0-bootstrap\n");
	process.exit(0);
}

process.stderr.write(`omv-bun-bootstrap: unsupported invocation: bun ${args.join(" ")}\n`);
process.exit(1);
