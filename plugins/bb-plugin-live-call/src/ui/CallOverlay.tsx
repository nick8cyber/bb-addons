/**
 * Звонок поверх BB (макеты design/live-call-mockups.html):
 * - десктоп: док в правом нижнем углу, сворачивается в пилюлю;
 * - телефон (≤700px): полноэкранный вид, подтверждение — нижний лист;
 * - после звонка — итог: длительность, действия, ссылка на тред звонка.
 * Цвета, шрифты и радиусы — только токены темы BB (app.css).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { callEngine, type CallMode, type CallView, type Confirmation, type FeedItem, type OrbState } from "./engine.js";
import { Icon, toolIcon } from "./icons.js";

const MOBILE_QUERY = "(max-width: 700px)";
const COLLAPSE_KEY = "lc-dock-collapsed";

const STATE_LABEL: Record<OrbState, string> = {
  connecting: "Соединяюсь",
  listening: "Слушаю",
  thinking: "Думаю",
  speaking: "Говорю",
  working: "Работаю",
  reconnecting: "Переподключаюсь",
  muted: "Микрофон выключен",
  ended: "Звонок завершён",
};

const END_REASON: Record<string, string> = {
  owner: "по твоей команде",
  limit: "лимит длительности",
  error: "ошибка",
  connection: "соединение прервалось",
};

function useView(): CallView {
  return useSyncExternalStore(callEngine.subscribe, callEngine.getSnapshot, callEngine.getSnapshot);
}

function useLevel(): number {
  return useSyncExternalStore(callEngine.level.subscribe, callEngine.level.get, callEngine.level.get);
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

function minutesLabel(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "меньше минуты";
  return `${min} мин`;
}

function useElapsed(view: CallView): string {
  const now = useNow(view.phase === "live");
  if (!view.startedAt) return "00:00";
  return clock((view.endedAt ?? now) - view.startedAt);
}

/** Корень: выбирает вид по фазе звонка и ширине окна. */
export function CallOverlay() {
  const view = useView();
  const mobile = useMedia(MOBILE_QUERY);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const lastSignal = useRef(view.expandSignal);
  useEffect(() => {
    if (view.expandSignal !== lastSignal.current) {
      lastSignal.current = view.expandSignal;
      setCollapsed(false);
    }
  }, [view.expandSignal]);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // приватный режим
    }
  }, [collapsed]);

  if (view.phase === "idle") return null;
  const mustShow = Boolean(view.confirmation) || view.phase === "ended" || view.phase === "failed";
  const minimized = collapsed && !mustShow;
  if (mobile) return <MobileCall view={view} minimized={minimized} onMinimize={setCollapsed} />;
  if (minimized) return <Pill view={view} onExpand={() => setCollapsed(false)} />;
  return <Dock view={view} onCollapse={() => setCollapsed(true)} />;
}

function Orb({ state, size = "sm" }: { state: OrbState; size?: "sm" | "lg" }) {
  const level = useLevel();
  const style = { "--lc-level": state === "listening" ? level.toFixed(2) : "0" } as CSSProperties;
  return <span className={`lc-orb lc-orb--${size} lc-orb--${state}`} style={style} aria-hidden="true" />;
}

function ModeSwitch({ view, compact = false }: { view: CallView; compact?: boolean }) {
  if (view.targetThreadId) return null;
  const disabled = view.phase !== "live" || view.switching || Boolean(view.confirmation);
  const title = view.confirmation ? "Сначала ответь на подтверждение" : undefined;
  const seg = (mode: CallMode, icon: "zap" | "sparkles", label: string, hint: string) => {
    const active = view.mode === mode;
    return (
      <button
        type="button"
        className={`lc-seg__item${active ? " is-active" : ""}`}
        aria-pressed={active}
        disabled={disabled && !active}
        title={title ?? hint}
        onClick={() => callEngine.switchMode(mode)}
      >
        <Icon name={icon} size={13} />
        {!compact && <span>{view.switching && !active ? "Переключаю…" : label}</span>}
      </button>
    );
  };
  return (
    <div className={`lc-seg${compact ? " lc-seg--compact" : ""}${view.switching ? " is-switching" : ""}`} role="group" aria-label="Режим звонка">
      {seg("extended", "sparkles", "Extended", "Extended Thinking: думает глубже, отвечает за 1,5–2 с; инструменты вызывает помощник по твоим словам")}
      {seg("normal", "zap", "Быстрый", "Быстрый: gemini-3.8-live, отвечает быстрее всего, сам вызывает инструменты")}
    </div>
  );
}

function StatusLine({ view }: { view: CallView }) {
  const elapsed = useElapsed(view);
  const parts = [elapsed];
  // Номер ключа виден, только когда звонок ушёл на запасной: основной — норма, не новость.
  if (view.keys && view.keys.active > 1) parts.push("запасной ключ");
  if (view.orb === "reconnecting" && view.stateDetail) parts.push(view.stateDetail);
  return <span className="lc-sub">{parts.join(" · ")}</span>;
}

function Dock({ view, onCollapse }: { view: CallView; onCollapse: () => void }) {
  const done = view.phase === "ended" || view.phase === "failed";
  return (
    <section className="lc-root lc-dock" aria-label="Звонок координатору">
      <header className="lc-dock__head">
        <Orb state={done ? "ended" : view.orb} />
        <div className="lc-dock__title">
          <span className="lc-state">{view.phase === "failed" ? "Звонок не начался" : STATE_LABEL[done ? "ended" : view.orb]}</span>
          {!done && <StatusLine view={view} />}
        </div>
        {/* Extended отключён (ADR-0006, пересмотр 2): переключателя режима нет */}
        {done ? (
          <button type="button" className="lc-icon-btn" title="Закрыть" aria-label="Закрыть" onClick={() => callEngine.dismiss()}>
            <Icon name="x" />
          </button>
        ) : (
          <button type="button" className="lc-icon-btn" title="Свернуть" aria-label="Свернуть" onClick={onCollapse}>
            <Icon name="chevron-down" />
          </button>
        )}
      </header>
      {view.phase === "failed" ? (
        <Failed view={view} />
      ) : view.phase === "ended" ? (
        <Summary view={view} />
      ) : (
        <>
          {view.confirmation && <ConfirmCard c={view.confirmation} />}
          <Feed view={view} />
          {view.micWarning && <MicWarning text={view.micWarning} />}
          <DockFooter view={view} />
        </>
      )}
    </section>
  );
}

function Pill({ view, onExpand }: { view: CallView; onExpand: () => void }) {
  const elapsed = useElapsed(view);
  return (
    <div className="lc-root lc-pill" role="group" aria-label="Звонок координатору, свёрнут">
      <button type="button" className="lc-pill__main" onClick={onExpand} title="Развернуть звонок">
        <Orb state={view.orb} />
        <span className="lc-state">{STATE_LABEL[view.orb]}</span>
        <span className="lc-sub">{elapsed}</span>
      </button>
      {/* переключателя режима нет */}
      <MuteButton view={view} iconOnly />
      <EndButton iconOnly />
      <button type="button" className="lc-icon-btn" title="Развернуть" aria-label="Развернуть" onClick={onExpand}>
        <Icon name="chevron-up" />
      </button>
    </div>
  );
}

function MuteButton({ view, iconOnly = false }: { view: CallView; iconOnly?: boolean }) {
  const label = view.muted ? "Включить микрофон" : "Выключить микрофон";
  return (
    <button
      type="button"
      className={`lc-btn lc-btn--ghost${view.muted ? " is-muted" : ""}${iconOnly ? " lc-btn--icon" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={view.muted}
      disabled={view.phase !== "live"}
      onClick={() => callEngine.toggleMute()}
    >
      <Icon name={view.muted ? "mic-off" : "mic"} />
      {!iconOnly && <span>{view.muted ? "Выключен" : "Микрофон"}</span>}
    </button>
  );
}

function EndButton({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <button
      type="button"
      className={`lc-btn lc-btn--danger${iconOnly ? " lc-btn--icon" : ""}`}
      title="Завершить звонок"
      aria-label="Завершить звонок"
      onClick={() => callEngine.end()}
    >
      <Icon name="phone-off" />
      {!iconOnly && <span>Завершить</span>}
    </button>
  );
}

function MicLevel() {
  const level = useLevel();
  const bars = [0.15, 0.35, 0.55, 0.75, 0.9];
  return (
    <span className="lc-level" aria-hidden="true">
      {bars.map((b) => (
        <i key={b} className={level >= b ? "is-on" : ""} />
      ))}
    </span>
  );
}

function DockFooter({ view }: { view: CallView }) {
  return (
    <footer className="lc-dock__foot">
      <MicLevel />
      {view.mics.length > 1 ? (
        <select
          className="lc-mic-select"
          value={view.micId ?? ""}
          title="Микрофон"
          aria-label="Микрофон"
          onChange={(e) => void callEngine.selectMic(e.target.value)}
        >
          {view.mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <span className="lc-sub lc-grow">микрофон</span>
      )}
      <MuteButton view={view} iconOnly />
      <EndButton />
    </footer>
  );
}

function MicWarning({ text }: { text: string }) {
  return (
    <div className="lc-micwarn" role="status">
      <Icon name="alert" size={14} />
      <span>{text}</span>
    </div>
  );
}

function Feed({ view, compact = false }: { view: CallView; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view.feed]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <div className={`lc-feed${compact ? " lc-feed--compact" : ""}`} ref={ref} onScroll={onScroll} aria-live="polite">
      {view.feed.length === 0 ? (
        <p className="lc-empty">
          {view.phase === "connecting" ? "Соединяюсь с координатором…" : "Говори — например: «Что сейчас происходит в BB?»"}
        </p>
      ) : (
        view.feed.map((item) => <FeedRow key={item.id} item={item} />)
      )}
    </div>
  );
}

function OpenThread({ threadId, label = "Открыть" }: { threadId: string; label?: string }) {
  const navigate = useBbNavigate();
  return (
    <button type="button" className="lc-link" onClick={() => navigate.toThread(threadId)}>
      {label}
      <Icon name="arrow-up-right" size={12} />
    </button>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "line":
      return (
        <div className={`lc-line lc-line--${item.role}${item.final ? "" : " is-partial"}`}>
          <span className="lc-line__who">{item.role === "owner" ? "Ты" : "Агент"}</span>
          <span className="lc-line__text">{item.text}</span>
        </div>
      );
    case "action":
      return (
        <div className={`lc-card lc-card--${item.status}`}>
          <span className="lc-card__icon">
            <Icon name={toolIcon(item.tool, item.cls)} size={14} />
          </span>
          <span className="lc-card__text">{item.summary}</span>
          <span className="lc-card__end">
            {item.threadId && item.status !== "running" ? <OpenThread threadId={item.threadId} /> : null}
            <ActionStatusMark status={item.status} />
          </span>
        </div>
      );
    case "event":
      return (
        <div className={`lc-card lc-card--event${item.eventKind === "thread.failed" ? " lc-card--failed" : ""}`}>
          <span className="lc-card__icon">
            <Icon name={item.eventKind === "thread.failed" ? "alert" : item.eventKind === "interaction.pending" ? "message" : "check"} size={14} />
          </span>
          <span className="lc-card__text">{item.summary}</span>
          <span className="lc-card__end">
            <OpenThread threadId={item.threadId} />
          </span>
        </div>
      );
    case "notice":
      return (
        <div className={`lc-notice lc-notice--${item.tone}`}>
          <Icon name={item.tone === "info" ? "check" : "alert"} size={13} />
          <span className="lc-grow">{item.text}</span>
          {item.action === "to-normal" && (
            <button type="button" className="lc-link" onClick={() => callEngine.switchMode("normal", "notice")}>
              Перейти на Быстрый
            </button>
          )}
        </div>
      );
    case "divider":
      return (
        <div className="lc-divider" role="separator">
          <span>{item.text}</span>
        </div>
      );
    default:
      return null;
  }
}

function ActionStatusMark({ status }: { status: FeedItem extends infer _ ? "running" | "done" | "failed" | "cancelled" : never }) {
  if (status === "running") return <Icon name="loader" size={14} className="lc-spin lc-muted" />;
  if (status === "done") return <Icon name="check" size={14} className="lc-ok" />;
  if (status === "cancelled") return <Icon name="x" size={14} className="lc-muted" />;
  return <Icon name="alert" size={14} className="lc-bad" />;
}

const CONFIRM_COPY: Record<Confirmation["cls"], { title: string; button: string; icon: "rocket" | "shield" | "send" }> = {
  L: { title: "Запуск агента", button: "Запустить", icon: "rocket" },
  P: { title: "Разрешение агенту", button: "Разрешить", icon: "shield" },
  C: { title: "Подтверди действие", button: "Подтвердить", icon: "send" },
};

function ConfirmCard({ c, sheet = false }: { c: Confirmation; sheet?: boolean }) {
  const now = useNow(true, 500);
  const total = 60;
  const left = Math.max(0, Math.ceil((c.expiresAt - now) / 1000));
  const copy = CONFIRM_COPY[c.cls];
  const icon = c.cls === "C" ? toolIcon(c.tool, c.cls) : copy.icon;
  const r = 15;
  const circ = 2 * Math.PI * r;
  return (
    <div className={`lc-confirm lc-confirm--${c.cls}${sheet ? " lc-confirm--sheet" : ""}`} role="alertdialog" aria-label={copy.title}>
      <div className="lc-confirm__head">
        <span className="lc-confirm__icon">
          <Icon name={icon} size={16} />
        </span>
        <b>{copy.title}</b>
        <span className="lc-grow" />
        <svg className="lc-ttl" width="30" height="30" viewBox="0 0 36 36" aria-label={`Осталось ${left} с`}>
          <circle cx="18" cy="18" r={r} className="lc-ttl__track" />
          <circle
            cx="18"
            cy="18"
            r={r}
            className="lc-ttl__value"
            strokeDasharray={`${(circ * Math.min(left, total)) / total} ${circ}`}
            transform="rotate(-90 18 18)"
          />
          <text x="18" y="22" textAnchor="middle">
            {left}
          </text>
        </svg>
      </div>
      <p className="lc-confirm__summary">{c.summary}</p>
      <div className="lc-confirm__say">
        {c.phase === "asking" ? (
          <span className="lc-chip">
            <Icon name="mic-off" size={12} />
            звучит вопрос — микрофон закрыт
          </span>
        ) : (
          <span className="lc-chip lc-chip--live">
            <Icon name="mic" size={12} />
            слушаю ответ
          </span>
        )}
        <span className="lc-sub">скажи</span>
        <span className="lc-word">«{c.word}»</span>
      </div>
      <div className="lc-confirm__actions">
        <button type="button" className="lc-btn lc-btn--primary lc-grow" onClick={() => callEngine.confirm(c.id)}>
          {copy.button}
        </button>
        <button type="button" className="lc-btn lc-btn--ghost" onClick={() => callEngine.cancel(c.id)}>
          Отмена
        </button>
      </div>
      {c.cls === "L" && <p className="lc-confirm__note">«Да» не запускает — так задумано. Отказ, шум или неясная фраза — отмена.</p>}
    </div>
  );
}

function Summary({ view }: { view: CallView }) {
  const navigate = useBbNavigate();
  const duration = view.startedAt ? minutesLabel((view.endedAt ?? Date.now()) - view.startedAt) : "—";
  const actions = view.feed.filter((f): f is Extract<FeedItem, { kind: "action" }> => f.kind === "action" && f.status === "done" && f.cls !== "R");
  const reads = view.feed.filter((f) => f.kind === "action" && f.cls === "R" && f.status === "done").length;
  return (
    <div className="lc-summary">
      <p className="lc-summary__meta">
        {duration}
        {view.endReason ? ` · ${END_REASON[view.endReason] ?? view.endReason}` : ""}
      </p>
      {actions.length > 0 ? (
        <div className="lc-summary__list">
          <span className="lc-label">Действия</span>
          {actions.slice(-6).map((a) => (
            <FeedRow key={a.id} item={a} />
          ))}
        </div>
      ) : (
        <p className="lc-sub">{reads > 0 ? `Только чтение: ${reads} ${plural(reads, "запрос", "запроса", "запросов")} к BB, ничего не менял.` : "Действий не было."}</p>
      )}
      <div className="lc-summary__actions">
        {view.threadId && (
          <button type="button" className="lc-btn lc-btn--primary" onClick={() => navigate.toThread(view.threadId!)}>
            Тред звонка
            <Icon name="arrow-up-right" size={14} />
          </button>
        )}
        <button type="button" className="lc-btn lc-btn--ghost" onClick={() => callEngine.start()}>
          <Icon name="phone" />
          Перезвонить
        </button>
        <span className="lc-grow" />
        <button type="button" className="lc-btn lc-btn--ghost" onClick={() => callEngine.dismiss()}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

const ERROR_HINT: Record<string, string> = {
  no_keys: "Добавь ключи AI Studio: Настройки → Live Call → Ключи Gemini.",
  busy: "Звонок уже идёт — в другой вкладке или на другом устройстве.",
  quota_all_keys: "Оба ключа упёрлись в лимит. Подожди минуту и перезвони.",
  google_unreachable: "Сервер BB не достучался до Google. Повтори через минуту.",
  extended_unavailable: "Для Extended нужны два ключа. Звони в обычном режиме или добавь второй ключ.",
};

function Failed({ view }: { view: CallView }) {
  const code = view.error?.code ?? "connect";
  return (
    <div className="lc-failed">
      <div className="lc-failed__msg">
        <Icon name="alert" size={16} className="lc-bad" />
        <span>{view.error?.message ?? "Звонок не начался"}</span>
      </div>
      {ERROR_HINT[code] && <p className="lc-sub">{ERROR_HINT[code]}</p>}
      <div className="lc-summary__actions">
        <button type="button" className="lc-btn lc-btn--primary" onClick={() => callEngine.start()}>
          <Icon name="refresh" />
          Повторить
        </button>
        <span className="lc-grow" />
        <button type="button" className="lc-btn lc-btn--ghost" onClick={() => callEngine.dismiss()}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

/** Телефон: весь экран, крупные кнопки, транскрипт — выдвижной лист. */
function MobileCall({ view, minimized, onMinimize }: { view: CallView; minimized: boolean; onMinimize: (v: boolean) => void }) {
  const [sheet, setSheet] = useState(false);
  const elapsed = useElapsed(view);
  if (minimized) {
    return (
      <button type="button" className="lc-root lc-mbar" onClick={() => onMinimize(false)} aria-label="Развернуть звонок">
        <Orb state={view.orb} />
        <span className="lc-state">{STATE_LABEL[view.orb]}</span>
        <span className="lc-sub">{elapsed}</span>
        <span className="lc-grow" />
        <Icon name="chevron-down" />
      </button>
    );
  }
  const done = view.phase === "ended" || view.phase === "failed";
  const lastAgent = [...view.feed].reverse().find((f) => f.kind === "line" && f.role === "agent") as Extract<FeedItem, { kind: "line" }> | undefined;
  const lastAction = [...view.feed].reverse().find((f) => f.kind === "action" || f.kind === "event");
  return (
    <section className="lc-root lc-mobile" aria-label="Звонок координатору">
      <header className="lc-mobile__top">
        <span className="lc-sub">{done ? "" : elapsed}</span>
        {/* Extended отключён (ADR-0006, пересмотр 2): переключателя режима нет */}
        {done ? (
          <button type="button" className="lc-icon-btn" aria-label="Закрыть" onClick={() => callEngine.dismiss()}>
            <Icon name="x" size={18} />
          </button>
        ) : (
          <button type="button" className="lc-icon-btn" aria-label="Свернуть" onClick={() => onMinimize(true)}>
            <Icon name="chevron-up" size={18} />
          </button>
        )}
      </header>
      {done ? (
        <div className="lc-mobile__done">
          <h2 className="lc-state">{view.phase === "failed" ? "Звонок не начался" : STATE_LABEL.ended}</h2>
          {view.phase === "failed" ? <Failed view={view} /> : <Summary view={view} />}
        </div>
      ) : (
        <>
          <div className="lc-mobile__center">
            <Orb state={view.orb} size="lg" />
            <span className="lc-state lc-state--lg">{STATE_LABEL[view.orb]}</span>
            {lastAgent && <p className="lc-mobile__line">{lastAgent.text}</p>}
            {lastAction && (
              <div className="lc-mobile__card">
                <FeedRow item={lastAction} />
              </div>
            )}
            {view.micWarning && <MicWarning text={view.micWarning} />}
          </div>
          <footer className="lc-mobile__controls">
            <button
              type="button"
              className={`lc-round${view.muted ? " is-muted" : ""}`}
              aria-label={view.muted ? "Включить микрофон" : "Выключить микрофон"}
              aria-pressed={view.muted}
              onClick={() => callEngine.toggleMute()}
            >
              <Icon name={view.muted ? "mic-off" : "mic"} size={22} />
            </button>
            <button type="button" className="lc-round lc-round--end" aria-label="Завершить звонок" onClick={() => callEngine.end()}>
              <Icon name="phone-off" size={24} />
            </button>
            <button type="button" className="lc-round" aria-label="Транскрипт" onClick={() => setSheet(true)}>
              <Icon name="message" size={22} />
            </button>
          </footer>
          {sheet && (
            <div className="lc-sheet" role="dialog" aria-label="Транскрипт звонка">
              <div className="lc-sheet__grab" />
              <div className="lc-sheet__head">
                <b>Транскрипт</b>
                <button type="button" className="lc-icon-btn" aria-label="Закрыть транскрипт" onClick={() => setSheet(false)}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <Feed view={view} compact />
            </div>
          )}
          {view.confirmation && (
            <div className="lc-sheet lc-sheet--confirm">
              <div className="lc-sheet__grab" />
              <ConfirmCard c={view.confirmation} sheet />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
