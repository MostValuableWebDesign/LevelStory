import assert from "node:assert/strict";
import test from "node:test";
import { resolveAllowedHosts } from "./vite-hosts.ts";

test("Vite host configuration is safe without Replit domain variables", () => {
  assert.deepEqual(resolveAllowedHosts({}), ["localhost", "127.0.0.1"]);
});

test("Vite host configuration includes configured Replit preview domains", () => {
  assert.deepEqual(
    resolveAllowedHosts({
      REPLIT_DEV_DOMAIN: "project.replit.dev",
      REPLIT_DOMAINS: " project.example.com, preview.example.com ",
    }),
    ["localhost", "127.0.0.1", "project.replit.dev", "project.example.com", "preview.example.com"],
  );
});