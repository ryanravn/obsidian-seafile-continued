export interface DiffLine {
	type: "same" | "add" | "remove"
	text: string
}

export interface LineDiffResult {
	lines: DiffLine[]
	additions: number | null
	deletions: number | null
	truncated: boolean
}

export interface DiffRun {
	type: DiffLine["type"]
	lines: string[]
}

export function createLineDiffResult(before: string, after: string, maxLines = 600): LineDiffResult {
	const left = before === "" ? [] : before.split("\n");
	const right = after === "" ? [] : after.split("\n");
	if (left.length + right.length > maxLines) {
		const lines = createPatienceDiff(left, right);
		return {
			lines,
			additions: lines.filter(line => line.type === "add").length,
			deletions: lines.filter(line => line.type === "remove").length,
			truncated: false
		};
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
	return {
		lines: result,
		additions: result.filter(line => line.type === "add").length,
		deletions: result.filter(line => line.type === "remove").length,
		truncated: false
	};
}

interface DiffAnchor {
	left: number
	right: number
}

function createPatienceDiff(left: string[], right: string[]): DiffLine[] {
	const result: DiffLine[] = [];
	diffRange(left, right, 0, left.length, 0, right.length, result);
	return result;
}

function diffRange(
	left: string[],
	right: string[],
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number,
	result: DiffLine[]
): void {
	while (leftStart < leftEnd && rightStart < rightEnd && left[leftStart] === right[rightStart]) {
		result.push({ type: "same", text: left[leftStart] });
		leftStart++;
		rightStart++;
	}
	let suffix = 0;
	while (leftStart < leftEnd - suffix && rightStart < rightEnd - suffix
		&& left[leftEnd - suffix - 1] === right[rightEnd - suffix - 1]) suffix++;
	const trimmedLeftEnd = leftEnd - suffix;
	const trimmedRightEnd = rightEnd - suffix;
	if (leftStart === trimmedLeftEnd) {
		for (let index = rightStart; index < trimmedRightEnd; index++) result.push({ type: "add", text: right[index] });
	} else if (rightStart === trimmedRightEnd) {
		for (let index = leftStart; index < trimmedLeftEnd; index++) result.push({ type: "remove", text: left[index] });
	} else {
		const anchors = findPatienceAnchors(left, right, leftStart, trimmedLeftEnd, rightStart, trimmedRightEnd);
		if (anchors.length === 0) {
			for (let index = leftStart; index < trimmedLeftEnd; index++) result.push({ type: "remove", text: left[index] });
			for (let index = rightStart; index < trimmedRightEnd; index++) result.push({ type: "add", text: right[index] });
		} else {
			let nextLeft = leftStart;
			let nextRight = rightStart;
			for (const anchor of anchors) {
				diffRange(left, right, nextLeft, anchor.left, nextRight, anchor.right, result);
				result.push({ type: "same", text: left[anchor.left] });
				nextLeft = anchor.left + 1;
				nextRight = anchor.right + 1;
			}
			diffRange(left, right, nextLeft, trimmedLeftEnd, nextRight, trimmedRightEnd, result);
		}
	}
	for (let index = suffix; index > 0; index--) result.push({ type: "same", text: left[leftEnd - index] });
}

function findPatienceAnchors(
	left: string[],
	right: string[],
	leftStart: number,
	leftEnd: number,
	rightStart: number,
	rightEnd: number
): DiffAnchor[] {
	const leftLines = new Map<string, { count: number, index: number }>();
	const rightLines = new Map<string, { count: number, index: number }>();
	for (let index = leftStart; index < leftEnd; index++) {
		const entry = leftLines.get(left[index]);
		if (entry) entry.count++;
		else leftLines.set(left[index], { count: 1, index });
	}
	for (let index = rightStart; index < rightEnd; index++) {
		const entry = rightLines.get(right[index]);
		if (entry) entry.count++;
		else rightLines.set(right[index], { count: 1, index });
	}
	const candidates: DiffAnchor[] = [];
	for (let index = leftStart; index < leftEnd; index++) {
		const leftEntry = leftLines.get(left[index]);
		const rightEntry = rightLines.get(left[index]);
		if (leftEntry?.count === 1 && rightEntry?.count === 1) candidates.push({ left: index, right: rightEntry.index });
	}
	if (candidates.length < 2) return candidates;

	const tails: number[] = [];
	const previous = new Int32Array(candidates.length).fill(-1);
	for (let index = 0; index < candidates.length; index++) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (candidates[tails[middle]].right < candidates[index].right) low = middle + 1;
			else high = middle;
		}
		if (low > 0) previous[index] = tails[low - 1];
		tails[low] = index;
	}
	const anchors = new Array<DiffAnchor>(tails.length);
	let candidate = tails[tails.length - 1];
	for (let index = anchors.length - 1; index >= 0; index--) {
		anchors[index] = candidates[candidate];
		candidate = previous[candidate];
	}
	return anchors;
}

export function createLineDiff(before: string, after: string, maxLines = 600): DiffLine[] {
	return createLineDiffResult(before, after, maxLines).lines;
}

export function compactLineDiff(lines: DiffLine[], context = 3): DiffLine[] {
	if (!lines.some(line => line.type !== "same")) return [{ type: "same", text: "No line changes." }];
	const keep = new Uint8Array(lines.length);
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].type === "same") continue;
		const start = Math.max(0, index - context);
		const end = Math.min(lines.length - 1, index + context);
		for (let nearby = start; nearby <= end; nearby++) keep[nearby] = 1;
	}
	const compacted: DiffLine[] = [];
	for (let index = 0; index < lines.length;) {
		if (keep[index]) {
			compacted.push(lines[index++]);
			continue;
		}
		const start = index;
		while (index < lines.length && !keep[index]) index++;
		compacted.push({ type: "same", text: `⋯ ${index - start} unchanged line${index - start === 1 ? "" : "s"}` });
	}
	return compacted;
}

export function groupDiffLines(lines: DiffLine[]): DiffRun[] {
	const runs: DiffRun[] = [];
	for (const line of lines) {
		const previous = runs[runs.length - 1];
		if (previous?.type === line.type) previous.lines.push(line.text);
		else runs.push({ type: line.type, lines: [line.text] });
	}
	return runs;
}
