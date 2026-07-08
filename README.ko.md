# 💬 SlackLite

오픈소스 셀프 호스팅 Slack 스타일 팀 메신저. Node.js 프로세스 하나, SQLite 파일 하나, 빌드 단계 없음.

**[English README](README.md)**

## 왜 SlackLite인가?

- **셀프 호스팅이 쉽다** — `docker compose up -d` 한 줄이면 끝. 외부 DB·Redis·S3 불필요.
- **네이티브 의존성 0개** — 내장 `node:sqlite` + 순수 JS bcrypt. `npm install`에 컴파일러 필요 없음.
- **프론트엔드 빌드 없음** — 바닐라 JS SPA 정적 서빙. 클론, 설치, 실행.
- **데이터는 내 것** — 모든 데이터가 SQLite 파일 하나에. `cp` 한 번이면 백업 완료.

## 기능

- 공개 채널 (생성/참여, 기본 `#general` `#random`, 채널 주제)
- 1:1 다이렉트 메시지
- 실시간 메시징 (Socket.IO WebSocket)
- 스레드 답글 + 답글 수 표시
- 이모지 리액션
- 본인 메시지 수정/삭제
- 채널·DM별 미읽음 배지
- 입력 중 표시, 온라인 프레즌스
- 메시지 전문 검색
- 초대 코드 가입 제한 (선택)
- macOS 데스크톱 앱 (Electron) — 독 배지·네이티브 알림

## 빠른 시작 (Docker, 권장)

```bash
git clone https://github.com/Rillmo/slacklite.git && cd slacklite
docker compose up -d
# http://localhost:3000 접속
```

클론 없이 미리 빌드된 이미지 사용:

```bash
docker run -d --name slacklite -p 3000:3000 -v slacklite-data:/data \
  ghcr.io/rillmo/slacklite:latest
```

데이터(SQLite DB + JWT 시크릿)는 `slacklite-data` 볼륨에 영속 저장됩니다.

가입을 제한하려면 `docker-compose.yml`에 초대 코드 설정:

```yaml
environment:
  INVITE_CODE: "our-team-invite"
```

## 빠른 시작 (Node.js 직접 실행)

**Node.js 23.4 이상** 필요 (Node 24 LTS 권장).

```bash
npm install
npm start          # http://localhost:3000
```

## 인터넷에 공개하기

HTTPS 리버스 프록시 뒤에서 운영하고 `TRUST_PROXY=1`을 설정하세요.

**Caddy** (자동 HTTPS):

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
server {
    server_name chat.example.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

공개 인스턴스 체크리스트: HTTPS ✅ · `INVITE_CODE` 설정 ✅ · `TRUST_PROXY=1` ✅ · `/data` 백업 ✅. 자세한 내용은 [SECURITY.md](SECURITY.md).

## 환경 변수

전부 선택 사항 — [.env.example](.env.example) 참고.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `DB_PATH` | `./data.db` | SQLite 데이터베이스 파일 |
| `SECRET_PATH` | `./.jwt-secret` | JWT 시크릿 파일 (자동 생성) |
| `JWT_SECRET` | — | JWT 시크릿 직접 지정 (`SECRET_PATH` 무시) |
| `INVITE_CODE` | — | 가입 시 초대 코드 요구 |
| `TRUST_PROXY` | — | 리버스 프록시 뒤에서 `1`로 설정 |

## macOS 데스크톱 앱

```bash
npm run app     # 개발 모드
npm run dist    # release/SlackLite-<버전>-arm64.dmg 빌드
```

앱이 서버를 내장하여 함께 실행되고(별도 서버 불필요), 미읽음 수를 독 배지로 표시하며, 네이티브 알림을 전달합니다. 포트 3000에 SlackLite 서버가 이미 있으면 새로 띄우지 않고 기존 서버에 접속합니다. 앱 데이터는 `~/Library/Application Support/SlackLite/`에 저장됩니다.

> 코드 서명 없는 빌드입니다 — 본인 Mac 사용은 문제없으나, 타인 배포 시 Apple Developer 인증서로 서명·공증이 필요합니다.

## 개발

```bash
npm run dev     # 자동 재시작 서버
npm test        # node:test 스위트 (REST + WebSocket, 임시 DB 격리)
```

```
server/
  index.js     # CLI 진입점, graceful shutdown
  app.js       # Express + Socket.IO 부트스트랩, 헬스체크
  db.js        # SQLite 스키마·쿼리 (node:sqlite)
  auth.js      # JWT 발급/검증, HTTP·소켓 미들웨어
  routes.js    # REST API (/api/*)
  sockets.js   # 실시간 이벤트 (메시지, 리액션, 타이핑, 프레즌스)
  ratelimit.js # 인증 엔드포인트용 IP별 인메모리 rate limiter
public/        # 바닐라 JS SPA (빌드 없음)
desktop/       # Electron 메인 프로세스 + 프리로드 (macOS 앱)
test/          # node:test API·소켓 테스트
```

### API 요약

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/healthz` | 헬스체크 |
| GET | `/api/meta` | 인스턴스 정보 (초대 코드 필요 여부) |
| POST | `/api/register` | 회원가입 (rate limit, 기본 채널 자동 참여) |
| POST | `/api/login` | 로그인 → JWT |
| GET | `/api/channels` | 채널·DM 목록 + 미읽음 수 |
| POST | `/api/channels` | 채널 생성 |
| GET | `/api/channels/:id/messages` | 채널 메시지 (공개 채널 자동 참여) |
| POST | `/api/dm/:userId` | DM 채널 생성/조회 |
| GET | `/api/messages/:id/thread` | 스레드 답글 |
| GET | `/api/search?q=` | 메시지 검색 |

소켓 이벤트: 클라이언트 `message:send/edit/delete`, `reaction:toggle`, `typing`, `channel:read` → 서버 `message:new/update/delete`, `presence`, `typing`, `channel:new`, `dm:new` 브로드캐스트.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md) 참고. 보안 제보: [SECURITY.md](SECURITY.md).

## 라이선스

[MIT](LICENSE)
