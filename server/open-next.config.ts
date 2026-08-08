import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// Next.js를 Cloudflare Workers에서 실행하기 위한 OpenNext 설정.
// 캐시/큐 오버라이드 없이 기본 구성으로 시작한다 — 이 서버는 페이지가 없고
// API 라우트만 있어서 ISR/SSG 캐시 대상이 없다.
export default defineCloudflareConfig()
