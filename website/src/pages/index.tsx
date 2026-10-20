import Head from "@docusaurus/Head";
import Link from "@docusaurus/Link";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import {
	ArrowRight,
	AudioLines,
	Camera,
	Check,
	Command,
	MonitorUp,
	MousePointer2,
	Pause,
	RotateCcw,
	Scissors,
	ShieldCheck,
	Sparkles,
} from "lucide-react";

import { CHECKOUT_URL } from "../lib/commerce";
import { jsonLd, SOFTWARE_APPLICATION_LD } from "../lib/structured-data";
import styles from "./index.module.css";

const CLIP_WIDTHS = [18, 28, 14, 32];

function ProductStage() {
	return (
		<div className={styles.productStage} aria-label="Klippt recording and editing workflow">
			<div className={styles.recordingHud}>
				<span className={styles.dragDots} aria-hidden="true">
					<span />
					<span />
					<span />
				</span>
				<span className={styles.sourceControl}>
					<MonitorUp size={14} /> Screen
				</span>
				<span className={styles.hudDivider} />
				<span className={styles.hudStatus}>00:38</span>
				<span className={styles.recordDot} />
				<span className={styles.pauseControl}>
					<Pause size={13} fill="currentColor" />
				</span>
				<span className={styles.hudDivider} />
				<span className={styles.removeControl}>
					<RotateCcw size={13} />
				</span>
				<div className={styles.clipRail} aria-hidden="true">
					{CLIP_WIDTHS.map((width, index) => (
						<span key={width} style={{ flex: width }} data-current={index === 3 || undefined} />
					))}
				</div>
			</div>

			<div className={styles.editorWindow}>
				<div className={styles.editorTopbar}>
					<div className={styles.windowDots} aria-hidden="true">
						<span />
						<span />
						<span />
					</div>
					<span className={styles.wordmark}>Klippt</span>
					<span className={styles.projectName}>Product walkthrough</span>
					<span className={styles.savedState}>Saved</span>
					<span className={styles.recordButton}>Record</span>
					<span className={styles.exportButton}>Export</span>
				</div>

				<div className={styles.editorBody}>
					<div className={styles.previewArea}>
						<div className={styles.previewCanvas}>
							<div className={styles.fakeWindow}>
								<div className={styles.fakeSidebar} />
								<div className={styles.fakeContent}>
									<span />
									<span />
									<span />
									<span />
								</div>
							</div>
							<div className={styles.cameraPreview}>
								<Camera size={18} />
							</div>
						</div>
					</div>

					<aside className={styles.inspector}>
						<div className={styles.inspectorTitle}>Automatic</div>
						<div className={styles.inspectorRow}>
							<span>Max zoom</span>
							<strong>1.65×</strong>
						</div>
						<div className={styles.slider}>
							<span />
						</div>
						<div className={styles.inspectorRow}>
							<span>Camera emphasis</span>
							<span className={styles.toggle} />
						</div>
						<div className={styles.inspectorRow}>
							<span>Protect screen activity</span>
							<span className={styles.toggle} />
						</div>
					</aside>
				</div>

				<div className={styles.timeline}>
					<div className={styles.timelineRuler}>
						<span>0:00</span>
						<span>0:10</span>
						<span>0:20</span>
						<span>0:30</span>
					</div>
					<div className={styles.effectLane}>
						<span style={{ left: "7%", width: "23%" }}>1.50×</span>
						<span style={{ left: "37%", width: "30%" }}>Follow pointer</span>
						<span style={{ left: "74%", width: "18%" }}>Camera</span>
					</div>
					<div className={styles.clipLane}>
						<span style={{ flex: 3 }} />
						<span style={{ flex: 2 }} />
						<span style={{ flex: 4 }} />
					</div>
					<div className={styles.playhead} />
				</div>
			</div>
		</div>
	);
}

const FEATURES = [
	{
		icon: MousePointer2,
		title: "Direction you can edit",
		body: "Clicks, drags, typing, and speech become normal Zoom and Camera Emphasis regions. Move them, resize them, or remove them.",
	},
	{
		icon: Scissors,
		title: "Fix the mistake, not the session",
		body: "Pause into clean MP4 clips. Remove the previous clip immediately, or insert a new clip between existing sections later.",
	},
	{
		icon: AudioLines,
		title: "Quicker spoken-word edits",
		body: "Shorten pauses with speech-aware analysis while protecting clicks, typing, cursor movement, and system audio.",
	},
	{
		icon: MonitorUp,
		title: "One recording, every frame",
		body: "Build 16:9, 9:16, 1:1, split-screen, and custom layouts from the same untouched source recording.",
	},
	{
		icon: ShieldCheck,
		title: "Local by default",
		body: "Recordings and projects stay on your Mac. Capture, preview, and export use the machine you already own.",
	},
	{
		icon: Command,
		title: "Built for precise control",
		body: "Every automatic change remains visible on the timeline, undoable, and available to the same command model used by the editor.",
	},
];

export default function Home() {
	return (
		<Layout
			title="Clip-native screen recorder and editor for Mac"
			description="Record clean clips, remove mistakes while recording, and return to an editable first cut with local automatic direction."
		>
			<Head>
				<script type="application/ld+json">{jsonLd(SOFTWARE_APPLICATION_LD)}</script>
			</Head>

			<main>
				<section className={styles.hero}>
					<div className={styles.heroCopy}>
						<div className={styles.eyebrow}>
							<span className={styles.liveDot} /> Private alpha · macOS
						</div>
						<Heading as="h1" className={styles.heroTitle}>
							Record clean clips.
							<span>Come back to a polished first edit.</span>
						</Heading>
						<p className={styles.heroBody}>
							Klippt lets you pause, remove the last section, and continue without ending the
							recording. When you stop, your clips, zooms, camera emphasis, and pauses are ready to
							adjust.
						</p>
						<div className={styles.heroActions}>
							<Link className={styles.primaryAction} to="/download/">
								Download for Mac <ArrowRight size={15} />
							</Link>
							<a className={styles.textAction} href="#workflow">
								See the workflow
							</a>
						</div>
						<p className={styles.heroNote}>
							Apple Silicon · local recording · editable automatic direction
						</p>
					</div>

					<ProductStage />
				</section>

				<section className={styles.workflow}>
					<div className={styles.sectionHeading}>
						<span>One recording session</span>
						<Heading as="h2" id="workflow">
							The editor and recorder work as one.
						</Heading>
					</div>
					<div className={styles.workflowRail}>
						<article>
							<div className={styles.stepNumber}>01</div>
							<h3>Record</h3>
							<p>Choose your sources once. Pause whenever a spoken section ends.</p>
						</article>
						<article>
							<div className={styles.stepNumber}>02</div>
							<h3>Keep moving</h3>
							<p>Remove the previous clip with one key, or continue into the next clean clip.</p>
						</article>
						<article>
							<div className={styles.stepNumber}>03</div>
							<h3>Finish the edit</h3>
							<p>Stop into one timeline. Adjust every cut, zoom, pause, frame, and camera move.</p>
						</article>
					</div>
				</section>

				<section className={styles.features}>
					<div className={styles.sectionHeading}>
						<span>Automatic, not mysterious</span>
						<Heading as="h2" id="features">
							A strong first edit that still belongs to you.
						</Heading>
					</div>
					<div className={styles.featureGrid}>
						{FEATURES.map(({ icon: Icon, title, body }) => (
							<article key={title} className={styles.feature}>
								<Icon size={17} />
								<h3>{title}</h3>
								<p>{body}</p>
							</article>
						))}
					</div>
				</section>

				<section className={styles.pricing}>
					<div className={styles.pricingCopy}>
						<span className={styles.pricingLabel}>Founding alpha</span>
						<Heading as="h2" id="pricing">
							One product. No feature maze.
						</Heading>
						<p>
							The private alpha will use one Klippt Pro subscription. Monthly and yearly plans
							unlock the same recorder, editor, automatic direction, and export controls.
						</p>
					</div>
					<div className={styles.priceCard}>
						<div className={styles.priceRow}>
							<div>
								<strong>$19</strong>
								<span>/ month</span>
							</div>
							<span className={styles.or}>or</span>
							<div>
								<strong>$99</strong>
								<span>/ year</span>
							</div>
						</div>
						<ul>
							<li>
								<Check size={14} /> 14-day trial after your first recording
							</li>
							<li>
								<Check size={14} /> Existing projects stay viewable if access ends
							</li>
							<li>
								<Check size={14} /> Cancel before the next billing period
							</li>
						</ul>
						{CHECKOUT_URL ? (
							<a className={styles.primaryAction} href={CHECKOUT_URL}>
								Buy Klippt Pro <ArrowRight size={15} />
							</a>
						) : (
							<Link className={styles.primaryAction} to="/download/">
								Start with the free trial <ArrowRight size={15} />
							</Link>
						)}
						<p className={styles.priceFoot}>
							14-day money-back guarantee · <Link to="/refund/">Refund policy</Link>
						</p>
					</div>
				</section>

				<section className={styles.closing}>
					<Sparkles size={18} />
					<Heading as="h2">Record without planning every correction.</Heading>
					<p>Your source stays clean. The first edit stays flexible.</p>
					<Link className={styles.secondaryAction} to="/download/">
						Download for Mac <ArrowRight size={15} />
					</Link>
				</section>
			</main>
		</Layout>
	);
}
