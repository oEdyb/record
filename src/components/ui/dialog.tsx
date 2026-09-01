import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import styles from "./dialog.module.css";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Overlay ref={ref} className={cn(styles.overlay, className)} {...props} />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
		size?: "sm" | "md" | "lg" | "xl";
		showCloseButton?: boolean;
	}
>(
	(
		{ className, children, size = "md", showCloseButton = true, onOpenAutoFocus, ...props },
		ref,
	) => (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				ref={ref}
				className={cn(
					styles.content,
					size === "sm" && styles.small,
					size === "md" && styles.medium,
					size === "lg" && styles.large,
					size === "xl" && styles.extraLarge,
					className,
				)}
				onOpenAutoFocus={(event) => {
					onOpenAutoFocus?.(event);
					if (event.defaultPrevented) return;
					const content = event.currentTarget;
					if (!(content instanceof HTMLElement)) return;
					const initial = content.querySelector<HTMLElement>("[data-dialog-initial-focus]");
					if (!initial) return;
					event.preventDefault();
					initial.focus({ preventScroll: true });
				}}
				{...props}
			>
				{children}
				{showCloseButton ? (
					<DialogPrimitive.Close className={styles.close}>
						<X />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				) : null}
			</DialogPrimitive.Content>
		</DialogPortal>
	),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<header className={cn(styles.header, className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<footer className={cn(styles.footer, className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn(styles.body, className)} {...props} />
);
DialogBody.displayName = "DialogBody";

const DialogHeading = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn(styles.heading, className)} {...props} />
);
DialogHeading.displayName = "DialogHeading";

const DialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Title ref={ref} className={cn(styles.title, className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description ref={ref} className={cn(styles.description, className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogHeading,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
