/**
 * Pure, SDK-free core shared by the server part and (for types) the TUI part.
 *
 * Ported from pi-ask-user-question. All functions here are deterministic and
 * have no dependency on pi or on the OpenCode SDK, which keeps them testable
 * and reusable across plugin parts.
 */

export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

export interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export type AskMode = "sync" | "async"

export type Outcome =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "error"; message: string }

/** View of an open async question, safe to serialize over RPC. */
export interface PendingView {
  id: number
  sessionID: string
  mode: AskMode
  questions: Question[]
  startedAt: number
  deadline: number
}

/** Payload of the server -> TUI `asked` event. */
export interface AskedEventData extends PendingView {
  timeoutMs: number
  timeoutMessage: string
}

/** Payload of the server -> TUI `resolved` event. */
export interface ResolvedEventData {
  id: number
  kind: Outcome["kind"]
}

export const MAX_HEADER = 12
export const ASK_TIMEOUT_MINUTES = 3
export const ASK_TIMEOUT_MS = ASK_TIMEOUT_MINUTES * 60 * 1000
export const TIMEOUT_MESSAGE =
  `Timeout - user did not reply within ${ASK_TIMEOUT_MINUTES} minutes. Do not retry.`

export const SUPERSEDE_NOTE =
  "Another question replaced it before the user answered. Ignore it unless the topic comes up again; do not re-ask."
export const USER_CANCEL_NOTE =
  "The user cancelled this pending question. Do not re-ask."

const DEFAULT_DECLINE_NOTE =
  "The user dismissed the question without answering. Do not re-ask the same thing; proceed with your best guess or ask something different."

/** Validate raw params, returning normalized questions + mode or an error string. */
export function normalize(params: {
  questions: {
    question: string
    header: string
    options: QuestionOption[]
    multiSelect?: boolean
  }[]
  mode?: string
}): { questions?: Question[]; mode?: AskMode; error?: string } {
  const raw = params.questions
  const mode: AskMode = params.mode === "async" ? "async" : "sync"
  if (!raw || raw.length === 0) return { error: "Error: provide 1-4 questions." }
  if (raw.length > 4) {
    return { error: `Error: max 4 questions per call, got ${raw.length}. Split into multiple calls.` }
  }

  const seenQ = new Set<string>()
  const questions: Question[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i]
    if (!q.question?.trim()) return { error: `Error: question ${i + 1} has empty text.` }
    if (seenQ.has(q.question)) {
      return { error: `Error: question texts must be unique (duplicate: "${q.question}").` }
    }
    seenQ.add(q.question)
    if (!q.options || q.options.length < 2) {
      return { error: `Error: question "${q.question}" needs 2-4 options, got ${q.options?.length ?? 0}.` }
    }
    if (q.options.length > 4) {
      return {
        error: `Error: question "${q.question}" has ${q.options.length} options, max is 4. Keep the most distinct ones.`,
      }
    }
    const seenL = new Set<string>()
    for (const o of q.options) {
      if (!o.label?.trim()) {
        return { error: `Error: question "${q.question}" has an option with empty label.` }
      }
      if (seenL.has(o.label)) {
        return {
          error: `Error: option labels must be unique within a question (duplicate "${o.label}" in "${q.question}").`,
        }
      }
      seenL.add(o.label)
    }
    questions.push({
      question: q.question,
      header: (q.header?.trim() || `Q${i + 1}`).slice(0, MAX_HEADER),
      options: q.options,
      multiSelect: q.multiSelect === true,
    })
  }
  return { questions, mode }
}

/** Headless fallback: tell the model to ask the questions in plain text. */
export function headlessText(questions: Question[]): string {
  const listed = questions
    .map((q, i) => `${i + 1}. ${q.question} Options: ${q.options.map((o) => o.label).join(" / ")}`)
    .join("\n")
  return (
    "UI not available (non-interactive mode), could not ask questions. " +
    "Ask the user directly in your reply text instead:\n" +
    listed
  )
}

/** Sync-mode answer text, identical to the pi original. */
export function formatAnswers(questions: Question[], answers: Record<string, string>): string {
  return questions.map((q) => `"${q.question}"="${answers[q.question] ?? "(no answer)"}"`).join(", ")
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

/** "⏱ 2:59 left to answer" (warning styling is left to the TUI). */
export function countdownLabel(secondsLeft: number): string {
  const m = Math.floor(secondsLeft / 60)
  const s = secondsLeft % 60
  return `⏱ ${m}:${String(s).padStart(2, "0")} left to answer`
}

/** Text returned by the tool immediately after opening an async question. */
export function asyncOpenText(id: number, questions: Question[]): string {
  const listed = questions.map((q) => `"${truncate(q.question, 70)}"`).join(" ")
  return (
    `Async question #${id} is now open: ${listed}\n` +
    "This call returned immediately. Continue with everything that does not depend on the answer, " +
    "and do not ask the same question again — the reply arrives as a message when the user " +
    `answers, presses Esc, or ${ASK_TIMEOUT_MINUTES} minutes pass. /ask-pending shows it.`
  )
}

/** Message injected into the session once an async question resolves. */
export function asyncSettleText(
  id: number,
  questions: Question[],
  outcome: Outcome,
  note?: string,
): string {
  const tag = `[AskUserQuestion #${id}`
  switch (outcome.kind) {
    case "answered":
      return `${tag} answered]\n${formatAnswers(questions, outcome.answers)}`
    case "timeout":
      return `${tag} timed out]\n${TIMEOUT_MESSAGE}`
    case "cancelled":
      return `${tag} ${note ? "cancelled" : "declined"}]\n${note ?? DEFAULT_DECLINE_NOTE}`
    default:
      return `${tag} failed]\nThe question UI errored: ${outcome.message}`
  }
}

/** Sync-mode tool result text for each outcome. */
export function syncResultText(questions: Question[], outcome: Outcome): string {
  switch (outcome.kind) {
    case "answered":
      return formatAnswers(questions, outcome.answers)
    case "timeout":
      return TIMEOUT_MESSAGE
    case "cancelled":
      return "User declined to answer questions."
    default:
      return `Question failed: ${outcome.message}`
  }
}

/** Desktop notification wording for a freshly asked question. */
export function notifyQuestionAsked(questions: Question[], uiConnected: boolean, mode: AskMode): {
  title: string
  body: string
} {
  const first = questions[0].question.replace(/\s+/g, " ").trim()
  const extra = questions.length > 1 ? ` (+${questions.length - 1} more)` : ""
  const how = !uiConnected
    ? "answer in the agent output"
    : mode === "async"
      ? "answer now or whenever — the agent keeps working"
      : "look into the OpenCode window to answer"
  return {
    title: "Agent asked a question",
    body: `${truncate(first, 120)}${extra} — ${how}.`,
  }
}

export function notifySettled(outcome: Outcome, id: number): { title: string; body: string } {
  switch (outcome.kind) {
    case "answered":
      return { title: "Question answered", body: `Async question #${id} is answered.` }
    case "timeout":
      return {
        title: "Question timed out",
        body: `Async question #${id} got no reply in ${ASK_TIMEOUT_MINUTES} min.`,
      }
    case "cancelled":
      return { title: "Question dismissed", body: `Async question #${id} was dismissed.` }
    default:
      return { title: "Question failed", body: `Async question #${id} errored.` }
  }
}
