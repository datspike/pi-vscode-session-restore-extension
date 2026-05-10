# Repo guidance

## Что это за репозиторий

- Это VS Code extension `Pi Session Restore` для best-effort восстановления Pi-сессий в integrated terminal.
- Runtime-код живёт в `src/`; собранные артефакты для extension entrypoint лежат в `dist/`.
- `resources/bin/pi` — PATH wrapper вокруг реального `pi`; любые изменения здесь могут повлиять на обычный запуск Pi в новых терминалах VS Code.
- Extension хранит только локальные restore records и диагностические события; содержимое Pi session JSONL и shell history не копировать и не логировать.

## Как ориентироваться

- Настройки, команды VS Code и activation events объявлены в `package.json`.
- Основной вход расширения: `src/extension.ts`.
- Работа с PATH wrapper и окружением: `src/env/` и `resources/bin/pi`.
- Интеграция с Pi CLI и Pi-side reporter: `src/pi/` и `resources/pi-extension/`.
- Отслеживание терминалов и событий: `src/tracker/`.
- Поиск и сопоставление sessions: `src/session/`.
- Политика восстановления: `src/restore/`.
- Локальное хранение records: `src/store/`.
- Тесты Vitest лежат в `tests/` и должны проверять наблюдаемое поведение модулей.

## Ограничения

- Не правь `dist/` вручную: сначала меняй `src/`, затем запускай сборку.
- Не расширяй поддержку Remote SSH, WSL, Dev Containers или tmux как побочный эффект другой задачи: README явно считает их ограничениями.
- Не добавляй сбор содержимого Pi sessions, shell history или приватных путей сверх уже необходимых restore records.
- При изменениях wrapper сохраняй безопасный поиск реального `pi` дальше по `PATH`, исключая директорию wrapper.
- Явный `--session`, resume, print и package-команды не должны получать новую сессию или переписанное намерение от wrapper, shell integration или Pi-side reporter.
- Auto-restore остаётся консервативным: сначала использовать вкладки, восстановленные VS Code; создавать недостающие вкладки только для ранее автоматически восстановленных records.

## Проверки

- Для изменений кода или тестов запускай `npm run check`.
- Для документационных правок достаточно проверить `git diff` и профильный markdown/agent validator, если он применим.
- Если менялся `resources/bin/pi` или session handling в `src/pi/`/`src/tracker/`, дополнительно проверь явный `--session`, resume, print и package-команды.

## Коммиты

- Используй Conventional Commits: `type(scope): summary`; scope можно опустить, если он не добавляет ясности.
- Предпочтительные типы: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
- Один коммит должен отражать одно логическое изменение.
