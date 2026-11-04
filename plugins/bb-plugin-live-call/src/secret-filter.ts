/**
 * Фильтр секретов (§14.6).
 * Маскирует учётки в URL, токены Bearer, x-access-token, ключи API и точные значения секретов.
 */

const URL_CREDENTIALS_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@]+)@/g;
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9_\-.~+/]+=*/gi;
const ACCESS_TOKEN_RE = /\bx-access-token\s*:\s*[^\s,;]+/gi;
const AIZA_KEY_RE = /\bAIza[0-9A-Za-z\-_]{35}\b/g;
const SK_KEY_RE = /\bsk-[a-zA-Z0-9]{20,}\b/g;
const GITHUB_TOKEN_RE = /\bgh[opsur]_[a-zA-Z0-9]{36,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[a-zA-Z0-9_]{50,}\b/g;
const SLACK_TOKEN_RE = /\bxox[abp]-[a-zA-Z0-9\-]+\b/g;
const KEY_VAL_SECRET_RE = /\b(token|password|passwd|secret|api_key|apikey)\s*([:=])\s*([^\s,;'"&]+)/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function maskSecrets(text: string, exactSecrets: string[] = []): string {
  if (!text || typeof text !== "string") return "";

  let out = text;

  // 1. Учётки в URL (scheme://user:pass@host)
  out = out.replace(URL_CREDENTIALS_RE, "$1***:***@");

  // 2. Bearer токен
  out = out.replace(BEARER_RE, "Bearer ***");

  // 3. x-access-token: ...
  out = out.replace(ACCESS_TOKEN_RE, "x-access-token:***");

  // 4. Паттерны известных ключей API
  out = out.replace(AIZA_KEY_RE, "***");
  out = out.replace(SK_KEY_RE, "***");
  out = out.replace(GITHUB_TOKEN_RE, "***");
  out = out.replace(GITHUB_PAT_RE, "***");
  out = out.replace(SLACK_TOKEN_RE, "***");

  // 5. Ключ-значение: token=..., password: ...
  out = out.replace(KEY_VAL_SECRET_RE, "$1$2***");

  // 6. Точные значения переданных секретов (отсортированы по убыванию длины)
  const validSecrets = exactSecrets
    .filter((s) => typeof s === "string" && s.trim().length >= 3)
    .sort((a, b) => b.length - a.length);

  for (const s of validSecrets) {
    const re = new RegExp(escapeRegExp(s), "g");
    out = out.replace(re, "***");
  }

  return out;
}
