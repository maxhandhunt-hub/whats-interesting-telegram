# Этап 2: реальные новости уже подключены

Рабочие новости готовит локальный Windows worker через официальное разрешение использования подписки ChatGPT. Платный API-ключ не используется. Полная актуальная инструкция, ограничения и проверки: [docs/PHASE2.md](docs/PHASE2.md).

Ниже сохранено описание первого этапа для истории; демонстрационные ответы больше не используются рабочим серверным обработчиком новостей.

# Что интересного?

Telegram Mini App с ответами на самом сайте. React + TypeScript + Vite, GitHub Pages, Supabase PostgreSQL и Edge Function. Локальный Python-бот из родительской папки не включён в этот публичный репозиторий.

Четыре раздела: реальная погода в Балабаново через Open-Meteo, политика, нейросети и интересное. Новости явно помечены «Демонстрационный режим»: реального новостного поиска/ИИ в этой версии нет. По нажатию раздела показываются обработка, результат, московские дата/время, раскрываемые подробности и источники. Есть обновление, возврат, свободный запрос до 1000 символов и история последних 50 запросов. Результаты в Telegram-чат не отправляются.

## Запуск пользователем

Откройте Mini App через Menu Button или inline web_app кнопку существующего Telegram-бота. Запуск через старую ReplyKeyboard web_app кнопку может не передавать initData и тогда доступен только ограниченный режим просмотра. Вне Telegram защищённые запросы и история не выполняются. Личные данные не сохраняются в localStorage.

## Supabase

Проект: `whats-interesting`, ref `igwvbcmpkipcoowzsaiu`. Endpoint: `https://igwvbcmpkipcoowzsaiu.supabase.co/functions/v1/telegram-app`. Публичный endpoint не содержит ключа и не даёт доступ без Telegram-подписи.

Edge Function `telegram-app` принимает POST JSON с `action` и исходной `initData`:

- `auth`: проверка подписи и разрешённого ID;
- `create`: category, prompt, requestId (UUID v4);
- `status`: jobId;
- `history`: последние 50 заданий с сохранёнными ответами.

В `supabase/config.toml` `verify_jwt=false`: Telegram initData не является Supabase JWT. Это не публичный обход входа: обработчик самостоятельно проверяет HMAC-SHA-256 по алгоритму Telegram, auth_date (1 час, допуск 30 секунд), уникальность параметров и разрешённый ID на каждом вызове. `initDataUnsafe` не используется.

`jobs`, `results`, `request_limits`: RLS включён, публичных разрешающих политик нет. `anon`/`authenticated` не имеют привилегий на таблицы и RPC. Доступ через серверный ключ, который Supabase предоставляет только среде Edge Function. Все выборки дополнительно ограничены проверенным владельцем. Создание/завершение задания транзакционны, повтор с тем же UUID не создаёт новую запись. Ограничения: 6 новых заданий/мин, 100/24 часа, 120 защищённых обращений/мин, тело до 16 КиБ. Задания старше 5 минут без результата завершаются ошибкой при следующем обращении. Клиент не ожидает бесконечно.

### Секреты — только сервер

В Supabase Dashboard → ваш проект → **Edge Functions → Secrets** добавьте:

- `TELEGRAM_BOT_TOKEN`: токен существующего бота от BotFather;
- `ALLOWED_TELEGRAM_USER_ID`: цифровой ID владельца.

Нажмите **Save**. Не помещайте значения в GitHub, `.env.example`, `VITE_` переменные или браузерный JavaScript. При отсутствии секретов backend блокирует доступ с понятной ошибкой. Секреты никогда не возвращаются в ответе и не записываются кодом в журналы. Доступ к настройкам проекта позволяет менять/читать поведение функции, поэтому членство Supabase должно оставаться ограниченным.

## Сборка и обновление для разработчика

Node 24. Зависимости и lockfile зафиксированы. Команды выполняет Codex: `npm ci --ignore-scripts`, `npm test`, `npm run build`. `VITE_BACKEND_URL` — только публичный URL функции. Base Vite `/whats-interesting-telegram/`.

`.github/workflows/pages.yml` проверяет тесты и сборку, затем публикует dist через официальный Pages artifact/deploy workflow. GitHub Settings → Pages → Source: GitHub Actions. Изменения frontend: commit + push в main, дождаться успешного workflow и проверить опубликованную страницу. В GitHub не нужны серверные секреты.

Изменения backend: новая миграция через Supabase CLI, проверка SQL и RLS, применение через подключённый Supabase, развёртывание файлов функции и shared-зависимостей. Изменения функции не разворачиваются Pages workflow автоматически. Локальные файлы миграций должны иметь те же версии, что возвращает история Supabase.

## Подключение через BotFather

После публикации возьмите фактический URL из Pages deployment (в отчёте DEPLOYMENT.md), а не адрес Edge Function. В BotFather: `/setmenubutton` → выберите существующего бота → отправьте URL Mini App → задайте текст «Что интересного?». Для Main Mini App: `/mybots` → бот → Bot Settings → Configure Mini App и укажите тот же URL. Если названия пунктов клиента отличаются, используйте команды BotFather и его подсказки.

## Документация и ограничения

Исходные инструкции: [Telegram Mini Apps](https://core.telegram.org/bots/webapps), [Bot API](https://core.telegram.org/bots/api), [Vite Pages deployment](https://vite.dev/guide/static-deploy.html#github-pages), [GitHub Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [Supabase auth](https://supabase.com/docs/guides/functions/auth), [Secrets](https://supabase.com/docs/guides/functions/secrets).

Дизайн/безопасность — docs/DESIGN.md; будущий исходящий Windows worker — docs/WINDOWS-WORKER.md; фактические проверки — docs/DEPLOYMENT.md. Бесплатный Supabase имеет квоты и может приостанавливать неактивный проект. Ни платные планы, ни платные ИИ API не подключены. Прогноз Open-Meteo — расчётные модельные данные, не измерение ближайшей станции. WebView может ограничить autoplay; тогда остаются обложки. Срок входа — час, после чего нужно заново открыть Mini App.
