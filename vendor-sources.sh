#!/bin/bash
# Produce every tarball bun.spec needs, from source, on a networked machine.
# Then: abb store the files this script prints.
#
# Nothing this script downloads is executed. cargo vendor / npm pack only
# collect source; WebKit and C-dep archives are unpacked later in the
# offline ABF buildroot and compiled there.
set -euo pipefail

VERSION="${1:-1.4.0}"
WEBKIT_VERSION="${2:-0f966e81b78c84bb23213e391bc679c4ef83e56b}"
NODEJS_HEADERS_VERSION="${3:-26.3.0}"
HERE=$(cd "$(dirname "$0")" && pwd)
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

BUN_TGZ="$HERE/bun-${VERSION}.tar.gz"
BUN_URL="https://github.com/oven-sh/bun/archive/bun-v${VERSION}/bun-${VERSION}.tar.gz"

echo "==> bun source"
if [ ! -f "$BUN_TGZ" ]; then
	curl -fL -o "$BUN_TGZ" "$BUN_URL"
fi
tar -xf "$BUN_TGZ" -C "$WORKDIR"
SRC="$WORKDIR/bun-bun-v${VERSION}"
[ -d "$SRC" ] || SRC="$WORKDIR/bun-${VERSION}"

echo "==> cargo vendor"
# bun already uses vendor/ for path deps (lolhtml, rust-argon2) that the
# build system fetches. cargo vendor must go into a different directory.
(
	cd "$SRC"
	rm -f rust-toolchain.toml
	# Path deps must exist so cargo can walk their crates.io deps.
	mkdir -p vendor/lolhtml vendor/rust-argon2
	curl -fL "https://github.com/oven-sh/lol-html/archive/725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e.tar.gz" \
		| tar -xz --strip-components=1 -C vendor/lolhtml
	curl -fL "https://github.com/sru-systems/rust-argon2/archive/ed81866f163f0c7026aa6fd8388adf37242eb32a.tar.gz" \
		| tar -xz --strip-components=1 -C vendor/rust-argon2
	if [ -f patches/rust-argon2/legacy-low-memory.patch ]; then
		patch -p1 -d vendor/rust-argon2 < patches/rust-argon2/legacy-low-memory.patch || \
		patch -p1 < patches/rust-argon2/legacy-low-memory.patch || true
	fi
	mkdir -p .cargo
	cargo vendor cargo-vendor
	tar -cJf "$HERE/bun-${VERSION}-cargo-vendor.tar.xz" cargo-vendor
)

echo "==> npm vendor (ignore-scripts, no binaries executed)"
# npm does not understand bun's workspace: protocol. Point those at
# the in-tree packages, then install the remaining registry deps.
(
	cd "$SRC"
	python - << 'PY'
import json, pathlib
p = pathlib.Path("package.json")
pkg = json.loads(p.read_text())
def rewrite(v):
    if not isinstance(v, str) or not v.startswith("workspace:"):
        return v
    rest = v[len("workspace:"):]
    if rest in ("*", ""):
        return v  # leave; handled via workspaces field
    return "file:" + rest.lstrip("./")
for section in ("dependencies", "devDependencies", "resolutions"):
    if section in pkg and isinstance(pkg[section], dict):
        pkg[section] = {k: rewrite(v) if k not in ("@types/bun", "bun-types") else
                        ("file:packages/@types/bun" if k == "@types/bun" else "file:packages/bun-types")
                        for k, v in pkg[section].items()}
p.write_text(json.dumps(pkg, indent=2) + "\n")
PY
	npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps
	find node_modules -type f \( -name '*.node' -o -name '*.exe' -o -name 'esbuild' \) -delete
	tar -cJf "$HERE/bun-${VERSION}-npm-vendor.tar.xz" node_modules
)

echo "==> C dependency prefetch (github-archive + node headers)"
PREFETCH="$WORKDIR/prefetch"
mkdir -p "$PREFETCH/by-url"

prefetch_url() {
	local url="$1"
	local key
	key=$(printf '%s' "$url" | sha256sum | awk '{print substr($1,1,32)}')
	local dest="$PREFETCH/by-url/$key"
	if [ ! -f "$dest" ]; then
		echo "    $url"
		curl -fL -o "$dest" "$url"
	fi
}

# Parse repo + commit out of scripts/build/deps/*.ts
# Matches:  repo: "owner/name",  then later  commit: "hex"
python - "$SRC" << 'PY' > "$WORKDIR/deps.list"
import re, sys, pathlib
root = pathlib.Path(sys.argv[1]) / "scripts/build/deps"
const_re = re.compile(r'(?:const|export const)\s+(\w+)\s*=\s*"([^"]+)"')
repo_re = re.compile(r'repo:\s*"([^"]+)"')
commit_re = re.compile(r'commit:\s*([A-Za-z0-9_]+|"[0-9a-f]{7,40}")')
for p in sorted(root.glob("*.ts")):
    text = p.read_text()
    if "github-archive" not in text:
        continue
    consts = dict(const_re.findall(text))
    repos = repo_re.findall(text)
    commits = []
    for raw in commit_re.findall(text):
        if raw.startswith('"'):
            commits.append(raw.strip('"'))
        elif raw in consts:
            commits.append(consts[raw])
    if repos and commits:
        print(f"{repos[0]} {commits[0]}")
    else:
        print(f"# skip {p.name}: repo={repos!r} commit={commits!r}", file=sys.stderr)
PY

while read -r repo commit; do
	[ -n "$repo" ] || continue
	prefetch_url "https://github.com/${repo}/archive/${commit}.tar.gz"
done < "$WORKDIR/deps.list"

prefetch_url "https://nodejs.org/dist/v${NODEJS_HEADERS_VERSION}/node-v${NODEJS_HEADERS_VERSION}-headers.tar.gz"

tar -cJf "$HERE/bun-${VERSION}-prefetch.tar.xz" -C "$PREFETCH" .

# Keep a copy of the node headers tarball as Source5
if [ ! -f "$HERE/node-v${NODEJS_HEADERS_VERSION}-headers.tar.gz" ]; then
	curl -fL -o "$HERE/node-v${NODEJS_HEADERS_VERSION}-headers.tar.gz" \
		"https://nodejs.org/dist/v${NODEJS_HEADERS_VERSION}/node-v${NODEJS_HEADERS_VERSION}-headers.tar.gz"
fi

echo "==> JSC-only WebKit @ ${WEBKIT_VERSION}"
# GitHub archive of oven-sh/WebKit is ~2G (422s or multi-hour). PORT=JSCOnly
# only compiles JavaScriptCore + WTF + bmalloc + unifdef. Clone, slice, xz.
WK="$HERE/WebKit-jsc-only-${WEBKIT_VERSION}.tar.xz"
if [ ! -f "$WK" ]; then
	CLONE="$WORKDIR/webkit-clone"
	git clone --depth 1 https://github.com/oven-sh/WebKit.git "$CLONE"
	if [ "$(git -C "$CLONE" rev-parse HEAD)" != "$WEBKIT_VERSION" ]; then
		git -C "$CLONE" fetch --depth 1 origin "$WEBKIT_VERSION"
		git -C "$CLONE" checkout --detach "$WEBKIT_VERSION"
	fi
	SLIM="$WORKDIR/webkit-jsc-only/WebKit"
	mkdir -p "$SLIM/Source/ThirdParty"
	cp -a "$CLONE/CMakeLists.txt" "$SLIM/"
	cp -a "$CLONE/Source/CMakeLists.txt" "$CLONE/Source/cmake" "$SLIM/Source/"
	cp -a "$CLONE/Source/JavaScriptCore" "$CLONE/Source/WTF" "$CLONE/Source/bmalloc" "$SLIM/Source/"
	for f in ReadMe.md jsc.md CMakePresets.json; do
		[ -f "$CLONE/$f" ] && cp -a "$CLONE/$f" "$SLIM/"
	done
	tar -C "$WORKDIR/webkit-jsc-only" -cJf "$WK" WebKit
fi

echo
echo "Store these with abb store:"
echo "  $BUN_TGZ"
echo "  $HERE/bun-${VERSION}-cargo-vendor.tar.xz"
echo "  $HERE/bun-${VERSION}-npm-vendor.tar.xz"
echo "  $HERE/bun-${VERSION}-prefetch.tar.xz"
echo "  $WK"
echo "  $HERE/node-v${NODEJS_HEADERS_VERSION}-headers.tar.gz"
echo "  $HERE/omv-bun-bootstrap.sh"
echo "  $HERE/bun-llvm-version.patch"
