# 막차는 없다 (No Last Train)

친구들과 하나의 지하철 도시를 나눠 운영하는 비동기 협동 방치형 게임이다.

## 구조

```text
client/   # Vite + React 프론트엔드
server/   # API 서버
```

## 실행

1. 루트에서 의존성 설치

```bash
npm install
```

2. Docker Postgres 실행

```bash
docker run -d \
  --name nlt-postgres \
  -e POSTGRES_USER=nlt \
  -e POSTGRES_PASSWORD=nlt \
  -e POSTGRES_DB=no_last_train \
  -p 5432:5432 \
  postgres:16
```

이미 컨테이너를 만든 뒤에는 `docker start nlt-postgres` 만 하면 된다.

3. `server/.env` 생성

```bash
cp server/.env.example server/.env
```

또는 직접 생성:

```env
DATABASE_URL="postgresql://nlt:nlt@127.0.0.1:5432/no_last_train"
```

4. 프론트 / 백엔드 실행

```bash
npm run dev:client
npm run dev:server
```

`npm run dev:server` 실행 시 스키마 반영·시드가 자동으로 돌아간다.  
프론트는 `http://localhost:5173`, 서버는 `http://localhost:3001`.

로컬 디버깅 로그가 필요하면 기존 개발 서버를 종료한 뒤 아래 명령으로 둘을 함께 실행한다.

```bash
npm run dev:logs
```

세션별 로그는 `.logs/<시작 시각>/`에 저장된다. `backend.log`, `frontend.log`, `combined.log`,
브라우저 오류용 `browser.ndjson`을 확인하면 된다. `.logs/latest.txt`에는 가장 최근 세션 이름이 기록된다.
브라우저 로그 수집 API는 개발 환경에서만 활성화되며 브라우저 이벤트와 프로세스 출력의
비밀번호·토큰·이메일은 저장 전에 마스킹된다.

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev:client` | 프론트 개발 서버 |
| `npm run dev:server` | 백엔드 개발 서버 |
| `npm run dev:logs` | 프론트·백엔드 실행 및 로컬 로그 수집 |
| `npm run build:client` | 프론트 프로덕션 빌드 |
| `npm run start:client` | 프론트 프로덕션 실행 |
| `npm run build:server` | 백엔드 프로덕션 빌드 |
| `npm run start:server` | 백엔드 프로덕션 실행 |

## 화면

- **타이틀** - 시작 / 설정
- **로비** - 관제실 선택
