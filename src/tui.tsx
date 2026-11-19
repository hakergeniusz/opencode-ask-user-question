/**
 * OpenCode V2 TUI part.
 *
 * Listens for `asked` events emitted by the server tool, drives native
 * OpenCode dialogs to collect the answers, and resolves the pending question
 * over RPC. This is the counterpart of the pi extension's custom TUI dialog:
 * it keeps the tab-less, native-dialog form (see README "Known gaps").
 */
import { Plugin } from "@opencode/plugin/tui"
import { AskUserQuestion as RpcContract } from "./rpc.js"
import type { AskedEventData, Question } from "./core.js"

type AnyContext = any

class Declined extends Error {}

async function registerWithRetry(client: AnyContext): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = (await client.rpc(RpcContract).register({})) as { token: string }
      return result.token
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastError ?? new Error("server part of opencode-ask-user-question is not available")
}

function questionTitle(q: Question, deadline: number, selected?: number): string {
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  const suffix = ` · ${seconds}s left`
  const count = selected === undefined ? "" : ` · ${selected} selected`
  return `${q.header}${count}${suffix}: ${q.question}`
}

async function collectAnswers(context: AnyContext, questions: Question[], deadline: number): Promise<Record<string, string>> {
  const answers: Record<string, string> = {}

  for (const q of questions) {
    const labels = q.options.map((o) => o.label)

    if (!q.multiSelect) {
      const picked = await context.ui.dialog.select({
        title: questionTitle(q, deadline),
        options: [
          ...q.options.map((o) => ({
            title: o.label,
            value: o.label,
            description: o.description,
          })),
          { title: "Other (write custom answer)", value: "__other__", description: "Write a custom answer." },
        ],
      })
      if (picked === undefined) throw new Declined()
      if (picked === "__other__") {
        const custom = await context.ui.dialog.prompt({
          title: `Custom answer: ${q.header}`,
          placeholder: "Type your answer…",
        })
        if (custom === undefined) throw new Declined()
        answers[q.question] = custom.trim() || "(no response)"
      } else {
        answers[q.question] = String(picked)
      }
      continue
    }

    // Multi-select: keep offering the remaining options until "Done".
    const picked: string[] = []
    let customText: string | undefined
    for (;;) {
      const remaining = labels.filter((label) => !picked.includes(label))
      const choice = await context.ui.dialog.select({
        title: questionTitle(q, deadline, picked.length),
        options: [
          ...remaining.map((label) => ({
            title: label,
            value: label,
            description: q.options.find((o) => o.label === label)?.description ?? "",
          })),
          ...(customText
            ? []
            : [{ title: "Other (write custom answer)", value: "__other__", description: "Write a custom answer." }]),
          { title: "Done", value: "__done__", description: "Finish this question." },
        ],
      })
      if (choice === undefined) throw new Declined()
      if (choice === "__done__") {
        if (picked.length === 0 && !customText) {
          context.ui.toast.show({ message: "Select at least one option or cancel." })
          continue
        }
        break
      }
      if (choice === "__other__") {
        const custom = await context.ui.dialog.prompt({
          title: `Custom answer: ${q.header}`,
          placeholder: "Type your answer…",
        })
        if (custom !== undefined && custom.trim()) customText = custom.trim()
        continue
      }
      picked.push(String(choice))
      if (picked.length + (customText ? 1 : 0) >= labels.length + 1) break
      if (remaining.length <= 1) break
    }
    answers[q.question] = [...picked, ...(customText ? [customText] : [])].join(", ")
  }

  return answers
}

export default Plugin.define({
  id: "ask-user-question.tui",
  async setup(context) {
    let token: string
    try {
      token = await registerWithRetry(context)
    } catch {
      context.ui.toast.show({ message: "opencode-ask-user-question: server part not available." })
      return
    }

    const api = context.client.rpc(RpcContract)
    const openIds = new Set<number>()

    // A question can be resolved without this dialog (timeout, supersede,
    // /ask-pending cancel, shutdown). Close the dialog in that case.
    const offResolved = api.events.on("resolved", (event) => {
      const { id } = event.data as { id: number }
      if (openIds.delete(id)) context.ui.dialog.clear()
    })

    const offAsked = api.events.on("asked", async (event) => {
      const data = event.data as AskedEventData
      openIds.add(data.id)
      try {
        const answers = await collectAnswers(context, data.questions, data.deadline)
        await context.client.rpc(RpcContract).answer({ id: data.id, answers })
      } catch {
        await context.client.rpc(RpcContract).decline({ id: data.id }).catch(() => {})
      } finally {
        openIds.delete(data.id)
      }
    })

    // Palette command for inspecting pending async questions. The canonical
    // `/ask-pending` slash command is registered by the server part.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ask-user-question.pending",
          title: "Ask User Question: list pending",
          palette: true,
          run: async () => {
            const result = (await context.client.rpc(RpcContract).list({})) as {
              pending: { id: number; deadline: number; questions: { question: string }[] }[]
            }
            const lines = result.pending.map((p) => {
              const left = Math.max(0, Math.ceil((p.deadline - Date.now()) / 1000))
              return `#${p.id} [${left}s left] ${p.questions.map((q) => q.question).join(" | ")}`
            })
            context.ui.toast.show({
              message: lines.length ? `Pending questions:\n${lines.join("\n")}` : "No pending questions.",
            })
          },
        },
      ],
    }))

    return () => {
      offAsked()
      offResolved()
      void context.client.rpc(RpcContract).unregister({ token }).catch(() => {})
    }
  },
})
