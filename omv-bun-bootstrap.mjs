#!/usr/bin/env node
// Build-time stand-in for the bun CLI. ABF has no prebuilt bun (Thompson
// trust) so configure/codegen run under Node + system esbuild.
// Installed as $HOME/.bun/bin/bun (findBun() prefers that) and as
// $HOME/.bun/omv-bun-bootstrap.mjs (--import loader). The rpm we ship
// is a real bun; this file is not.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect as nodeInspect } from "node:util";
import { isMainThread } from "node:worker_threads";
import module from "node:module";
import { Readable } from "node:stream";

const here = fileURLToPath(import.meta.url);
const realNode = process.execPath;
const stubPath = process.env.OMV_BUN_STUB || here;
const loaderPath = process.env.OMV_BUN_LOADER || join(homedir(), ".bun/omv-bun-bootstrap.mjs");

function esbuildBin() {
	return (
		process.env.ESBUILD_BINARY_PATH ||
		(existsSync("/usr/bin/esbuild") && "/usr/bin/esbuild") ||
		"esbuild"
	);
}

function findRepoRoot(start) {
	let dir = start;
	for (let i = 0; i < 24; i++) {
		if (existsSync(join(dir, "src/codegen")) && existsSync(join(dir, "scripts/build.ts"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

function tryFile(p) {
	if (existsSync(p) && statSync(p).isFile()) return p;
	for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]) {
		if (existsSync(p + ext) && statSync(p + ext).isFile()) return p + ext;
	}
	for (const ext of ["/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
		if (existsSync(p + ext)) return p + ext;
	}
	return null;
}

// ── Bun API used by src/codegen/* ──────────────────────────────────────

function bunFile(p) {
	return {
		async text() {
			return readFileSync(p, "utf8");
		},
		async arrayBuffer() {
			const b = readFileSync(p);
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		},
		exists() {
			return existsSync(p);
		},
		get size() {
			try {
				return statSync(p).size;
			} catch {
				return 0;
			}
		},
		name: p,
	};
}

async function bunWrite(p, contents) {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, contents);
	return Number(statSync(p).size);
}

function mapStdio(stdio) {
	if (!stdio) return "inherit";
	if (typeof stdio === "string") return stdio;
	return stdio.map(s => (s === "pipe" || s === "inherit" || s === "ignore" ? s : "pipe"));
}

function rewriteCmd(cmd) {
	if (!cmd || cmd.length === 0) return cmd;
	const out = [...cmd];
	const looksLikeNode =
		out[0] === process.execPath ||
		out[0] === stubPath ||
		/\/node(\.exe)?$/.test(out[0] || "") ||
		/\/bun$/.test(out[0] || "");
	if (looksLikeNode) out[0] = stubPath;
	return out;
}

function bunSpawnSync(cmdOrOpts, opts) {
	if (Array.isArray(cmdOrOpts)) {
		const [cmd, ...args] = rewriteCmd(cmdOrOpts);
		const r = spawnSync(cmd, args, {
			encoding: undefined,
			maxBuffer: 64 * 1024 * 1024,
			...opts,
		});
		return {
			exitCode: r.status ?? 1,
			stdout: r.stdout || Buffer.alloc(0),
			stderr: r.stderr || Buffer.alloc(0),
			success: r.status === 0,
		};
	}
	const o = cmdOrOpts;
	const [cmd, ...args] = rewriteCmd(o.cmd);
	const r = spawnSync(cmd, args, {
		cwd: o.cwd,
		env: o.env || process.env,
		stdio: mapStdio(o.stdio),
		encoding: undefined,
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		exitCode: r.status ?? 1,
		stdout: r.stdout || Buffer.alloc(0),
		stderr: r.stderr || Buffer.alloc(0),
		success: r.status === 0,
	};
}

function bunSpawn(opts) {
	const [cmd, ...args] = rewriteCmd(opts.cmd);
	const child = spawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env || process.env,
		stdio: [
			opts.stdin === "pipe" ? "pipe" : opts.stdin === "ignore" ? "ignore" : "inherit",
			opts.stdout === "pipe" ? "pipe" : "inherit",
			opts.stderr === "inherit" ? "inherit" : opts.stderr === "pipe" ? "pipe" : "inherit",
		],
	});
	return {
		stdin: child.stdin,
		stdout: child.stdout ? Readable.toWeb(child.stdout) : undefined,
		get exitCode() {
			return child.exitCode;
		},
		get signalCode() {
			return child.signalCode;
		},
		exited: new Promise(resolve => child.on("close", resolve)),
	};
}

class BunGlob {
	constructor(pattern) {
		this.pattern = pattern;
	}
	*scanSync() {
		const pat = this.pattern;
		const star = pat.lastIndexOf("*");
		if (star === -1) {
			if (existsSync(pat)) yield pat;
			return;
		}
		const slash = pat.lastIndexOf(sep, star);
		const dir = slash === -1 ? process.cwd() : pat.slice(0, slash);
		const rest = slash === -1 ? pat : pat.slice(slash + 1);
		if (rest === "*.ts" || rest === "*.js" || rest === "*.tsx") {
			const ext = rest.slice(1);
			if (!existsSync(dir)) return;
			for (const name of readdirSync(dir)) {
				if (name.endsWith(ext)) yield join(dir, name);
			}
			return;
		}
		// recursive **/*.ext
		const extMatch = rest.match(/\*\*\/\*(\.[A-Za-z0-9]+)$/);
		const ext = extMatch ? extMatch[1] : null;
		function* walk(d) {
			if (!existsSync(d)) return;
			for (const ent of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, ent.name);
				if (ent.isDirectory()) yield* walk(p);
				else if (!ext || p.endsWith(ext)) yield p;
			}
		}
		yield* walk(dir);
	}
}

function scanImports(source) {
	source = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const imports = [];
	const re = /(?:^|[^.\w$])(?:import|export)\s+(?!type\b)(?:[^'"\n]*?\sfrom\s+)?["']([^"']+)["']/gm;
	let m;
	while ((m = re.exec(source))) {
		if (m[1]) imports.push({ kind: "import-statement", path: m[1] });
	}
	const exports = [];
	if (/\bexport\s+default\b/.test(source)) exports.push("default");
	return { imports: imports.filter(i => typeof i.path === "string" && i.path.length > 0), exports };
}

function esbuildBuild(opts) {
	const entrypoints = opts.entrypoints || [];
	const args = [...entrypoints, "--bundle", "--format=" + (opts.format || "esm")];
	const target = opts.target;
	if (target === "browser") args.push("--platform=browser");
	else if (target === "node" || target === "bun") args.push("--platform=node");
	else args.push("--platform=neutral");
	if (opts.outdir) args.push("--outdir=" + opts.outdir);
	else args.push("--outfile=" + join(process.env.TMPDIR || "/tmp", "omv-bun-build-" + process.pid + ".js"));
	// Full minify renames identifiers and breaks bake-codegen's __marker__ pass.
	if (opts.minify === true) {
		/* keep names */
	}
	if (opts.minify && typeof opts.minify === "object") {
		if (opts.minify.syntax) args.push("--minify-syntax");
		if (opts.minify.whitespace) args.push("--minify-whitespace");
		// Official bun --keep-names only stops the minifier renaming
		// functions. esbuild's flag also injects a __name() helper;
		// JSC builtins (shell.ts, ProcessObjectInternals, …) and
		// createBuiltinExecutable modules cannot see that helper.
		if (opts.minify.keepNames && target !== "bun") args.push("--keep-names");
	}
	if (opts.define) {
		for (const [k, v] of Object.entries(opts.define)) {
			let lit = v;
			if (typeof v !== "string") lit = JSON.stringify(v);
			else {
				const t = v.trim();
				if (!(t === "true" || t === "false" || t === "null" || t === "undefined" || /^["']/.test(t) || /^-?\d/.test(t))) {
					lit = JSON.stringify(v);
				}
			}
			args.push(`--define:${k}=${lit}`);
		}
	}
	if (opts.drop) {
		for (const d of opts.drop) {
			if (d === "console" || d === "debugger") args.push("--drop:" + d);
			else args.push(`--define:${d}=undefined`);
		}
	}
	if (opts.conditions) args.push("--conditions=" + opts.conditions.join(","));
	if (opts.env === "disable") args.push("--packages=external");
	args.push("--loader:.svg=dataurl", "--loader:.png=dataurl", "--loader:.txt=text");
	const outfileIdx = args.findIndex(a => a.startsWith("--outfile="));
	const outdir = opts.outdir;
	const r = spawnSync(esbuildBin(), args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (r.status !== 0) {
		return {
			success: false,
			outputs: [],
			logs: [new Error(r.stderr || r.stdout || "esbuild failed")],
		};
	}
	const outputs = [];
	if (outdir) {
		const collect = d => {
			if (!existsSync(d)) return;
			for (const ent of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, ent.name);
				if (ent.isDirectory()) collect(p);
				else if (/\.(js|css|mjs)$/.test(p)) {
					outputs.push({
						path: p,
						async text() {
							return readFileSync(p, "utf8");
						},
					});
				}
			}
		};
		collect(outdir);
	} else if (outfileIdx !== -1) {
		const p = args[outfileIdx].slice("--outfile=".length);
		outputs.push({
			path: p,
			async text() {
				return readFileSync(p, "utf8");
			},
		});
	}
	return { success: true, outputs, logs: [] };
}

function installBunGlobal() {
	if (globalThis.Bun && globalThis.Bun.__omv) return globalThis.Bun;
	const BunObj = {
		__omv: true,
		env: process.env,
		file: bunFile,
		write: bunWrite,
		sleep: ms => new Promise(r => setTimeout(r, ms)),
		spawn: bunSpawn,
		spawnSync: bunSpawnSync,
		build: esbuildBuild,
		Glob: BunGlob,
		hash(value) {
			const s = typeof value === "string" ? value : JSON.stringify(value);
			const h = createHash("sha1").update(s).digest();
			return h.readBigUInt64BE(0);
		},
		zstdCompressSync(buf, opts) {
			const level = (opts && opts.level) || 19;
			const tmpIn = join(process.env.TMPDIR || "/tmp", "omv-zstd-in-" + process.pid + "-" + Date.now());
			writeFileSync(tmpIn, buf);
			const r = spawnSync("zstd", ["-" + Math.min(level, 19), "-c", tmpIn], {
				encoding: null,
				maxBuffer: 64 * 1024 * 1024,
			});
			try {
				unlinkSync(tmpIn);
			} catch {}
			if (r.status !== 0) throw new Error(String(r.stderr || "zstd failed"));
			return r.stdout;
		},
		inspect(value, opts) {
			return nodeInspect(value, { colors: !!(opts && opts.colors), depth: 8, maxArrayLength: 50 });
		},
		enableANSIColors: !!process.stdout.isTTY,
		stringWidth(s) {
			return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
		},
		resolveSync(specifier, from) {
			const req = createRequire(join(from, "package.json"));
			try {
				return req.resolve(specifier);
			} catch {
				const found = tryFile(join(from, specifier));
				if (found) return found;
				throw new Error(`Cannot resolve ${specifier} from ${from}`);
			}
		},
		Transpiler: class {
			constructor() {}
			scan(source) {
				return scanImports(source);
			}
			transformSync(source) {
				return source;
			}
		},
		$(strings, ...values) {
			let cmd = "";
			for (let i = 0; i < strings.length; i++) {
				cmd += strings[i];
				if (i < values.length) {
					const v = values[i];
					if (v && typeof v === "object" && v.raw != null) cmd += v.raw;
					else cmd += v;
				}
			}
			return {
				text() {
					return new Promise((resolve, reject) => {
						const r = spawnSync("sh", ["-c", cmd], {
							encoding: "utf8",
							env: process.env,
							maxBuffer: 64 * 1024 * 1024,
						});
						if (r.status !== 0) {
							reject(new Error((r.stderr || r.stdout || "") + `\n[omv-bun $] ${cmd}`));
						} else resolve(r.stdout || "");
					});
				},
			};
		},
	};
	BunObj.inspect.custom = nodeInspect.custom;
	globalThis.Bun = BunObj;
	return BunObj;
}

// ── bun / bun:test virtual modules ─────────────────────────────────────

const BUN_MODULE_SRC = `
const B = globalThis.Bun;
export const spawn = (...a) => B.spawn(...a);
export const spawnSync = (...a) => B.spawnSync(...a);
export const file = (...a) => B.file(...a);
export const write = (...a) => B.write(...a);
export const sleep = (...a) => B.sleep(...a);
export const Glob = B.Glob;
export const hash = (...a) => B.hash(...a);
export const inspect = B.inspect;
export const Transpiler = B.Transpiler;
export default B;
`;

const BUN_TEST_SRC = `
export function expect(val) {
	const s = String(val);
	return {
		toEndWith(suffix) {
			if (!s.endsWith(suffix)) throw new Error("expected " + JSON.stringify(val) + " to end with " + JSON.stringify(suffix));
		},
		toBe(x) { if (val !== x) throw new Error("expected " + val + " to be " + x); },
		toEqual(x) {
			if (JSON.stringify(val) !== JSON.stringify(x)) throw new Error("expected equal");
		},
	};
}
export default { expect };
`;

// ── loader hooks (--import) ────────────────────────────────────────────

function resolveHook(specifier, context, nextResolve) {
	if (specifier === "bun") {
		return { url: "data:text/javascript;charset=utf-8," + encodeURIComponent(BUN_MODULE_SRC), shortCircuit: true };
	}
	if (specifier === "bun:test") {
		return { url: "data:text/javascript;charset=utf-8," + encodeURIComponent(BUN_TEST_SRC), shortCircuit: true };
	}
	if (specifier === "bindgen" || specifier === "bindgenv2") {
		const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
		const root = findRepoRoot(parent);
		const dest =
			specifier === "bindgen"
				? join(root, "src/codegen/bindgen-lib.ts")
				: join(root, "src/codegen/bindgenv2/lib.ts");
		return { url: pathToFileURL(dest).href, shortCircuit: true };
	}
	if (
		specifier.startsWith("node:") ||
		specifier.startsWith("data:") ||
		specifier.startsWith("file:") ||
		specifier.startsWith("http:")
	) {
		return nextResolve(specifier, context);
	}
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd() + "/.";
		const resolved = isAbsolute(specifier) ? specifier : join(dirname(parent), specifier);
		const found = tryFile(resolved);
		if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

function loadHook(url, context, nextLoad) {
	if (!url.startsWith("file:")) return nextLoad(url, context);
	const file = fileURLToPath(url);
	if (!(file.endsWith(".ts") || file.endsWith(".tsx"))) return nextLoad(url, context);
	const source = readFileSync(file, "utf8").replace(/^#![^\n]*\n/, "");
	const r = spawnSync(
		esbuildBin(),
		[
			file.endsWith(".tsx") ? "--loader=tsx" : "--loader=ts",
			"--format=esm",
			"--platform=node",
			"--target=esnext",
			"--sourcemap=inline",
			"--sourcefile=" + file,
			"--log-level=error",
		],
		{ input: source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (r.status !== 0) {
		throw new Error(`esbuild ${relative(process.cwd(), file)}:\n${r.stderr || r.stdout}`);
	}
	let js = r.stdout;
	js = js.replace(/\bimport\.meta\.dir\b(?!name)/g, "import.meta.dirname");
	js = js.replace(/\bimport\.meta\.path\b/g, "import.meta.filename");
	js = js.replace(/require\(\s*(["'])\.\/optional\1\s*\)/g, "(globalThis.__omvBindgenOptional)");
	const preamble = `
import { createRequire as __omvCR } from "node:module";
import { pathToFileURL as __omvU } from "node:url";
const require = __omvCR(import.meta.url);
if (typeof import.meta.require !== "function") import.meta.require = require;
if (typeof globalThis.Bun === "undefined" || !globalThis.Bun.__omv) {
	throw new Error("omv-bun-bootstrap: Bun global missing (loader did not install it)");
}
`;
	return { format: "module", source: preamble + js, shortCircuit: true };
}

// ── bun build CLI (codegen drives this via process.execPath) ───────────

function bunDefineToEsbuild(spec) {
	// bun: --define=KEY:VALUE or --define=KEY=VALUE  →  esbuild --define:KEY=VALUE
	const colon = spec.indexOf(":");
	const eq = spec.indexOf("=");
	let key, val;
	if (colon !== -1 && (eq === -1 || colon < eq)) {
		key = spec.slice(0, colon);
		val = spec.slice(colon + 1);
	} else if (eq !== -1) {
		key = spec.slice(0, eq);
		val = spec.slice(eq + 1);
	} else {
		return "--define:" + spec;
	}
	return "--define:" + key + "=" + val;
}

// esbuild --bundle --format=esm wraps a bun builtin as:
//   var require_X = __commonJS({ "file"(exports) { var $; ...; return $ } });
//   export default require_X();
// Stock __commonJS ignores the callback return and yields mod.exports === {}.
// Prefer the callback return (bun's $ exports object) and turn
// `export default` into the IIFE return.
function unwrapEsbuildCommonJS(js) {
	js = js.replace(
		/var __commonJS = \(cb, mod\) => function\(\) \{[\s\S]*?\n\};/,
		`var __commonJS = (cb, mod) => function() {
  var box = { exports: {} };
  var names = Object.getOwnPropertyNames(cb);
  var ret = names.length ? (0, cb[names[0]])(box.exports, box) : void 0;
  return ret !== void 0 ? ret : box.exports;
};`,
	);
	// esbuild quotes bun intrinsics (`@undefined` is not valid JS). The
	// builtin compiler wants the @-identifier. Quoted "@undefined" made
	// require() pass options.paths = "@undefined" (a string).
	js = js.replace(/"__intrinsic__undefined"/g, "@undefined");
	js = js.replace(/"@undefined"/g, "@undefined");
	return js.replace(/export default /g, "return ");
}

function walkJsFiles(dir, fn) {
	if (!existsSync(dir)) return;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) walkJsFiles(p, fn);
		else if (p.endsWith(".js")) fn(p);
	}
}

function bunBuildCli(argv) {
	const entries = [];
	const args = [esbuildBin()];
	let outdir = "";
	let outfile = "";
	let root = "";
	let format = "";
	// --target bun is bun's builtin-module codegen. Official bun's bundler
	// turns export default / $$EXPORT$$($) into an IIFE return. esbuild
	// --bundle wraps the same file in __commonJS and then `return require_X()`
	// yields mod.exports === {} (the callback's `return $` is ignored).
	let targetBun = false;
	let keepNames = false;
	const externals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--minify") args.push("--minify");
		else if (a === "--minify-syntax") args.push("--minify-syntax");
		else if (a === "--minify-whitespace") args.push("--minify-whitespace");
		else if (a === "--keep-names") keepNames = true;
		else if (a === "--target") {
			const t = argv[++i];
			if (t === "bun") targetBun = true;
			args.push(t === "browser" ? "--platform=browser" : t === "node" ? "--platform=node" : "--platform=neutral");
		} else if (a.startsWith("--target=")) {
			const t = a.slice("--target=".length);
			if (t === "bun") targetBun = true;
			args.push(t === "browser" ? "--platform=browser" : t === "node" ? "--platform=node" : "--platform=neutral");
		} else if (a === "--outdir") outdir = argv[++i];
		else if (a.startsWith("--outdir=")) outdir = a.slice("--outdir=".length);
		else if (a === "--outfile") outfile = argv[++i];
		else if (a.startsWith("--outfile=")) outfile = a.slice("--outfile=".length);
		else if (a === "--root") root = argv[++i];
		else if (a.startsWith("--root=")) root = a.slice("--root=".length);
		else if (a === "--external") externals.push("--external:" + argv[++i]);
		else if (a.startsWith("--external=")) externals.push("--external:" + a.slice("--external=".length));
		else if (a.startsWith("--external:")) externals.push(a);
		else if (a === "--define") args.push(bunDefineToEsbuild(argv[++i]));
		else if (a.startsWith("--define=")) args.push(bunDefineToEsbuild(a.slice("--define=".length)));
		else if (a === "--format") format = argv[++i];
		else if (a.startsWith("--format=")) format = a.slice("--format=".length);
		else if (a.startsWith("-")) {
			// ignore unknown bun-build flags
		} else entries.push(a);
	}
	// --keep-names may appear before --target bun in argv (bundle-modules).
	if (keepNames && !targetBun) args.push("--keep-names");
	args.push(...entries, "--bundle", ...externals, "--format=" + (format || "esm"), "--loader:.svg=dataurl", "--loader:.png=dataurl", "--loader:.txt=text");
	if (outdir) args.push("--outdir=" + outdir);
	if (outfile) args.push("--outfile=" + outfile);
	if (root) args.push("--outbase=" + root);
	if (!outdir && !outfile) {
		const tmp = join(process.env.TMPDIR || "/tmp", "omv-bun-stdout-" + process.pid + "-" + Date.now() + ".out");
		args.push("--outfile=" + tmp);
		const r = spawnSync(args[0], args.slice(1), {
			stdio: ["inherit", "inherit", "pipe"],
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (r.status !== 0) {
			process.stderr.write(r.stderr || r.stdout || "");
			process.exit(r.status ?? 1);
		}
		if (existsSync(tmp)) {
			let out = readFileSync(tmp, "utf8");
			if (targetBun) out = unwrapEsbuildCommonJS(out);
			process.stdout.write(out);
		}
		process.exit(0);
	}
	const r = spawnSync(args[0], args.slice(1), {
		stdio: ["inherit", "inherit", "inherit"],
		maxBuffer: 64 * 1024 * 1024,
	});
	if (r.status === 0 && targetBun && outdir) {
		walkJsFiles(outdir, p => {
			const next = unwrapEsbuildCommonJS(readFileSync(p, "utf8"));
			writeFileSync(p, next);
		});
	}
	process.exit(r.status ?? 1);
}

function runTs(scriptAndArgs) {
	const loader = existsSync(loaderPath) ? loaderPath : here;
	const r = spawnSync(
		realNode,
		["--import", pathToFileURL(loader).href, "--no-warnings", ...scriptAndArgs],
		{
			stdio: "inherit",
			env: {
				...process.env,
				OMV_BUN_STUB: stubPath,
				OMV_BUN_LOADER: loader,
			},
		},
	);
	process.exit(r.status ?? 1);
}

async function cli() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		process.stderr.write("omv-bun-bootstrap: no arguments (build-time stub, not bun)\n");
		process.exit(1);
	}
	// ABF is offline; cargo/npm trees are pre-vendored. Never try the network.
	if (args[0] === "install") process.exit(0);
	if (args[0] === "--version" || args[0] === "-v" || args[0] === "--revision") {
		process.stdout.write("1.4.0-bootstrap\n");
		process.exit(0);
	}
	if (args[0] === "build") {
		bunBuildCli(args.slice(1));
		return;
	}
	if (args[0] === "run") args.shift();
	if (args[0] && /\.(ts|mjs|js|tsx)$/.test(args[0])) {
		runTs(args);
		return;
	}
	// bun run <name>: package.json script, or name.ts in cwd (build-fallbacks).
	if (args[0] && !args[0].startsWith("-")) {
		const name = args[0];
		for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
			if (existsSync(name + ext)) {
				args[0] = name + ext;
				runTs(args);
				return;
			}
		}
		if (existsSync("package.json")) {
			try {
				const pkg = JSON.parse(readFileSync("package.json", "utf8"));
				const script = pkg.scripts && pkg.scripts[name];
				if (script) {
					const parts = script.trim().split(/\s+/);
					if (parts[0] === "bun") parts.shift();
					await cliFrom(parts.concat(args.slice(1)));
					return;
				}
			} catch {}
		}
	}
	process.stderr.write(`omv-bun-bootstrap: unsupported invocation: bun ${args.join(" ")}\n`);
	process.exit(1);
}

function cliFrom(argv) {
	process.argv = [process.argv[0], process.argv[1], ...argv];
	return cli();
}

// Main thread: either the bun CLI, or --import into a codegen script.
if (isMainThread) {
	installBunGlobal();
	const argv1 = process.argv[1] ? pathResolve(process.argv[1]) : "";
	const me = pathResolve(here);
	const isCli = argv1 === me || argv1 === me.replace(/\.mjs$/, "");
	if (isCli) {
		await cli();
	} else {
		// Codegen script: make process.execPath look like bun so
		// spawn([process.execPath, "run"|"build", ...]) re-enters this stub.
		if (process.env.OMV_BUN_STUB) {
			try {
				process.argv[0] = process.env.OMV_BUN_STUB;
				Object.defineProperty(process, "execPath", {
					value: process.env.OMV_BUN_STUB,
					configurable: true,
				});
			} catch {}
		}
		if (!module._extensions[".ts"]) {
			module._extensions[".ts"] = function (mod, filename) {
				const src = readFileSync(filename, "utf8").replace(/^#![^\n]*\n/, "");
				const r = spawnSync(
					esbuildBin(),
					[
						"--loader=ts",
						"--format=cjs",
						"--platform=node",
						"--target=esnext",
						"--sourcefile=" + filename,
						"--log-level=error",
					],
					{ input: src, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
				);
				if (r.status !== 0) throw new Error(r.stderr || r.stdout);
				let cjs = r.stdout.replace(
					/const import_meta = \{\};/g,
					'const import_meta = { dir: __dirname, dirname: __dirname, path: __filename, filename: __filename, url: require("url").pathToFileURL(__filename).href };',
				);
				mod._compile(cjs, filename);
			};
			module._extensions[".tsx"] = module._extensions[".ts"];
			const orig = module._resolveFilename;
			module._resolveFilename = function (request, parent, isMain, options) {
				try {
					return orig.call(this, request, parent, isMain, options);
				} catch (err) {
					if (parent && parent.filename && (request.startsWith(".") || request.startsWith("/"))) {
						const found = tryFile(
							request.startsWith("/") ? request : join(dirname(parent.filename), request),
						);
						if (found) return found;
					}
					throw err;
				}
			};
		}
		module.registerHooks({ resolve: resolveHook, load: loadHook });
	}
}
