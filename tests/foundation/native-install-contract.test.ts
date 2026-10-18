import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

it("preserves the pinned native package's no-implicit-build contract in the lockfile", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const native = JSON.parse(fs.readFileSync(
    path.join(root, "node_modules/better-sqlite3/package.json"), "utf8",
  ));
  const locked = lock.packages["node_modules/better-sqlite3"];

  expect(native.version).toBe("13.0.3");
  expect(native.gypfile).toBe(false);
  expect(locked.version).toBe(native.version);
  expect(locked.gypfile).toBe(native.gypfile);
  expect(locked.integrity).toBe(
    "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
  );
});
