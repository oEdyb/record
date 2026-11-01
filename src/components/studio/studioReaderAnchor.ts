export function preserveStudioReader() {
	const body = document.querySelector<HTMLElement>("[data-studio-reader]");
	if (!body) return;
	const top = body.getBoundingClientRect().top;
	const anchor = [...body.querySelectorAll<HTMLElement>("[data-time]")].find(
		(node) => node.getBoundingClientRect().bottom > top,
	);
	if (!anchor) return;
	const offset = anchor.getBoundingClientRect().top - top;
	requestAnimationFrame(() => {
		if (anchor.isConnected)
			body.scrollTop +=
				anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
	});
}
