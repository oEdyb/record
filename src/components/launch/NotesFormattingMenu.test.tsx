// @vitest-environment jsdom

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { NotesFormattingMenu } from "./NotesFormattingMenu";

vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const bubbleMenuProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

vi.mock("@tiptap/react/menus", () => ({
	BubbleMenu: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
		bubbleMenuProps.value = props;
		return <div data-testid="bubble-menu">{children}</div>;
	},
}));

function createEditor(active: string[] = []): Editor {
	const chain: Record<string, ReturnType<typeof vi.fn>> = {};
	for (const command of [
		"focus",
		"toggleBold",
		"toggleItalic",
		"toggleStrike",
		"toggleBulletList",
		"toggleOrderedList",
		"toggleBlockquote",
		"toggleCodeBlock",
	]) {
		chain[command] = vi.fn(() => chain);
	}
	chain.run = vi.fn(() => true);
	return {
		can: () => ({ chain: () => chain }),
		chain: () => chain,
		isActive: (name: string) => active.includes(name),
		isEditable: true,
		on: vi.fn(),
		off: vi.fn(),
	} as unknown as Editor;
}

describe("NotesFormattingMenu", () => {
	it("offers every formatting command on the selection and applies it", async () => {
		const user = userEvent.setup();
		const editor = createEditor(["bold"]);
		render(
			<I18nProvider>
				<NotesFormattingMenu editor={editor} disabled={false} />
			</I18nProvider>,
		);

		const buttons = within(screen.getByTestId("notes-formatting-controls")).getAllByRole("button");
		expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Bold",
			"Italic",
			"Strikethrough",
			"Bullet list",
			"Numbered list",
			"Blockquote",
			"Code block",
		]);
		expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");

		await user.click(screen.getByRole("button", { name: "Bullet list" }));
		expect(editor.chain().toggleBulletList).toHaveBeenCalled();
	});

	it("shows only for a non-empty selection in an editable note", () => {
		render(
			<I18nProvider>
				<NotesFormattingMenu editor={createEditor()} disabled={false} />
			</I18nProvider>,
		);
		const shouldShow = bubbleMenuProps.value?.shouldShow as (props: {
			editor: Editor;
			from: number;
			to: number;
		}) => boolean;
		const editable = { isEditable: true, isActive: () => false } as unknown as Editor;
		const locked = { isEditable: false, isActive: () => false } as unknown as Editor;

		expect(shouldShow({ editor: editable, from: 1, to: 4 })).toBe(true);
		expect(shouldShow({ editor: editable, from: 3, to: 3 })).toBe(false);
		expect(shouldShow({ editor: locked, from: 1, to: 4 })).toBe(false);
	});

	it("is absent while the note is locked or before the editor exists", () => {
		const { rerender } = render(
			<I18nProvider>
				<NotesFormattingMenu editor={createEditor()} disabled />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("notes-formatting-controls")).not.toBeInTheDocument();

		rerender(
			<I18nProvider>
				<NotesFormattingMenu editor={null} disabled={false} />
			</I18nProvider>,
		);
		expect(screen.queryByTestId("notes-formatting-controls")).not.toBeInTheDocument();
	});
});
