// 게임에 포함된 오픈소스와 외부 에셋 고지.
// MIT·Apache-2.0 계열 라이선스는 배포물에 저작권과 라이선스 고지를 남길 것을 요구하므로,
// 설정 → 오픈소스 라이선스 화면에서 이 목록을 그대로 보여준다.
// 의존성을 추가하거나 버전을 올리면 이 파일도 함께 갱신한다.

export interface LicenseNotice {
  /** 표시 이름과 버전 */
  name: string
  /** 이 프로젝트에서 맡은 역할 */
  usage: string
  /** SPDX 식별자 */
  license: string
  links: { label: string; url: string }[]
}

export interface LicenseGroup {
  title: string
  items: LicenseNotice[]
}

export const LICENSE_GROUPS: LicenseGroup[] = [
  {
    title: 'AI',
    items: [
      {
        name: 'OpenAI Node SDK 7.4.0',
        usage: 'AI 도시 운영관의 자연어 명령 해석',
        license: 'Apache-2.0',
        links: [{ label: 'GitHub', url: 'https://github.com/openai/openai-node' }],
      },
      {
        name: 'Anthropic SDK 0.32.1',
        usage: 'AI SDK (의존성으로 포함)',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/anthropics/anthropic-sdk-typescript' }],
      },
      {
        name: 'Zod 3.25.76',
        usage: 'AI 입출력 스키마 검증',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/colinhacks/zod' }],
      },
    ],
  },
  {
    title: '클라이언트',
    items: [
      {
        name: 'React 19.2.8',
        usage: '게임 UI',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/facebook/react' }],
      },
      {
        name: 'Vite 6.4.3',
        usage: '개발 서버와 번들 빌드',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/vitejs/vite' }],
      },
    ],
  },
  {
    title: '서버 · 데이터베이스',
    items: [
      {
        name: 'Next.js 15.5.22',
        usage: 'API 서버',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/vercel/next.js' }],
      },
      {
        name: 'Prisma 6.19.3',
        usage: '게임 상태 저장과 스키마 관리',
        license: 'Apache-2.0',
        links: [{ label: 'GitHub', url: 'https://github.com/prisma/prisma' }],
      },
      {
        name: 'PostgreSQL 16',
        usage: '게임 데이터베이스',
        license: 'PostgreSQL License',
        links: [{ label: '라이선스', url: 'https://www.postgresql.org/about/licence/' }],
      },
      {
        name: 'node-postgres (pg) 8.22.0',
        usage: 'Node.js PostgreSQL 드라이버',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/brianc/node-postgres' }],
      },
      {
        name: 'Nodemailer 9.0.4',
        usage: '비밀번호 재설정 등 이메일 발송',
        license: 'MIT-0',
        links: [{ label: 'GitHub', url: 'https://github.com/nodemailer/nodemailer' }],
      },
    ],
  },
  {
    title: '배포 · 개발 도구',
    items: [
      {
        name: 'OpenNext for Cloudflare 1.20.2',
        usage: 'Next.js 서버의 Cloudflare Workers 배포',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/opennextjs/opennextjs-cloudflare' }],
      },
      {
        name: 'Wrangler 4.120.0',
        usage: 'Cloudflare 배포 CLI',
        license: 'MIT / Apache-2.0',
        links: [{ label: 'GitHub', url: 'https://github.com/cloudflare/workers-sdk' }],
      },
      {
        name: 'TypeScript 5.9.3 / 6.0.3',
        usage: '타입 검사와 빌드',
        license: 'Apache-2.0',
        links: [{ label: 'GitHub', url: 'https://github.com/microsoft/TypeScript' }],
      },
      {
        name: 'tsx 4.23.8',
        usage: '서버 스크립트와 테스트 실행',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/privatenumber/tsx' }],
      },
      {
        name: 'Playwright 1.62.1',
        usage: 'E2E 테스트',
        license: 'Apache-2.0',
        links: [{ label: 'GitHub', url: 'https://github.com/microsoft/playwright' }],
      },
      {
        name: 'oxlint 1.77.0',
        usage: '클라이언트 린트',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/oxc-project/oxc' }],
      },
      {
        name: 'DefinitelyTyped (@types/*)',
        usage: 'TypeScript 타입 정의',
        license: 'MIT',
        links: [{ label: 'GitHub', url: 'https://github.com/DefinitelyTyped/DefinitelyTyped' }],
      },
    ],
  },
  {
    title: '에셋',
    items: [
      {
        name: 'Toy Train — Crab_Audio',
        usage: '배경음악',
        license: 'Pixabay Content License',
        links: [
          { label: '음원', url: 'https://pixabay.com/music/happy-childrens-tunes-toy-train-296983/' },
          { label: '라이선스', url: 'https://pixabay.com/service/license-summary/' },
          { label: '제작자', url: 'https://pixabay.com/users/crab_audio-47493304/' },
        ],
      },
      {
        name: 'Unlock new item game notification — Mixkit',
        usage: '목표 달성 효과음',
        license: 'Mixkit Sound Effects Free License',
        links: [
          { label: '음원', url: 'https://mixkit.co/free-sound-effects/game/' },
          { label: '라이선스', url: 'https://mixkit.co/license/#sfxFree' },
        ],
      },
    ],
  },
]

// 지도, 노선, 역, 차량, 시민 표시 등 게임 화면의 그래픽은 외부 에셋 없이 React·SVG·CSS로 직접 그렸다.
export const OWN_ASSETS_NOTE =
  '지도와 노선, 역, 차량, 시민 표시는 외부 에셋 없이 React·SVG·CSS로 직접 구현했습니다.'
