# bun 1.4 is Rust + JavaScriptCore. Official builds download a previous bun
# binary and a prebuilt WebKit tarball. That is unacceptable here:
# everything must be compiled from source (Thompson trust) and ABF has no
# network during the rpm build.
#
# Bootstrap:
#   * configure/codegen run under Node + system esbuild
#     (omv-bun-bootstrap.mjs stands in for the bun CLI and Bun.* APIs)
#   * esbuild (packaged separately, built from Go source) bundles JS builtins
#   * cargo crates, npm modules, C library snapshots and oven-sh/WebKit
#     are all SourceN tarballs produced by vendor-sources.sh
#   * --profile=release-local compiles JavaScriptCore from that WebKit tree
#     with the same clang that compiles bun, so the upstream LLVM 21 pin
#     (which exists to match their prebuilt JSC) can be relaxed
#
# First time, on a networked machine:
#   ./vendor-sources.sh
#   abb store bun-*.tar.gz bun-*-vendor-*.tar.xz WebKit-*.tar.gz \
#       node-*-headers.tar.gz bun-*-prefetch.tar.xz
#
# rust-toolchain.toml wants nightly-2026-07-20; we delete it and use
# system rustc with RUSTC_BOOTSTRAP=1.

Name:		bun
Version:	1.4.0
Release:	1
Summary:	JavaScript runtime, bundler, test runner and package manager
Group:		Development/Other
License:	MIT and LGPLv2+
URL:		https://bun.com/
Source0:	https://github.com/oven-sh/bun/archive/bun-v%{version}/bun-%{version}.tar.gz
# cargo vendor into cargo-vendor/ (vendor/ is bun's own path-dep tree)
Source1:	bun-%{version}-cargo-vendor.tar.xz
# npm pack of bun's own package.json devDependencies, --ignore-scripts
Source2:	bun-%{version}-npm-vendor.tar.xz
# BUN_BUILD_PREFETCH_DIR layout: github-archive snapshots of C deps
Source3:	bun-%{version}-prefetch.tar.xz
# JSC-only slice of oven-sh/WebKit at WEBKIT_VERSION (see vendor-sources.sh).
# Full WebKit is ~8G / 1.9G compressed; bun's PORT=JSCOnly only compiles
# JavaScriptCore + WTF + bmalloc (~110M / 9M xz). Source/cmake in that
# tree is WebKit's own *.cmake modules (OptionsJSCOnly, WebKitMacros,
# …), not a bundled cmake; the cmake and unifdef binaries are system
# BuildRequires.
Source4:	WebKit-jsc-only-0f966e81b78c84bb23213e391bc679c4ef83e56b.tar.xz
# node headers bun embeds for process.versions / N-API (nodejs.org source)
Source5:	https://nodejs.org/dist/v26.3.0/node-v26.3.0-headers.tar.gz
Source6:	omv-bun-bootstrap.mjs
Patch0:		bun-llvm-version.patch
Patch1:		bun-offline.patch
Patch2:		bun-codegen-async.patch

BuildRequires:	clang
BuildRequires:	llvm
BuildRequires:	lld
BuildRequires:	cmake
BuildRequires:	ninja
BuildRequires:	make
BuildRequires:	unifdef
BuildRequires:	nasm
BuildRequires:	zstd
BuildRequires:	rust
BuildRequires:	cargo
BuildRequires:	nodejs
BuildRequires:	esbuild
BuildRequires:	python
BuildRequires:	ruby
BuildRequires:	perl
BuildRequires:	perl-JSON-PP
BuildRequires:	pkgconfig(icu-uc)
BuildRequires:	pkgconfig(icu-i18n)
BuildRequires:	pkgconfig(zlib)
BuildRequires:	pkgconfig(libbrotlidec)
BuildRequires:	pkgconfig(openssl)
BuildRequires:	pkgconfig(libuv)
BuildRequires:	pkgconfig(sqlite3)
BuildRequires:	git

# JSC is LGPLv2+ and is statically linked. Ship the static archive so a
# user can rebuild JSC and relink bun.
%package	webkit-static
Summary:	JavaScriptCore static library used to link bun
Group:		Development/Other
License:	LGPLv2+

%description	webkit-static
Static JavaScriptCore (and WTF/bmalloc) archives produced from the
oven-sh/WebKit fork at the revision bun %{version} pins. Required for
LGPL relinkability because bun links JSC statically.

%description
Bun is an all-in-one JavaScript/TypeScript toolkit: runtime (JavaScriptCore),
package manager, bundler and test runner, in a single executable.

This package is compiled entirely from source. It does not use the
prebuilt bun or bun-webkit binaries published by upstream.

%prep
%autosetup -p1 -n bun-bun-v%{version}

# System rustc. The pin is a rustup nightly; ABF has no rustup and we
# refuse to download one. RUSTC_BOOTSTRAP is set in the build phase.
rm -f rust-toolchain.toml

# Cargo vendor (must not unpack over vendor/ — that is lolhtml/rust-argon2)
tar -xf %{S:1}
mkdir -p .cargo
cat > .cargo/config.toml << 'EOF'
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "cargo-vendor"

[net]
offline = true
EOF

# npm / esbuild: drop the vendored tree and point the esbuild the
# build looks up (node_modules/.bin/esbuild) at the system binary.
tar -xf %{S:2}
mkdir -p node_modules/.bin
ln -sfn %{_bindir}/esbuild node_modules/.bin/esbuild

# C/C++ dep prefetch cache (content-addressed by URL, see download.ts)
mkdir -p bun-prefetch
tar -xf %{S:3} -C bun-prefetch

# WebKit source. release-local looks in vendor/WebKit or $BUN_WEBKIT_PATH.
mkdir -p vendor
tar -xf %{S:4} -C vendor
# GitHub archive top-level is WebKit-<sha>/ or oven-sh-WebKit-<sha>/
wk=$(echo vendor/WebKit-* vendor/oven-sh-WebKit-* 2>/dev/null | awk '{print $1}')
if [ -d "$wk" ] && [ "$wk" != "vendor/WebKit" ]; then
	mv "$wk" vendor/WebKit
fi

# OptionsJSCOnly.cmake unconditionally sets ENABLE_API_TESTS ON on
# non-Windows, which overrides -DENABLE_API_TESTS=OFF and then
# add_subdirectory(ThirdParty/gtest) on a tree that does not ship gtest.
sed -i 's/set(ENABLE_API_TESTS ON)/set(ENABLE_API_TESTS OFF)/' \
	vendor/WebKit/Source/cmake/OptionsJSCOnly.cmake

# Keep CMake FetchContent from trying the network (WebKit).
# ENABLE_API_TESTS would pull gtest, which the slim tree does not ship.
sed -i \
	-e '/ENABLE_WEB_RTC: "OFF",/a\      FETCHCONTENT_FULLY_DISCONNECTED: "ON",' \
	-e '/ENABLE_WEB_RTC: "OFF",/a\      ENABLE_API_TESTS: "OFF",' \
	-e '/ENABLE_WEB_RTC: "OFF",/a\      USE_SYSTEM_UNIFDEF: "ON",' \
	-e '/ENABLE_WEB_RTC: "OFF",/a\      USE_HEADER_MAPS: "OFF",' \
	-e '/ENABLE_WEB_RTC: "OFF",/a\      ENABLE_TOOLS: "OFF",' \
	scripts/build/deps/webkit.ts

# Node headers prefetch: same by-url scheme. vendor-sources.sh also
# drops the tarball into the prefetch tree; keep Source5 as a documented
# origin even if it is already inside Source3.

%build
%set_build_flags
export RUSTC_BOOTSTRAP=1
export CARGO_HOME="$PWD/.cargo"
export CARGO_NET_OFFLINE=true
export RUSTUP_OFFLINE=1
export BUN_BUILD_PREFETCH_DIR="$PWD/bun-prefetch"
export BUN_BUILD_OFFLINE=1
export BUN_WEBKIT_PATH="$PWD/vendor/WebKit"
export ESBUILD_BINARY_PATH=%{_bindir}/esbuild
export npm_config_offline=true
export npm_config_ignore_scripts=true
# git/cmake must not prompt or try a remote
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# findBun() checks ~/.bun/bin/bun first. Put the bootstrap stub there
# so configure never tries to download a previous bun. The .mjs copy is
# what Node --import loads (extensionless files are not a stable ESM URL).
mkdir -p "$HOME/.bun/bin"
install -m0755 %{S:6} "$HOME/.bun/omv-bun-bootstrap.mjs"
install -m0755 %{S:6} "$HOME/.bun/bin/bun"
mkdir -p bootstrap-bin
install -m0755 %{S:6} bootstrap-bin/bun
export PATH="$PWD/bootstrap-bin:$PATH"
export OMV_BUN_LOADER="$HOME/.bun/omv-bun-bootstrap.mjs"
export OMV_BUN_STUB="$HOME/.bun/bin/bun"

# Node 22.18+ / 26 type stripping. scripts/build.ts is TypeScript.
node --experimental-strip-types --no-warnings scripts/build.ts \
	--profile=release-local \
	--webkit=local \
	--lto=off \
	--build-dir=build/release \
	--configure-only

ninja -C build/release -v

%install
install -Dm0755 build/release/bun %{buildroot}%{_bindir}/bun
ln -s bun %{buildroot}%{_bindir}/bunx

if [ -d completions ]; then
	[ -f completions/bun.bash ] && \
		install -Dm0644 completions/bun.bash \
			%{buildroot}%{_datadir}/bash-completion/completions/bun
	[ -f completions/bun.fish ] && \
		install -Dm0644 completions/bun.fish \
			%{buildroot}%{_datadir}/fish/vendor_completions.d/bun.fish
	[ -f completions/bun.zsh ] && \
		install -Dm0644 completions/bun.zsh \
			%{buildroot}%{_datadir}/zsh/site-functions/_bun
fi

# LGPL relink bits — JSC/WTF/bmalloc static archives from the local WebKit build
mkdir -p %{buildroot}%{_libdir}/bun
find build/release -name 'libJavaScriptCore.a' -o -name 'libWTF.a' -o -name 'libbmalloc.a' \
	| while read f; do
		install -m0644 "$f" %{buildroot}%{_libdir}/bun/
	done

%check
%{buildroot}%{_bindir}/bun --version
echo 'console.log("ok")' | %{buildroot}%{_bindir}/bun -e 'console.log("ok")'

%files
%license LICENSE.md
%doc README.md
%{_bindir}/bun
%{_bindir}/bunx
%{_datadir}/bash-completion/completions/bun
%{_datadir}/fish/vendor_completions.d/bun.fish
%{_datadir}/zsh/site-functions/_bun

%files webkit-static
%{_libdir}/bun/
