# VoltHome Backend (Node.js)

Минимальный API для мобильного приложения:
- `/health` — проверка
- `/auth/yandex/exchange` — мок обмена на серверную сессию (вернет sessionJwt)
- `/auth/session/refresh` — мок-рефреш
- `/auth/session/logout` — инвалидирует мок refresh
- `/profile/me` — защищенный профиль (Bearer sessionJwt)

## Запуск локально
```bash
cd server
cp ../.env.example ../.env
npm install
npm start
# сервер на http://localhost:3000