import { describe, expect, it } from "vitest";
import { dedupeByDoi, excludeByPublicationType } from "../src/filter.js";
import { makePaper } from "./helpers.js";

const EXCLUDED = ["Published Erratum", "Comment", "Editorial"];

describe("excludeByPublicationType", () => {
  it("drops records whose type is editorial noise", () => {
    const papers = [
      makePaper("1", { publicationTypes: ["Journal Article"] }),
      makePaper("2", { publicationTypes: ["Published Erratum"] }),
      makePaper("3", { publicationTypes: ["Journal Article", "Comment"] }),
    ];
    const { kept, dropped } = excludeByPublicationType(papers, EXCLUDED);

    expect(kept.map((p) => p.pmid)).toEqual(["1"]);
    expect(dropped.map((d) => d.reason)).toEqual(["Published Erratum", "Comment"]);
  });

  it("matches case-insensitively", () => {
    const papers = [makePaper("1", { publicationTypes: ["published erratum"] })];
    expect(excludeByPublicationType(papers, EXCLUDED).kept).toHaveLength(0);
  });

  it("keeps records with no publication types at all", () => {
    const papers = [makePaper("1", { publicationTypes: [] })];
    expect(excludeByPublicationType(papers, EXCLUDED).kept).toHaveLength(1);
  });
});

describe("dedupeByDoi", () => {
  it("keeps one record per DOI", () => {
    const papers = [
      makePaper("1", { doi: "10.1/a" }),
      makePaper("2", { doi: "10.1/b" }),
      makePaper("3", { doi: "10.1/a" }),
    ];
    const { kept, dropped } = dedupeByDoi(papers);

    expect(kept.map((p) => p.pmid)).toEqual(["1", "2"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.paper.pmid).toBe("3");
  });

  // The ahead-of-print record often has no abstract while the final one does; the ledger can't
  // catch the pair because each version has its own PMID.
  it("prefers the version that has an abstract, keeping its position", () => {
    const papers = [
      makePaper("aheadofprint", { doi: "10.1/a", hasAbstract: false, abstract: "" }),
      makePaper("other", { doi: "10.1/b" }),
      makePaper("final", { doi: "10.1/a", hasAbstract: true, abstract: "texto" }),
    ];
    const { kept, dropped } = dedupeByDoi(papers);

    expect(kept.map((p) => p.pmid)).toEqual(["final", "other"]);
    expect(dropped[0]!.paper.pmid).toBe("aheadofprint");
  });

  it("keeps every record that has no DOI", () => {
    const papers = [makePaper("1"), makePaper("2"), makePaper("3")];
    expect(dedupeByDoi(papers).kept).toHaveLength(3);
  });
});
