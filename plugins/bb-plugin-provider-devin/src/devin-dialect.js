// ../bb-plugin-provider-devin/src/devin-dialect.js (вставляется в копию моста)
// Devin CLI отдаёт субагента как обычный ACP tool_call без имени инструмента:
//   rawInput = { title, task, profile: "subagent_general" | "subagent_explore" | <свой>,
//                is_background }
//   title    = "Ran general subagent <title>"
// Диалект превращает его в элемент bb `delegation`: карточка «Running subagent /
// Subagent finished» с названием задачи, как у Cursor и Claude.
var devinSubagentRawInputSchema = z.object({
  task: z.string(),
  profile: z.string().optional(),
  title: z.string().optional(),
  is_background: z.boolean().optional()
}).passthrough();
function devinSubagentDetail(input) {
  const parts = [];
  if (input.profile !== void 0) {
    parts.push(input.profile.replace(/^subagent_/u, ""));
  }
  if (input.is_background === true) {
    parts.push("в фоне");
  }
  return parts.length === 0 ? void 0 : parts.join(" · ");
}
function devinClassifyToolCall(event) {
  const parsed = devinSubagentRawInputSchema.safeParse(event.rawInput);
  if (!parsed.success) {
    return void 0;
  }
  const input = parsed.data;
  if (input.profile === void 0 && !/subagent/iu.test(event.title ?? "")) {
    return void 0;
  }
  const label = input.title ?? event.title ?? "Devin subagent";
  const detail = devinSubagentDetail(input);
  return {
    item: {
      type: "delegation",
      childRef: event.toolCallId,
      label,
      background: input.is_background === true
    },
    presentation: delegationPresentation({ label, ...detail === void 0 ? {} : { detail } })
  };
}
var DEVIN_ACP_DIALECT = {
  id: "devin",
  classifyToolCall: devinClassifyToolCall
};
