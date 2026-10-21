# Pi 0.86.1 → 1.3.0: решение и совместимость

Дата проверки: 2026-10-21. Исходный checkout: `67faea4`, ветка
`fix/review-2026-09-23`, исходное дерево без изменений.
Карта реализации: [ARCHITECTURE.md](ARCHITECTURE.md).

## Решение

Обновить закреплённый development/CI host до Pi 1.3.0. Причина — полезные
исправления контекста и OpenAI-compatible tool calls, а также необходимость
явно определить поведение делегирования рядом с новым codemode. Переписывать
независимое от Pi ядро или автоматически заменять companion stack оснований
по результатам этой проверки нет.

Проверено через npm: `@earendil-works/pi-coding-agent` имеет `latest: 1.3.0`,
Node requirement остаётся `>=22.19.0`. Это released tag от 2026-10-15,
а не содержимое unreleased `main`.

## Источники upstream

- [Релиз 1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0).
- [Changelog coding-agent на теге 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md): прочитан диапазон после 0.86.1.
- [Changelog pi-ai на том же теге](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md).
- [Extension API и exposure](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md#tool-exposure).
- [Типы Extension API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/types.ts).
- [Native codemode](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/codemode.md).
- [Встроенный llama.cpp provider](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/llama-cpp.md).

Оценка пользы ниже основана на чтении этих источников. Исправления самих
провайдеров Pi здесь повторно не воспроизводились на реальной LLM.

## Изменения, относящиеся к движку

| Изменение Pi | Как касается проекта | Решение |
|---|---|---|
| 0.87.0: `context` больше не отдаёт system messages обработчикам и восстанавливает prompt/tools после фильтрации | Мы удаляем старые repository capsules в `context`; host исправляет опасный побочный эффект такой фильтрации | Сохранить текущий capsule hook; не переходить на более мощный `context_with_system` без задачи |
| 0.87.0 и 1.3.0: исправления strict schemas для неизвестных OpenAI-compatible endpoint и обработки повреждённых tool arguments | Относится к основной модели Pi на локальном сервере | Использовать новый host; сохранить flattening схемы pi-lean-edit, которое решает отдельную проблему локального парсера |
| 0.99.0: встроенные MCP/codemode, `ctx.executeTool`, exposure и parentToolCallId | Tool с default `direct` теперь доступен из другого tool, в том числе рядом с другими вызовами из скрипта | Сделать исполняющее делегирование `model-only`; candidate-only оставить composable |
| Per-tool `executionMode` | Пока идут TinyCoder, запись и build/test, движок просит не выполнять sibling mutations; одних prompt guidelines недостаточно для scheduler | Явно задать `sequential` исполняющему инструменту; не объявлять это межпроцессной блокировкой |
| 0.99.0: nested tool calls проходят lifecycle hooks | Это отличается от bridge в стороннем Python `pi-code-tool`, который движок ограничивает prompt guidelines | Native codemode можно исследовать отдельно; автоматическую замену `code` не делать без замера на локальных моделях |
| 0.99.0: `--no-extensions` отключает и встроенные расширения | Наш RPC load gate сознательно проверяет только engine; install gate проверяет полный manifest | Сохранить оба gate: один не заменяет другой |
| 1.2.0: `before_agent_start` различает user и custom trigger | Обработчики проекта читают `systemPromptOptions` и cwd, не обращаются к `event.prompt` | Изменение сигнатуры не требует ветвления по messageType; оба типа должны получать policy/capsule |
| 1.3.0: exact internal dependencies, исправление active tools при resume, очистка чужого thinking при смене модели | В проекте есть минимальный tool profile и hybrid edit policy при model switch | Обновить host; не дублировать его session restoration внутри движка |
| Встроенный llama.cpp router/provider и классификаторы | Удобны основной модели Pi; TinyCoder остаётся отдельным endpoint с собственным spec/repair transport | Не объединять конфигурации: смена основной модели не должна неявно менять исполнителя |
| Virtual models и routing | Маршрутизация выбора модели не заменяет bounded spec, guarded apply и TRX verification | Возможная будущая оптимизация основной модели, не причина менять текущий workflow |

Native MCP в Pi — клиент для подключения серверов. Наш `mcp/server.mjs` —
сервер, предоставляющий движок другим harness. Это разные стороны протокола;
появление встроенного клиента не делает наш сервер лишним.

`tiny-client.mjs` отправляет HTTP-запрос сам и не использует `pi-ai`.
Поэтому provider fixes Pi не меняют его транспорт автоматически. Существующие
fallback, endpoint normalization и timeout остаются нужны.

## Внесённые адаптации

1. `package.json` и lockfile закрепляют Pi 1.3.0 для разработки и проверок.
   Host peer остаётся `"*"`, companion-версии не менялись. Это не заявление
   о проверке каждой старой версии Pi.
2. `execute_delegated_implementation` получает `exposure: "model-only"` и
   `executionMode: "sequential"`. Он остаётся доступен основной модели, но Pi
   исключает его из callable tools и отвергает `ctx.executeTool()` к нему.
   `delegate_implementation` сохраняет default direct exposure.
3. RPC helper разрешает CLI из локального пакета и его `bin.pi`, запускает
   его через текущий Node. Прямой запуск gate больше не зависит от глобального
   `pi` или npm-подстановки `PATH`.
4. Добавлены реальные host-contract и CLI-resolution тесты; golden metadata
   отражает exposure и execution mode. CI push-фильтр включает `fix/**`.
5. Audit обнаружил high advisory
   [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
   в старом override `sharp@0.35.4`. Override обновлён до 0.35.5.
6. Обновлены обе README и описание проверок; исправлены устаревшие указания,
   что MCP/Claude Code и automatic current-file attachment ещё не реализованы.

## Свидетельства проверок

Среда локальных запусков: Windows, Node 24.15.0, npm 11.12.1,
.NET SDK 10.0.203. Node 22.19.0 и Linux задаются существующим CI workflow;
эта запись сама по себе не является свидетельством их выполнения.

| Проверка | Наблюдение |
|---|---|
| Исходный `npm run gate:local`, Pi 0.86.1 | PASS; 317 passed, 1 Windows symlink skip |
| Новый `tests/pi-host-contract.test.mjs` до исправления | FAIL: nested call нашёл исполняющий tool и дошёл до проверки его аргументов |
| Тот же тест после `model-only` | PASS: tool declared/active, nested invocation отвергнут как недоступный; candidate-only остаётся callable; sequential metadata дошла до реального AgentTool |
| `tests/pi-rpc.test.mjs` с пустым PATH до исправления | FAIL: `pi.cmd` не найден |
| Тот же тест после локального разрешения CLI | PASS: запускается Pi 1.3.0 из manifest проекта |
| `npm run gate:local`, Pi 1.3.0 | PASS; 319 passed, 1 Windows symlink skip; syntax, dry-run, transport smoke и все 8 команд через реальный RPC |
| `npm run gate:edit` | PASS, включая отрицательный случай lean с конфликтующим edit и положительные none/hybrid/never; плоская схема сохранена |
| `npm run gate:install -- --package-dir .` | PASS: все 4 companion реально активны в изолированном Pi agent-dir |
| Полный `npm run gate:install` | PASS: копия рабочего дерева, обычный `npm install --omit=dev`, изолированный install и doctor; все 4 companion активны |
| `npm run gate:dotnet` | PASS: malformed response → wrong candidate/red TRX → repaired candidate; итог green на попытке 3, изменён только разрешённый файл |
| `npm audit --omit=dev --audit-level=high` | Exit 0; 8 moderate в цепочке sprintf-js; high/critical не сообщает |

Первый install-gate после `npm ci --ignore-scripts` отказал из-за отсутствия
native binding `better-sqlite3`. `npm rebuild better-sqlite3` восстановил
binding, повторный gate прошёл. Это ошибка неполной подготовки native dependency,
а не несовместимость extension API. Для обычной установки нужен `npm ci`
с install scripts companion-зависимостей.

Во время загрузки dependencies npm дважды вернул HTTP 404 для
`@aws-sdk/types@3.975.0`; последующий HEAD того же URL вернул 200, и установка
из сформированного lockfile прошла. Специального override для обхода этой
временной ошибки не добавлено.

## Ограничения и следующие шаги

Реальный GGUF/llama-server acceptance не выполнен: install-doctor сообщил
недоступность TinyCoder на loopback. Успешная регистрация всех companions
подтверждает совместимость загрузки, но не доказывает embedding inference,
качество поиска, LSP на произвольном C# проекте или качество TinyCoder.

Следующий полезный эксперимент — сравнить native codemode и bundled `code`
на одинаковой локальной модели: размер prompt, latency, доля корректных вызовов,
сохранение edit/LSP lifecycle. Удалять Python companion стоит только по этим
результатам. Обновление host уже полезно независимо от такого эксперимента.

Оставшиеся moderate-зависимости требуют отдельного решения по
`pi-knowledge`/transformers/mammoth. Предлагаемый npm `audit fix --force`
понижает `pi-knowledge` до другой несовместимой версии; он не применялся.
