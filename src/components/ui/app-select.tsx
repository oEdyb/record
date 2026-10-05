import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Children, type CSSProperties, isValidElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./app-select.module.css";

const EMPTY_VALUE = "__klippt_empty_select_value__";

interface ParsedOption {
	value: string;
	label: ReactNode;
	disabled: boolean;
	group?: string;
	style?: CSSProperties;
}

interface AppSelectChangeEvent {
	target: { value: string };
}

export interface AppSelectProps {
	value: string | number;
	onChange: (event: AppSelectChangeEvent) => void;
	children: ReactNode;
	disabled?: boolean;
	className?: string;
	style?: CSSProperties;
	id?: string;
	"data-testid"?: string;
	"aria-label"?: string;
	align?: "start" | "center" | "end";
}

function radixValue(value: string): string {
	return value === "" ? EMPTY_VALUE : value;
}

function parseOptions(children: ReactNode, group?: string): ParsedOption[] {
	const options: ParsedOption[] = [];
	Children.forEach(children, (child) => {
		if (!isValidElement(child)) return;
		if (child.type === "option") {
			const props = child.props as {
				value?: string | number;
				children?: ReactNode;
				disabled?: boolean;
				style?: CSSProperties;
			};
			const value = String(props.value ?? props.children ?? "");
			options.push({
				value,
				label: props.children,
				disabled: Boolean(props.disabled),
				group,
				style: props.style,
			});
			return;
		}
		if (child.type === "optgroup") {
			const props = child.props as { label?: string; children?: ReactNode };
			options.push(...parseOptions(props.children, props.label));
			return;
		}
		options.push(...parseOptions(child.props.children, group));
	});
	return options;
}

function groupedOptions(options: ParsedOption[]) {
	const groups: Array<{ label?: string; options: ParsedOption[] }> = [];
	for (const option of options) {
		const last = groups.at(-1);
		if (!last || last.label !== option.group) {
			groups.push({ label: option.group, options: [option] });
		} else {
			last.options.push(option);
		}
	}
	return groups;
}

/**
 * Klippt's themed replacement for native HTML select menus.
 *
 * It accepts normal option and optgroup children so existing controlled menus can
 * migrate without changing their value logic. Radix renders the popup inside the
 * app, which keeps selection, focus, spacing, and dark mode on the shared tokens
 * instead of inheriting the host operating system's accent color.
 */
export function AppSelect({
	value,
	onChange,
	children,
	disabled = false,
	className,
	style,
	id,
	"data-testid": dataTestId,
	"aria-label": ariaLabel,
	align = "end",
}: AppSelectProps) {
	const groups = groupedOptions(parseOptions(children));
	return (
		<SelectPrimitive.Root
			value={radixValue(String(value))}
			disabled={disabled}
			onValueChange={(next) => onChange({ target: { value: next === EMPTY_VALUE ? "" : next } })}
		>
			<SelectPrimitive.Trigger
				className={cn(styles.trigger, className)}
				style={style}
				id={id}
				data-testid={dataTestId}
				aria-label={ariaLabel}
				data-klippt-select-trigger=""
			>
				<SelectPrimitive.Value className={styles.value} />
				<SelectPrimitive.Icon asChild>
					<ChevronDown className={styles.chevron} size={13} />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					className={styles.content}
					data-klippt-select-content=""
					position="popper"
					sideOffset={4}
					align={align}
					collisionPadding={8}
				>
					<SelectPrimitive.ScrollUpButton className={styles.scrollButton}>
						<ChevronUp size={13} />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.Viewport className={styles.viewport}>
						{groups.map((group, groupIndex) => (
							<SelectPrimitive.Group key={`${group.label ?? "ungrouped"}-${groupIndex}`}>
								{groupIndex > 0 ? <SelectPrimitive.Separator className={styles.separator} /> : null}
								{group.label ? (
									<SelectPrimitive.Label className={styles.groupLabel}>
										{group.label}
									</SelectPrimitive.Label>
								) : null}
								{group.options.map((option) => (
									<SelectPrimitive.Item
										key={option.value}
										value={radixValue(option.value)}
										disabled={option.disabled}
										className={styles.item}
										style={option.style}
									>
										<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
										<SelectPrimitive.ItemIndicator className={styles.indicator}>
											<Check size={12} strokeWidth={2.25} />
										</SelectPrimitive.ItemIndicator>
									</SelectPrimitive.Item>
								))}
							</SelectPrimitive.Group>
						))}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollDownButton className={styles.scrollButton}>
						<ChevronDown size={13} />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}
