import Link from "@docusaurus/Link";
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
					<Link to="/download/">Download</Link>
					<Link to="/support/">Support</Link>
					<Link to="/privacy/">Privacy</Link>
					<Link to="/terms/">Terms</Link>
					<Link to="/refund/">Refunds</Link>
					<Link to="/notices/">Notices</Link>
					<a href="mailto:support@klippt.app">support@klippt.app</a>
					<a href="https://dyberg.co">Dyberg &amp; Co AB</a>
				</div>
				<p className={styles.copyright}>
					© 2026 Dyberg &amp; Co AB · org. no. 559577-0917 · Sweden
				</p>
			</div>
		</footer>
	);
}
