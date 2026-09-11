export type HistoryTextKind = "markdown" | "json" | "text";

const MARKDOWN_PATTERN = /\.(?:md|markdown)$/i;
const JSON_PATTERN = /\.(?:canvas|json)$/i;
const TEXT_PATTERN = /\.(?:base|conf|css|csv|env|html?|ics|ini|jsonc|jsonl|jsx?|log|mermaid|properties|sql|text|toml|tsx?|txt|vcf|xml|ya?ml)$/i;
const BINARY_PATTERN = /\.(?:7z|avi|bmp|docx?|eot|flac|gif|gz|heic|ico|jpe?g|m4a|mkv|mov|mp3|mp4|ogg|otf|pdf|png|pptx?|rar|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|zip)$/i;
const MARKDOWN_DIFF_LIMIT = 16 * 1024 * 1024;
const TEXT_DIFF_LIMIT = 2 * 1024 * 1024;
const UNKNOWN_TEXT_DIFF_LIMIT = 1024 * 1024;

export function historyTextKind(path: string): HistoryTextKind | null {
	if (MARKDOWN_PATTERN.test(path)) return "markdown";
	if (JSON_PATTERN.test(path)) return "json";
	if (TEXT_PATTERN.test(path)) return "text";
	return null;
}

export function historyTextDiffLimit(path: string): number | null {
	const kind = historyTextKind(path);
	if (!kind) return BINARY_PATTERN.test(path) ? null : UNKNOWN_TEXT_DIFF_LIMIT;
	return kind === "markdown" ? MARKDOWN_DIFF_LIMIT : TEXT_DIFF_LIMIT;
}

export function isLikelyTextContent(content: ArrayBuffer): boolean {
	if (content.byteLength === 0) return true;
	const sample = new Uint8Array(content, 0, Math.min(content.byteLength, 64 * 1024));
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample);
	} catch {
		return false;
	}
	let controls = 0;
	for (const byte of sample) {
		if (byte === 0) return false;
		if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls++;
	}
	return controls / sample.byteLength < 0.01;
}

export function formatHistoryText(path: string, text: string): string {
	if (historyTextKind(path) !== "json") return text;
	try {
		return JSON.stringify(sortJson(JSON.parse(text) as unknown), null, 2);
	} catch {
		return text;
	}
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => [key, sortJson(child)]));
}
