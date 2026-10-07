# Photo Sorter 2.3 — Docker + Nginx Proxy Manager

Целевая схема для `https://photo-sorter.knzteam.ru`:

```text
Internet
   │
   ▼
Nginx Proxy Manager (80/443 + Let's Encrypt)
   │ Docker network
   ▼
photo-sorter:3000
   │
   ├── /storage/photo-sorter   — постоянные фотографии
   ├── /data                   — SQLite и runtime-конфигурация
   └── /cache                  — WebP thumbnails
```

Контейнер Photo Sorter **не публикует порт на хост**. Nginx Proxy Manager обращается к нему по общей Docker-сети.

## 1. DNS

Создайте DNS-запись:

```text
photo-sorter.knzteam.ru → IP вашего VDS
```

## 2. Клонирование

```bash
git clone <URL_ВАШЕГО_REPOSITORY>
cd <ПАПКА_REPOSITORY>
```

## 3. Узнать Docker-сеть Nginx Proxy Manager

```bash
docker network ls
```

Обычно она выглядит примерно так:

```text
nginx-proxy-manager_default
npm_default
```

Нужна сеть, к которой уже подключён контейнер Nginx Proxy Manager.

## 4. Создать `.env`

```bash
cp .env.example .env
nano .env
```

Обязательно поменяйте:

```dotenv
PHOTO_SORTER_PASSWORD=12345  # замените на свой PIN из 5 цифр
PHOTO_SORTER_UPLOAD_PASSWORD=ДРУГОЙ_ПАРОЛЬ_ТОЛЬКО_ДЛЯ_ЗАГРУЗКИ
PHOTO_SORTER_SESSION_SECRET=СЛУЧАЙНАЯ_СТРОКА_МИНИМУМ_32_СИМВОЛА
NPM_NETWORK=ИМЯ_СЕТИ_NPM
```

Секрет для сессий удобно получить так:

```bash
openssl rand -hex 32
```

`.env` находится в `.gitignore` и не должен попадать в GitHub.

## 5. Создать постоянные каталоги

```bash
mkdir -p storage runtime/data runtime/cache
```

На обычном Ubuntu-пользователе с UID 1000 дополнительных прав обычно не требуется. Если контейнер сообщает `EACCES`:

```bash
sudo chown -R 1000:1000 storage runtime
```

Фотографии остаются в `./storage`, SQLite — в `./runtime/data`, thumbnails — в `./runtime/cache`. Пересборка или удаление контейнера их не удаляет.

## 6. Запустить

```bash
docker compose up -d --build
```

Проверить:

```bash
docker compose ps
docker compose logs -f photo-sorter
```

В `docker compose ps` сервис должен перейти в состояние `healthy`.

## 7. Nginx Proxy Manager

Создайте **Proxy Host**:

```text
Domain Names:       photo-sorter.knzteam.ru
Scheme:             http
Forward Hostname:   photo-sorter
Forward Port:       3000
```

Включите:

- Block Common Exploits;
- Websockets Support можно оставить включённым, хотя текущая версия использует HTTP polling;
- SSL Certificate → Request a new SSL Certificate;
- Force SSL;
- HTTP/2 Support.

### Advanced

Добавьте:

```nginx
client_max_body_size 16m;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Photo Sorter отправляет фотографии chunk'ами максимум по 8 MiB, поэтому лимит 16 MiB достаточен. Весь массив 1.19 ГБ никогда не идёт одним HTTP-запросом.

## 8. Первый вход

Откройте:

```text
https://photo-sorter.knzteam.ru
```

Введите своё имя и общий 5-значный PIN из:

```text
PHOTO_SORTER_PASSWORD
```

Несколько сотрудников используют один общий 5-значный PIN, но каждый указывает своё имя. Каждый браузер получает отдельный `session_id`, поэтому присутствие, Undo и контроль конфликтов остаются независимыми, а в верхней панели отображаются имена участников.

## 9. Загрузка фотографий через интерфейс

Нажмите:

```text
↑ Загрузить фото
```

Введите отдельный:

```text
PHOTO_SORTER_UPLOAD_PASSWORD
```

и выберите **корневую папку проекта**, внутри которой находятся папки залов.

Поддерживается структура:

```text
Проект/
├── Арма/
│   ├── raw/
│   ├── Люди/
│   └── Оборудование/
├── Гагарин/
└── ...
```

Также поддерживается старый входной формат:

```text
Проект/Арма/photo_123.jpg
```

При загрузке такой файл автоматически записывается как:

```text
Арма/raw/photo_123.jpg
```

Загрузка resumable: сервер хранит `.upload-part`, сообщает уже принятый offset и продолжает с него. После завершения всех файлов автоматически выполняется `БД ↔ файловая система` sync.

Если файл с тем же именем уже существует и имеет другой размер, Photo Sorter останавливает загрузку этого файла с конфликтом вместо перезаписи.

## 10. Обновление приложения вручную

Автодеплой не требуется. Для новой версии:

```bash
cd <ПАПКА_REPOSITORY>
git pull
docker compose up -d --build
```

`storage/` и `runtime/` остаются на месте.

## 11. Резервная копия

Минимально нужно резервировать:

```text
storage/
runtime/data/
```

`runtime/cache/` можно не резервировать — thumbnails создаются заново.

## 12. Что не хранится в GitHub

Не коммитить:

```text
.env
storage/
runtime/
data/photo-sorter.sqlite*
```

GitHub хранит только код приложения и документацию. Рабочие фотографии находятся на диске VDS.
