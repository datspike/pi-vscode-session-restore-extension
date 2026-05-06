# Pi Session Restore

VS Code extension для прозрачного best-effort восстановления Pi sessions в обычном integrated terminal.

## Как работает

- При activation extension добавляет `resources/bin` в начало `PATH` только для новых VS Code integrated terminals через `ExtensionContext.environmentVariableCollection`.
- `resources/bin/pi` безопасно ищет настоящий `pi` дальше по `PATH`, исключая директорию wrapper.
- Для обычного интерактивного запуска wrapper заранее назначает Pi session JSONL и запускает реальный CLI как `pi --session <path> ...`; явные session/resume/print/package-команды не переписываются.
- Alias вида `p='pi'` не создаётся extension, но продолжает работать косвенно: shell раскрывает alias в `pi`, а дальше используется PATH wrapper.
- VS Code-side tracker сохраняет локальные restore records из wrapper/shell events; shell integration используется как дополнительный best-effort источник.
- Restore command строится через локально подтверждённый синтаксис `pi --session <path|id>`.

## Commands

- `Pi Session Restore: Show Records`
- `Pi Session Restore: Clear Records`
- `Pi Session Restore: Restore Last Session`

## Settings

- `piSessionRestore.enabled`: включает PATH wrapper для новых terminals.
- `piSessionRestore.sessionGlobPaths`: glob-пути session JSONL, по умолчанию `~/.pi/agent/sessions/**/*.jsonl`.
- `piSessionRestore.restorePolicy`: `off`, `prompt`, `auto-confident`; по умолчанию `auto-confident`.
- `piSessionRestore.confidenceThreshold`: `high`, `medium`, `low`.
- `piSessionRestore.diagnosticsLevel`: `off`, `error`, `info`, `debug`.
- `piSessionRestore.recordTtlDays`: TTL локальных записей.

## Privacy

Extension хранит только локальные диагностические события wrapper и restore records в `globalStorageUri` VS Code. Session contents не копируются.

## Known limitations

- Не восстанавливает живой terminal process.
- Не поддерживает tmux, Remote SSH, WSL и Dev Containers.
- Auto-restore намеренно консервативный: работает только при `restorePolicy=auto-confident`, high-confidence records и известном workspace scope. Если VS Code восстановил несколько idle terminal tabs в одном workspace, extension пытается восстановить соответствующее количество последних Pi records этого workspace.
- Shell integration в VS Code может быть недоступна; в этом случае используется wrapper event log и fallback `terminal.sendText` для ручной команды restore.
