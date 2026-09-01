import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { ChevronRight, HelpCircle, Info } from "lucide-react";
import {
	type ButtonHTMLAttributes,
	type ComponentPropsWithoutRef,
	forwardRef,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import styles from "./inspector.module.css";

export const InspectorIconButton = forwardRef<
	HTMLButtonElement,
	ButtonHTMLAttributes<HTMLButtonElement> & {
		label: string;
		tone?: "default" | "danger";
	}
>(({ label, tone = "default", className = "", children, ...props }, ref) => (
	<button
		ref={ref}
		type="button"
		className={`${styles.iconButton} ${tone === "danger" ? styles.danger : ""} ${className}`}
		aria-label={label}
		{...props}
	>
		{children}
	</button>
));
InspectorIconButton.displayName = "InspectorIconButton";

export function InspectorPane({
	title,
	helpLabel,
	helpText,
	toolbar,
	className = "",
	children,
}: {
	title: string;
	helpLabel: string;
	helpText?: string;
	toolbar?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<TooltipProvider>
			<section
				className={`${styles.pane} ${className}`}
				aria-label={title}
				data-inspector-layout="flat"
				data-has-toolbar={toolbar ? "true" : "false"}
			>
				<header className={styles.paneHeader}>
					<h2>{title}</h2>
					{helpText ? (
						<Popover>
							<Tooltip content={helpLabel} side="left">
								<PopoverTrigger asChild>
									<InspectorIconButton label={helpLabel}>
										<HelpCircle size={14} />
									</InspectorIconButton>
								</PopoverTrigger>
							</Tooltip>
							<PopoverContent align="end" sideOffset={8} className={styles.helpPopover} role="note">
								{helpText}
							</PopoverContent>
						</Popover>
					) : null}
				</header>
				{toolbar}
				<div className={styles.paneBody}>{children}</div>
			</section>
		</TooltipProvider>
	);
}

export function InspectorToolbar({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className={styles.toolbar} role="toolbar" aria-label={label}>
			{children}
		</div>
	);
}

export function InspectorActionButton({
	tone = "secondary",
	className = "",
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	tone?: "primary" | "secondary" | "quiet";
}) {
	return (
		<button
			type="button"
			className={`${styles.actionButton} ${styles[tone]} ${className}`}
			{...props}
		>
			{children}
		</button>
	);
}

export function InspectorEmptyState({
	icon,
	title,
	description,
	action,
}: {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className={styles.emptyState}>
			{icon ? <div className={styles.emptyStateIcon}>{icon}</div> : null}
			<strong>{title}</strong>
			{description ? <p>{description}</p> : null}
			{action}
		</div>
	);
}

export function InspectorSection({
	title,
	hint,
	children,
}: {
	title?: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<section className={styles.section}>
			{title ? <h3>{title}</h3> : null}
			{hint ? <p className={styles.sectionHint}>{hint}</p> : null}
			{children}
		</section>
	);
}

export function InspectorRow({
	label,
	helpText,
	children,
}: {
	label: string;
	helpText?: string;
	children: ReactNode;
}) {
	return (
		<div className={styles.row}>
			<span className={styles.rowLabel}>
				{label}
				{helpText ? <InspectorHelp label={label} text={helpText} /> : null}
			</span>
			{children}
		</div>
	);
}

function InspectorHelp({ label, text }: { label: string; text: string }) {
	return (
		<Tooltip
			content={text}
			side="left"
			className="max-w-56 whitespace-normal px-2.5 py-2 text-left leading-[1.4]"
		>
			<InspectorIconButton label={`${label}: ${text}`} className={styles.infoButton}>
				<Info size={11} />
			</InspectorIconButton>
		</Tooltip>
	);
}

export function InspectorSwitch({
	label,
	checked,
	disabled,
	onCheckedChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<SwitchPrimitive.Root
			className={styles.switchRoot}
			checked={checked}
			disabled={disabled}
			onCheckedChange={onCheckedChange}
			aria-label={label}
		>
			<SwitchPrimitive.Thumb className={styles.switchThumb} />
		</SwitchPrimitive.Root>
	);
}

export function InspectorSlider({
	label,
	value,
	min,
	max,
	step = 1,
	decimals = 0,
	suffix = "",
	disabled,
	onChange,
	onCommit,
	showValue = true,
	helpText,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	decimals?: number;
	suffix?: string;
	disabled?: boolean;
	onChange: (next: number) => void;
	onCommit: () => void;
	showValue?: boolean;
	helpText?: string;
}) {
	const pointerInteraction = useRef(false);
	const commitPending = useRef(false);
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;

	const performCommit = useCallback(() => {
		if (!commitPending.current) return;
		commitPending.current = false;
		commitRef.current();
	}, []);

	const flushCommit = useCallback(() => {
		if (commitTimer.current !== null) {
			clearTimeout(commitTimer.current);
			commitTimer.current = null;
		}
		performCommit();
	}, [performCommit]);

	const scheduleKeyboardCommit = useCallback(() => {
		if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		commitTimer.current = setTimeout(() => {
			commitTimer.current = null;
			performCommit();
		}, 180);
	}, [performCommit]);

	useEffect(
		() => () => {
			if (commitTimer.current !== null) {
				clearTimeout(commitTimer.current);
				commitTimer.current = null;
			}
			performCommit();
		},
		[performCommit],
	);

	return (
		<div className={styles.slider}>
			<div className={styles.sliderHeader}>
				<span className={styles.sliderLabel}>
					{label}
					{helpText ? <InspectorHelp label={label} text={helpText} /> : null}
				</span>
				{showValue ? (
					<output className={styles.sliderValue}>
						{value.toFixed(decimals)}
						{suffix}
					</output>
				) : null}
			</div>
			<SliderPrimitive.Root
				className={styles.sliderRoot}
				value={[value]}
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				onValueChange={([next]) => {
					if (next === undefined) return;
					commitPending.current = true;
					onChange(next);
				}}
				onPointerDown={() => {
					pointerInteraction.current = true;
				}}
				onPointerCancel={() => {
					if (!pointerInteraction.current) return;
					pointerInteraction.current = false;
					flushCommit();
				}}
				onValueCommit={() => {
					if (pointerInteraction.current) {
						pointerInteraction.current = false;
						flushCommit();
						return;
					}
					scheduleKeyboardCommit();
				}}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) flushCommit();
				}}
			>
				<SliderPrimitive.Track className={styles.sliderTrack}>
					<SliderPrimitive.Range className={styles.sliderRange} />
				</SliderPrimitive.Track>
				<SliderPrimitive.Thumb className={styles.sliderThumb} aria-label={label} />
			</SliderPrimitive.Root>
		</div>
	);
}

export function InspectorSegmentedControl<T extends string>({
	label,
	value,
	options,
	disabled,
	className = "",
	onValueChange,
}: {
	label: string;
	value: T;
	options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
	disabled?: boolean;
	className?: string;
	onValueChange: (value: T) => void;
}) {
	return (
		<ToggleGroupPrimitive.Root
			type="single"
			className={`${styles.segmentedControl} ${className}`}
			aria-label={label}
			value={value}
			disabled={disabled}
			onValueChange={(next) => next && onValueChange(next as T)}
		>
			{options.map((option) => (
				<ToggleGroupPrimitive.Item
					key={option.value}
					value={option.value}
					className={styles.segmentedItem}
					aria-label={option.label}
				>
					{option.icon}
					<span>{option.label}</span>
				</ToggleGroupPrimitive.Item>
			))}
		</ToggleGroupPrimitive.Root>
	);
}

export function InspectorDisclosure({
	label,
	children,
	defaultOpen = false,
	...props
}: ComponentPropsWithoutRef<"details"> & {
	label: string;
	children: ReactNode;
	defaultOpen?: boolean;
}) {
	return (
		<details className={styles.disclosure} open={defaultOpen || undefined} {...props}>
			<summary>
				<ChevronRight size={14} />
				<span>{label}</span>
			</summary>
			<div className={styles.disclosureBody}>{children}</div>
		</details>
	);
}
