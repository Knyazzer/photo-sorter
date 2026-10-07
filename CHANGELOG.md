# 2.3.2

- Исправлены все browser fetch-ошибки `String contains non ISO-8859-1 code point`: кириллица больше не передаётся в custom HTTP headers без кодирования.
- Локальный `start-windows.bat` теперь проверяет, что `sharp` действительно загружается через Node.js; при сломанной/неполной установке выполняется восстановление зависимостей.
- Thumbnail fallback больше не засоряет консоль отдельным предупреждением для каждой фотографии.

# 2.3.1

- Исправлена ошибка браузера `String contains non ISO-8859-1 code point`: кириллические названия залов больше не передаются в HTTP headers в сыром виде.
- Служебные header-values (`x-client-hall`, `x-client-mode`, `x-upload-password`) кодируются на frontend и безопасно декодируются на backend.
- Это исправляет Preview/синхронизацию для залов с кириллическими названиями и позволяет использовать не-ASCII пароль загрузки.

# Changelog

# Photo Sorter 2.3

- Убран логин: для входа нужен только общий пароль.
- Локальная cookie больше не помечается Secure при обычном HTTP localhost.
- В production Secure-cookie сохраняется по умолчанию; значение можно переопределить PHOTO_SORTER_COOKIE_SECURE.
- Отдельный пароль загрузки сохранён.

## 2.2.0 — Docker/VDS + authentication + resumable upload

- добавлен общий login/password для Photo Sorter;
- авторизация переведена с access token в URL на подписанную `HttpOnly` cookie;
- добавлен отдельный `PHOTO_SORTER_UPLOAD_PASSWORD`;
- upload password не сохраняется в браузерном persistent storage;
- добавлена resumable folder upload: chunk upload + offset recovery;
- старый формат `Зал/photo.jpg` при импорте автоматически направляется в `Зал/raw/photo.jpg`;
- добавлена защита от перезаписи уже существующего файла другого размера;
- добавлен Dockerfile и `docker-compose.yml`;
- фотографии, SQLite и thumbnail cache вынесены в отдельные persistent volumes;
- контейнер рассчитан на подключение напрямую к Docker-сети Nginx Proxy Manager без публичного порта;
- добавлен `/health` для Docker healthcheck;
- runtime пути БД и cache теперь задаются environment variables;
- удалён старый access-token механизм;
- подготовлен deployment для `photo-sorter.knzteam.ru`.

## 2.1.0

- удаление ФИО возвращает фотографии в корень `Зал/Люди`, а не в `raw`;
- стабильные preview URL по `photo_id`;
- точечное обновление карточек после сортировки;
- thumbnail-cache;
- отдельные browser sessions;
- version conflict protection;
- live JSON refresh между сессиями.
