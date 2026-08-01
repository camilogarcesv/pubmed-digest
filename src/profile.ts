import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ExemplarSchema = z.object({
  title: z.string().min(1),
  pmid: z.string().optional(),
});

/**
 * What the digest searches. This lives with the profile rather than in config.ts because
 * coverage is the reader's decision, not the operator's — and when several profiles exist,
 * each one needs to own its own sources.
 */
const SourcesSchema = z
  .object({
    /** Journals followed, matched with the [Journal] tag. ISO abbreviations are safest. */
    journals: z.array(z.string()).default([]),
    /**
     * Standing PubMed queries run on every digest. They catch the excellent paper published
     * outside the followed journals. Plain phrases become ("word"[tiab] AND ...); strings that
     * already contain a field tag or AND/OR/NOT pass through untouched.
     */
    queries: z.array(z.string()).default([]),
  })
  .default({ journals: [], queries: [] });

const ProfileSchema = z.object({
  description: z.string().min(1),
  topics: z.array(z.string()).default([]),
  must_have: z.array(z.string()).default([]),
  nice_to_have: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exemplar_papers: z.array(ExemplarSchema).default([]),
  sources: SourcesSchema,
  /** Optional per-profile override of config.threshold. */
  threshold: z.number().int().min(0).max(10).optional(),
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
