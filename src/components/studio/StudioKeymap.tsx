import styles from "./StudioWindow.module.css";

/**
 * The shortcut list as rows of action and keys. Each locale writes it as lines of
 * "keys: action" pairs joined by " · ", so translators keep one string.
 */
export function StudioKeymap({ keymap }: { keymap: string }) {
	return (
		<dl className={styles.keymap}>
			{parseKeymap(keymap).map(({ keys, action }) => (
				<div key={keys.join(" ")} className={styles.keymapRow}>
					<dt>{action}</dt>
					<dd>
						{keys.map((key) => (
							<kbd key={key}>{key}</kbd>
						))}
					</dd>
				</div>
			))}
		</dl>
	);
}

export function parseKeymap(keymap: string) {
	return keymap
		.split("\n")
		.flatMap((line) => line.split(" · "))
		.map((entry) => {
			const match = /^(.+?)\s*[:：]\s*(.+)$/.exec(entry.trim());
			if (!match) return null;
			return { keys: match[1].split(" / ").map((key) => key.trim()), action: match[2] };
		})
		.filter((entry): entry is { keys: string[]; action: string } => entry !== null);
}
