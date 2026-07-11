import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ExemplarSchema = z.object({
  title: z.string().min(1),
  pmid: z.string().optional(),
});

const ProfileSchema = z.object({
  description: z.string().min(1),
  topics: z.array(z.string()).default([]),
  must_have: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exemplar_papers: z.array(ExemplarSchema).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

const DEFAULT_PROFILE_PATH = resolve(process.cwd(), "profile.yaml");

export function loadProfile(path: string = DEFAULT_PROFILE_PATH): Profile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read profile at ${path}: ${(err as Error).message}`);
  }

  const data = parseYaml(raw);
  const parsed = ProfileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid profile.yaml:\n${issues}`);
  }
  return parsed.data;
}
