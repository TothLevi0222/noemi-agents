import { describe, expect, it } from "vitest";
import questionsDoc from "../eval/faq-questions.json";
import { searchKnowledge } from "./search";

/**
 * Same golden set as the marketing site's /faq quotations
 * (website lib/faq/questions.json). Keep the two files identical.
 */
const TOP_K = 5;

describe("faq retrieval", () => {
  for (const question of questionsDoc.questions) {
    it(`${question.id} retrieves ${question.source}`, () => {
      const hits = searchKnowledge(question.query, TOP_K);
      const matching = hits.filter((hit) => hit.source === question.source);
      expect(
        matching.length,
        hits.map((hit) => `${hit.source} ${hit.title}`).join(" | "),
      ).toBeGreaterThan(0);
      const blob = matching
        .map((hit) => `${hit.title}\n${hit.text}`)
        .join("\n")
        .toLowerCase();
      for (const phrase of question.mustMention) {
        expect(blob, phrase).toContain(phrase.toLowerCase());
      }
    });
  }
});
