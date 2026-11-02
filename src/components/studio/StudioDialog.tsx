import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";

/**
 * A modal over the Studio. Radix keeps focus inside it and stacks the menus opened within
 * it (device lists) above it, which a native top-layer <dialog> cannot. It renders in place,
 * not in a portal, so it keeps the Studio's colour tokens. `bare` hosts a panel that brings
 * its own frame and close button.
 */
export function StudioDialog({
	title,
	onClose,
	children,
	bare = false,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
	bare?: boolean;
}) {
	const t = useScopedT("launch");
	return (
		<DialogPrimitive.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogPrimitive.Overlay className={styles.dialogLayer} />
			<DialogPrimitive.Content
				className={styles.dialog}
				data-bare={bare}
				aria-describedby={undefined}
			>
				{bare ? (
					<DialogPrimitive.Title className={styles.srOnly}>{title}</DialogPrimitive.Title>
				) : (
					<header>
						<DialogPrimitive.Title asChild>
							<strong>{title}</strong>
						</DialogPrimitive.Title>
						<button type="button" onClick={onClose}>
							{t("deviceSettings.done")}
						</button>
					</header>
				)}
				{children}
			</DialogPrimitive.Content>
		</DialogPrimitive.Root>
	);
}
