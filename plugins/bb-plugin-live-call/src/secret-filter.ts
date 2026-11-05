/**
 * Фильтр секретов (§14.6).
 * Маскирует точные значения секретов (первыми) и шаблоны (учётки в URL, Bearer, x-access-token, ключи API).
 */

const URL_CREDENTIALS_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)([^\s/]*)@/g;
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9_\-.~+/*]+=*/gi;
const ACCESS_TOKEN_RE = /\bx-access-token\s*:\s*[^\s,;]+/gi;
// Прогон с `*` (уже замаскированное точное значение внутри ключа) закрывается без требования длины (§14.6, ревью PLUG-117 round-10).
const AIZA_KEY_RE = /\bAIza(?:[0-9A-Za-z\-_]{35}\b|(?=[0-9A-Za-z\-_*]{0,34}\*)[0-9A-Za-z\-_*]{1,35})/g;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_*-]{20,}/g;
const GITHUB_TOKEN_RE = /\bgh[opsur]_(?:[a-zA-Z0-9]{36,}\b|(?=[a-zA-Z0-9*]{0,255}\*)[a-zA-Z0-9*]+)/g;
const GITHUB_PAT_RE = /\bgithub_pat_[a-zA-Z0-9_*]{50,}(?:\b|(?<=\*))/g;
const SLACK_TOKEN_RE = /\bxox[abp]-[a-zA-Z0-9\-*]+(?:\b|(?<=\*))/g;
const KEY_VAL_SECRET_RE = /\b(token|password|passwd|secret|api_key|apikey)\s*([:=])\s*([^\s,;'"&]+)/gi;

export function isValidSecretValue(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 3 && !/[\u0000-\u001F\u007F]/.test(v);
}

export function getSecretOccurrences(text: string, secrets: string[]): Array<[number, number]> {
  const iv: Array<[number, number]> = [];
  for (const s of secrets) {
    if (!isValidSecretValue(s)) continue;
    for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + 1)) {
      iv.push([i, i + s.length]);
    }
  }
  return iv.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}

export function maskSecrets(text: string, exactSecrets: string[] = []): string {
  if (!text || typeof text !== "string") return "";

  // 1. Точные значения первыми: объединение всех вхождений (включая перекрывающиеся) в интервалы (§14.6)
  const iv = getSecretOccurrences(text, exactSecrets);
  let out = "";
  let pos = 0;
  let i = 0;
  while (i < iv.length) {
    let [s, e] = iv[i];
    while (i + 1 < iv.length && iv[i + 1][0] < e) {
      e = Math.max(e, iv[++i][1]);
    }
    i++;
    out += text.slice(pos, s) + "***";
    pos = e;
  }
  out += text.slice(pos);

  // 2. Шаблоны после точных значений (§14.6)
  // Учётки в URL (scheme://user:pass@host)
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme, creds) => {
    return `${scheme}${creds.includes(":") ? "***:***@" : "***@"}`;
  });

  // Bearer токен
  out = out.replace(BEARER_RE, "Bearer ***");

  // x-access-token: ...
  out = out.replace(ACCESS_TOKEN_RE, "x-access-token:***");

  // Паттерны известных ключей API
  out = out.replace(AIZA_KEY_RE, "***");
  out = out.replace(SK_KEY_RE, "***");
  out = out.replace(GITHUB_TOKEN_RE, "***");
  out = out.replace(GITHUB_PAT_RE, "***");
  out = out.replace(SLACK_TOKEN_RE, "***");

  // Ключ-значение: token=..., password: ...
  out = out.replace(KEY_VAL_SECRET_RE, "$1$2***");

  return out;
}
