import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const legacySymbol = ["full", "Decision"].join("");
const repositoryRoot = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const matches = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name))) continue;
    const contents = await readFile(entryPath, "utf8");
    if (!contents.includes(legacySymbol)) continue;
    const relativePath = path.relative(repositoryRoot, entryPath);
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (line.includes(legacySymbol)) matches.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    }
  }
}

await stat(repositoryRoot);
await walk(repositoryRoot);

if (matches.length > 0) {
  console.error(`Legacy decision helper reference found for ${legacySymbol}:`);
  console.error(matches.join("\n"));
  process.exit(1);
}

console.log(`No ${legacySymbol} imports, exports, or references found.`);