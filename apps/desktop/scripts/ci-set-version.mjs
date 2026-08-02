// Stamp the released version (from the CI tag, e.g. v1.2.3 -> 1.2.3) into the app
// manifests so the built installers carry it instead of the checked-in 0.1.0.
// Cross-platform (called the same way from the Linux, macOS and Windows CI jobs):
//
//   node scripts/ci-set-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`ci-set-version: expected a semver X.Y.Z, got: ${version ?? "(none)"}`);
  process.exit(1);
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The in-app « Nouveautés » page is the user-facing contract for a release:
// refuse to stamp a version that has no patch notes, so version numbers and
// notes can never drift apart.
const changelog = readFileSync(join(desktopRoot, "src", "lib", "changelog.ts"), "utf8");
if (!changelog.includes(`version: "${version}"`)) {
  console.error(
    `ci-set-version: src/lib/changelog.ts has no entry for ${version} — add the patch notes for v${version} (title + notes) before tagging.`,
  );
  process.exit(1);
}

for (const rel of ["package.json", "src-tauri/tauri.conf.json"]) {
  const path = join(desktopRoot, rel);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`ci-set-version: ${rel} -> ${version}`);
}
