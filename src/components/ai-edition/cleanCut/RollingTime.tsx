import { useEffect, useState } from "react";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import styles from "./RollingTime.module.css";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A running time whose digits roll to each new value, like an odometer, so restoring a cut
 * reads as the number itself changing. With `fromSec` it opens there and rolls in.
 */
export function RollingTime({
	sec,
	fromSec,
	className,
}: {
	sec: number;
	fromSec?: number;
	className?: string;
}) {
	const [shown, setShown] = useState(fromSec ?? sec);
	useEffect(() => {
		const frame = requestAnimationFrame(() => setShown(sec));
		return () => cancelAnimationFrame(frame);
	}, [sec]);
	const chars = [...formatPlayerTime(shown)];
	return (
		<span
			className={className ? `${styles.rolling} ${className}` : styles.rolling}
			role="timer"
			aria-label={formatPlayerTime(sec)}
		>
			{chars.map((char, index) => {
				const fromRight = chars.length - index;
				if (!/\d/.test(char))
					return (
						<span key={`s${fromRight}`} className={styles.sep} aria-hidden="true">
							{char}
						</span>
					);
				return (
					<span key={`d${fromRight}`} className={styles.column} aria-hidden="true">
						<span
							className={styles.strip}
							style={{
								transform: `translateY(${-Number(char) * 10}%)`,
								transitionDelay: `${index * 40}ms`,
							}}
						>
							{DIGITS.map((digit) => (
								<span key={digit}>{digit}</span>
							))}
						</span>
					</span>
				);
			})}
		</span>
	);
}
