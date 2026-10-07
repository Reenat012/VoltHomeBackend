# Запуск backend ВольтХом на Timeweb Cloud

Схема: **облачный сервер** (Ubuntu 24.04, Москва) принимает запросы, перед приложением стоит **Caddy** (сам получает HTTPS-сертификат Let's Encrypt), приложение работает под **pm2**. Данные лежат в **управляемой PostgreSQL 16** Timeweb. Код выкладывает GitHub Actions: сначала тесты на временной PostgreSQL, потом выкладка по SSH с автоматическими миграциями и откатом, если сервер не поднялся.

Секреты (пароль базы, `JWT_*`, секрет Яндекса, ключ для выкладки) вы вводите сами на сервере и в GitHub. В чат и в репозиторий их не присылайте.

## 0. Что должно быть готово

- [ ] Сервер создан (в панели: Облачные серверы), известен его публичный IP.
- [ ] База PostgreSQL 16 создана (в панели: Базы данных), известны хост, порт, имя базы, пользователь; пароль сохранён у вас в менеджере паролей.
- [ ] Домен `volthome.ru` на DNS Timeweb (уже так).

## 1. База данных: проверка и доступ

1. В настройках базы найдите список разрешённых адресов (доступ по IP). Оставьте **только ваш IP** и, когда появится, IP сервера. Не «разрешить всем».
2. Проверьте подключение со своего компьютера (пароль спросит сам `psql`, он не попадёт в историю команд):

   ```bash
   psql "host=ХОСТ port=ПОРТ dbname=ИМЯ_БАЗЫ user=ПОЛЬЗОВАТЕЛЬ sslmode=require" \
     -c "select version();" \
     -c "select name from pg_available_extensions where name in ('uuid-ossp','pgcrypto');" \
     -c "select rolsuper, rolcreatedb from pg_roles where rolname = current_user;"
   ```

   Ожидаем: версия 16, в списке оба расширения `uuid-ossp` и `pgcrypto` (они нужны миграциям). Результат без пароля можно показать мне.
3. Если расширений нет или миграции упадут на `CREATE EXTENSION`, напишите в поддержку Timeweb с просьбой включить их, или дайте пользователю нужные права.

## 2. Сервер: первичная настройка (один раз)

С вашего компьютера, из папки backend:

```bash
scp scripts/server-setup.sh root@IP_СЕРВЕРА:/root/
ssh root@IP_СЕРВЕРА 'bash /root/server-setup.sh api.volthome.ru'
```

Скрипт идемпотентный (можно запускать повторно). Он обновляет систему, ставит Node.js 20 (NodeSource), pm2, Caddy (официальный репозиторий), fail2ban, включает брандмауэр (открыты только 22, 80 и 443), создаёт пользователя `deploy` и каталог `/var/www/VoltHomeBackend` и кладёт туда заготовку `.env`.

Внешние источники, откуда скрипт скачивает пакеты: репозитории Ubuntu, `deb.nodesource.com`, `dl.cloudsmith.io` (Caddy), `registry.npmjs.org`.

## 3. Заполнить настройки сервера

```bash
ssh deploy@IP_СЕРВЕРА
nano /var/www/VoltHomeBackend/.env
```

Замените все `__ЗАПОЛНИТЬ__`:

| Переменная | Что вписать |
| --- | --- |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | данные со страницы базы. Если сервер и база в одной приватной сети, лучше внутренний адрес |
| `PGSSLMODE` | `require` (уже стоит) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | **два разных** случайных значения: `openssl rand -base64 48` (запустите дважды на своём компьютере) |
| `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET` | со страницы приложения Яндекса (см. раздел 6); секрет только здесь |
| `YANDEX_ALLOWED_REDIRECT_URIS` | `https://volthome.ru/auth/callback.html` |
| `CORS_ORIGINS` | `https://volthome.ru` (адреса сайтов через запятую) |

Остальное оставьте: `HOST=127.0.0.1` (приложение слушает только сервер, снаружи доступен лишь Caddy), `PG_POOL_MAX=5` (экономит память маленькой базы). Файл доступен только пользователю `deploy` (права 600).

## 4. DNS и HTTPS

1. В панели Timeweb: Домены и SSL → `volthome.ru` → добавьте запись **A**: имя `api`, значение IP сервера.
2. Подождите несколько минут. Проверка: `dig +short api.volthome.ru` (должен вернуть IP сервера).
3. Сертификат Caddy получит сам при первом обращении (порты 80 и 443 открыты). Если нет, смотрите `journalctl -u caddy -n 50` на сервере.

## 5. Выкладка через GitHub Actions

1. Создайте на своём компьютере отдельный ключ **только для выкладки** (без пароля):

   ```bash
   ssh-keygen -t ed25519 -N "" -C "volthome-deploy" -f ~/.ssh/volthome_deploy
   ssh-copy-id -i ~/.ssh/volthome_deploy.pub deploy@IP_СЕРВЕРА
   ```
2. В GitHub репозитория VoltHomeBackend: Settings → Secrets and variables → Actions → New repository secret:
   - `SERVER_HOST` = IP сервера
   - `SERVER_USER` = `deploy`
   - `SERVER_PATH` = `/var/www/VoltHomeBackend`
   - `SSH_PRIVATE_KEY` = содержимое файла `~/.ssh/volthome_deploy` (команда `pbcopy < ~/.ssh/volthome_deploy` положит его в буфер обмена)
3. Откройте Pull Request из ветки `feature/shared-backend` в `main`. GitHub запустит тесты на временной PostgreSQL. Когда они зелёные, смело сливайте (Merge): после слияния автоматически начнётся выкладка.
4. Ход выкладки: вкладка Actions в GitHub. Порядок такой: тесты, архив, загрузка на сервер, `npm ci`, **миграции**, переключение, перезапуск, проверка `/health` (если не поднялось, возврат на прошлый релиз).

## 6. Яндекс (вход на сайте)

1. https://oauth.yandex.ru/client/new → название «ВольтХом», платформа «Веб-сервисы».
2. Callback URI: `https://volthome.ru/auth/callback.html`.
3. Доступ к данным: логин/имя (`login:info`) и адрес электронной почты (`login:email`). Аватар не нужен. Названия пунктов в интерфейсе Яндекса могут отличаться.
4. Скопируйте ID и пароль (секрет) приложения: ID пойдёт в настройки сайта и сервера, секрет только в `.env` на сервере (раздел 3). После изменения `.env` перезапустите: `pm2 reload volthome-api --update-env`.

## 7. Проверка после запуска

С вашего компьютера, из папки backend:

```bash
sh scripts/smoke.sh https://api.volthome.ru https://volthome.ru
```

Скрипт ничего не меняет и секретов не требует. Все пункты должны быть с галочками. Если что-то не прошло, он напишет что именно.

Дополнительно на сервере: `pm2 ls` (процесс `volthome-api` online) и `pm2 logs volthome-api --lines 50`.

## 8. Подключение сайта

Когда сервер отвечает, а в документах сайта проставлена дата (docs/LEGAL_NOTES.md сайта), в настройках приложения сайта в Timeweb App Platform задаются переменные:

- `VITE_API_BASE_URL` = `https://api.volthome.ru`
- `VITE_YANDEX_CLIENT_ID` = ID приложения Яндекса

После этого сайт пересобирается автоматически и вход включается.

## Откат и обслуживание

- **Откат на прошлый релиз** (на сервере под `deploy`): `ls /var/www/VoltHomeBackend/releases`, затем `ln -sfn /var/www/VoltHomeBackend/releases/ВРЕМЯ /var/www/VoltHomeBackend/current && pm2 reload volthome-api --update-env`.
- **Откат миграции:** `cd /var/www/VoltHomeBackend/current && npm run migrate:down` (по одной, откатывает последнюю).
- **Выдать PRO вручную:** `cd /var/www/VoltHomeBackend/current && npm run admin:find-user -- --email ...`, затем `admin:grant-pro` (см. README).
- **Резервные копии базы** включены в панели Timeweb (раз в день): один раз проверьте, как их восстановить.
- Рекомендую внешний мониторинг доступности `https://api.volthome.ru/health` (любой сервис проверки сайтов) и оповещение вам на почту.

## Расходы (на момент настройки, октябрь 2026)

Сервер около 1 000 ₽/мес (конфигурация 800 + публичный IP 200), база около 744 ₽/мес (496 + IPv4 200 + копии 48). Итого около 1 750 ₽/мес. Если IPv4 у базы не нужен (доступ только по частной сети), минус 200 ₽.
