import { WebDemuxer } from "web-demuxer";

const WEB_DEMUXER_WASM_PATH = "wasm/web-demuxer.wasm";

/**
 * Resolve the public WASM file in both renderer environments.
 *
 * Vite serves `public/` from the web root in development. Packaged Electron
 * loads `dist/index.html` through `file://`, where the copied public asset sits
 * beside that HTML file instead. Keeping this rule here prevents individual
 * media paths from accidentally treating a source-module path as a page URL.
 */
export function webDemuxerWasmUrl(pageUrl: string = window.location.href): string {
	const page = new URL(pageUrl);
	return page.protocol === "file:"
		? new URL("../../web-demuxer.wasm", page).href
		: new URL(`/${WEB_DEMUXER_WASM_PATH}`, page).href;
}

export function createWebDemuxer(): WebDemuxer {
	return new WebDemuxer({ wasmFilePath: webDemuxerWasmUrl() });
}
