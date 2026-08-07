import { useEffect, useRef } from 'react'
import styles from './TitlePage.module.css'

interface Props {
  onStart: () => void
  onOpenSettings: () => void
}

export default function TitlePage({ onStart, onOpenSettings }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const nodes = svgRef.current?.querySelectorAll('.node-dot')
    if (!nodes) return
    nodes.forEach((node, i) => {
      const el = node as SVGCircleElement
      el.style.animationDelay = `${i * 0.4}s`
    })
  }, [])

  return (
    <div className={styles.page}>
      <div className={styles.left}>
        <div className={styles.brand}>
          <div className={styles.wordmark}>
            <div className={styles.titleKo}>막차는 없다</div>
            <div className={styles.titleEn}>No Last Train</div>
          </div>

          <svg
            ref={svgRef}
            className={styles.railSvg}
            viewBox="0 0 320 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M 20 80 Q 80 80 100 55 Q 120 30 180 30 Q 240 30 300 55"
              stroke="#E07B35"
              strokeWidth="2.5"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M 20 90 Q 90 90 130 70 Q 170 50 220 50 Q 270 50 300 70"
              stroke="#5B9BD5"
              strokeWidth="2.5"
              strokeLinecap="round"
              fill="none"
            />

            <circle className="node-dot" cx="20" cy="80" r="5" fill="#E07B35" />
            <circle className="node-dot" cx="100" cy="55" r="4" fill="#FAFAF7" stroke="#E07B35" strokeWidth="2" />
            <circle className="node-dot" cx="180" cy="30" r="5" fill="#E07B35" />
            <circle className="node-dot" cx="300" cy="55" r="4" fill="#FAFAF7" stroke="#E07B35" strokeWidth="2" />

            <circle className="node-dot" cx="130" cy="70" r="4" fill="#FAFAF7" stroke="#5B9BD5" strokeWidth="2" />
            <circle className="node-dot" cx="220" cy="50" r="5" fill="#5B9BD5" />
            <circle className="node-dot" cx="300" cy="70" r="4" fill="#FAFAF7" stroke="#5B9BD5" strokeWidth="2" />

            <circle r="5" fill="#E07B35" opacity="0.85">
              <animateMotion
                dur="4s"
                repeatCount="indefinite"
                path="M 20 80 Q 80 80 100 55 Q 120 30 180 30 Q 240 30 300 55"
              />
            </circle>

            <circle r="4" fill="#5B9BD5" opacity="0.85">
              <animateMotion
                dur="5.5s"
                repeatCount="indefinite"
                begin="1.2s"
                path="M 20 90 Q 90 90 130 70 Q 170 50 220 50 Q 270 50 300 70"
              />
            </circle>
          </svg>

          <p className={styles.tagline}>내가 자는 동안에도, 우리가 만든 도시는 계속 달린다.</p>
        </div>
      </div>

      <aside className={styles.right}>
        <nav className={styles.menu}>
          <button className={styles.menuBtn} onClick={onStart} type="button">
            시작
          </button>
          <button className={styles.menuBtn} onClick={onOpenSettings} type="button">
            설정
          </button>
        </nav>

        <div className={styles.versionBadge}>v1.0</div>
      </aside>
    </div>
  )
}
