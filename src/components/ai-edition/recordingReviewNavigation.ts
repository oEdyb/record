export function createRecordingReviewNavigation(options: { isPreparing: () => boolean }): {
	run: (action: () => void) => boolean;
	isBlocked: () => boolean;
	runAfter: <T>(
		prepare: () => Promise<T>,
		apply: (value: T) => void | Promise<void>,
		isCurrent?: () => boolean,
	) => Promise<boolean>;
} {
	const isBlocked = () => options.isPreparing();
	return {
		isBlocked,
		async runAfter(prepare, apply, isCurrent = () => true) {
			if (isBlocked() || !isCurrent()) return false;
			const value = await prepare();
			if (isBlocked() || !isCurrent()) return false;
			await apply(value);
			return true;
		},
		run(action) {
			if (isBlocked()) return false;
			action();
			return true;
		},
	};
}
