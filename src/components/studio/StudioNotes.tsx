import { useEffect, useState } from "react";
import { loadInitialNotesContent } from "../launch/notesTeleprompter";
import styles from "./StudioWindow.module.css";

function notesText() {
	const doc = new DOMParser().parseFromString(loadInitialNotesContent(), "text/html");
	for (const node of doc.querySelectorAll("p,li,h1,h2,h3")) node.append("\n");
	return doc.body.textContent ?? "";
}
export function StudioNotes() {
	const [text, setText] = useState(notesText);
	useEffect(() => {
		const update = (event: StorageEvent) => {
			if (event.key === "notes" || event.key === null) setText(notesText());
		};
		window.addEventListener("storage", update);
		return () => window.removeEventListener("storage", update);
	}, []);
	return <div className={styles.notes}>{text}</div>;
}
