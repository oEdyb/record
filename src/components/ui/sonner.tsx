import { useEffect } from "react";
import { Toaster as Sonner, toast } from "sonner";
import { cn } from "@/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ className, ...props }: ToasterProps) => {
	useEffect(() => {
		// Sonner 2.0.7 starts empty and does not hydrate from its history.
		// Replay active toasts only, so lazy mounting cannot lose or resurrect notices.
		for (const item of toast.getToasts()) {
			if ("dismiss" in item) continue;
			const { title, type, jsx, ...options } = item;
			if (jsx) {
				toast.custom(() => <>{jsx}</>, options);
			} else if (type === "success") {
				toast.success(title, options);
			} else if (type === "info") {
				toast.info(title, options);
			} else if (type === "warning") {
				toast.warning(title, options);
			} else if (type === "error") {
				toast.error(title, options);
			} else if (type === "loading") {
				toast.loading(title, options);
			} else {
				toast(title, options);
			}
		}
	}, []);

	return (
		<Sonner
			theme="dark"
			className={cn(
				"dark toaster group pointer-events-none [&_[data-sonner-toast]]:pointer-events-auto",
				className,
			)}
			duration={3000}
			// Top centre, under a review header, one or two at a time: notices stay out
			// of the play bar and never pile up.
			position="top-center"
			offset={72}
			visibleToasts={2}
			toastOptions={{
				style: {
					borderRadius: 16,
					border: "1px solid rgba(255, 255, 255, 0.09)",
					background: "rgba(18, 21, 26, 0.96)",
					boxShadow: "0 24px 48px -16px rgba(0, 0, 0, 0.7), 0 4px 12px rgba(0, 0, 0, 0.4)",
					color: "#e8ebef",
					fontSize: 13,
				},
				classNames: {
					toast: "group toast",
					description: "group-[.toast]:text-slate-400",
					actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
