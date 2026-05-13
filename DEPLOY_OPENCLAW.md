# Deploy AccAPI di OpenClaw / Docker

AccAPI terdiri dari 2 service:

- `accapi-frontend` — Next.js, port `3000`
- `accapi-backend` — FastAPI Python, port `8000`

Backend menyimpan data runtime di volume persistent. Jangan deploy backend tanpa persistent storage, karena data payments, bukti transfer, audit log, dan output SPPD bisa hilang saat redeploy.

## File deploy

File yang disiapkan:

- `Dockerfile.backend`
- `Dockerfile.frontend`
- `docker-compose.yml`
- `.env.example`
- `.dockerignore`

## Environment wajib

Copy `.env.example` menjadi `.env`, lalu ubah minimal bagian ini:

```bash
cp .env.example .env
```

Wajib diganti:

```env
NEXT_PUBLIC_APP_URL=http://DOMAIN-ATAU-IP:3000
NEXT_PUBLIC_FASTAPI_BASE_URL=http://DOMAIN-ATAU-IP:8000
NEXT_PUBLIC_ACCURATE_REDIRECT_URI=http://DOMAIN-ATAU-IP:3000/api/auth/callback
AUTH_SECRET=isi-random-panjang
AUTH_USERS=admin:password-kuat
BETTER_AUTH_URL=http://DOMAIN-ATAU-IP:3000
BETTER_AUTH_SECRET=isi-random-panjang-lainnya
DATABASE_URL=file:/app/data/sqlite.db
ADMIN_SETUP_TOKEN=isi-random-untuk-bootstrap-admin-pertama
```

Generate `AUTH_SECRET`, `BETTER_AUTH_SECRET`, dan `ADMIN_SETUP_TOKEN`:

```bash
openssl rand -hex 32
openssl rand -hex 24
```

Jika sudah pakai HTTPS, set:

```env
AUTH_COOKIE_SECURE=1
NEXT_PUBLIC_APP_URL=https://domain
NEXT_PUBLIC_FASTAPI_BASE_URL=https://domain-backend-atau-path
NEXT_PUBLIC_ACCURATE_REDIRECT_URI=https://domain/api/auth/callback
```

Jika masih HTTP/IP langsung, biarkan:

```env
AUTH_COOKIE_SECURE=0
```

## Persistent storage backend

`docker-compose.yml` sudah membuat volume:

```text
accapi_backend_data   -> /app/python_backend/data
accapi_backend_output -> /app/python_backend/output
accapi_frontend_data  -> /app/data
```

Path penting backend:

```env
AUTH_USERS_JSON=/app/python_backend/data/users.json
AUDIT_LOG_PATH=/app/python_backend/data/audit_log.jsonl
ERROR_LOG_PATH=/app/python_backend/data/error_log.jsonl
PAYMENTS_DB_PATH=/app/python_backend/data/payments.json
PAYMENTS_FILES_DIR=/app/python_backend/output/payments
PAYMENTS_PROOFS_DIR=/app/python_backend/output/payments/proofs
SPPD_TEMPLATE_PATH=/app/python_backend/SPPD TGL 24 FEBRUARI 2026.docx
```

## Jalankan dengan Docker Compose

```bash
docker compose up -d --build
```

Cek service:

```bash
docker compose ps
docker compose logs -f accapi-backend
docker compose logs -f accapi-frontend
```

Buka:

```text
Frontend: http://DOMAIN-ATAU-IP:3000
Backend docs: http://DOMAIN-ATAU-IP:8000/docs
```

## Bootstrap admin pertama

Public register dinonaktifkan. Setelah deploy pertama, buat admin awal dengan setup token:

```bash
curl -X POST http://DOMAIN-ATAU-IP:3000/api/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -H "x-admin-setup-token: $ADMIN_SETUP_TOKEN" \
  -d '{"name":"Admin","email":"admin@example.com","password":"ganti-password-kuat","role":"admin"}'
```

Endpoint ini hanya bisa dipakai saat tabel `user` masih kosong. Setelah admin pertama dibuat, user berikutnya dikelola dari menu **User & RBAC** di dashboard.

## Deploy via OpenClaw UI

Jika OpenClaw mendukung Docker Compose:

1. Source: GitHub repo ini.
2. Pilih `docker-compose.yml`.
3. Isi environment dari `.env.example`.
4. Pastikan volume persistent aktif:
   - backend: `/app/python_backend/data`
   - backend: `/app/python_backend/output`
   - frontend auth DB: `/app/data`
5. Deploy dua service:
   - `accapi-backend`, port `8000`
   - `accapi-frontend`, port `3000`

Jika OpenClaw deploy per-service:

### Service backend

- Root/source: repo root
- Dockerfile: `Dockerfile.backend`
- Port: `8000`
- Persistent volumes:
  - `/app/python_backend/data`
  - `/app/python_backend/output`
- Env: pakai bagian backend dari `.env.example`

### Service frontend

- Root/source: repo root
- Dockerfile: `Dockerfile.frontend`
- Port: `3000`
- Persistent volume:
  - `/app/data`
- Env/build args:
  - `DATABASE_URL`
  - `BETTER_AUTH_URL`
  - `BETTER_AUTH_SECRET`
  - `NEXT_PUBLIC_APP_URL`
  - `NEXT_PUBLIC_FASTAPI_BASE_URL`
  - `NEXT_PUBLIC_ACCURATE_CLIENT_ID`
  - `NEXT_PUBLIC_ACCURATE_REDIRECT_URI`

## Catatan penting

- Beberapa fitur browser memanggil backend FastAPI dari sisi client, jadi `NEXT_PUBLIC_FASTAPI_BASE_URL` harus berupa URL yang bisa diakses browser pengguna, bukan hostname internal Docker seperti `http://accapi-backend:8000`.
- Untuk production yang rapi, sebaiknya pakai domain + HTTPS + reverse proxy.
- Jangan commit file `.env` karena berisi secret.
