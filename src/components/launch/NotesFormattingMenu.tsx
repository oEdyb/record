import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Code, Italic, List, ListOrdered, Quote, Strikethrough } from "lucide-react";
import { type ReactNode, useEffect, useReducer } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";

type FormattingButtonProps = {
	"aria-label": string;
	active: boolean;
	disabled: boolean;
	onClick: () => void;
	children: ReactNode;
};

function FormattingButton({
	"aria-label": ariaLabel,
	active,
	disabled,
	onClick,
	children,
}: FormattingButtonProps) {
	return (
		<Tooltip content={ariaLabel}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-pressed={active}
				disabled={disabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={onClick}
				className={cn(
					"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-violet-400 disabled:cursor-not-allowed disabled:opacity-35",
					active && "bg-white/90 text-gray-900 hover:bg-white hover:text-gray-900",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}

function useEditorRevision(editor: Editor | null): void {
	const [, bumpRevision] = useReducer((revision: number) => revision + 1, 0);
	useEffect(() => {
		if (!editor) return;
		const handleUpdate = () => bumpRevision();
		editor.on("selectionUpdate", handleUpdate);
		editor.on("transaction", handleUpdate);
		return () => {
			editor.off("selectionUpdate", handleUpdate);
			editor.off("transaction", handleUpdate);
		};
	}, [editor]);
}

/**
 * Formatting lives on the selection, not in a permanent bar: markdown shortcuts cover
 * writing, and this menu appears only when text is selected in an editable note.
 */
export function NotesFormattingMenu({
	editor,
	disabled,
}: {
	editor: Editor | null;
	/** True while the note body rejects edits (playback or mirroring). */
	disabled: boolean;
}) {
	useEditorRevision(editor);
	const t = useScopedT("launch");
	if (!editor || disabled) return null;

	return (
		<BubbleMenu
			editor={editor}
			options={{ placement: "top", offset: 8 }}
			shouldShow={({ editor: current, from, to }) =>
				current.isEditable && from !== to && !current.isActive("codeBlock")
			}
		>
			<div
				data-testid="notes-formatting-controls"
				className="flex items-center gap-0.5 rounded-lg border border-white/12 bg-[rgb(22_22_26_/_0.94)] p-1 shadow-[0_6px_18px_-6px_rgb(0_0_0_/_0.6)] backdrop-blur-md"
			>
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.bold")}
					active={editor.isActive("bold")}
					disabled={!editor.can().chain().focus().toggleBold().run()}
					onClick={() => editor.chain().focus().toggleBold().run()}
				>
					<Bold size={14} />
				</FormattingButton>
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.italic")}
					active={editor.isActive("italic")}
					disabled={!editor.can().chain().focus().toggleItalic().run()}
					onClick={() => editor.chain().focus().toggleItalic().run()}
				>
					<Italic size={14} />
				</FormattingButton>
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.strikethrough")}
					active={editor.isActive("strike")}
					disabled={!editor.can().chain().focus().toggleStrike().run()}
					onClick={() => editor.chain().focus().toggleStrike().run()}
				>
					<Strikethrough size={14} />
				</FormattingButton>
				<span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden="true" />
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.bulletList")}
					active={editor.isActive("bulletList")}
					disabled={!editor.can().chain().focus().toggleBulletList().run()}
					onClick={() => editor.chain().focus().toggleBulletList().run()}
				>
					<List size={14} />
				</FormattingButton>
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.numberedList")}
					active={editor.isActive("orderedList")}
					disabled={!editor.can().chain().focus().toggleOrderedList().run()}
					onClick={() => editor.chain().focus().toggleOrderedList().run()}
				>
					<ListOrdered size={14} />
				</FormattingButton>
				<span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden="true" />
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.blockquote")}
					active={editor.isActive("blockquote")}
					disabled={!editor.can().chain().focus().toggleBlockquote().run()}
					onClick={() => editor.chain().focus().toggleBlockquote().run()}
				>
					<Quote size={14} />
				</FormattingButton>
				<FormattingButton
					aria-label={t("tooltips.notesToolbar.codeBlock")}
					active={editor.isActive("codeBlock")}
					disabled={!editor.can().chain().focus().toggleCodeBlock().run()}
					onClick={() => editor.chain().focus().toggleCodeBlock().run()}
				>
					<Code size={14} />
				</FormattingButton>
			</div>
		</BubbleMenu>
	);
}
