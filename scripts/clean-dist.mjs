import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(repositoryRoot, "dist");

if (path.dirname(outputDirectory) !== repositoryRoot) {
  throw new Error("Refusing to clean a build directory outside the repository");
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
