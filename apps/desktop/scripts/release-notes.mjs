// Print one version's patch notes from packages/core/src/lib/changelog.ts as plain text —
// the title line, then one "• " bullet per note. The CI release job feeds this
// into latest.json's `notes` (shown by the in-app update banner) and into the
// GitLab release description, so the notes users see always come from the same
// source the « Nouveautés » page renders.
//
//   node scripts/release-notes.mjs 0.4.6
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`release-notes: expected a semver X.Y.Z, got: ${version ?? "(none)"}`);
  process.exit(1);
}

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "core", "src", "lib", "changelog.ts"),
  "utf8",
);

const start = source.indexOf(`version: "${version}"`);
if (start === -1) {
  console.error(`release-notes: no "${version}" entry in packages/core/src/lib/changelog.ts`);
  process.exit(1);
}
const next = source.indexOf(`version: "`, start + 1);
const entry = source.slice(start, next === -1 ? undefined : next);

const title = entry.match(/title:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
const notesBlock = entry.match(/notes:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
const notes = [...notesBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));

if (!title || notes.length === 0) {
  console.error(`release-notes: the ${version} entry has no title/notes`);
  process.exit(1);
}

console.log([JSON.parse(`"${title}"`), ...notes.map((n) => `• ${n}`)].join("\n"));
