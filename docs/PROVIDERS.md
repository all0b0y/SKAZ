# Модели, доступ и ограничения

## Контракт возможностей
Capability registry хранит task type, input/output modalities, streaming mode, languages, timestamps, endpoint, auth method, provenance/last validation. Семейство или произвольное имя не подтверждает возможности.

Audio input у мультимодальной LLM не равнозначен специализированной ASR: нужны проверка реального аудиозапроса, формата текста, задержки и временных меток. Непроверенная custom-модель не должна показываться как подтверждённо совместимая.

## Желаемые интеграции
- OpenRouter: динамический каталог, LLM для агента/конспекта; ASR только для реально проверенного API и модели.
- OpenAI: проверить текущие transcription/realtime endpoints; отдельный текстовый адаптер.
- Anthropic: текстовый агент/конспекты; наличие ASR не предполагается.
- Local ASR: отдельный адаптер, явная загрузка весов, оценка RAM/CPU/GPU; нет скрытого скачивания гигабайт.
- OAuth OpenAI/Anthropic: исследовать официально поддерживаемую авторизацию стороннего приложения. Подписка не равна API-кредитам. Не копировать токены Hermes/Claude Code и не обходить ограничения провайдера.

## Исполнители разработки
Запрошены Opus 4.8 и Opus 5. Официальная страница https://www.anthropic.com/news/claude-opus-5 указывает `claude-opus-5`; описание https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5 сравнивает его с Opus 4.8. Это подтверждает публикации, но не доступ аккаунта.

Проверка окружения: Claude Code 2.1.246 установлен, `claude auth status` вернул loggedIn=false / authMethod=none. OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY не экспортированы в текущем shell. Это не доказательство отсутствия ключей в других хранилищах. Секреты не считывались.

Обновление: пользователь авторизовал Claude Code через свой аккаунт; реальные вызовы подтвердили `claude-opus-5` и `claude-opus-4-8` в modelUsage. Оба используются исполнителями, без fallback. Оркестратор — gpt-6-astra / openai-codex. После достижения лимита Claude Pro работа возобновлена после сброса лимита в исходных сессиях.

Документация OpenRouter получена напрямую: https://openrouter.ai/docs/guides/overview/multimodal/audio — base64 input_audio через chat/completions. Пользователь предоставил ключ в проектном .env под OPEN_ROUTER_KEY, реальный GET key/models прошёл. Ключ не коммитится. Gemini2.5FlashLite прошёл начальную проверку на WAV/FLAC человеческой речи; NVIDIA Nano Omni пока не прошёл. Подробности и ограничения в INTEGRATION-FINDINGS.md.
