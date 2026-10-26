/** Windows have already closed at will-quit; capture's before-quit guard has
 * finished saving the take. Only local diagnostics remain to be flushed. */
export function createWorkloadQuitGuard(deps: {
	finishPreviews: () => Promise<void>;
	quit: () => void;
	onError: (error: unknown) => void;
}) {
	let finishing = false;
	let finished = false;
	let poweringOff = false;
	return {
		systemPoweringOff() {
			poweringOff = true;
		},
		willQuit(event: { preventDefault: () => void }) {
			if (poweringOff || finished) return;
			event.preventDefault();
			if (finishing) return;
			finishing = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Workload report flush timed out")), 2_000);
			});
			void Promise.race([Promise.resolve().then(deps.finishPreviews), deadline])
				.catch(deps.onError)
				.finally(() => {
					clearTimeout(timer);
					finished = true;
					deps.quit();
				});
		},
	};
}
