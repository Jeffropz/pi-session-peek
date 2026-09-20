// npm version 的钩子，两种用法：
//   node scripts/release-changelog.mjs --check   preversion：确认 CHANGELOG.md 有非空的 "## Unreleased" 段落，
//                                               没有就让 npm version 在改动任何文件之前失败
//   node scripts/release-changelog.mjs           version：把 "## Unreleased" 改成刚升上去的版本号并 git add，
//                                               这样它会和 package.json 一起进 "chore: release X.Y.Z" 那个提交
// release.yml 也要靠这个版本段落生成 GitHub Release。不需要手动运行；流程见 README 的 Releasing 一节。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");

function fail(msg) {
  console.error(`release-changelog: ${msg}`);
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(nl);

const i = lines.findIndex((l) => /^## Unreleased\s*$/i.test(l));
if (i === -1) fail(`CHANGELOG.md has no "## Unreleased" section; write the release notes first`);
const next = lines.findIndex((l, k) => k > i && l.startsWith("## "));
const body = lines.slice(i + 1, next === -1 ? undefined : next);
if (!body.some((l) => l.trim())) fail(`the "## Unreleased" section is empty; write the release notes first`);

if (checkOnly) process.exit(0);

const version = process.env.npm_package_version;
if (!version) fail("npm_package_version is not set; run this through `npm version`, not directly");
if (lines.some((l) => l.trim() === `## ${version}`)) fail(`CHANGELOG.md already has a "## ${version}" section`);

lines[i] = `## ${version}`;
writeFileSync(file, lines.join(nl));
execFileSync("git", ["add", file], { stdio: "inherit" });
console.log(`release-changelog: "## Unreleased" -> "## ${version}"`);
