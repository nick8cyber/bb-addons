# Изоляция данных и исполнение в песочнице (Zero-Leak Sandbox)

> [!IMPORTANT] Нормативный статус
> Документ развивает требования [ADR-0035](../adr/0035-orchestrator-zero-leak-sandbox.md), устраняет 5 критических блокеров независимого аудита безопасности (`audit-zero-leak-argon.md`) и регламентирует безопасное подключение публичных и бесплатных моделей (OpenCode free, веб-Gemini/Argon) в оркестратор.

---

## 1. Термины и сущности

- **Zero-Leak Sandbox:** комплексная подсистема изоляции данных и процессов, исключающая передачу конфиденциального кода, системных путей, учетных записей и истории репозитория сторонним провайдерам.
- **Snapshot Sandbox:** одноразовая среда рабочей копии, создаваемая из архива целевого коммита (`git archive`), полностью лишённая связи с родительским репозиторием `.git` хоста.
- **`confidentialPaths`:** нормативный массив glob-шаблонов защищённых путей проекта, определяемый в политике оркестратора (§2.1 / `policy.ts`, например `["src/auth/**", "secrets/**", ".env*"]`).
- **`--privacy <normal|strict>`:** флаг конфиденциальности в CLI (`bb orchestrator delegate`, `bb orchestrator enqueue`), параметрах API и полях `task_queue.payload.privacy` / метаданных раздачи:
  - `normal` (по умолчанию): задача допускает автоматический фоллбэк на публичные маршруты только при условии, что её диффы и файлы не затрагивают шаблоны `confidentialPaths`;
  - `strict`: задача принудительно требует доверенного маршрута (`trusted-local` или `trusted-cloud`) независимо от состава затронутых файлов.
- **DLP Redaction Engine:** детерминированный модуль маскирования чувствительных сущностей во входных данных (промпты, диффы, вложения) и контролируемой подстановки в выходных результатах. Охватывает как предварительную очистку входящих материалов, так и безопасную сборку исходящих диффов.
- **Sandbox Preflight Probe:** обязательная проверка доступности непривилегированных пространств имён ядра хоста при инициализации оркестратора.
- **Unmasking Oracle Attack:** класс атак, при котором злоумышленник через prompt injection или специально сформированные тесты провоцирует модель вернуть токен секрета в публичном фрагменте ответа, в результате чего наивный модуль демаскирования заменяет его на реальный секрет и запекает в коммит.
- **Route Trust Level (`route.trust`):** уровень доверия маршрута (`trusted-local`, `trusted-cloud`, `public`), определяющий допустимость работы с конфиденциальными файлами и глубину изоляции рантайма.

---

## 2. Модель угроз и векторы утечек

| Вектор утечки | Механизм в наивной схеме | Решение Zero-Leak Sandbox |
|---|---|---|
| **Git Object Store & History (Блокер 1)** | `git worktree` хранит ссылку на общий `.git`. Агент вызывает `git log -p --all`, `git reflog`, `git rev-list --objects`, читая удалённые секреты, конфиденциальные файлы и метаданные авторов (`git log --format="%an %ae"`). | **Snapshot Sandbox:** разворачивание чистого tar-слепка (`git archive`) в изолированный каталог с одноразовым `git init`. Физическое отсутствие родительского `.git`. |
| **Runtime Traversal `confidentialPaths` (Блокер 2)** | `confidentialPaths` проверяется только на старте. Во время выполнения агент читает файлы секретных модулей напрямую через `read_file` или `bash`. | **Mount Masking & Archive Exclusion:** файлы `confidentialPaths` исключаются из архива слепка и принудительно перекрываются точками монтирования: файл → `--ro-bind /dev/null`, каталог → `--tmpfs`. |
| **Синтаксический слом и Unmasking Oracle (Блокер 3)** | Кириллические скобочные маркеры `[скрыто: <тип>]` ломают парсеры JSON/YAML/URL и `git apply`. Слепая подстановка запекает секреты из prompt injection в репозиторий. | **RFC ASCII-маски и One-Way Context Unmasking:** стандартизированные идентификаторы (`host-N.bb-mask.internal`, `198.51.100.N`, `__BB_REDACTED_SECRET_NNN__`). Подстановка секретов разрешена ТОЛЬКО в неизменённых строках `' '` и удалениях `'-'`. Строгий отказ сдачи при наличии токенов в `'+'` или отчёте. |
| **Утечки окружения хоста и DoS (Блокер 4)** | bwrap без `--clearenv` передаёт переменные окружения родителя (`BB_THREAD_ID`, ключи API). Неограниченный `bash` запускает fork-бомбу. На ядрах с запретом userns запуск падает. | **Bubblewrap Sandbox, Preflight и prlimit:** обязательный `--clearenv`, полный сетевой карантин и изоляция (`--unshare-all`), боевой Sandbox Preflight Probe, исключение `/etc/resolv.conf`, лимит `prlimit --nproc=64 --as=4294967296 --cpu=1200` (4 GiB, 20 мин CPU) внутри песочницы, валидация симлинков. |
| **Автоматический даунгрейд приватности (Блокер 5)** | При сбое доверенных провайдеров задача молча уходит на публичные бесплатные маршруты. | **Принцип Fail-Closed:** задачи с `--privacy strict` или затрагивающие `confidentialPaths` при недоступности доверенных маршрутов блокируются (`status: blocked`), фоллбэк на public запрещён. |

---

## 3. Архитектура песочницы Snapshot Sandbox

### 3.1. Жизненный цикл одноразового слепка

1. **Создание слепка:**
   - Для задачи с базовым коммитом `<base-sha>` оркестратор генерирует временный каталог песочницы:
     `SANDBOX_DIR="/tmp/bb-sandbox-${taskKey}-${runId}"`
   - Исключаются конфиденциальные пути через pathspec `:(exclude)` и tar excludes:
     `git archive --format=tar <base-sha> -- . ':(exclude)<confidential_glob>' | tar -xf - -C "$SANDBOX_DIR"`
   - Если путь из `confidentialPaths` всё же попал в каталог `$SANDBOX_DIR`, он физически удаляется до старта процессов: `rm -rf "$SANDBOX_DIR/<path>"`.
   - Конфигурационные файлы пакетных менеджеров (`.npmrc`, `.yarnrc.yml`), содержащие токены приватных реестров, не удаляются (что вызвало бы ошибку `git apply` в соседних строках контекста), а проходят in-place замену: значения токенов заменяются масками `__BB_REDACTED_SECRET_*__` с обязательной регистрацией пар `токен -> маска` в `DLP_MAP` задачи, сохраняя структуру строк. Файлы секретов `.env`, `.env.local`, `.env.production` (за исключением шаблонов вроде `.env.example`, если они явно не включены в `confidentialPaths`), кэши `.pytest_cache`, `.mypy_cache`, `.next`, `node_modules/.cache` зачищаются.

2. **Инициализация одноразового Git:**
   - Внутри `$SANDBOX_DIR` выполняется:
     ```bash
     git -C "$SANDBOX_DIR" init -q
     git -C "$SANDBOX_DIR" config user.name "BB Sandbox Agent"
     git -C "$SANDBOX_DIR" config user.email "sandbox@localhost"
     git -C "$SANDBOX_DIR" add -A
     git -C "$SANDBOX_DIR" commit -q -m "sandbox root snapshot"
     ```
   - Репозиторий песочницы содержит ровно одну ревизию. Команды инспекции истории безопасны.

3. **Sandbox Preflight Probe и запуск в Bubblewrap:**
   - **Боевая Preflight-проверка:** при старте плагина оркестратора и перед раздачей на маршрут `trust: "public"` оркестратор проверяет работоспособность пространств имён ядра боевым набором параметров:
     ```bash
     bwrap --unshare-all --die-with-parent --ro-bind /usr /usr --proc /proc --dev /dev -- true
     ```
     Флаг `--unshare-all` включает изоляцию всех пространств имён (включая User и Network namespaces). Команда верифицирует создание User namespace (запись в `uid_map` / `gid_map`) и сетевую изоляцию (loopback `lo`).
     Если на хосте ограничены непривилегированные пользовательские пространства имён (например, `kernel.apparmor_restrict_unprivileged_userns = 1` в Ubuntu 24.04+) **И** бинарник `bwrap` не имеет установленного `setuid`-бита (`chmod u+s /usr/bin/bwrap`), либо нарушена сетевая изоляция (`Failed RTM_NEWADDR`):
     - Маршрут помечается как `sandbox-unavailable`. Запись о блокировке регистрируется в таблице `route_holds` через `store.hold(routeKey, Date.now() + 86400000, "sandbox-unavailable: unprivileged userns or network namespace restricted")` в единой модели с `unavailablePatterns` / hold (§2 / `policy.ts`).
     - Для снятия удержания интерфейс хранилища расширяется методом `store.unhold(routeKey: string): void` (`DELETE FROM route_holds WHERE quota_group = ?`). При перезапуске плагина оркестратор повторно выполняет `probeSandbox()`; при успехе вызывается `store.unhold(routeKey)`, немедленно разблокируя маршрут до истечения суточного TTL.
     - Ошибки вида `"bwrap: setting up uid map: Permission denied"` и `"loopback: Failed RTM_NEWADDR"` входят в состав системных `BUILTIN_UNAVAILABLE_PATTERNS`.
     - Задачи исполнителя на этом маршруте не стартуют на голом хосте, а немедленно переводятся в `blocked` (Fail-Closed).
   - **Запрет подмены `--unshare-all`:** использование полного флага `--unshare-all` является строгим требованием безопасности. Подмена его набором выборочных флагов (например, только `--unshare-net` и `--unshare-pid`) **категорически запрещена**: User namespace изолирует UID/GID и гарантирует свежий локальный счётчик ucounts для `prlimit --nproc=64`. Исключение флага User namespace приводит к падению с ошибкой `EAGAIN` при старте из-за фоновых процессов хоста.
   - При успешном preflight агент и его дочерние инструменты запускаются внутри изолированного окружения:
     ```bash
     bwrap \
       --clearenv \
       --unshare-all \
       --die-with-parent \
       --ro-bind /usr /usr \
       --ro-bind /bin /bin \
       --ro-bind /lib /lib \
       --ro-bind /lib64 /lib64 \
       --ro-bind /etc/alternatives /etc/alternatives \
       --proc /proc \
       --dev /dev \
       --tmpfs /tmp \
       --tmpfs /var/tmp \
       --bind "$SANDBOX_DIR" /workspace \
       --chdir /workspace \
       --setenv HOME /tmp \
       --setenv PATH /usr/local/bin:/usr/bin:/bin \
       --setenv BB_SANDBOX "1" \
       <точки_монтирования_confidentialPaths> \
       -- prlimit --nproc=64 --as=4294967296 --cpu=1200 -- <команда_агента>
     ```
   - **Лимиты ресурсов внутри песочницы:** утилита `prlimit --nproc=64 --as=4294967296 --cpu=1200` (4 GiB виртуальной памяти, 64 процесса, 1200 секунд CPU) накладывается **СТРОГО ВНУТРИ** песочницы на команду агента. Это исключает падение с ошибкой `EAGAIN` при старте, возникающее, если накладывать лимит снаружи на процесс `bwrap` при большом числе фоновых процессов пользователя хоста.
   - **Подготовка mountpoint:** для путей из `confidentialPaths` оркестратор предварительно раскрывает glob-шаблоны по списку файлов базового коммита (`git ls-files <base-sha> -- <glob>`) и каталогов верхнего уровня. Для каждого разрешённого пути перед запуском bwrap гарантируется существование целевого файла (`mkdir -p $(dirname ...) && touch ...`) или директории (`mkdir -p ...`), сохраняя список фактически созданных временных плейсхолдеров в виде абсолютных путей внутри каталога песочницы в массиве `CREATED_PLACEHOLDERS` (`CREATED_PLACEHOLDERS+=("$SANDBOX_DIR/$targetPath")`):
     - если путь в репозитории — файл: `--ro-bind /dev/null /workspace/<confidentialPath>`
     - если путь в репозитории — каталог: `--tmpfs /workspace/<confidentialPath>`
   - Замечание: файл `/etc/resolv.conf` **НЕ пробрасывается**, так как сеть отключена (`--unshare-all`), а его содержимое раскрывает IP-адреса локальных DNS-серверов хоста.

4. **Извлечение, очистка и применение результата:**
   - По завершении хода оркестратор выполняет безопасную очистку артефактов и плейсхолдеров, регистрирует новые untracked-файлы и снимает дифф:
     ```bash
     # 1. Безопасная очистка только игнорируемых артефактов сборки и кэшей
     # Флаг -X гарантирует удаление ТОЛЬКО файлов и директорий, подпадающих под .gitignore
     # (node_modules, .venv, __pycache__, кэши тестов). Закоммиченные файлы (например dist/bundle.js)
     # и созданные агентом новые исходные файлы не затрагиваются!
     git -C "$SANDBOX_DIR" clean -fdX

     # 2. Удаление сохранённых плейсхолдеров confidentialPaths перед фиксацией
     # Пути сохранены строго как абсолютные пути ($SANDBOX_DIR/...), исключая удаление файлов хоста
     for placeholder in "${CREATED_PLACEHOLDERS[@]}"; do
       rm -rf "$placeholder"
     done

     # 3. Инициализация и формирование массива pathspec-исключений для confidentialPaths и артефактов
     CONFIDENTIAL_PATHS=("${POLICY_CONFIDENTIAL_PATHS[@]}")
     EXCLUDE_CONFIDENTIAL_ARGS=()
     for p in "${CONFIDENTIAL_PATHS[@]}"; do
       EXCLUDE_CONFIDENTIAL_ARGS+=(":(exclude)$p")
     done
     # Защита от раздутия патча артефактами в корне и вложенных пакетах монорепозитория
     EXCLUDE_CONFIDENTIAL_ARGS+=(
       ":(exclude)node_modules" ":(exclude)*/node_modules"
       ":(exclude).venv" ":(exclude)*/.venv"
       ":(exclude)__pycache__" ":(exclude)*/__pycache__"
       ":(exclude)*.pyc"
     )

     # 4. Регистрация untracked-файлов без принудительного флага -f
     # Флаг -f исключён: он втаскивал бы игнорируемые деревья и кэши в патч.
     # Регистрация уважает .gitignore и исключает confidentialPaths.
     git -C "$SANDBOX_DIR" add -AN -- . "${EXCLUDE_CONFIDENTIAL_ARGS[@]}"

     # 5. Снятие диффа с явным исключением confidentialPaths
     git -C "$SANDBOX_DIR" diff HEAD -- . "${EXCLUDE_CONFIDENTIAL_ARGS[@]}" > "$SANDBOX_DIR/patch.diff"
     ```
   - **Исключение флага `-f` и правило размещения артефактов:** стандартная команда `git add -AN` уважает правила `.gitignore`. Новые исходные файлы агента (например, `src/utils/new-helper.ts`) регистрируются как intent-to-add и попадают в дифф, в то время как сборочные зависимости и кэши отсекаются `git clean -fdX`, `.gitignore` и pathspec-исключениями. Исполнитель на публичном маршруте обязан сохранять целевые артефакты вне путей, включённых в `.gitignore`; если агент создаёт файл под шаблоном `.gitignore` (например `report.log` при `*.log`), такой файл трактуется как сборочный мусор и не входит в патч.
   - **Порог размера патча:** если результирующий файл `patch.diff` превышает 10 МБ, сдача немедленно бракуется с отказом `patch-too-large` для защиты от переполнения доверенного хранилища.
   - **Удаление плейсхолдеров и pathspec exclusion:** удаление сохранённых плейсхолдеров `CREATED_PLACEHOLDERS` и явное pathspec-исключение `"${EXCLUDE_CONFIDENTIAL_ARGS[@]}"` гарантируют, что пути из `confidentialPaths` не попадут в `patch.diff` в виде `new file mode 100644`. Это предотвращает ошибку `git apply --check: already exists in working directory` на доверенном рабочем дереве и исключает утечку имён секретных файлов в заголовок патча.
   - Дифф валидируется через DLP Redaction Engine (§4.2) и проходит верификацию символических ссылок (§4.3).
   - Валидированный патч применяется к рабочему дереву задачи в доверенном контуре:
     `git apply --check "$SANDBOX_DIR/patch.diff" && git apply "$SANDBOX_DIR/patch.diff"`
   - Каталог `$SANDBOX_DIR` безопасно удаляется:
     `rm -rf "$SANDBOX_DIR"`

---

## 4. Спецификация DLP Redaction Engine

### 4.1. Стандартизированный синтаксис масок (RFC ASCII)

Маскирование секретов по §20.2 п.5 заменяется единым движком со стандартизированными ASCII-псевдонимами. Замены выполняются детерминированно с ведением локальной таблицы соответствий задачи (`DLP_MAP`):

| Тип данных | Формат ASCII-замены | Источник сущностей | Обратимость (Unmasking) |
|---|---|---|---|
| **Сетевые имена и домены** | `host-${N}.bb-mask.internal` | Сканер сетевых адресов и хостов, `BB_SERVER_URL` | Двусторонняя (по словарю задачи) |
| **IPv4-адреса** | `198.51.100.${N}` (RFC 5737 TEST-NET-2) | IP-сканер (IPv4 regex) | Двусторонняя (по словарю задачи) |
| **ID тредов и задач** | `thr_MASKED_${NNN}`, `TASK_MASKED_${NNN}` | Реестр активных ID тредов и задач | Двусторонняя (по словарю задачи) |
| **Секреты, ключи API, токены** | `__BB_REDACTED_SECRET_${NNN}__` | Шаблоны `leaks` (§22.1), `confidentialPaths`, ключи провайдеров, in-place `.npmrc` | **Строго односторонняя** |

### 4.2. Алгоритм защиты от Unmasking Oracle

```
[Выходной unified diff от публичной модели]
                  │
                  ▼
   ┌──────────────────────────────┐
   │ Построчный синтаксический    │
   │ разбор unified diff          │
   └──────────────┬───────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
[Строки контекста ' '    [Строки добавлений '+']
 и удаления '-']                    │
        │                           ▼
        │               Содержит ли токен секрета
        │               __BB_REDACTED_SECRET_*__?
        │                    │              │
        │                   ДА             НЕТ
        │                    │              │
        │                    ▼              ▼
        │           ОТКАЗ СДАЧИ        Разрешена замена
        │           dlp-violation      только хостов и IP
        │                                   │
        ▼                                   ▼
Разрешена обратная               [Контролируемый патч]
подстановка секрета                         │
для сходимости git apply                    ▼
        │                        Применение git apply
        └─────────────┬─────────────────────┘
                      │
                      ▼
        ┌───────────────────────────┐
        │  Вторичный DLP-скан       │
        │  результирующего коммита  │
        └─────────────┬─────────────┘
                      │
            Прошёл проверку?
              │            │
             ДА           НЕТ ──► ОТКАЗ: коммит блокирован
              ▼
    Успешная фиксация
```

**Нормативные правила демаскирования:**
1. Обратная подстановка токена секрета `__BB_REDACTED_SECRET_NNN__` разрешена **СТРОГО в неизменённых контекстных строках `' '` и удаляемых строках `'-'`** unified diff. Это обеспечивает сходимость `git apply` на реальном репозитории при изменении существующих строк.
2. Если токен секрета `__BB_REDACTED_SECRET_NNN__` обнаружен в строке добавления (`'+'`) диффа ЛИБО в теле отчёта / комментария исполнителя, операция сдачи **немедленно бракуется** с отказом:
   `dlp-violation: token exfiltration detected in diff addition or report body`.
   Никакого скрытого запекания реального секрета в репозиторий не допускается.

### 4.3. Валидация символических ссылок (Symlink Traversal Protection)

При разборе `patch.diff` (до применения к доверенному рабочему дереву) оркестратор анализирует патч на предмет создания или модификации символических ссылок (`new file mode 120000`):
1. **Запрет абсолютных симлинков:** если целевой путь (target) симлинка начинается с `/` (например `+ /etc/passwd` или `+ /home/ubuntu/.bb/config.json`), патч немедленно отклоняется с ошибкой:
   `symlink-violation: absolute symlink target '<target>' is prohibited`.
2. **Запрет выхода за пределы репозитория:** если относительный путь симлинка с учётом переходов `../` выходит за пределы корня репозитория (`path.resolve(repoRoot, linkDir, target)` лежит вне `repoRoot`), патч отклоняется:
   `symlink-violation: symlink target '<target>' escapes repository root`.
3. **Проверка путей перед применением:** до вызова `git apply` оркестратор проверяет каждый затрагиваемый в `patch.diff` путь в рабочем дереве: если целевой файл на хосте уже является существующей символической ссылкой, наложение патча отклоняется (`symlink-violation: cannot patch through existing symlink on host`), защищая хост от побега через предсуществующие симлинки.

---

## 5. Матрица доверия (Capability & Trust Matrix)

### 5.1. Уровни доверия маршрутов в политике

В конфигурации политики (`policy.ts`) интерфейс `PolicyRoute` расширяется двумя новыми полями:

```typescript
export type RouteTrustLevel = "trusted-local" | "trusted-cloud" | "public";

export interface PolicyRoute {
  // --- Существующие поля (policy.ts:14-40) ---
  preset: string;
  provider: string;
  quotaGroup?: string;
  quotaPatterns?: string[];
  unavailablePatterns?: string[];
  firstResponseSeconds?: number;
  startSeconds?: number;
  idleSeconds?: number;
  tools?: boolean;
  maxActive?: number;
  maxPromptBytes?: number;
  routeBusyWaitSeconds?: number;

  // --- Новые поля ревизии 34.3 (Zero-Leak Sandbox) ---
  /** Уровень доверия маршрута (по умолчанию: 'trusted-cloud') */
  trust?: RouteTrustLevel;
  /** Разрешён ли доступ к путям из confidentialPaths (по умолчанию: true для trusted-local/trusted-cloud, false для public) */
  confidentialPathsAllowed?: boolean;
}
```

1. **`trusted-local`:**
   - Доверенные локальные модели (vLLM, Ollama) в защищенном контуре.
   - Маскируются только мастер-ключи хоста `~/.bb/`. Исходный код проекта передаётся без купюр.
   - Полный доступ к `git worktree` и локальной сети сборки.

2. **`trusted-cloud`:**
   - Корпоративные облачные провайдеры с подтверждённым соглашением о Zero Data Retention (Anthropic API, OpenAI Enterprise, Vertex AI).
   - Разрешён доступ к файлам `confidentialPaths`. Выполняется базовый скраббинг production-секретов.
   - Исполнение в изолированном worktree (§24); разрешён доступ к корпоративным прокси-серверам пакетов.

3. **`public`:**
   - Бесплатные модели, публичные провайдеры, веб-интерфейсы.
   - Полный строгий DLP-фильтр (RFC ASCII-маскирование хостов, IP, токенов).
   - Физическое исключение `confidentialPaths`.
   - Исполнение:
     - для всех ролей (`executor`, `auditor`, `researcher`, `architect`): исполнение строго в Snapshot Sandbox на базе Bubblewrap с сетевым карантином (`--unshare-all`) при успешном Sandbox Preflight Probe. Режим «маршрут без инструментов» (`tools: false`) и сборка пакета материалов первого сообщения оркестратором полностью удалены (ADR-0036, PLUG-316). Внешние веб-модели без нативных инструментов используют внутренний агент плагина провайдера (ADR-0034) или запускаются в Snapshot Sandbox.

### 5.2. Правило Fail-Closed

1. Если задача помечена меткой/флагом `--privacy strict`, либо рабочий набор изменений затрагивает хотя бы один файл из перечня `confidentialPaths`:
   - Задача допускается к раздаче **СТРОГО** на маршруты уровней `trusted-local` или `trusted-cloud`.
   - Если все доступные доверенные маршруты исчерпали квоту, испытывают сбой сети или отключены, конвейер переводит задачу в статус `blocked` с ошибкой:
     `route-unavailable: задача затрагивает confidentialPaths или помечена --privacy strict, но доверенные маршруты недоступны; автоматический фоллбэк на public-маршруты запрещён политикой безопасности`.
2. Попытка принудительно делегировать такую задачу на публичный маршрут через CLI отклоняется на уровне валидации `runEnqueue` / `resolveTransition`.

---

## 6. Приёмочные сценарии (Верификация 5 блокеров безопасности)

1. **Тест Б1 (Snapshot Sandbox + ENV sterilization):**
   - Запуск агента на публичном маршруте.
   - Проверка истории: `git log --all`, `git reflog`, `git rev-list --objects` возвращают ровно один коммит `sandbox root snapshot`.
   - Проверка ENV: вызов `env` внутри песочницы подтверждает отсутствие `BB_THREAD_ID`, `BB_SERVER_URL` и токенов провайдеров.
2. **Тест Б2 (Физическое исключение `confidentialPaths`, сохранность отслеживаемых файлов и фильтрация .gitignore):**
   - В репозитории есть `src/auth/secret.ts` (файл) и `secrets/keys/` (каталог) из `confidentialPaths`, а также закоммиченный файл сборки `dist/bundle.js`.
   - Чтение файла возвращает пустой вывод (`/dev/null`), чтение каталога — пустую директорию `tmpfs`.
   - В процессе работы агент создаёт:
     - новый файл `src/utils/new-helper.ts` (untracked, не в `.gitignore`);
     - временные сборочные файлы в корне и пакетах: `node_modules/pkg/index.js`, `packages/sub/node_modules/dep/index.js` и `test.log` (подпадают под `.gitignore` либо pathspec-исключения).
   - После `git clean -fdX` и удаления сохранённых плейсхолдеров `CREATED_PLACEHOLDERS`:
     1) закоммиченный `dist/bundle.js` остаётся нетронутым и НЕ попадает в дифф как `deleted`;
     2) сборочный мусор (`node_modules/`, `test.log`) удаляется и НЕ попадает в `patch.diff`;
     3) новый исходный файл `src/utils/new-helper.ts` корректно регистрируется и попадает в `patch.diff` как `new file`;
     4) плейсхолдеры `confidentialPaths` удалены, pathspec `':(exclude)'` исключает конфиденциальные пути, а `git apply --check` на доверенном дереве завершается успешно без ошибки `already exists in working directory`.
3. **Тест Б3 (Защита от Unmasking Oracle):**
   - Агент возвращает unified diff, где в добавленной строке `'+'` находится токен `__BB_REDACTED_SECRET_001__`.
   - Оркестратор бракует сдачу с ошибкой `dlp-violation`. Секрет не запекается в репозиторий.
   - Агент возвращает удаление строки с секретом (строка `'-'`): анмаскинг в удаляемой строке проходит успешно, `git apply` накладывается без ошибок.
4. **Тест Б4 (Изоляция Bubblewrap, Preflight и Prlimit):**
   - Боевой Sandbox Preflight Probe (`bwrap --unshare-all --die-with-parent --ro-bind /usr /usr --proc /proc --dev /dev -- true`) запускается при старте. Если unprivileged userns заблокированы ядром И отсутствует setuid-бит на bwrap, публичный маршрут исполнителя получает статус `sandbox-unavailable` с регистрацией в `route_holds` (снятие через `store.unhold(routeKey)`).
   - При активной песочнице агент вызывает `curl https://google.com` или пытается прочитать `/etc/shadow`.
   - Результат: отказ сети `Network is unreachable`, отказ доступа к файлам хоста. Внутренний лимит `prlimit --nproc=64 --as=4294967296 --cpu=1200` защищает от fork-бомбы и исчерпания памяти/CPU.
5. **Тест Б5 (Fail-Closed):**
   - Задача с `--privacy strict`. Провайдер `swe2` (trusted-cloud) отключен или исчерпал лимиты.
   - Попытка перехода задачи с `--privacy strict` на публичный маршрут при отключенном swe2.
   - Результат: автоматический переход в `blocked` без попытки раздачи на `argon`/`web-gemini`/`public`.
