#!/usr/bin/env node

/**
 * Lockstep version maintenance for this **pnpm workspace**.
 *
 * 用法：
 *   node scripts/sync-versions.js                                  # 校验 lockstep + 把内部依赖规格统一为 workspace:*
 *   node scripts/sync-versions.js --bump patch|minor|major         # 先整体升版本，再做上面的同步
 *
 * 与 npm 时代的差异：内部依赖统一写 pnpm 的 `workspace:*` 协议（packages/* 内互相引用），
 * 不再写 `^<version>` —— 否则 pnpm 会去 registry 拉旧版本而不是链接本地包。
 * `dependencies` / `devDependencies` / `peerDependencies` 三个字段一并处理。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUMP_KINDS = ["patch", "minor", "major"];
const WORKSPACE_SPEC = "workspace:*";

const args = process.argv.slice(2);
const bumpIndex = args.indexOf("--bump");
const bumpKind = bumpIndex >= 0 ? args[bumpIndex + 1] : undefined;
if (bumpIndex >= 0 && !BUMP_KINDS.includes(bumpKind)) {
	console.error(`Unknown bump kind: ${bumpKind ?? "(missing)"}. Use one of: ${BUMP_KINDS.join(", ")}`);
	process.exit(1);
}

const packagesDir = join(process.cwd(), "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter((dirent) => dirent.isDirectory())
	.map((dirent) => dirent.name);

// Read all package.json files and build version map
const packages = {};
const versionMap = {};

for (const dir of packageDirs) {
	const pkgPath = join(packagesDir, dir, "package.json");
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		packages[dir] = { path: pkgPath, data: pkg };
		versionMap[pkg.name] = pkg.version;
	} catch (e) {
		console.error(`Failed to read ${pkgPath}:`, e.message);
	}
}

/** Semver bump for plain `x.y.z` versions (the only shape this repo uses). */
function bumpVersion(version, kind) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!m) {
		console.error(`Cannot ${kind}-bump non-semver version: ${version}`);
		process.exit(1);
	}
	const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

// Optional bump first, so the lockstep check below validates the new state.
if (bumpKind) {
	for (const pkg of Object.values(packages)) {
		const next = bumpVersion(pkg.data.version, bumpKind);
		console.log(`  ${pkg.data.name}: ${pkg.data.version} → ${next}`);
		pkg.data.version = next;
		versionMap[pkg.data.name] = next;
		writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
	}
	console.log(`\nBumped all packages (${bumpKind}).`);
}

console.log("Current versions:");
for (const [name, version] of Object.entries(versionMap).sort()) {
	console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
	console.error("\n❌ ERROR: Not all packages have the same version!");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  pnpm run version:patch");
	console.error("  pnpm run version:minor");
	console.error("  pnpm run version:major");
	process.exit(1);
}

console.log("\n✅ All packages at same version (lockstep)");

// Normalize every intra-monorepo dependency to the pnpm workspace protocol
const FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
let totalUpdates = 0;

for (const pkg of Object.values(packages)) {
	let updated = false;

	for (const field of FIELDS) {
		const deps = pkg.data[field];
		if (!deps) continue;
		for (const [depName, currentSpec] of Object.entries(deps)) {
			if (!versionMap[depName]) continue; // 只处理本仓 workspace 内部的包
			if (currentSpec === WORKSPACE_SPEC) continue;
			console.log(`\n${pkg.data.name}:`);
			console.log(`  ${field} ${depName}: ${currentSpec} → ${WORKSPACE_SPEC}`);
			deps[depName] = WORKSPACE_SPEC;
			updated = true;
			totalUpdates++;
		}
	}

	if (updated) {
		writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
	}
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies already use workspace:*.");
} else {
	console.log(`\n✅ Normalized ${totalUpdates} intra-monorepo dependency spec(s) to workspace:*`);
}
