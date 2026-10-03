import type { Editor } from "@tiptap/react";
import {
	ChevronDown,
	ChevronUp,
	FlipHorizontal2,
	GripHorizontal,
	Minus,
	Pause,
	Play,
	Plus,
	X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import {
	MAX_NOTES_FONT_SIZE,
	MAX_TELEPROMPTER_SPEED,
	MIN_NOTES_FONT_SIZE,
	MIN_TELEPROMPTER_SPEED,
} from "./notesTeleprompter";

export type NotesToolbarProps = {
	editor: Editor | null;
	isPlaying: boolean;
	speed: number;
	fontSize: number;
	mirrored: boolean;
	onTogglePlaying: () => void;
	onDecreaseSpeed: () => void;
	onIncreaseSpeed: () => void;
	onDecreaseFontSize: () => void;
	onIncreaseFontSize: () => void;
	onToggleMirror: () => void;
	onClose: () => void;
};

type ToolbarButtonProps = {
	"aria-label": string;
	/** Toggle state: drives both `aria-pressed` and the pressed styling. */
	active?: boolean;
	/**
	 * Pressed styling without `aria-pressed`, for buttons that already announce their state
	 * through a label that changes with it. Announcing both would say it twice.
	 */
	highlighted?: boolean;
	disabled?: boolean;
	teleprompterControl?: boolean;
	onClick: () => void;
	children: ReactNode;
};

function ToolbarButton({
	"aria-label": ariaLabel,
	active,
	highlighted = false,
	disabled = false,
	teleprompterControl = false,
	onClick,
	children,
}: ToolbarButtonProps) {
	return (
		<Tooltip content={ariaLabel}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-pressed={active}
				disabled={disabled}
				data-teleprompter-control={teleprompterControl ? "" : undefined}
				onClick={onClick}
				className={cn(
					"notes-chrome-control inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-30",
					(active || highlighted) && "bg-white/90 text-gray-900 hover:bg-white hover:text-gray-900",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}

/**
 * One slim strip: a drag handle, play/pause, speed, and a chevron that reveals font size and
 * mirror. Everything else the note needs lives on the text selection (NotesFormattingMenu).
 */
export function NotesToolbar({
	editor,
	isPlaying,
	speed,
	fontSize,
	mirrored,
	onTogglePlaying,
	onDecreaseSpeed,
	onIncreaseSpeed,
	onDecreaseFontSize,
	onIncreaseFontSize,
	onToggleMirror,
	onClose,
}: NotesToolbarProps) {
	const { locale } = useI18n();
	const t = useScopedT("launch");
	const tCommon = useScopedT("common");
	const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="flex w-full min-w-0 flex-col gap-1" data-testid="notes-chrome">
			<div
				data-testid="notes-teleprompter-controls"
				className="flex h-7 w-full min-w-0 items-center gap-0.5"
			>
				<div
					className="notes-drag-handle flex h-full min-w-0 flex-1 items-center pl-1 text-white/30"
					aria-label={t("tooltips.notesToolbar.move")}
					title={t("tooltips.notesToolbar.move")}
				>
					<GripHorizontal size={14} aria-hidden="true" />
				</div>

				<ToolbarButton
					aria-label={t(isPlaying ? "tooltips.notesToolbar.pause" : "tooltips.notesToolbar.play")}
					highlighted={isPlaying}
					disabled={!editor}
					teleprompterControl
					onClick={onTogglePlaying}
				>
					{isPlaying ? <Pause size={13} /> : <Play size={13} />}
				</ToolbarButton>

				<div
					role="group"
					aria-label={t("tooltips.notesToolbar.speed")}
					className="flex shrink-0 items-center"
				>
					<ToolbarButton
						aria-label={t("tooltips.notesToolbar.decreaseSpeed")}
						disabled={speed <= MIN_TELEPROMPTER_SPEED}
						teleprompterControl
						onClick={onDecreaseSpeed}
					>
						<Minus size={13} />
					</ToolbarButton>
					<output className="min-w-11 text-center text-[11px] tabular-nums text-white/60">
						{tCommon("units.pixelsPerSecond", { value: numberFormatter.format(speed) })}
					</output>
					<ToolbarButton
						aria-label={t("tooltips.notesToolbar.increaseSpeed")}
						disabled={speed >= MAX_TELEPROMPTER_SPEED}
						teleprompterControl
						onClick={onIncreaseSpeed}
					>
						<Plus size={13} />
					</ToolbarButton>
				</div>

				<ToolbarButton
					aria-label={t(expanded ? "tooltips.notesToolbar.less" : "tooltips.notesToolbar.more")}
					active={expanded}
					onClick={() => setExpanded((current) => !current)}
				>
					{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
				</ToolbarButton>

				<ToolbarButton aria-label={t("tooltips.notesToolbar.close")} onClick={onClose}>
					<X size={13} />
				</ToolbarButton>
			</div>

			{expanded ? (
				<div
					data-testid="notes-secondary-controls"
					className="flex h-7 w-full min-w-0 items-center justify-end gap-0.5"
				>
					<div
						role="group"
						aria-label={t("tooltips.notesToolbar.fontSize")}
						className="flex shrink-0 items-center"
					>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.decreaseFontSize")}
							disabled={fontSize <= MIN_NOTES_FONT_SIZE}
							teleprompterControl
							onClick={onDecreaseFontSize}
						>
							<Minus size={13} />
						</ToolbarButton>
						<output className="min-w-9 text-center text-[11px] tabular-nums text-white/60">
							{tCommon("units.pixels", { value: numberFormatter.format(fontSize) })}
						</output>
						<ToolbarButton
							aria-label={t("tooltips.notesToolbar.increaseFontSize")}
							disabled={fontSize >= MAX_NOTES_FONT_SIZE}
							teleprompterControl
							onClick={onIncreaseFontSize}
						>
							<Plus size={13} />
						</ToolbarButton>
					</div>

					<ToolbarButton
						aria-label={t("tooltips.notesToolbar.mirror")}
						active={mirrored}
						teleprompterControl
						onClick={onToggleMirror}
					>
						<FlipHorizontal2 size={13} />
					</ToolbarButton>
				</div>
			) : null}
		</div>
	);
}
