import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useEntitlementStore } from "@/lib/entitlements/store";
import { ipcErrorMessage } from "@/lib/ipcErrorMessage";
import styles from "./EntitlementDialog.module.css";

const MONTHLY_PRICE_USD = 19;
const YEARLY_PRICE_USD = 99;
const LICENSE_KEY_PATTERN = "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";

function formatUsd(locale: string, amount: number): string {
	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(amount);
}

export function EntitlementDialog() {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const {
		snapshot,
		dialogOpen,
		blockedCapability,
		busy,
		error,
		closeDialog,
		activate,
		openCheckout,
		openManagement,
	} = useEntitlementStore();
	const [licenseKey, setLicenseKey] = useState("");
	if (!snapshot.commerceConfigured) return null;

	const expired = snapshot.access === "read-only";
	const title = t(expired ? "entitlement.titleExpired" : "entitlement.titleTrial");
	const capability = blockedCapability
		? t(`entitlement.capability.${blockedCapability}`)
		: t("entitlement.capability.default");
	const description = expired
		? t("entitlement.descriptionExpired", { capability })
		: snapshot.status === "trial-not-started"
			? t("entitlement.descriptionTrialNotStarted")
			: t("entitlement.descriptionTrial");
	const price = t("entitlement.price", {
		monthly: formatUsd(locale, MONTHLY_PRICE_USD),
		yearly: formatUsd(locale, YEARLY_PRICE_USD),
	});
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (await activate(licenseKey)) {
			setLicenseKey("");
			toast.success(t("entitlement.activated"));
		}
	};

	return (
		<Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
			<DialogContent className={styles.content}>
				<div className={styles.body}>
					<p className={styles.eyebrow}>
						{t(expired ? "entitlement.eyebrowReadOnly" : "entitlement.eyebrowPro")}
					</p>
					<DialogTitle className={styles.title}>{title}</DialogTitle>
					<DialogDescription className={styles.description}>{description}</DialogDescription>
					<div className={styles.rule} />
					<ul className={styles.benefits}>
						<li className={styles.benefit}>
							<Check size={15} aria-hidden />
							<span>{t("entitlement.benefitClips")}</span>
						</li>
						<li className={styles.benefit}>
							<Check size={15} aria-hidden />
							<span>{t("entitlement.benefitSources")}</span>
						</li>
						<li className={styles.benefit}>
							<Check size={15} aria-hidden />
							<span>{t("entitlement.benefitExport")}</span>
						</li>
					</ul>
					<button
						type="button"
						className={styles.primary}
						disabled={busy || !snapshot.checkoutAvailable}
						onClick={() => void openCheckout()}
					>
						{busy ? <LoaderCircle size={15} className="animate-spin" /> : null}
						{t("entitlement.getPro")}
						<ArrowUpRight size={14} aria-hidden />
					</button>
					<p className={styles.price}>{price}</p>
					<form className={styles.license} onSubmit={submit}>
						<input
							type="text"
							autoComplete="off"
							spellCheck={false}
							placeholder={LICENSE_KEY_PATTERN}
							aria-label={t("entitlement.licenseKey")}
							value={licenseKey}
							onChange={(event) => setLicenseKey(event.target.value)}
						/>
						<button type="submit" disabled={busy || !licenseKey.trim()}>
							{t("entitlement.activate")}
						</button>
					</form>
					{error ? (
						<p className={styles.error} role="alert">
							{ipcErrorMessage(error)}
						</p>
					) : null}
				</div>
				<div className={styles.footer}>
					<span>{t("entitlement.filesSafe")}</span>
					{snapshot.managementAvailable ? (
						<button type="button" className={styles.manage} onClick={() => void openManagement()}>
							{t("entitlement.manage")}
						</button>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
