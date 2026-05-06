# Repo guidance

## Что это за репозиторий

- Это VS Code extension `Pi Session Restore` для best-effort восстановления Pi-сессий в integrated terminal.
- Runtime-код живёт в `src/`; собранные артефакты для extension entrypoint лежат в `dist/`.
- `resources/bin/pi` — PATH wrapper вокруг реального `pi`; любые изменения здесь могут повлиять на обычный запуск Pi в новых терминалах VS Code.
- Extension хранит только локальные restore records и диагностические события; содержимое session JSONL не копировать и не логировать.

## Как ориентироваться

- Настройки, команды VS Code и activation events объявлены в `package.json`.
- Основной вход расширения: `src/extension.ts`.
- Работа с PATH wrapper: `src/env/` и `resources/bin/pi`.
- Поиск и сопоставление sessions: `src/session/`.
- Политика восстановления: `src/restore/`.
- Локальное хранение records: `src/store/`.
- Тесты Vitest лежат в `tests/` и должны проверять наблюдаемое поведение модулей.

## Ограничения

- Не правь `dist/` вручную: сначала меняй `src/`, затем запускай сборку.
- Не расширяй поддержку Remote SSH, WSL, Dev Containers или tmux как побочный эффект другой задачи: README явно считает их ограничениями.
- Не добавляй сбор содержимого Pi sessions, shell history или приватных путей сверх уже необходимых restore records.
- При изменениях wrapper сохраняй безопасный поиск реального `pi` дальше по `PATH`, исключая директорию wrapper.

## Проверки

- Для изменений кода или тестов запускай `npm run check`.
- Для документационных правок достаточно проверить `git diff` и профильный markdown/agent validator, если он применим.
- Если менялся `resources/bin/pi`, дополнительно проверь сценарии явного `--session`, `resume`, `print` и package-команд, которые wrapper не должен переписывать.

## Коммиты

- Используй Conventional Commits: `type(scope): summary`; scope можно опустить, если он не добавляет ясности.
- Предпочтительные типы: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
- Один коммит должен отражать одно логическое изменение.
