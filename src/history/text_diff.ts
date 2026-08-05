export interface DiffLine {
	type: "same" | "add" | "remove"
	text: string
}

export function createLineDiff(before: string, after: string, maxLines = 600): DiffLine[] {
	const left = before.split("\n");
	const right = after.split("\n");
	if (left.length + right.length > maxLines) {
		return [
			{ type: "remove", text: `Current version (${left.length} lines)` },
			{ type: "add", text: `Selected version (${right.length} lines)` }
		];
	}
	const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			lengths[i][j] = left[i] === right[j]
				? lengths[i + 1][j + 1] + 1
				: Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length || j < right.length) {
		if (i < left.length && j < right.length && left[i] === right[j]) {
			result.push({ type: "same", text: left[i++] });
			j++;
		} else if (j < right.length && (i === left.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
			result.push({ type: "add", text: right[j++] });
		} else {
			result.push({ type: "remove", text: left[i++] });
		}
	}
	return result;
}
