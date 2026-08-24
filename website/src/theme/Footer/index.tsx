import type { ReactNode } from "react";

import styles from "./styles.module.css";

export default function Footer(): ReactNode {
	return (
		<footer className={styles.footer}>
			<div className={styles.inner}>
				<div className={styles.brandBlock}>
					<strong>Klippt</strong>
					<p>Record clean clips. Fix everything after.</p>
				</div>
				<div className={styles.links}>
					<a href="mailto:support@klippt.app">support@klippt.app</a>
					<a href="https://dyberg.co">Dyberg &amp; Co AB</a>
				</div>
				<p className={styles.copyright}>© 2026 Dyberg &amp; Co AB · Sweden</p>
			</div>
		</footer>
	);
}
