import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const buildId = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const env = { ...process.env, LEVELSTORY_BUILD_ID: buildId };
for (const name of ["@workspace/levelstory", "@workspace/api-server"]) {
  execFileSync("pnpm", ["--filter", name, "run", "build"], { cwd, env, stdio: "inherit" });
}
console.log(`Frontend and API built together: ${buildId}. Restart both serving processes to use these artifacts.`);
