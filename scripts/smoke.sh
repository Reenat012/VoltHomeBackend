#!/usr/bin/env sh
# Проверка работающего сервера. Ничего не меняет и не требует секретов.
# Использование: sh scripts/smoke.sh https://api.volthome.ru [https://volthome.ru]
#   первый аргумент: адрес сервера, второй: адрес сайта (для проверки CORS), по умолчанию https://volthome.ru
set -u

BASE="${1:-}"
ORIGIN="${2:-https://volthome.ru}"
if [ -z "$BASE" ]; then
  echo "Использование: sh scripts/smoke.sh https://api.volthome.ru [https://volthome.ru]" >&2
  exit 2
fi
BASE="${BASE%/}"
EVIL="https://evil.example"
fails=0

ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails + 1)); }

# check ИМЯ ОЖИДАЕМЫЙ_КОД ФРАГМЕНТ_ТЕЛА -- curl-аргументы...
check() {
  name="$1"; want="$2"; frag="$3"; shift 4
  tmp="$(mktemp)"
  code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 20 "$@" 2>/dev/null)"
  if [ "$code" != "$want" ]; then
    bad "$name: ждали $want, получили $code"
  elif [ -n "$frag" ] && ! grep -q "$frag" "$tmp"; then
    bad "$name: в ответе нет «$frag»"
  else
    ok "$name"
  fi
  rm -f "$tmp"
}

hdr() { curl -s -D - -o /dev/null --max-time 20 "$@" 2>/dev/null | tr -d '\r'; }

echo "Сервер: $BASE   Сайт (CORS): $ORIGIN"
echo "Работа сервера и базы"
check "GET /health" 200 '"ok":true' -- "$BASE/health"
check "GET /health/db (база данных отвечает)" 200 '"db":"ok"' -- "$BASE/health/db"

echo "Защита доступа"
check "без токена /v1/projects: 401 no_token" 401 'no_token' -- "$BASE/v1/projects"
check "неверный токен: 401 invalid_token" 401 'invalid_token' -- -H 'Authorization: Bearer not-a-jwt' "$BASE/v1/profile/me"
check "старая ручка /v1/auth/login удалена: 404" 404 '' -- -X POST -H 'Content-Type: application/json' -d '{"userId":"x"}' "$BASE/v1/auth/login"
check "вход только с uid отклоняется: 400" 400 'invalid_request' -- -X POST -H 'Content-Type: application/json' -d '{"uid":"victim"}' "$BASE/v1/auth/yandex/exchange"
check "подтверждение покупки без токена: 401" 401 '' -- -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/v1/billing/rustore/confirm"
check "удаление аккаунта без токена: 401" 401 '' -- -X POST -H 'Content-Type: application/json' -d '{"confirm":true}' "$BASE/v1/profile/delete"

echo "CORS (запросы с сайта)"
pre="$(hdr -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type,x-volthome-client' "$BASE/v1/projects")"
echo "$pre" | head -1 | grep -q ' 204' && ok "preflight с сайта: 204" || bad "preflight с сайта: не 204"
echo "$pre" | grep -qi "^access-control-allow-origin: $ORIGIN" && ok "разрешён именно $ORIGIN" || bad "нет access-control-allow-origin для $ORIGIN"
echo "$pre" | grep -qi '^access-control-allow-headers:.*x-volthome-client' && ok "разрешён заголовок X-VoltHome-Client" || bad "заголовок X-VoltHome-Client не разрешён"
evil="$(hdr -X OPTIONS -H "Origin: $EVIL" -H 'Access-Control-Request-Method: POST' "$BASE/v1/projects")"
echo "$evil" | head -1 | grep -q ' 403' && ok "чужой источник отклонён: 403" || bad "чужой источник не отклонён"
echo "$evil" | grep -qi '^access-control-allow-origin:' && bad "чужому источнику выдан access-control-allow-origin" || ok "чужому источнику разрешение не выдано"

echo "Заголовки"
h="$(hdr "$BASE/health")"
echo "$h" | grep -qi '^x-powered-by:' && bad "виден X-Powered-By" || ok "X-Powered-By скрыт"
echo "$h" | grep -qi '^x-content-type-options: nosniff' && ok "X-Content-Type-Options: nosniff" || bad "нет X-Content-Type-Options"
case "$BASE" in
  https://*)
    echo "$h" | grep -qi '^strict-transport-security:' && ok "есть HSTS" || bad "нет HSTS"
    plain="http://${BASE#https://}"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$plain/health" 2>/dev/null)"
    case "$code" in 301|302|307|308) ok "http перенаправляет на https ($code)";; *) bad "http не перенаправляет на https (код $code)";; esac
    ;;
  *) echo "  - HTTPS-проверки пропущены (адрес не https)";;
esac

echo
if [ "$fails" -eq 0 ]; then echo "Всё в порядке."; exit 0; fi
echo "Не прошло проверок: $fails"; exit 1
