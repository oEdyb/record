import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ className, ...props }: ToasterProps) => {
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
					toast: "group toast backdrop-blur-xl",
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
