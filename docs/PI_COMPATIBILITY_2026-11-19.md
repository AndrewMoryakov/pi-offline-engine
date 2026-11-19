# Pi 1.3.0 → 1.5.0: совместимость и решение

Дата проверки: 2026-11-19. Исходный checkout: `73528ae`
(`origin/fix/review-2026-09-23`), ветка `docs/pi-1.5-compat`; код движка в этой
проверке не менялся. Карта реализации: [ARCHITECTURE.md](ARCHITECTURE.md).
Предыдущий разбор: [PI_COMPATIBILITY_2026-10-21.md](PI_COMPATIBILITY_2026-10-21.md).

## Решение

Движок совместим с Pi 1.5.0 без изменений кода, с оговорками. Загрузка
расширения, восемь команд, маршрутизация `edit`, граница nested calls,
валидация аргументов и хуки одного прогона агента проверены на реальном
Pi 1.5.0 (наблюдалось; загрузку, команды и `edit` — координатор). Не
проверены: загрузка трёх bundled companion (`pi-knowledge`,
`pi-lsp-extension`, `pi-code-tool`) под 1.5.0, `gate:install`, `gate:dotnet`,
исполняющий путь `execute_delegated_implementation` (подтверждение, запись,
`dotnet` через `pi.exec`), реальная модель и реальный TinyCoder.

Рекомендация: перевести закреплённый development/CI host на Pi 1.5.0
отдельным изменением, на машине, где можно выполнить `npm install` и все
gates. Условие слияния — `gate:install` на перегенерированном lockfile. Перечень
затрагиваемых мест — в разделе «Закрепление devDependency».

## Статус после повышения закрепления

Закрепление повышено до 1.5.0 в этой же ветке (`package.json`, `package-lock.json`,
`tests/packaging.test.mjs`, документы). Оговорки раздела «Решение» закрыты так.
Все результаты ниже **наблюдались** 2026-11-19 на коммите `ed0d1ae`: свежий клон,
Ubuntu 26.04 (машина `andrewm-hardware`, без GPU), официальный Node 22.19.0 с
nodejs.org (контрольная сумма сверена), npm 10.9.3, `npm ci` без обходных
переменных окружения, Pi 1.5.0 из lockfile.

- Загрузка трёх bundled companion под 1.5.0: `npm run gate:install` PASS. Активны
  `execute_delegated_implementation`, `knowledge_search`, `lsp_diagnostics`, `code`,
  `lsp_symbols`, провайдер `edit` из `pi-lean-edit`.
- `node --test`: 338 тестов, 337 pass, 0 fail, 1 skipped. `gate:local`, `gate:pi`,
  `gate:edit` PASS. `npm audit --omit=dev --audit-level=high`: 0 уязвимостей.
- `npm run gate:dotnet` PASS в двух окружениях: только .NET 10 (SDK 10.0.404; гейт сам
  включает `DOTNET_ROLL_FORWARD=Major`) и .NET 8 + 10 с `DOTNET_ROLL_FORWARD=Minor`.
- `pi install git:github.com/AndrewMoryakov/pi-offline-engine@<полный sha>` в отдельном
  `PI_CODING_AGENT_DIR` (Pi 1.5.2): код 0, установлен ровно этот коммит.

Две находки, не относящиеся к самому Pi:

- Свежая установка на Linux x64 падала: postinstall `onnxruntime-node` 1.21.0 скачивает
  CUDA-сборку с GitHub-релиза `microsoft/onnxruntime` v1.21.0, который больше не
  отвечает (404). Падали `npm ci`, `gate:install` и `pi install ...@v0.1.1`. Исправлено
  строкой `onnxruntime-node-install-cuda=skip` в `.npmrc`; npm 11 предупреждает, что
  неизвестный ключ перестанет работать в следующей мажорной версии npm.
- На дистрибутивном Node Ubuntu (22.22.1, `process.features.typescript === false`)
  семь файлов тестов не загружаются (`ERR_UNKNOWN_FILE_EXTENSION` для `.ts`): тесты
  импортируют `extensions/*.ts` напрямую и требуют Node с встроенной поддержкой
  TypeScript, как в официальных сборках начиная с 22.18.

Не наблюдалось: работа с реальной моделью, запуск на Windows, вызовы `dotnet` через
`pi.exec` в живой сессии Pi (`gate:dotnet` идёт через `nodeExec`), а также
`pi install ...@<тег>` после исправления (проверен вариант с полным sha).

## Как помечены утверждения

- **прочитано** — указаны файл и версия источника;
- **наблюдалось (координатор)** — запуск координатора 2026-11-19 на этом коде
  под Pi 1.5.0;
- **наблюдалось** — тест или проба, выполненные в этой проверке;
- **вывод** — следует из прочитанного кода и документации, не запускалось.

## Версия и среда

- 1.5.0 выпущен 2026-11-02; требование Node `>=22.19.0` и `bin.pi`
  (`dist/bundle/cli.js`) такие же, как в 1.3.0 (прочитано: CHANGELOG и
  `package.json` coding-agent на тегах v1.3.0 и v1.5.0).
- npm dist-tags на 2026-11-19: `latest` = 1.5.2 (наблюдалось: запрос к
  registry). 1.5.0 — версия, которой пользуется владелец; 1.5.1 и 1.5.2
  разобраны только по changelog, см. «Закрепление devDependency».
- `CHANGELOG.md`, `docs/extensions.md`, `docs/rpc.md` глобальной установки
  Pi 1.5.0 побайтно совпадают с тегом v1.5.0 (наблюдалось: `diff -q`).
  Поэтому ниже указаны ссылки на тег.
- Среда запусков: Linux, Node 24.18.0. Дерево зависимостей не совпадает с
  lockfile: Pi 1.5.0 из глобальной установки (lockfile: 1.3.0), `sharp` 0.35.4
  (override: 0.35.5), `typebox` 1.3.34, companion-пакеты в версиях manifest,
  `vscode-languageserver-protocol` 3.17.5 (наблюдалось).

## Источники upstream

- [Changelog coding-agent на теге 1.5.0](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md): прочитаны 1.4.0 и 1.5.0.
- [Changelog pi-ai](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md) и [pi-agent-core](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md) на том же теге: 1.4.0 и 1.5.0.
- [Extension API](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md), разделы «Tool parameter schemas and TypeBox», `before_agent_start`, `context`, `pi.exec`, «Tool Exposure».
- Типы Extension API на [v1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/types.ts) и [v1.5.0](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/extensions/types.ts): сравнены построчно.
- Валидация аргументов pi-ai на [v1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/src/utils/validation.ts) и [v1.5.0](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/utils/validation.ts).
- RPC: `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md` на обоих тегах.
- [Changelog coding-agent на теге 1.5.2](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md): только для выбора версии закрепления.

Исправления провайдеров Pi здесь на реальной LLM не воспроизводились.

## Какой частью Pi пользуется движок

| Что | Где | Изменения после 1.3.0 | Основание |
|---|---|---|---|
| Импорты: `getAgentDir`, `withFileMutationQueue`, типы `ExtensionAPI`/`ExtensionContext`; `Type` из `typebox`; default export `pi-lean-edit` | `extensions/*.ts` | Экспорты на месте; `typebox` импортируется напрямую, не через pi-ai | прочитано: `dist/index.d.ts` 1.5.0, grep импортов; наблюдалось: проба очереди файлов |
| `pi.registerTool`: TypeBox-параметры, `promptSnippet`/`promptGuidelines`, `exposure: "model-only"`, `executionMode: "sequential"` | `register-delegation-tools.ts` | `ToolDefinition` не изменился; изменилась валидация аргументов (строка 1 ниже) | прочитано: diff `types.ts`; наблюдалось: `pi-host-contract` |
| `pi.registerCommand` ×8 с `getArgumentCompletions` | `register-offline-commands.ts` | Нет | прочитано; наблюдалось (координатор): `gate:pi` |
| `pi.on`: `session_start` ×3, `session_compact`, `session_tree`, `before_agent_start` ×2 (меняет `systemPromptOptions.promptGuidelines`, возвращает `message`), `context` (возвращает `messages`), `tool_result` (возвращает `content`), `model_select` | `register-lifecycle-hooks.ts`, `pi-lean-edit.ts` | Типы событий не изменились | прочитано: diff `types.ts`; наблюдалось: faux-прогон |
| `pi.getAllTools`, `getActiveTools`, `setActiveTools` | `pi-lean-edit.ts`, `/offline-tools`, doctor | Порядок после `setActiveTools` (строка 6) | прочитано; наблюдалось (координатор): `gate:edit` hybrid+never |
| `pi.exec` | `extension-runtime.ts` → verification, doctor, repo capsule | `maxBuffer`, `truncated`, SIGKILL, UTF-8, ошибка spawn (строка 4) | прочитано; наблюдалось: в faux-прогоне капсула собрана через `pi.exec("git")`. Вызовы `dotnet` через `pi.exec` под 1.5.0 не запускались |
| `ctx.cwd`, `ctx.hasUI`, `ctx.model`, `ctx.ui.notify/confirm/select` | все адаптеры | Исправление параллельных диалогов (строка 8) | прочитано |
| RPC в `scripts/lib/pi-rpc.mjs`: `bin.pi` из manifest, `--mode rpc`, `--no-session`, `--no-extensions`, `-e`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--version`; запросы `get_commands` и `prompt`; события `response`, `extension_ui_request`/`notify`/`notifyType`, `extension_error` | gates | Документы RPC в v1.3.0 и в 1.5.0 совпадают; `bin.pi` тот же | прочитано: diff; наблюдалось (координатор): `gate:pi`, `gate:edit` |
| SDK в тестах: `createAgentSession`, `DefaultResourceLoader`, `SessionManager.inMemory`, `SettingsManager.inMemory`, `getActiveToolNames`, `getCallableToolNames`, `agent.state.tools`, `ctx.executeTool` | `tests/pi-host-contract.test.mjs` | — | наблюдалось: тест проходит |

Diff `types.ts` между v1.3.0 и v1.5.0 только добавляет: `KeybindingHints`
(`keyText`/`keyHint`) в контекстах отрисовки, `blocked` для inline
`ctx.ui.custom()`, `messageId`/`timestamp` для отрисовки сохранённых записей
(прочитано). Ничего из этого движок не использует.

## Изменения upstream, относящиеся к движку

| № | Изменение Pi | Как касается проекта | Решение | Основание |
|---|---|---|---|---|
| 1 | 1.5.0, breaking: аргументы tools валидирует `@earendil-works/pi-schema` (`compile(schema, { coerce: true })`) вместо TypeBox `Value.Convert` и собственного приведения pi-ai | Касается обоих инструментов делегирования и плоской схемы `edit`/`line_edit`. На 17 вариантах аргументов `delegate_implementation` старый и новый валидаторы приняли и отклонили одно и то же, приведённые значения совпали; отличается только текст ошибок (`- spec.target: missing` вместо `must have required properties target`). Из 7 вариантов `edit` отличается один: одиночный объект в `edits` 1.5.0 оборачивает в массив, 1.3.0 отклонял (`edits: must be array`). Строку `../x.cs` схема пропускает, а `validateImplementationSpec` отвергает, как и раньше. Текст ошибок Pi в коде и тестах проекта не проверяется | Сохранить; код не менять | наблюдалось: A/B-проба; прочитано: CHANGELOG pi-ai 1.5.0, `validation.ts` на обоих тегах; grep |
| 2 | 1.5.0: pi-ai больше не реэкспортирует TypeBox; pi-ai и pi-agent-core не зависят от `typebox`; `AgentTool.params` типизируется через pi-schema; TypeBox-возможности вне JSON Schema (`Refine`, codecs, `Format.Set`) не применяются к аргументам | Движок берёт `Type` из `typebox` (`delegation-schema.ts:4`) и использует только `Object`, `String`, `Literal`, `Array`, `Boolean`, `Optional`. `extensions/`, `src/`, `mcp/` не импортируют pi-ai и pi-agent-core. TypeScript-проверки типов в проекте нет: tsconfig отсутствует, CI не запускает `tsc`, Pi загружает `.ts` через jiti | Сохранить | прочитано: код, CHANGELOG pi-ai и pi-agent-core 1.5.0, `.github/workflows/ci.yml` |
| 3 | Тот же релиз, для companion-пакетов: `pi-lsp-extension` импортирует `@sinclair/typebox`, `pi-lean-edit` и `pi-code-tool` импортируют `typebox`; по документации 1.5.0 Pi отображает эти имена на свои копии. `pi-lean-edit` строит схему через `Type.Unsafe`, это обычная JSON Schema | Загрузка `pi-knowledge`, `pi-lsp-extension`, `pi-code-tool` под 1.5.0 не наблюдалась: `gate:pi` грузит только `index.ts` с `--no-extensions`, `gate:edit` — только обёртку lean edit | Перед повышением закрепления выполнить `gate:install` | прочитано: `extensions.md` «Available Imports», grep в `node_modules`; не наблюдалось |
| 4 | 1.5.0: `pi.exec()` получил `maxBuffer` (по умолчанию 256 MiB; при превышении `truncated: true`, `killed: true`, ненулевой код), SIGKILL через 5 с после SIGTERM, исправленную склейку UTF-8 между chunks, текст ошибки spawn в stderr; падение `RangeError` устранено | `dotnet build/test`, `dotnet test --help` и git идут через `pi.exec` без `maxBuffer`. Последствия в пользу движка: не-ASCII вывод dotnet не портится на границе chunks, test host, игнорирующий SIGTERM, больше не подвешивает инструмент. Текст ошибки spawn — исправление на стороне хоста: в журнал и диагностику build/test он попадёт (verification пишет stderr в артефакт), а preflight и doctor по-прежнему сообщают только `exit N`. `inspectDotnetTestRunner` называет любой `killed` таймаутом — подпись неверна только при выводе `dotnet test --help` больше 256 MiB | Перейти на новый host; код не менять | прочитано: CHANGELOG 1.5.0, `extensions.md` `pi.exec`, `src/verification.mjs`; вывод |
| 5 | То же, со стороны движка: `src/node-exec.mjs` (MCP-сервер и `gate:dotnet`) объявлен «same contract as pi.exec» | SIGKILL через 5 с и текст ошибки spawn в нём уже есть. Нет `maxBuffer`/`truncated`, и каждый chunk декодируется отдельно (`data.toString()`) — та ошибка UTF-8, которую Pi исправил в #11312. Путь через Pi этот модуль не использует | Совместимость не затронута; отдельная небольшая задача: `setEncoding("utf8")` и уточнение комментария | вывод (чтение кода), не воспроизводилось |
| 6 | 1.5.0: `setActiveTools()` сохраняет порядок инструментов, которые остаются активными, новые добавляет в конец | `planScriptEditActivation` и `buildMinimalToolSet` проверяют наличие, не порядок. Уведомление `/offline-tools minimal` печатает порядок движка, `/offline-tools status` — порядок Pi; они могут различаться | Сохранить | прочитано; вывод; вызов `setActiveTools` из `session_start` работает (наблюдалось (координатор): `gate:edit` hybrid+never) |
| 7 | 1.4.0: при resume и `/tree` extension tools, которые ветка не добавляла и не убирала, активны, если не заданы с `defaultActive: false` | Инструменты движка активны по умолчанию: сессия, начатая до установки движка, получит их при resume. Флаг `hiddenByPolicy` гибридной политики и `savedActiveTools` живут в памяти процесса, а Pi с 1.3.0 восстанавливает активный набор ветки. Следствие (существует с 1.3.0, не новое): после перезапуска и resume при `scriptEditPolicy=cloud-only` скрытый прежним процессом `edit` не вернётся при переходе на удалённую модель; `/offline-tools restore` после resume сообщит, что восстанавливать нечего. Gates стартуют с `--no-session` и resume не покрывают | Повышению не мешает; исследовать отдельно пробой с сохранённой сессией | прочитано: CHANGELOG 1.3.0 и 1.4.0; вывод |
| 8 | 1.4.0: параллельные диалоги расширений — второй заменял первый, и promise первого не завершался | `execute_delegated_implementation` ждёт `ctx.ui.confirm`, `/offline-setup` — `ctx.ui.select`. При одновременном диалоге другого расширения подтверждение на 1.3.0 могло зависнуть | Перейти на новый host | прочитано; вывод |
| 9 | 1.5.0: «Tightened system prompt». Контракт `before_agent_start` прежний; документация прямо разрешает менять `promptGuidelines` | В faux-прогоне правило `applyCodeToolPolicy` присутствовало в системном сообщении каждого из трёх запросов; капсула вставлялась; после `/offline-context refresh` в последнем запросе осталась одна капсула из двух. Как новая формулировка промпта Pi влияет на локальные модели, не измерялось | Сохранить | наблюдалось: faux-прогон; прочитано: `extensions.md` `before_agent_start` |
| 10 | 1.5.0: `Usage.cost.totalFromProvider`; суммарный usage считается выставленным провайдером, только если таким является каждая часть | `toPiUsage` отдаёт нулевую стоимость без флага. Итоги сессии с usage инструмента делегирования будут помечены как оценка, даже если основная модель отдаёт billing. Это верно: у локального TinyCoder нет счёта провайдера | Сохранить | прочитано; вывод |
| 11 | 1.5.0 и 1.4.0: потоковые tool calls разбираются инкрементально; tool output из одних пробелов заменяется заглушкой для OpenAI Completions/Responses | Для основной модели на локальном OpenAI-compatible сервере: меньше CPU на больших `write`/`edit`, меньше ответов 400. Транспорт TinyCoder не использует pi-ai | Перейти на новый host | прочитано; не измерялось |
| 12 | 1.5.0: сбой установки сконфигурированного пакета больше не обрывает запуск Pi (предупреждение, пакет пропускается) | `gate:install` выполняет явный `pi install`, который по changelog по-прежнему завершается ненулевым кодом, и требует строки doctor от каждого companion. Отсутствующий companion gate по-прежнему отвергнет | Сохранить | прочитано: CHANGELOG, `scripts/install-gate.mjs`; вывод |
| 13 | 1.5.0: Pi показывает changelog пакета после обновления (`pi.changelogPath` или `CHANGELOG.md` в корне) | В корне репозитория `CHANGELOG.md` нет, поэтому уведомление не появится | По желанию; к совместимости не относится | прочитано |
| 14 | 1.4.0: breaking changes pi-ai (`telemetryContext`, User-Agent, `resolveTranscriptTools`), заголовки в `before_provider_headers` | Не используются: pi-ai движок не импортирует, provider hooks не регистрирует, `tiny-client.mjs` делает HTTP-запрос сам | Сохранить | прочитано: grep |
| 15 | Exposure, `executionMode`, `ctx.executeTool` | Без изменений; `execute_delegated_implementation` объявлен модели, sequential, из nested call отвергается; `delegate_implementation` остаётся callable | Сохранить | прочитано: diff `types.ts`; наблюдалось: `pi-host-contract` |

К движку не относятся: каталог моделей и провайдеров, TUI и терминалы, MCP
OAuth, доверие к проекту (`ctx.isProjectTrusted()` движок не вызывает),
обновление `pi -e npm:`/`git:` (gates загружают расширение по локальному
пути), очередь воркеров и поиск в codemode. Пункт 1.5.0 о том, что сводки
`/tree` учитывают context edits (#11602), касается записей сессии
`context_edit`, а не хука `context` (прочитано: `session-format.md`).

## Найденные несовместимости

Несовместимостей с Pi 1.5.0, требующих изменения кода, не найдено.

A/B-проба показала одно поведение, существовавшее уже на 1.3.0. Хост
превращает `null` в обязательном строковом поле в строку `"null"`, а число —
в строку (`42` → `"42"`); `validateImplementationSpec` такие значения
принимает. Сценарий: основная модель вызывает `delegate_implementation` или
`execute_delegated_implementation` с `"target": {"file": "src/A.cs",
"symbol": null}`; TinyCoder получает задачу изменить символ `null`. Так же
ведут себя `goal.summary` и `spec_id`. Файловая область не затронута: пути
проверяются отдельно. Решение — исследовать; отвергать ли буквальное `"null"`
в `validateImplementationSpec`, решает владелец. Повышению версии не мешает.

## Закрепление devDependency

Рекомендация: закрепить 1.5.0 — версию, которой пользуется владелец и которая
проверена здесь. 1.5.1 и 1.5.2 разобраны только по changelog: раздел 1.5.2 и раздел
«Breaking Changes» 1.5.1 прочитаны полностью, остальное в 1.5.1 просмотрено
поиском по ключевым словам. Два breaking change 1.5.1 — `GrepOperations.readFile`
(движок не использует) и отказ от `"tools": []` в запросах OpenAI-compatible
моделей, когда все tools отключены; движок все tools не отключает,
`/offline-tools minimal` оставляет набор. Одно место затрагивает загрузку:
1.5.1 перед импортом приводит путь входного файла расширения к реальному
(#8112), что важно для пакета, подключённого через symlink.
Закрепление 1.5.2 потребует пройти этот разбор заново, начиная с `gate:install`.

Что затронет повышение до 1.5.0:

1. `package.json`: `devDependencies["@earendil-works/pi-coding-agent"]` →
   `"1.5.0"`. `"pi-lsp-extension": "1.3.0"` — версия companion, не Pi; её не
   трогать.
2. `package-lock.json` перегенерирует npm. Ожидаемо (вывод из CHANGELOG и
   `package.json` 1.5.0): пакеты `@earendil-works/*` перейдут на 1.5.0,
   появится `@earendil-works/pi-schema`, исчезнут вложенные `typebox` у pi-ai
   и pi-agent-core. Проверить, что override по-прежнему держат `sharp` 0.35.5
   и `vscode-languageserver-protocol` 3.17.5.
3. `tests/packaging.test.mjs`, строки 80 и 92: `"1.3.0"` → `"1.5.0"`
   (devDependency и запись lockfile). Комментарий в строке 66 относится к
   `pi-lsp-extension`.
4. `tests/pi-rpc.test.mjs` менять не нужно: тест сравнивает `pi --version` с
   devDependency из manifest. Его нынешний отказ (`'1.5.0' !== '1.3.0'`)
   означает расхождение дерева и manifest, а не API (наблюдалось).
5. Документация с «Pi 1.3.0» как базовой версией: `README.md` (бейдж в строке
   11, строки 143, 175, 177, 180), `README.ru.md` (11, 143, 173, 175),
   `docs/LOCAL_VALIDATION.md` (15, 37). Упоминания `pi-lsp-extension` 1.3.0 к
   этому не относятся.
6. Перед слиянием: `npm ci`, `gate:local`,
   `npm audit --omit=dev --audit-level=high`, `gate:pi`, `gate:edit`,
   `gate:install -- --package-dir .` и полный `gate:install`, `gate:dotnet`.
   CI выполняет их на Node 22.19.0; эта проверка шла на Node 24.18.0.

## Свидетельства проверок

| Проверка | Кто | Результат |
|---|---|---|
| `npm run gate:pi` | координатор | PASS: Pi 1.5.0, зарегистрированы все 8 команд |
| `npm run gate:edit` | координатор | PASS, 13 проверок: lean отвергает второй `edit`; none; hybrid; плоская схема `line_edit`; hybrid+never |
| Полный `node --test` (объединённая работа) | координатор | 335 тестов: 333 pass, 1 skipped, 1 fail (`pi-rpc`) |
| `tests/pi-host-contract.test.mjs` | эта проверка | PASS |
| `tests/pi-rpc.test.mjs` | эта проверка | FAIL: actual `'1.5.0'`, expected `'1.3.0'` |
| `tests/packaging.test.mjs` | эта проверка | 9/9 PASS (manifest и lockfile ещё на 1.3.0) |
| `tests/extension-registration.test.mjs` | эта проверка | 19/19 PASS (fake Pi: логика хуков, не хост) |
| A/B-проба валидации аргументов | эта проверка | 17 вариантов `delegate_implementation`, 7 вариантов `edit`; различие одно, описано в строке 1 |
| Faux-прогон агента | эта проверка | Без ошибок загрузки; 3 запроса к провайдеру; результаты в строках 1 и 9 |
| diff `types.ts` и документов RPC между v1.3.0 и 1.5.0 | эта проверка | `types.ts` только расширен; три документа RPC совпадают |
| Проба `withFileMutationQueue` | эта проверка | Два писателя через вложенные очереди на двух путях, как в `extension-runtime.ts`: выполнились по очереди, файл `XY`. Контроль без очереди: запуски перекрылись, файл `X`, одна запись потеряна |

A/B-проба. Сессия Pi 1.5.0 через SDK (`DefaultResourceLoader` с
`extensions/index.ts` и `extensions/pi-lean-edit.ts`, без модели). Из
`session.agent.state.tools` взяты реальные объекты инструментов и прогнаны
через `validateToolArguments` — функцию, которую вызывает цикл агента
(`pi-agent-core` `agent-loop.js`). Для 1.3.0 тем же объектам дан
`dist/utils/validation.js` из npm-тарбола pi-ai 1.3.0 (sha512 совпадает с
`package-lock.json`) с `typebox` 1.3.27 — версией, которую pi-ai 1.3.0
закрепляет в lockfile. Это валидатор 1.3.0, а не полная сессия Pi 1.3.0.
Варианты: корректная спецификация; `allowed_files` и `requirements` строкой;
`"true"` и `null` в булевых полях; `version: "1"`; `null` и число в строковых
полях; `null` в необязательном `preserve`; лишние свойства на двух уровнях;
три файла; путь `../x.cs`; отсутствующий `target`; вложенный `context`. Для
`edit`: строчная, колоночная и `edits[]` формы, числа строками, `edits`
объектом, без `path`, с лишним `oldText`.

Faux-прогон. Сессия Pi 1.5.0 через SDK; faux provider из pi-ai 1.5.0
зарегистрирован inline-расширением через `registerProvider`; загружен
`extensions/index.ts` и инструмент-заглушка `code`. Временный git-репозиторий,
endpoint TinyCoder — закрытый порт `127.0.0.1:9`. Три prompt: `first` (faux
возвращает вызов `delegate_implementation` с `allowed_files: "src/A.cs"` и
`allow_new_files: "false"`), `/offline-context refresh`, `second`. Вызов
прошёл валидацию Pi и `validateImplementationSpec` и завершился ошибкой
транспорта `Tiny implementer failed: fetch failed`. До обращения к TinyCoder
спецификация проверяется (ARCHITECTURE.md, «Маршрут одного изменения»), так что
отказ транспорта означает, что обе проверки пройдены. Сообщений в трёх
запросах к провайдеру: 3, 5, 7, капсул — по одной; без фильтра в `context` в
третьем запросе было бы 8 сообщений и 2 капсулы. Фильтрует капсулы по
`customType` только хук движка — вывод.

Не запускались: `gate:install`, `gate:dotnet` (по данным координатора, на этой
машине он падает из-за .NET SDK, не связанного с Pi), `gate:local` целиком,
`npm audit`, реальная LLM, реальный TinyCoder, Windows, Node 22.19.0.

Под Pi 1.5.0 никто не выполнял `execute_delegated_implementation` дальше
регистрации: подтверждение через `ctx.ui.confirm`, запись под очередями файлов,
применение кандидата и `dotnet` через `pi.exec`. `gate:dotnet` этот пробел не
закроет: он передаёт workflow `nodeExec` (`scripts/dotnet-gate.mjs:66`), а не
`pi.exec`. Отдельно проверены только очередь файлов (проба выше) и `pi.exec`
для git (faux-прогон).

## Ограничения и следующие шаги

1. `gate:install` под 1.5.0 — главный открытый пункт: только он покажет, что
   bundled companions загружаются и регистрируют инструменты.
2. Прогон `execute_delegated_implementation` под Pi 1.5.0 на .NET-фикстуре
   через `pi.exec`, а не `nodeExec`: faux provider и
   `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` во временном каталоге или RPC с ответом
   на `confirm`.
3. Сессия с реальной локальной моделью: как на неё влияют обновлённый
   системный промпт Pi и приведение аргументов pi-schema.
4. Проба resume с сохранённой сессией для гибридной политики и
   `/offline-tools` (строка 7).
5. Декодирование UTF-8 в `src/node-exec.mjs` (строка 5) — небольшое
   изменение с тестом на многобайтовый символ на границе chunk.
6. Решение о буквальном `"null"` в спецификации (раздел «Найденные
   несовместимости»).
