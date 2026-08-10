# 막차는 없다 (No Last Train)

친구들과 하나의 지하철 도시를 나눠 운영하는 비동기 협동 방치형 게임이다.

## 구조

```text
client/   # Vite + React 프론트엔드
server/   # Next.js API 서버 + 실시간 WebSocket 스크립트
deploy/   # nginx 설정 · 배포 스크립트 (publish.sh)
```

실행 시 보통 아래가 함께 돌아간다.

| 구성 | 역할 |
|------|------|
| **PostgreSQL** | 도시·플레이어·틱·경제 등 정본 저장소 |
| **Redis** (선택) | 실시간 차량 모션 베이스 캐시 + pub/sub. 없으면 API/실시간 서버가 PostgreSQL로 폴백 |
| **API 서버** (`nlt-server`) | `/api/*` HTTP API (Next.js) |
| **실시간 서버** (`nlt-realtime`) | `/ws` WebSocket — 차량 좌표·도시 스냅샷 push (`server/scripts/realtime-server.ts`) |
| **프론트** | Vite(dev) 또는 nginx 정적 파일(prod) |

Redis는 PostgreSQL을 대체하지 않는다. 연결이 없거나 끊겨도 동작은 유지되고, 모션만 DB 조회로 내려간다.

## 로컬 실행

### 1. 의존성

```bash
npm install
```

### 2. PostgreSQL

```bash
docker run -d \
  --name nlt-postgres \
  -e POSTGRES_USER=nlt \
  -e POSTGRES_PASSWORD=nlt \
  -e POSTGRES_DB=no_last_train \
  -p 5432:5432 \
  postgres:16
```

이미 컨테이너가 있으면 `docker start nlt-postgres` 만 하면 된다.

### 3. Redis (권장)

실시간 모션 캐시·프로세스 간 pub/sub용이다. 없어도 서버는 뜨지만, 있으면 좌표 push가 가볍다.

```bash
docker run -d \
  --name nlt-redis \
  -p 6379:6379 \
  redis:7
```

이미 있으면 `docker start nlt-redis`.

### 4. 환경 변수

```bash
cp server/.env.example server/.env
```

로컬 최소 예시:

```env
PORT="3001"
DATABASE_URL="postgresql://nlt:nlt@127.0.0.1:5432/no_last_train"
REDIS_URL="redis://127.0.0.1:6379"
# 실시간 WS 포트 (기본 3012). nginx/Vite에서 /ws 로 붙일 때 맞춤
# REALTIME_PORT="3012"
```

선택 항목(AI 명령·메일 등)은 `server/.env.example` 주석을 보면 된다.

프론트 프록시 대상은 `client/.env.example` → `client/.env` (`API_PROXY_TARGET`, 기본 `http://localhost:3001`).

### 5. 프로세스 실행

터미널을 나눠 띄운다. `dev:server` 실행 시 스키마 반영·시드가 자동으로 돌아간다.

```bash
# API (http://localhost:3001)
npm run dev:server

# 실시간 WebSocket (ws://localhost:3012) — 게임 화면 차량 모션에 필요
cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts

# 프론트 (http://localhost:5173)
npm run dev:client
```

로컬 Vite는 `/api` → API(기본 3001), `/ws` → 실시간 서버(기본 3012)로 프록시한다. 포트를 바꿨다면 `client/.env`의 `API_PROXY_TARGET` / `REALTIME_PROXY_TARGET`을 맞춘다.

효과음은 재배포가 제한된 라이선스라 저장소에 두지 않고, 프론트 개발·빌드 시작 시 `scripts/fetch-audio-assets.mjs`가 원본에서 내려받는다(체크섬 검증 포함). 처음 한 번은 네트워크가 필요하고, 이후에는 받아둔 파일을 쓴다.

로컬 디버깅 로그가 필요하면 기존 개발 서버를 끈 뒤:

```bash
npm run dev:logs
```

세션 로그는 `.logs/<시작 시각>/` (`backend.log`, `frontend.log`, `combined.log`, `browser.ndjson`). `.logs/latest.txt`에 최근 세션 이름이 있다. 브라우저 로그 API는 개발 환경에서만 켜지며, 비밀번호·토큰·이메일은 저장 전 마스킹된다. (`dev:logs`는 API·프론트만 띄우므로, 실시간 모션까지 보려면 위 realtime 프로세스를 따로 실행한다.)

## 프로덕션에 가깝게 돌릴 때

이 저장소의 배포 스크립트(`deploy/publish.sh`) 기준이다.

1. PostgreSQL · Redis 기동 (`DATABASE_URL`, `REDIS_URL`을 `server/.env`에 설정)
2. 프론트 빌드 후 nginx 문서 루트로 동기화
3. API: `npm run build:next -w no-last-train-server` 후 PM2 `nlt-server`
4. 실시간: PM2 `nlt-realtime` → `server` cwd에서  
   `node --env-file-if-exists=.env --import tsx scripts/realtime-server.ts`  
   (기본 `REALTIME_PORT=3012`)
5. nginx가 `/api/` → API, `/ws` → realtime 으로 프록시 (`deploy/nginx-nlt-app.inc`)

한 번에 빌드·동기화·재시작:

```bash
./deploy/publish.sh
```

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev:client` | 프론트 개발 서버 |
| `npm run dev:server` | API 개발 서버 (스키마·시드 포함) |
| `npm run dev:logs` | 프론트·API 실행 및 로컬 로그 수집 |
| `npm run build:client` | 프론트 프로덕션 빌드 |
| `npm run start:client` | 프론트 프로덕션 실행 |
| `npm run build:server` | 백엔드 프로덕션 빌드 (Cloudflare 경로) |
| `npm run start:server` | API 프로덕션 실행 |
| `cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts` | 실시간 WebSocket 서버 |

## 화면

- **타이틀** - 시작 / 설정
- **로비** - 관제실 선택
