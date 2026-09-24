import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { QUESTION_SET, QUESTIONS } from "./onboardingQuestions";

// Answers for the current question set. A save that omits QUESTION_SET is
// rejected as a stale page ("Forge has been updated. Reload the page…").
export const HARBOR_ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier\n\nNeighbours and visitors in Port Ellen",
  "Send you a message",
  "Pier Roast 250g — £11\nDecaf Harbour 250g — £12\nSubscription, a bag a fortnight — £20 a month",
  "",
  "",
  "",
  "Warm and welcoming",
  "",
  "",
] as const;

export const TACO_ANSWERS = [
  "Taquería El Farolito",
  "Tacos, burritos and aguas frescas, made to order\n\nFamilies and lunch crowds in Plano",
  "See a menu or price list\nFind you on a map",
  "Tacos al pastor — $3.50\nHorchata — $4",
  "",
  "",
  "",
  "Warm and welcoming",
  "",
  "",
] as const;

type Mutator = {
  mutation: (
    ref: typeof api.onboarding.save,
    args: {
      id: Id<"siteOnboarding">;
      index: number;
      answer: string;
      advance: boolean;
      questionSet: number;
    },
  ) => Promise<unknown>;
};

export async function fillBrief(
  client: Mutator,
  id: Id<"siteOnboarding">,
  answers: readonly string[] = HARBOR_ANSWERS,
) {
  if (answers.length !== QUESTIONS.length) {
    throw new Error(`Expected ${QUESTIONS.length} answers, got ${answers.length}`);
  }
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await client.mutation(api.onboarding.save, {
      id,
      index,
      answer: answers[index] ?? "",
      advance: true,
      questionSet: QUESTION_SET,
    });
  }
}
