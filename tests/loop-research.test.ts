import { describe, it, expect } from "vitest";
import {
 countUniqueSourceUrls,
 effectiveSourceCount,
} from "../extensions/loop/sources";

describe("countUniqueSourceUrls", () => {
 it("counts unique URLs, dedupes, ignores non-URL lines", () => {
  const text = [
   "- Claim A → https://example.com/a",
   "- Claim B → https://example.com/b",
   "- Claim C → https://example.com/a (duplicate)",
   "Source: https://arxiv.org/abs/2402.02716",
   "no url here",
  ].join("\n");
  expect(countUniqueSourceUrls(text)).toBe(3);
 });

 it("strips trailing punctuation from URLs", () => {
  expect(countUniqueSourceUrls("see https://example.com/x.")).toBe(1);
 });

 it("ignores non-http schemes", () => {
  expect(countUniqueSourceUrls("mailto:a@b.c and ftp://x")).toBe(0);
 });

 it("returns 0 for empty text", () => {
  expect(countUniqueSourceUrls("")).toBe(0);
 });
});

describe("effectiveSourceCount", () => {
 it("uses min(reported, counted) and hints when the model over-reports", () => {
  const result = effectiveSourceCount(24, 18);
  expect(result.sources).toBe(18);
  expect(result.hint).toContain("reported 24");
  expect(result.hint).toContain("18");
 });

 it("trusts reported when counted >= reported", () => {
  expect(effectiveSourceCount(18, 24)).toEqual({ sources: 18, hint: "" });
 });

 it("falls back to reported when notes.md is unavailable (null)", () => {
  expect(effectiveSourceCount(20, null)).toEqual({ sources: 20, hint: "" });
 });
});
