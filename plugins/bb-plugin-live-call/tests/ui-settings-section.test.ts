import React from "react";
import { renderToString } from "react-dom/server.browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectCallsView, SettingsSection } from "../src/ui/SettingsSection.js";
import {
  setCustomRpcHandler,
  type ProjectCallsApproveResult,
  type ProjectCallsListResult,
  type ProjectCallsRejectResult,
} from "../src/ui/rpc.js";

describe("SettingsSection — реестр звонков по проекту (§15.2, §15.8)", () => {
  beforeEach(() => {
    if (typeof (globalThis as any).window === "undefined") {
      const eventTarget = new EventTarget();
      (globalThis as any).window = {
        addEventListener: eventTarget.addEventListener.bind(eventTarget),
        removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
        dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      };
    }
  });

  afterEach(() => {
    setCustomRpcHandler(null);
  });

  it("рендерит список проектов реестра с состояниями и diff для pending", async () => {
    setCustomRpcHandler(async (method) => {
      if (method === "status") {
        return { configured: true, keys: 2, activeCall: null };
      }
      if (method === "projectCallsList") {
        return {
          projects: [
            { projectId: "crm", title: "CRM", state: "approved" },
            {
              projectId: "infra",
              title: "Infra",
              state: "pending",
              hash: "hash123",
              diff: ["+ command: node infra.js", "+ defaultClass: deny"],
            },
            {
              projectId: "broken",
              title: "Broken",
              state: "invalid",
              error: "invalid transport config",
            },
          ],
        } satisfies ProjectCallsListResult;
      }
      return {};
    });

    // Отрендерим компонент отображения реестра
    const html = renderToString(
      React.createElement(ProjectCallsView, {
        projects: [
          { projectId: "crm", title: "CRM", state: "approved" },
          {
            projectId: "infra",
            title: "Infra",
            state: "pending",
            hash: "hash123",
            diff: ["+ command: node infra.js", "+ defaultClass: deny"],
          },
          {
            projectId: "broken",
            title: "Broken",
            state: "invalid",
            error: "invalid transport config",
          },
        ],
        onApprove: () => {},
        onReject: () => {},
      }),
    );
    expect(html).toContain("Звонки по проектам");
    expect(html).toContain("CRM");
    expect(html).toContain("Infra");
    expect(html).toContain("Broken");
    expect(html).toContain("Подтверждён");
    expect(html).toContain("Ждёт подтверждения");
    expect(html).toContain("Ошибка");
    expect(html).toContain("invalid transport config");
    expect(html).toContain("+ command: node infra.js");
    expect(html).toContain("+ defaultClass: deny");
    expect(html).toContain("Подтвердить");
    expect(html).toContain("Отклонить");
  });

  it("вызов approveProject отправляет projectCallsApprove с projectId и hash", async () => {
    let approvedPayload: { projectId: string; hash: string } | null = null;
    setCustomRpcHandler(async (method, input) => {
      if (method === "status") return { configured: true, keys: 1, activeCall: null };
      if (method === "projectCallsList") {
        return {
          projects: [
            {
              projectId: "crm",
              title: "CRM",
              state: "pending",
              hash: "h-xyz-456",
              diff: ["- old: 1", "+ new: 2"],
            },
          ],
        } satisfies ProjectCallsListResult;
      }
      if (method === "projectCallsApprove") {
        approvedPayload = input as { projectId: string; hash: string };
        return { ok: true } satisfies ProjectCallsApproveResult;
      }
      return {};
    });

    const html = renderToString(
      React.createElement(ProjectCallsView, {
        projects: [
          {
            projectId: "crm",
            title: "CRM",
            state: "pending",
            hash: "h-xyz-456",
            diff: ["- old: 1", "+ new: 2"],
          },
        ],
        onApprove: () => {},
        onReject: () => {},
      }),
    );
    expect(html).toContain("CRM");
    expect(html).toContain("Подтвердить");
    expect(html).toContain("- old: 1");

    // Вызываем логику RPC подтверждения напрямую, проверяя контракт
    const { rpc } = await import("../src/ui/rpc.js");
    const res = await rpc<ProjectCallsApproveResult>("projectCallsApprove", { projectId: "crm", hash: "h-xyz-456" });
    expect(res.ok).toBe(true);
    expect(approvedPayload).toEqual({ projectId: "crm", hash: "h-xyz-456" });
  });

  it("вызов rejectProject отправляет projectCallsReject с projectId", async () => {
    let rejectedPayload: { projectId: string } | null = null;
    setCustomRpcHandler(async (method, input) => {
      if (method === "projectCallsReject") {
        rejectedPayload = input as { projectId: string };
        return { ok: true } satisfies ProjectCallsRejectResult;
      }
      return {};
    });

    const { rpc } = await import("../src/ui/rpc.js");
    const res = await rpc<ProjectCallsRejectResult>("projectCallsReject", { projectId: "infra" });
    expect(res.ok).toBe(true);
    expect(rejectedPayload).toEqual({ projectId: "infra" });
  });
});
