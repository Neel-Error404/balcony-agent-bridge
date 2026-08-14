import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DispatchConfigurationError } from "../errors.js";

const ProjectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "must contain only letters, numbers, dots, underscores, and hyphens",
  );

const ProjectRegistrySchema = z
  .object({
    schema_version: z.literal("1.0"),
    projects: z
      .array(
        z
          .object({
            key: ProjectKeySchema,
            path: z.string().trim().min(1),
            enabled: z.boolean().default(true),
            peer_readable: z.literal(true),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

export interface RegisteredProject {
  key: string;
  path: string;
}

export class ProjectRegistry {
  private readonly projects: ReadonlyMap<string, RegisteredProject>;

  private constructor(projects: ReadonlyMap<string, RegisteredProject>) {
    this.projects = projects;
  }

  public static load(registryPath: string): ProjectRegistry {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch (error) {
      throw new DispatchConfigurationError(
        "The dispatcher project registry could not be read as JSON.",
        { cause: error },
      );
    }

    const parsed = ProjectRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new DispatchConfigurationError(
        `The dispatcher project registry is invalid: ${detail}`,
      );
    }

    const projects = new Map<string, RegisteredProject>();
    for (const project of parsed.data.projects) {
      const normalizedKey = project.key.toLowerCase();
      if (projects.has(normalizedKey)) {
        throw new DispatchConfigurationError(
          `The dispatcher project registry contains duplicate key '${project.key}'.`,
        );
      }
      if (!project.enabled) {
        continue;
      }

      if (!path.isAbsolute(project.path)) {
        throw new DispatchConfigurationError(
          `Project '${project.key}' must use an absolute local filesystem path.`,
        );
      }
      const configuredPath = path.resolve(project.path);
      if (isNetworkPath(configuredPath)) {
        throw new DispatchConfigurationError(
          `Project '${project.key}' must use a local filesystem path.`,
        );
      }

      let resolvedPath: string;
      try {
        const stat = fs.statSync(configuredPath);
        if (!stat.isDirectory()) {
          throw new Error("not a directory");
        }
        resolvedPath = fs.realpathSync.native(configuredPath);
        if (isNetworkPath(resolvedPath)) {
          throw new Error("resolves to a network path");
        }
      } catch (error) {
        throw new DispatchConfigurationError(
          `Project '${project.key}' does not resolve to an accessible directory.`,
          { cause: error },
        );
      }

      projects.set(normalizedKey, {
        key: project.key,
        path: resolvedPath,
      });
    }

    if (projects.size === 0) {
      throw new DispatchConfigurationError(
        "The dispatcher project registry has no enabled projects.",
      );
    }
    return new ProjectRegistry(projects);
  }

  public get(projectKey: string): RegisteredProject | undefined {
    return this.projects.get(projectKey.toLowerCase());
  }
}

function isNetworkPath(value: string): boolean {
  return value.startsWith("\\\\") || value.startsWith("//");
}
