"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import * as React from "react";
import styles from "./app-menu.module.css";

export const AppMenu = DropdownMenuPrimitive.Root;

export const AppMenuTrigger = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ ...props }, ref) => <DropdownMenuPrimitive.Trigger ref={ref} {...props} />);
AppMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

export const AppMenuContent = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className = "", sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
	<DropdownMenuPrimitive.Portal>
		<DropdownMenuPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			collisionPadding={collisionPadding}
			className={`${styles.content} ${className}`}
			{...props}
		/>
	</DropdownMenuPrimitive.Portal>
));
AppMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export const AppMenuItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className = "", ...props }, ref) => (
	<DropdownMenuPrimitive.Item ref={ref} className={`${styles.item} ${className}`} {...props} />
));
AppMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const AppMenuLabel = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className = "", ...props }, ref) => (
	<DropdownMenuPrimitive.Label ref={ref} className={`${styles.label} ${className}`} {...props} />
));
AppMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const AppMenuSeparator = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className = "", ...props }, ref) => (
	<DropdownMenuPrimitive.Separator
		ref={ref}
		className={`${styles.separator} ${className}`}
		{...props}
	/>
));
AppMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export const AppMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export const AppMenuRadioItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className = "", children, ...props }, ref) => (
	<DropdownMenuPrimitive.RadioItem
		ref={ref}
		className={`${styles.item} ${styles.radioItem} ${className}`}
		{...props}
	>
		<span className={styles.indicatorSlot} aria-hidden>
			<DropdownMenuPrimitive.ItemIndicator>
				<Check size={13} strokeWidth={2.2} />
			</DropdownMenuPrimitive.ItemIndicator>
		</span>
		{children}
	</DropdownMenuPrimitive.RadioItem>
));
AppMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;
