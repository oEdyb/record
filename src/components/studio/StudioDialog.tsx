import { type ReactNode, useEffect, useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";

export function StudioDialog({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const t = useScopedT("launch");
	useEffect(() => {
		const opener = document.activeElement;
		ref.current?.showModal();
		return () => {
			if (opener instanceof HTMLElement) opener.focus();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={styles.dialog}
			aria-label={title}
			onCancel={onClose}
			onClose={onClose}
		>
			<header>
				<strong>{title}</strong>
				<button type="button" onClick={onClose}>
					{t("deviceSettings.done")}
				</button>
			</header>
			{children}
		</dialog>
	);
}
