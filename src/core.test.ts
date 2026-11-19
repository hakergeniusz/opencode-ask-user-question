/**
 * Ported, SDK-free tests for the pure validation/formatting core of the
 * original pi extension. No pi dependency and no OpenCode SDK is needed to run
 * these: `bun test src/core.test.ts`.
 */
import { describe, expect, it } from "bun:test"
import {
  asyncOpenText,
  asyncSettleText,
  formatAnswers,
  headlessText,
  normalize,
  notifyQuestionAsked,
  syncResultText,
  TIMEOUT_MESSAGE,
} from "./core.js"

const q = (over: Record<string, unknown> = {}) => ({
  question: "Deploy to prod?",
  header: "Deploy",
  options: [
    { label: "Yes", description: "ship it" },
    { label: "No", description: "hold" },
  ],
  ...over,
})

const exec = (params: unknown) =>
  normalize(params as Parameters<typeof normalize>[0])

describe("param validation", () => {
  it("rejects an empty questions array", () => {
    expect(exec({ questions: [] }).error).toBe("Error: provide 1-4 questions.")
  })

  it("rejects more than 4 questions", () => {
    expect(exec({ questions: [q(), q(), q(), q(), q()] }).error).toBe(
      "Error: max 4 questions per call, got 5. Split into multiple calls.",
    )
  })

  it("rejects empty question text and duplicate question texts", () => {
    expect(exec({ questions: [q({ question: "   " })] }).error).toBe(
      "Error: question 1 has empty text.",
    )
    expect(exec({ questions: [q(), q()] }).error).toBe(
      'Error: question texts must be unique (duplicate: "Deploy to prod?").',
    )
  })

  it("rejects fewer than 2 and more than 4 options", () => {
    expect(exec({ questions: [q({ options: [{ label: "Yes", description: "" }] })] }).error).toBe(
      'Error: question "Deploy to prod?" needs 2-4 options, got 1.',
    )
    const five = [q().options[0], q().options[1], { label: "C", description: "" }, { label: "D", description: "" }, { label: "E", description: "" }]
    expect(exec({ questions: [q({ options: five })] }).error).toBe(
      'Error: question "Deploy to prod?" has 5 options, max is 4. Keep the most distinct ones.',
    )
  })

  it("rejects empty and duplicate option labels", () => {
    expect(exec({ questions: [q({ options: [{ label: " ", description: "" }, { label: "No", description: "" }] })] }).error).toBe(
      'Error: question "Deploy to prod?" has an option with empty label.',
    )
    expect(exec({ questions: [q({ options: [{ label: "Yes", description: "" }, { label: "Yes", description: "" }] })] }).error).toBe(
      'Error: option labels must be unique within a question (duplicate "Yes" in "Deploy to prod?").',
    )
  })

  it("normalizes headers (Q<n>, trim, 12-char cap), multiSelect and mode", () => {
    const result = exec({
      questions: [
        q({ header: "  ", multiSelect: undefined }),
        q({ question: "Second?", header: "a-very-long-header" }),
      ],
    })
    expect(result.questions![0].header).toBe("Q1")
    expect(result.questions![1].header).toHaveLength(12)
    expect(result.questions![0].multiSelect).toBe(false)
    expect(result.mode).toBe("sync")
    expect(exec({ questions: [q()], mode: "async" }).mode).toBe("async")
  })
})

describe("headless fallback", () => {
  it("lists the questions and their options", () => {
    const text = headlessText(normalize({ questions: [q()] }).questions!)
    expect(text).toContain("UI not available (non-interactive mode)")
    expect(text).toContain("1. Deploy to prod? Options: Yes / No")
  })
})

describe("sync results", () => {
  it("formats answers and mirrors uncovered questions", () => {
    const questions = normalize({ questions: [q()] }).questions!
    expect(formatAnswers(questions, { "Deploy to prod?": "Yes" })).toBe(
      '"Deploy to prod?"="Yes"',
    )
    expect(formatAnswers(questions, {})).toBe('"Deploy to prod?"="(no answer)"')
  })

  it("maps every outcome to the expected wording", () => {
    const questions = normalize({ questions: [q()] }).questions!
    expect(syncResultText(questions, { kind: "answered", answers: { "Deploy to prod?": "No" } })).toBe(
      '"Deploy to prod?"="No"',
    )
    expect(syncResultText(questions, { kind: "cancelled" })).toBe("User declined to answer questions.")
    expect(syncResultText(questions, { kind: "timeout" })).toBe(TIMEOUT_MESSAGE)
    expect(syncResultText(questions, { kind: "error", message: "dialog blew up" })).toBe(
      "Question failed: dialog blew up",
    )
  })
})

describe("async lifecycle text", () => {
  it("announces an open question and settles it in all modes", () => {
    const questions = normalize({ questions: [q()] }).questions!
    expect(asyncOpenText(7, questions)).toContain("Async question #7 is now open")
    expect(asyncOpenText(7, questions)).toContain("do not ask the same question again")
    expect(asyncSettleText(7, questions, { kind: "answered", answers: { "Deploy to prod?": "No" } })).toBe(
      '[AskUserQuestion #7 answered]\n"Deploy to prod?"="No"',
    )
    expect(asyncSettleText(7, questions, { kind: "timeout" })).toBe(
      `[AskUserQuestion #7 timed out]\n${TIMEOUT_MESSAGE}`,
    )
    expect(asyncSettleText(7, questions, { kind: "cancelled" }, "Custom note")).toContain(
      "[AskUserQuestion #7 cancelled]",
    )
  })
})

describe("desktop notification wording", () => {
  it("varies with UI availability and mode", () => {
    const questions = normalize({ questions: [q()] }).questions!
    expect(notifyQuestionAsked(questions, false, "sync").body).toContain("answer in the agent output")
    expect(notifyQuestionAsked(questions, true, "async").body).toContain("agent keeps working")
    expect(notifyQuestionAsked(questions, true, "sync").body).toContain("look into the OpenCode window")
  })
})
