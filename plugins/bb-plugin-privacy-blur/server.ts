// bb-plugin-privacy-blur — серверная часть.
//
// Отдаёт фронтенду список «известных» чувствительных слов, которые регуляркой
// не поймать: названия проектов, имена хостов/инстансов, имя пользователя ОС,
// git-автор, адрес публичного инстанса и слова из настроек.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const optionsSchema = z.object({
  terms: z.array(z.string()),
  blurInputs: z.boolean(),
  blurTerminal: z.boolean(),
  blurAvatars: z.boolean(),
  blurThreadTitles: z.boolean(),
  detectNames: z.boolean(),
  extraSelectors: z.string(),
});
export type PrivacyOptions = z.infer<typeof optionsSchema>;

export const rpcContract = defineRpcContract({
  privacy_options: {
    input: z.null(),
    output: optionsSchema,
  },
});

/** Разбивает строку настроек «через запятую или с новой строки». */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function gitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", "--get", key], {
      timeout: 2000,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    customTerms: {
      type: "string",
      label: "Свои слова для скрытия",
      description:
        "Имена, компании, логины, названия — через запятую или с новой строки. Регистр не важен, от 3 символов.",
      default: "",
    },
    autoTerms: {
      type: "boolean",
      label: "Скрывать названия проектов, хостов, пользователя ОС и git-автора",
      default: true,
    },
    blurInputs: {
      type: "boolean",
      label: "Размывать поля ввода (кроме того, где сейчас курсор)",
      default: true,
    },
    blurTerminal: {
      type: "boolean",
      label: "Размывать терминал",
      default: true,
    },
    blurAvatars: {
      type: "boolean",
      label: "Размывать аватары",
      default: true,
    },
    blurThreadTitles: {
      type: "boolean",
      label: "Размывать заголовки тредов (сайдбар, шапка, списки)",
      default: false,
    },
    detectNames: {
      type: "boolean",
      label: "Искать имена людей (два слова подряд с заглавной: «Иван Петров»)",
      default: false,
    },
    extraSelectors: {
      type: "string",
      label: "Доп. CSS-селекторы для размытия целиком",
      description: "Через запятую или с новой строки.",
      default: "",
    },
  });

  async function collectAutoTerms(): Promise<string[]> {
    const terms: string[] = [];
    const push = (value: unknown) => {
      if (typeof value === "string" && value.trim().length > 0) terms.push(value.trim());
    };
    try {
      const projects = await bb.sdk.projects.list();
      for (const project of projects) push(project.name);
    } catch (error) {
      bb.log.warn(`projects.list failed: ${String(error)}`);
    }
    try {
      const hosts = await bb.sdk.hosts.list();
      for (const host of hosts) push(host.name);
    } catch (error) {
      bb.log.warn(`hosts.list failed: ${String(error)}`);
    }
    push(os.hostname());
    try {
      push(os.userInfo().username);
    } catch {
      // userInfo бросает, если у uid нет записи в passwd.
    }
    push(await gitConfig("user.name"));
    push(await gitConfig("user.email"));
    push(hostnameOf(bb.server.experimental_appUrl));
    return terms;
  }

  bb.rpc.register(rpcContract, {
    privacy_options: async () => {
      const current = await settings.get();
      const terms = splitList(current.customTerms);
      if (current.autoTerms) terms.push(...(await collectAutoTerms()));
      return {
        terms: [...new Set(terms)],
        blurInputs: current.blurInputs,
        blurTerminal: current.blurTerminal,
        blurAvatars: current.blurAvatars,
        blurThreadTitles: current.blurThreadTitles,
        detectNames: current.detectNames,
        extraSelectors: current.extraSelectors,
      };
    },
  });

  bb.log.info("privacy-blur loaded");
}
