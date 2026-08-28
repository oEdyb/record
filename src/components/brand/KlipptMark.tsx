import klipptMarkSvg from "../../../design/assets/klippt-mark.svg?raw";
import styles from "./KlipptMark.module.css";

interface KlipptMarkProps {
	className?: string;
}

/** The canonical free-standing mark, recolored by the current interface surface. */
export function KlipptMark({ className }: KlipptMarkProps) {
	return (
		<span
			className={className ? `${styles.mark} ${className}` : styles.mark}
			data-klippt-mark="canonical"
			aria-hidden
			dangerouslySetInnerHTML={{ __html: klipptMarkSvg }}
		/>
	);
}
