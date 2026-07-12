import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// A saved run snapshot: the fetched papers AND their scores. --from-cache replays the
// scores (free); --rescore reuses the papers and re-runs scoring (skips PubMed).

const AuthorSchema = z.object({
  lastName: z.string().optional(),
  foreName: z.string().optional(),
});

const PaperSchema = z.object({
  pmid: z.string(),
  title: z.string(),
  abstract: z.string(),
  hasAbstract: z.boolean(),
  authors: z.array(AuthorSchema),
  journal: z.string(),
  pubDate: z.string(),
  source: z.string(),
});

const ScoredPaperSchema = PaperSchema.extend({
  relevance: z.number().int().min(0).max(10),
  reason: z.string(),
});

const SnapshotSchema = z.object({
  version: z.literal(1),
  command: z.enum(["digest", "search"]),
  topic: z.string().optional(),
  createdAt: z.string(),
  model: z.string(),
  papers: z.array(PaperSchema),
  scored: z.array(ScoredPaperSchema),
});

export type CacheSnapshot = z.infer<typeof SnapshotSchema>;

export async function saveCache(path: string, snapshot: CacheSnapshot): Promise<void> {
  const validated = SnapshotSchema.parse(snapshot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export async function loadCache(path: string): Promise<CacheSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No cache at ${path}. Run once with --save-cache first.`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Cache file ${path} is not valid JSON.`);
  }

  const parsed = SnapshotSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Cache file ${path} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}
