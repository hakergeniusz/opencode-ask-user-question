/**
 * OpenCode V2 server part of `opencode-ask-user-question`.
 *
 * Registers the `AskUserQuestion` tool, the `/ask-pending` command, and the
 * RPC bridge used by the TUI part (`./tui`) to render interactive dialogs.
 * The behavior mirrors the original pi extension:
 *   - 1-4 questions, 2-4 options each, "Other" added by the UI, multi-select
 *   - sync (block) and async (deliver the answer as a follow-up message) modes
 *   - one hard 3-minute deadline for all questions; no auto-retry
 *   - one dialog at a time: a new question withdraws an older async one
 *   - desktop notifications via `notify-send`
 *   - headless fallback that tells the model to ask in plain text
 */
import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin"
import { AskUserQuestion as RpcContract } from "./rpc.js"
import {
  ASK_TIMEOUT_MS,
  AskedEventData,
  asyncOpenText,
  asyncSettleText,
  headlessText,
  notifyQuestionAsked,
  notifySettled,
  Outcome,
  PendingView,
  Question,
  SUPERSEDE_NOTE,
  syncResultText,
  TIMEOUT_MESSAGE,
  USER_CANCEL_NOTE,
  normalize,
} from "./core.js"

interface PendingRecord extends PendingView {
  reported?: boolean
  resolve?: (outcome: Outcome) => void
  timer?: ReturnType<typeof setTimeout>
}

const TOOL_DESCRIPTION = [
  "Asks the user 1-4 multiple-choice questions (2-4 options each) to gather info, clarify ambiguity, or decide between options.",
  'An "Other" free-text option is appended automatically — never add your own.',
  'If you recommend an option, put it first with "(Recommended)" in its label.',
  '- mode "sync" (default) blocks the turn until answered; "async" returns at once and delivers the reply as a message later — keep working, never re-ask.',
  "- In plan mode, clarify requirements before finalizing, never ask for plan approval.",
  `- Times out after 3 minutes with no reply; do not retry.`,
].join("\n")

const TOOL_INPUT = {
  type: "object" as const,
  properties: {
    questions: {
      type: "array" as const,
      description: "1-4 questions to ask the user.",
      items: {
        type: "object" as const,
        properties: {
          question: {
            type: "string" as const,
            description: 'Complete question ending with "?". Unique across questions.',
          },
          header: {
            type: "string" as const,
            description: 'Short tab label, max 12 chars. E.g. "Auth".',
          },
          options: {
            type: "array" as const,
            description: "2-4 distinct, mutually exclusive choices (unless multiSelect).",
            items: {
              type: "object" as const,
              properties: {
                label: {
                  type: "string" as const,
                  description: "Display text (1-5 words), unique within the question.",
                },
                description: {
                  type: "string" as const,
                  description: "What this option means; trade-offs or implications.",
                },
                preview: {
                  type: "string" as const,
                  description: "Optional code/mockup/config shown with the option. Single-select only.",
                },
              },
              required: ["label", "description"],
              additionalProperties: false,
            },
          },
          multiSelect: {
            type: "boolean" as const,
            description: "Allow selecting several options. Default false.",
          },
        },
        required: ["question", "header", "options"],
        additionalProperties: false,
      },
    },
    mode: {
      type: "string" as const,
      enum: ["sync", "async"],
      default: "sync",
      description:
        "sync (default) blocks until answered or declined; async returns immediately and delivers the reply as a message later. " +
        "Use async only if you can make progress without the answer.",
    },
  },
  required: ["questions"],
  additionalProperties: false,
}

export default Plugin.define({
  id: "ask-user-question",
  async setup(ctx) {
    const pending = new Map<number, PendingRecord>()
    const uiTokens = new Set<string>()
    let nextId = 1
    let events: {
      emit: (name: "asked" | "resolved", data: AskedEventData | { id: number; kind: Outcome["kind"] }) => Promise<unknown>
    }

    /** Fire-and-forget `notify-send`. Never throws, never keeps the process alive. */
    function desktopNotify(title: string, body: string): void {
      try {
        const child = spawn("notify-send", ["--app-name=opencode", "--icon=dialog-question", title, body], {
          detached: true,
          stdio: "ignore",
        })
        child.on("error", () => {})
        child.unref()
      } catch {
        // Best effort only.
      }
    }

    function armTimeout(rec: PendingRecord): void {
      rec.timer = setTimeout(() => settle(rec, { kind: "timeout" }), ASK_TIMEOUT_MS)
      rec.timer.unref?.()
    }

    function view(rec: PendingRecord): PendingView {
      return {
        id: rec.id,
        sessionID: rec.sessionID,
        mode: rec.mode,
        questions: rec.questions,
        startedAt: rec.startedAt,
        deadline: rec.deadline,
      }
    }

    /** Resolve a pending question exactly once, notify every listener, deliver async replies. */
    function settle(rec: PendingRecord, outcome: Outcome, note?: string): void {
      if (rec.reported) return
      rec.reported = true
      if (rec.timer) clearTimeout(rec.timer)
      pending.delete(rec.id)
      rec.resolve?.(outcome)

      void Promise.resolve(events.emit("resolved", { id: rec.id, kind: outcome.kind })).catch(() => {})

      if (rec.mode === "async") {
        const n = notifySettled(outcome, rec.id)
        desktopNotify(n.title, n.body)
        void ctx.session
          .prompt({
            sessionID: rec.sessionID,
            text: asyncSettleText(rec.id, rec.questions, outcome, note),
            delivery: "queue",
          })
          .catch(() => {
            // Session replaced/reloaded underneath us: nothing to do.
          })
      }
    }

    function retirePending(note: string): void {
      for (const rec of [...pending.values()]) settle(rec, { kind: "cancelled" }, note)
    }

    function open(id: number, questions: Question[], mode: "sync" | "async", sessionID: string): PendingRecord {
      const rec: PendingRecord = {
        id,
        sessionID,
        mode,
        questions,
        startedAt: Date.now(),
        deadline: Date.now() + ASK_TIMEOUT_MS,
      }
      pending.set(id, rec)
      armTimeout(rec)
      void Promise.resolve(
        events.emit("asked", {
          ...view(rec),
          timeoutMs: ASK_TIMEOUT_MS,
          timeoutMessage: TIMEOUT_MESSAGE,
        }),
      ).catch(() => {})
      return rec
    }

    // ---------------------------------------------------------------- RPC --
    const rpc = await ctx.rpc.register(RpcContract, {
      register: async () => {
        const token = crypto.randomUUID()
        uiTokens.add(token)
        return { token }
      },
      unregister: async (input) => {
        uiTokens.delete((input as { token: string }).token)
        return {}
      },
      answer: async (input) => {
        const { id, answers } = input as { id: number; answers: Record<string, string> }
        const rec = pending.get(id)
        if (rec) settle(rec, { kind: "answered", answers })
        return {}
      },
      decline: async (input) => {
        const { id } = input as { id: number }
        const rec = pending.get(id)
        if (rec) settle(rec, { kind: "cancelled" })
        return {}
      },
      list: async () => ({
        pending: [...pending.values()].map(view),
      }),
    })
    events = rpc.events as typeof events

    // ---------------------------------------------------------------- Tool --
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "AskUserQuestion",
        description: TOOL_DESCRIPTION,
        input: TOOL_INPUT,
        options: { codemode: true },
        execute: async (input, context) => {
          const norm = normalize(input as Parameters<typeof normalize>[0])
          if (!norm.questions) return { content: norm.error! }
          const questions = norm.questions
          const mode = norm.mode!

          const uiConnected = uiTokens.size > 0
          const notice = notifyQuestionAsked(questions, uiConnected, mode)
          desktopNotify(notice.title, notice.body)

          // No TUI attached: preserve the pi headless fallback as plain text.
          if (!uiConnected) return { content: headlessText(questions) }

          // Only one dialog fits on screen; withdraw any older async question.
          retirePending(SUPERSEDE_NOTE)

          const id = nextId++
          const rec = open(id, questions, mode, context.sessionID)

          if (mode === "async") {
            return { content: asyncOpenText(id, questions) }
          }

          const outcome = await new Promise<Outcome>((resolve) => {
            rec.resolve = resolve
            if (context.signal?.aborted) {
              settle(rec, { kind: "cancelled" })
              return
            }
            context.signal?.addEventListener("abort", () => settle(rec, { kind: "cancelled" }), { once: true })
          })
          return { content: syncResultText(questions, outcome) }
        },
      })
    })

    // ------------------------------------------------------------- Command --
    await ctx.command.transform((editor) => {
      editor.add({
        name: "ask-pending",
        description: "List open async questions, or cancel one: /ask-pending <id>",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim()
          const reply = (text: string) =>
            ctx.session.prompt({ sessionID, text, delivery }).catch(() => {})

          if (arg) {
            const id = Number.parseInt(arg, 10)
            const rec = pending.get(id)
            if (!rec) {
              await reply(`No pending question #${arg}.`)
              return
            }
            settle(rec, { kind: "cancelled" }, USER_CANCEL_NOTE)
            await reply(`Cancelled question #${id}.`)
            return
          }

          if (pending.size === 0) {
            await reply("No pending questions.")
            return
          }
          const lines = [...pending.values()].map((p) => {
            const left = Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000))
            const age = Math.round((Date.now() - p.startedAt) / 1000)
            return `#${p.id} [${age}s old, ${left}s left] ${p.questions.map((q) => q.question).join(" | ")}`
          })
          await reply(`Pending async questions:\n${lines.join("\n")}`)
        },
      })
    })

    // ------------------------------------------------------------- Cleanup --
    return () => {
      // Session shutdown / plugin unload: close everything without waking the model.
      for (const rec of [...pending.values()]) {
        rec.reported = true
        if (rec.timer) clearTimeout(rec.timer)
        pending.delete(rec.id)
      }
      uiTokens.clear()
      void Promise.resolve(rpc.dispose()).catch(() => {})
    }
  },
})
