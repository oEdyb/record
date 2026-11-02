import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import { Download } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { fetchMacDownload, formatSize, type MacDownload, MINIMUM_MACOS } from "../lib/release";
import styles from "./download.module.css";

const SUPPORT_EMAIL = "support@klippt.app";

type State = { kind: "loading" } | { kind: "ready"; download: MacDownload } | { kind: "missing" };

export default function DownloadPage(): ReactNode {
	const [state, setState] = useState<State>({ kind: "loading" });

	useEffect(() => {
		const controller = new AbortController();
		fetchMacDownload(controller.signal)
			.then((download) => setState(download ? { kind: "ready", download } : { kind: "missing" }))
			.catch(() => {
				if (!controller.signal.aborted) setState({ kind: "missing" });
			});
		return () => controller.abort();
	}, []);

	return (
		<Layout
			title="Download Klippt for Mac"
			description={`Download Klippt for Apple Silicon Macs running ${MINIMUM_MACOS} or later.`}
		>
			<main className={styles.page}>
				<Heading as="h1">Download Klippt</Heading>
				<p className={styles.lead}>
					For Macs with Apple Silicon (M1 or later) running {MINIMUM_MACOS} or later. Intel Macs are
					not supported.
				</p>

				<div className={styles.card}>
					{state.kind === "ready" ? (
						<>
							<a className={styles.action} href={state.download.url}>
								<Download size={16} /> Download Klippt {state.download.version}
							</a>
							<p className={styles.meta}>
								Apple Silicon · notarized by Apple · {formatSize(state.download.sizeBytes) || "DMG"}
							</p>
						</>
					) : state.kind === "loading" ? (
						<p className={styles.meta}>Finding the latest version…</p>
					) : (
						<p>
							The download is not available right now. Email{" "}
							<a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will send you a link.
						</p>
					)}
				</div>

				<Heading as="h2">Install</Heading>
				<ol className={styles.steps}>
					<li>Open the downloaded DMG and drag Klippt to Applications.</li>
					<li>Open Klippt from Applications. Updates only install from there.</li>
					<li>
						Allow Screen &amp; System Audio Recording, Microphone, and Camera when macOS asks. You
						can change them later in System Settings → Privacy &amp; Security.
					</li>
				</ol>

				<Heading as="h2">Free and open source</Heading>
				<p>
					Klippt has no trial, licence key, or account.{" "}
					<a href="https://github.com/oEdyb/record">The source is on GitHub</a>.
				</p>
			</main>
		</Layout>
	);
}
