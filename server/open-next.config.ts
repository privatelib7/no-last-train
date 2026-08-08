import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// Next.js를 Cloudflare Workers에서 실행하기 위한 OpenNext 설정.
// 캐시/큐 오버라이드는 두지 않는다 — 이 서버는 페이지가 없고 API 라우트만
// 있어서 ISR/SSG 캐시 대상이 없다.
export default {
  ...defineCloudflareConfig(),

  // opennextjs-cloudflare build는 내부에서 Next 빌드를 돌릴 때 기본적으로
  // `npm run build`를 실행한다(@opennextjs/aws의 buildNextjsApp).
  // 이 저장소의 build 스크립트가 곧 opennextjs-cloudflare build이므로
  // 기본값을 그대로 두면 자기 자신을 재호출해 무한 재귀에 빠진다.
  // 순수 next build를 가리키게 해서 끊는다.
  buildCommand: 'npm run build:next',
}
