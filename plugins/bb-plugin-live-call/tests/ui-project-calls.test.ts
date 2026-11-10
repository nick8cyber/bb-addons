import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import appDef from "../app.js";
import { callEngine } from "../src/ui/engine.js";
import {
  initProjectEvents,
  LIVE_CALL_PROJECTS_EVENT,
  LIVE_CALL_PROJECTS_REQUEST_EVENT,
  LIVE_CALL_START_PROJECT_EVENT,
  publishProjects,
} from "../src/ui/project-events.js";
import {
  setCustomRpcHandler,
  type ProjectCallsApproveResult,
  type ProjectCallsListResult,
  type ProjectCallsRejectResult,
} from "../src/ui/rpc.js";

// Polyfill CloseEvent в среде Node.js
class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;
  constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(type);
    this.code = init?.code ?? 1000;
    this.reason = init?.reason ?? "";
    this.wasClean = init?.wasClean ?? true;
  }
}
if (typeof (globalThis as any).CloseEvent === "undefined") {
  (globalThis as any).CloseEvent = MockCloseEvent;
}

// Мокаем глобальный WebSocket для тестов engine
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];
  binaryType = "arraybuffer";

  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) {
        this.onopen(new Event("open") as any);
      }
    }, 0);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      this.sentMessages.push(data);
    }
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    const ev = new CloseEvent("close", { code, reason });
    if (this.onclose) this.onclose(ev);
  }

  receiveMessage(data: string | ArrayBuffer) {
    const ev = new MessageEvent("message", { data });
    if (this.onmessage) this.onmessage(ev);
  }

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
}

describe("Live Call UI — звонок по проекту (§15.1, §15.8, §16.2)", () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let registeredSlots: Record<string, any>;
  let registeredCommands: Array<{ id: string; title: string; defaultShortcut?: any; run: (ctx?: any) => Promise<void> | void }>;
  let registeredSidebarFooter: Array<{ id: string; label: string; onActivate: () => void }>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;

    const eventTarget = new EventTarget();
    const windowMock = {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      location: { protocol: "http:", host: "localhost:3000" },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    };
    (globalThis as any).window = windowMock;
    (globalThis as any).location = windowMock.location;

    // Собираем регистрации плагина
    registeredSlots = {};
    registeredCommands = [];
    registeredSidebarFooter = [];

    const mockApp = {
      slots: {
        experimental_appOverlay: vi.fn((reg) => {
          registeredSlots.experimental_appOverlay = reg;
        }),
        experimental_threadAction: vi.fn((reg) => {
          registeredSlots.experimental_threadAction = reg;
        }),
        experimental_threadHeaderAction: vi.fn((reg) => {
          registeredSlots.experimental_threadHeaderAction = reg;
        }),
        experimental_newThreadPanelAction: vi.fn((reg) => {
          registeredSlots.experimental_newThreadPanelAction = reg;
        }),
        experimental_providerIcon: vi.fn((reg) => {
          registeredSlots.experimental_providerIcon = reg;
        }),
        experimental_providerIcon: vi.fn((reg) => {
          registeredSlots.experimental_providerIcon = reg;
        }),
        settingsSection: vi.fn((reg) => {
          registeredSlots.settingsSection = reg;
        }),
      },
      experimental_sidebarFooter: {
        register: vi.fn((reg) => {
          registeredSidebarFooter.push(reg);
        }),
      },
      commands: {
        register: vi.fn((reg) => {
          registeredCommands.push(reg);
        }),
      },
    };

    (appDef as any).setup(mockApp);
    callEngine.dismiss();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    setCustomRpcHandler(null);
    callEngine.dismiss();
  });

  describe("1. Регистрация входов в app.tsx", () => {
    it("регистрирует experimental_newThreadPanelAction «Позвонить по проекту»", () => {
      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      expect(panelAction).toBeDefined();
      expect(panelAction.id).toBe("call-project");
      expect(panelAction.title).toBe("Позвонить по проекту");
      expect(panelAction.icon).toBe("live-call/phone");
      expect(typeof panelAction.run).toBe("function");
    });

    it("регистрирует кнопку шапки треда «Звонок по треду» с иконкой телефона", () => {
      const headerAction = registeredSlots.experimental_threadHeaderAction;
      expect(headerAction).toBeDefined();
      expect(headerAction.id).toBe("call");
      expect(headerAction.title).toBe("Звонок по треду");
      const el = headerAction.component({ threadId: "thr_test01", projectId: "proj_test", isCompactViewport: false });
      expect(el.type).toBe("button");
      expect(el.props["aria-label"]).toBe("Звонок по треду");
      const children = [el.props.children].flat();
      expect(children.some((c: any) => typeof c === "object" && c?.props?.name === "phone")).toBe(true);
      expect(children.some((c: any) => typeof c === "object" && c?.props?.children === "Звонок по треду")).toBe(true);
      // Компактная ширина — только иконка, без текста
      const compact = headerAction.component({ threadId: "thr_test01", projectId: "proj_test", isCompactViewport: true });
      expect([compact.props.children].flat().some((c: any) => typeof c === "object" && c?.props?.children === "Звонок по треду")).toBe(false);
    });

    it("регистрирует команду «Live Call: позвонить по проекту»", () => {
      const cmd = registeredCommands.find((c) => c.id === "call-project");
      expect(cmd).toBeDefined();
      expect(cmd?.title).toBe("Live Call: позвонить по проекту");
      expect(typeof cmd?.run).toBe("function");
    });

    it("сохраняет стандартную кнопку сайдбара и горячую клавишу Mod+Shift+L без изменений", () => {
      const sidebarBtn = registeredSidebarFooter.find((b) => b.id === "call");
      expect(sidebarBtn).toBeDefined();
      expect(sidebarBtn?.label).toBe("Позвонить координатору");

      const toggleCmd = registeredCommands.find((c) => c.id === "call-toggle");
      expect(toggleCmd).toBeDefined();
      expect(toggleCmd?.title).toBe("Live Call: позвонить / завершить звонок");
      expect(toggleCmd?.defaultShortcut).toEqual({ key: "l", mod: true, shift: true });
    });
  });

  describe("2. experimental_newThreadPanelAction «Позвонить по проекту» (§15.1)", () => {
    it("если context.projectId не передан — показывает понятное сообщение", async () => {
      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      await panelAction.run({ projectId: null });

      expect(callEngine.getSnapshot().overlayNotice).toBe("звонок для проекта не настроен");
      expect(callEngine.isActive()).toBe(false);
    });

    it("если проект отсутствует в реестре — показывает «звонок для проекта не настроен»", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return { projects: [{ projectId: "other-proj", title: "Other", state: "approved" }] } satisfies ProjectCallsListResult;
        }
        return {};
      });

      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      await panelAction.run({ projectId: "unknown-proj" });

      expect(callEngine.getSnapshot().overlayNotice).toBe("звонок для проекта не настроен");
      expect(callEngine.isActive()).toBe(false);
    });

    it("если проект в состоянии pending — звонок всё равно идёт (§15.8: по прежнему подтверждённому реестру)", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [
              {
                projectId: "crm-proj",
                title: "CRM",
                state: "pending",
                hash: "h1",
                diff: ["+ command: node server.js"],
              },
            ],
          } satisfies ProjectCallsListResult;
        }
        return {};
      });

      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      await panelAction.run({ projectId: "crm-proj" });

      expect(callEngine.isActive()).toBe(true);
      expect(callEngine.getSnapshot().targetProjectId).toBe("crm-proj");
    });

    it("если проект в состоянии approved — начинает звонок callEngine.start({ projectId })", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [{ projectId: "crm-proj", title: "CRM", state: "approved" }],
          } satisfies ProjectCallsListResult;
        }
        if (method === "callToken") {
          return { token: "tok-test-123" };
        }
        return {};
      });

      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      await panelAction.run({ projectId: "crm-proj" });

      expect(callEngine.isActive()).toBe(true);
      expect(callEngine.getSnapshot().targetProjectId).toBe("crm-proj");
    });

    it("если звонок уже идёт — разворачивает док (requestExpand) без повторного старта", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [{ projectId: "crm-proj", title: "CRM", state: "approved" }],
          } satisfies ProjectCallsListResult;
        }
        if (method === "callToken") return { token: "tok" };
        return {};
      });

      const panelAction = registeredSlots.experimental_newThreadPanelAction;
      await panelAction.run({ projectId: "crm-proj" });
      const initialExpand = callEngine.getSnapshot().expandSignal;

      await panelAction.run({ projectId: "crm-proj" });
      expect(callEngine.getSnapshot().expandSignal).toBeGreaterThan(initialExpand);
    });
  });

  describe("3. Команда «Live Call: позвонить по проекту» (§15.1 п. 2)", () => {
    it("отфильтровывает проекты: approved и pending в выборе, invalid — нет", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [
              { projectId: "p-approved-1", title: "CRM", state: "approved" },
              { projectId: "p-pending", title: "Pending", state: "pending" },
              { projectId: "p-invalid", title: "Broken", state: "invalid" },
              { projectId: "p-approved-2", title: "Infra", state: "approved" },
            ],
          } satisfies ProjectCallsListResult;
        }
        return {};
      });

      const cmd = registeredCommands.find((c) => c.id === "call-project")!;
      await cmd.run();

      const picker = callEngine.getSnapshot().projectPicker;
      expect(picker).toBeDefined();
      expect(picker?.projects).toEqual([
        { projectId: "p-approved-1", title: "CRM" },
        { projectId: "p-pending", title: "Pending" },
        { projectId: "p-approved-2", title: "Infra" },
      ]);
    });

    it("если нет проектов со звонком — показывает сообщение «звонок для проекта не настроен»", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [{ projectId: "p-invalid", title: "Broken", state: "invalid" }],
          } satisfies ProjectCallsListResult;
        }
        return {};
      });

      const cmd = registeredCommands.find((c) => c.id === "call-project")!;
      await cmd.run();

      expect(callEngine.getSnapshot().overlayNotice).toBe("звонок для проекта не настроен");
      expect(callEngine.getSnapshot().projectPicker).toBeNull();
    });

    it("выбор проекта в селекторе callEngine.selectProject() начинает звонок по выбранному проекту", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "callToken") return { token: "tok" };
        return {};
      });

      callEngine.openProjectPicker([
        { projectId: "crm", title: "CRM" },
        { projectId: "infra", title: "Infra" },
      ]);

      callEngine.selectProject("infra");

      expect(callEngine.getSnapshot().projectPicker).toBeNull();
      expect(callEngine.isActive()).toBe(true);
      expect(callEngine.getSnapshot().targetProjectId).toBe("infra");
    });
  });

  describe("4. Движок звонка callEngine: projectId, токен и ошибки (§15.1, §15.8, §16.2)", () => {
    it("отправляет кадр hello с projectId и полученным через RPC callToken", async () => {
      let callTokenFetched = false;
      setCustomRpcHandler(async (method) => {
        if (method === "callToken") {
          callTokenFetched = true;
          return { token: "super-secret-token-123" };
        }
        return {};
      });

      callEngine.start({ projectId: "crm-proj" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sock = MockWebSocket.instances[0];
      expect(sock).toBeDefined();
      expect(callTokenFetched).toBe(true);

      const helloMsg = JSON.parse(sock.sentMessages[0]);
      expect(helloMsg).toEqual({
        type: "hello",
        protocol: 1,
        token: "super-secret-token-123",
        projectId: "crm-proj",
      });
    });

    it("при закрытии кодом 4401 unauthorized перезапрашивает токен и пробует один раз; не уходит в бесконечный цикл", async () => {
      let tokenCalls = 0;
      setCustomRpcHandler(async (method) => {
        if (method === "callToken") {
          tokenCalls += 1;
          return { token: `token-attempt-${tokenCalls}` };
        }
        return {};
      });

      callEngine.start({ projectId: "test-proj" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const firstSock = MockWebSocket.instances[0];
      expect(tokenCalls).toBe(1);

      // Сервер закрывает первый сокет с 4401
      firstSock.close(4401, "unauthorized");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Движок должен создать второй сокет и снова запросить токен
      expect(MockWebSocket.instances.length).toBe(2);
      expect(tokenCalls).toBe(2);
      const secondSock = MockWebSocket.instances[1];

      // Сервер снова закрывает второй сокет с 4401
      secondSock.close(4401, "unauthorized");
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Движок НЕ должен создавать третий сокет
      expect(MockWebSocket.instances.length).toBe(2);
      expect(callEngine.getSnapshot().phase).toBe("failed");
      expect(callEngine.getSnapshot().error?.code).toBe("unauthorized");
    });

    it("кадр ошибки project_not_configured переводит звонок в failed с понятным описанием", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "callToken") return { token: "tok" };
        return {};
      });

      callEngine.start({ projectId: "unconfigured-proj" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const sock = MockWebSocket.instances[0];
      sock.receiveMessage(
        JSON.stringify({
          type: "error",
          code: "project_not_configured",
          message: "звонок для проекта не настроен в реестре",
          retryable: false,
        }),
      );
      sock.close(1000);

      const view = callEngine.getSnapshot();
      expect(view.phase).toBe("failed");
      expect(view.error?.code).toBe("project_not_configured");
      expect(view.error?.message).toBe("звонок для проекта не настроен в реестре");
    });
  });

  describe("5. События window (§15.1, §15.8)", () => {
    it("publishProjects публикует bb-live-call:projects для approved и pending (§15.1: список из реестра)", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [
              { projectId: "proj-app", title: "App", state: "approved" },
              { projectId: "proj-pend", title: "Pend", state: "pending" },
            ],
          } satisfies ProjectCallsListResult;
        }
        return {};
      });

      let receivedEvent: CustomEvent | null = null;
      const listener = (e: Event) => {
        receivedEvent = e as CustomEvent;
      };
      window.addEventListener(LIVE_CALL_PROJECTS_EVENT, listener);

      await publishProjects();

      expect(receivedEvent).not.toBeNull();
      expect(receivedEvent!.detail).toEqual({
        projects: [{ projectId: "proj-app" }, { projectId: "proj-pend" }],
      });

      window.removeEventListener(LIVE_CALL_PROJECTS_EVENT, listener);
    });

    it("отвечает на bb-live-call:projects-request повторной публикацией", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "projectCallsList") {
          return {
            projects: [{ projectId: "proj-1", title: "P1", state: "approved" }],
          } satisfies ProjectCallsListResult;
        }
        return {};
      });

      const cleanup = initProjectEvents();

      let publishedCount = 0;
      const onProjects = () => {
        publishedCount += 1;
      };
      window.addEventListener(LIVE_CALL_PROJECTS_EVENT, onProjects);

      // Имитируем запрос от sidebar-collapse
      window.dispatchEvent(new CustomEvent(LIVE_CALL_PROJECTS_REQUEST_EVENT));

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(publishedCount).toBeGreaterThan(0);

      window.removeEventListener(LIVE_CALL_PROJECTS_EVENT, onProjects);
      cleanup();
    });

    it("слушает bb-live-call:start-project и запускает звонок по проекту", async () => {
      setCustomRpcHandler(async (method) => {
        if (method === "callToken") return { token: "tok" };
        return {};
      });

      const cleanup = initProjectEvents();

      window.dispatchEvent(
        new CustomEvent(LIVE_CALL_START_PROJECT_EVENT, {
          detail: { projectId: "proj-sidebar" },
        }),
      );

      expect(callEngine.isActive()).toBe(true);
      expect(callEngine.getSnapshot().targetProjectId).toBe("proj-sidebar");

      cleanup();
    });
  });
});
