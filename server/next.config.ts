import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // API 전용 서버 — 페이지 빌드 불필요
  output: 'standalone',

  webpack: (config) => {
    // workerd용 Prisma 클라이언트가 WASM 엔진을 `query_engine_bg.wasm?module`로
    // import한다. 이 플래그가 없으면 "module is not flagged as WebAssembly
    // module"로 빌드가 깨진다.
    //
    // 주의: 이 상태는 빌드/배포까지는 통과하지만 런타임에서 실패한다.
    // webpack이 wasm을 에셋 파일로 배출하고 런타임에 파일로 읽으려 하는데
    // (readAll '/bundle/static/wasm/<hash>.wasm') Worker에는 파일시스템이 없다.
    // 남은 과제는 이 import를 파일이 아니라 모듈로 번들에 넣는 것.
    config.experiments = { ...config.experiments, asyncWebAssembly: true }
    return config
  },
}

export default nextConfig
