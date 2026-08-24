const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARACTER = /[\\:*?"<>|]/;

export interface PathPreflightIssue {
	kind: "invalid-name" | "case-collision"
	path: string
	detail: string
}

export function validatePathSegment(path: string): PathPreflightIssue | null {
	const name = path.split("/").pop() ?? "";
	if (!name) return null;
	if (WINDOWS_INVALID_CHARACTER.test(name)) {
		return { kind: "invalid-name", path, detail: "contains a character that is not supported on Windows" };
	}
	if (/[. ]$/.test(name)) {
		return { kind: "invalid-name", path, detail: "ends with a period or space, which is not supported on Windows" };
	}
	if (WINDOWS_RESERVED_NAME.test(name)) {
		return { kind: "invalid-name", path, detail: "uses a reserved Windows filename" };
	}
	return null;
}

export function findCaseCollisions(parentPath: string, names: Iterable<string>): PathPreflightIssue[] {
	const byFoldedName = new Map<string, string>();
	const issues: PathPreflightIssue[] = [];
	for (const name of names) {
		const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
		const previous = byFoldedName.get(folded);
		if (previous && previous !== name) {
			const base = parentPath.replace(/\/$/, "");
			issues.push({
				kind: "case-collision",
				path: `${base}/${name}`,
				detail: `collides with '${previous}' on case-insensitive filesystems`
			});
		} else {
			byFoldedName.set(folded, name);
		}
	}
	return issues;
}
