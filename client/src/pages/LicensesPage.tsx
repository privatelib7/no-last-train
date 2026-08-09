import styles from './LicensesPage.module.css'
import { LICENSE_GROUPS, OWN_ASSETS_NOTE } from '../lib/licenses'

interface Props {
  onBack: () => void
}

export default function LicensesPage({ onBack }: Props) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <button className={styles.backBtn} onClick={onBack} type="button" title="설정으로">
          <span className={styles.backArrow}>←</span>
        </button>

        <div className={styles.header}>
          <div className={styles.titleKo}>오픈소스 라이선스</div>
          <p className={styles.subtitle}>
            「막차는 없다」는 아래 오픈소스와 외부 에셋을 사용합니다. 만들어 주신 분들께 감사드립니다.
          </p>
        </div>

        {LICENSE_GROUPS.map((group) => (
          <section className={styles.section} key={group.title}>
            <span className={styles.sectionTitle}>{group.title}</span>

            <ul className={styles.list}>
              {group.items.map((item) => (
                <li className={styles.item} key={item.name}>
                  <div className={styles.itemHead}>
                    <span className={styles.itemName}>{item.name}</span>
                    <span className={styles.badge}>{item.license}</span>
                  </div>
                  <span className={styles.itemUsage}>{item.usage}</span>
                  <div className={styles.links}>
                    {item.links.map((link) => (
                      <a
                        className={styles.link}
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <p className={styles.footnote}>
          {OWN_ASSETS_NOTE} 각 라이선스 전문과 저작권 고지는 위 링크의 원본 저장소에서 확인할 수 있습니다.
        </p>

        <button className={styles.doneBtn} type="button" onClick={onBack}>
          돌아가기
        </button>
      </div>
    </div>
  )
}
