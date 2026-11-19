/**
 * Typed contract between the server part and the TUI part of this plugin.
 *
 * The server tool emits `asked` events and waits for the TUI to resolve them
 * through the `answer` / `decline` methods. `resolved` lets all TUI instances
 * close a dialog that is no longer relevant (timeout, supersede, shutdown).
 */
import { Rpc } from "@opencode/plugin/rpc"

const optionSchema = {
  type: "object" as const,
  properties: {
    label: { type: "string" as const },
    description: { type: "string" as const },
    preview: { type: "string" as const },
  },
  required: ["label", "description"],
  additionalProperties: false,
}

const questionSchema = {
  type: "object" as const,
  properties: {
    question: { type: "string" as const },
    header: { type: "string" as const },
    options: { type: "array" as const, items: optionSchema },
    multiSelect: { type: "boolean" as const },
  },
  required: ["question", "header", "options", "multiSelect"],
  additionalProperties: false,
}

const pendingViewSchema = {
  type: "object" as const,
  properties: {
    id: { type: "number" as const },
    sessionID: { type: "string" as const },
    mode: { type: "string" as const, enum: ["sync", "async"] },
    questions: { type: "array" as const, items: questionSchema },
    startedAt: { type: "number" as const },
    deadline: { type: "number" as const },
  },
  required: ["id", "sessionID", "mode", "questions", "startedAt", "deadline"],
  additionalProperties: false,
}

export const AskUserQuestion = Rpc.define({
  id: "ask-user-question",
  methods: {
    /** TUI announces itself so the tool can fall back to text when no UI exists. */
    register: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
    },
    unregister: {
      input: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
    },
    answer: {
      input: {
        type: "object",
        properties: {
          id: { type: "number" },
          answers: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["id", "answers"],
        additionalProperties: false,
      },
    },
    decline: {
      input: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    list: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          pending: { type: "array", items: pendingViewSchema },
        },
        required: ["pending"],
        additionalProperties: false,
      },
    },
  },
  events: {
    asked: {
      schema: {
        type: "object" as const,
        properties: {
          ...pendingViewSchema.properties,
          timeoutMs: { type: "number" as const },
          timeoutMessage: { type: "string" as const },
        },
        required: [...pendingViewSchema.required, "timeoutMs", "timeoutMessage"],
        additionalProperties: false,
      },
    },
    resolved: {
      schema: {
        type: "object" as const,
        properties: {
          id: { type: "number" as const },
          kind: { type: "string" as const, enum: ["answered", "cancelled", "timeout", "error"] },
        },
        required: ["id", "kind"],
        additionalProperties: false,
      },
    },
  },
})
