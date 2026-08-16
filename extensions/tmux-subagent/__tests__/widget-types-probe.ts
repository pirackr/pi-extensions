/**
 * Type probe: compiles only if setWidget overloads and stub types exist
 * on ExtensionUIContext. Does not run at runtime.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function probe(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;

	// 1. Component factory
	const component = (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => ({
		render(width: number): string[] {
			return [theme.fg("green", "hello")];
		},
		invalidate(): void {
			tui.requestRender();
		},
		dispose(): void {
			tui.requestRender();
		},
	});

	// 2. setWidget with component factory
	ctx.ui.setWidget("tmux-subagents", component, { placement: "aboveEditor" });

	// 3. setWidget with string[]
	ctx.ui.setWidget("tmux-subagents", ["line 1", "line 2"]);

	// 4. setWidget to clear
	ctx.ui.setWidget("tmux-subagents", undefined);
}
