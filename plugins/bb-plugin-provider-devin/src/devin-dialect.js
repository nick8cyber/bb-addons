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

// Правила bb для треда — в файл, чтобы хук Devin вернул их после сжатия контекста.
// Мост отдаёт их агенту один раз текстом в первом сообщении сессии (у Claude и
// Codex они в системной части каждого запроса), а сжатие Devin их выбрасывает.
// Файл: ~/.local/state/bb-devin/instructions/<bbThreadId>.md (читает
// ~/.config/devin/hooks/bb_instructions.py по BB_THREAD_ID).
var DEVIN_BB_INSTRUCTIONS_DIR = path2.join(os.homedir(), ".local", "state", "bb-devin", "instructions");
function persistDevinBbInstructions(bbThreadId, instructions) {
  if (typeof instructions !== "string" || instructions.length === 0 || !/^thr_[a-z0-9]+$/u.test(bbThreadId)) {
    return;
  }
  const file = path2.join(DEVIN_BB_INSTRUCTIONS_DIR, `${bbThreadId}.md`);
  void fs.mkdir(DEVIN_BB_INSTRUCTIONS_DIR, { recursive: true, mode: 448 }).then(() => fs.writeFile(file, instructions, { mode: 384 })).catch(() => {
  });
}

// Системные уведомления bb ("[bb system] ... completed", "... is now a child") и
// служебные сообщения сторожа оркестратора ("[orchestrator] ...") не прерывают
// идущий ход Devin: ACP не умеет вклинивать сообщение в ход, и мост отменял ход
// (session/cancel) — Devin обрывал текущую команду. Такие уведомления ждут в
// очереди и приходят сразу после хода. Сообщения владельца и других тредов
// по-прежнему прерывают ход (чтобы можно было остановить агента).
function isBbSystemNotice(input) {
  const first = Array.isArray(input) ? input.find((item) => item && item.type === "text") : void 0;
  const text = typeof first?.text === "string" ? first.text : "";
  return text.startsWith("[bb system]") || text.startsWith("[orchestrator]");
}

// docs/specs/provider-devin.md §1: режим прав сессии Devin по permissionMode
// треда bb. Мост передаёт Devin флаг --permission-mode при запуске, но сессия
// ACP его не учитывает — режим прав в ACP это опция сессии "mode". Мост
// выставляет её после session/new и после успешного session/load. Нет опции или
// нужного значения в ней — одно предупреждение в журнал, режим агента не
// меняется; ошибка session/set_config_option — предупреждение, fail-open.
var DEVIN_ACP_MODE_BY_PERMISSION_MODE = {
  "accept-edits": "accept-edits",
  auto: "smart",
  full: "bypass"
};
function findDevinAcpModeConfigOption(configOptions) {
  const options = configOptions ?? [];
  return options.find((option) => option.category === "mode") ?? options.find((option) => option.id === "mode");
}
async function applyDevinAcpSessionMode(args) {
  const target = DEVIN_ACP_MODE_BY_PERMISSION_MODE[args.permissionMode];
  if (target === void 0) {
    return;
  }
  const modeOption = findDevinAcpModeConfigOption(args.configOptions);
  if (modeOption === void 0 || !(modeOption.options ?? []).some((option) => option.value === target)) {
    process.stderr.write(
      `acp bridge: ACP agent "${args.agentLabel}" does not offer session mode "${target}" for permissionMode "${args.permissionMode}"; leaving the agent's default mode
`
    );
    return;
  }
  try {
    await args.connection.request({
      method: "session/set_config_option",
      params: {
        sessionId: args.sessionId,
        configId: modeOption.id,
        value: target
      },
      resultSchema: z.unknown()
    });
  } catch (error) {
    process.stderr.write(
      `acp bridge: failed to set ACP session mode "${target}" on "${args.agentLabel}": ${error instanceof Error ? error.message : String(error)}
`
    );
  }
}
