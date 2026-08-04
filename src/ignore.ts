export const SEAFILE_IGNORE_FILE = "seafile-ignore.txt";

export interface IgnoreList {
	denies: (path: string, isDirectory?: boolean) => boolean
}

function normalizePath(path: string): string {
	while (path.startsWith("/")) path = path.slice(1);
	while (path.endsWith("/")) path = path.slice(0, -1);
	return path;
}

function patternRegex(pattern: string): RegExp {
	let source = "";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Compile the pattern format used by Seafile's root seafile-ignore.txt file. */
export function compileIgnoreList (contents: string): IgnoreList {
	const patterns = contents
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.map(rawPattern => {
			let pattern = rawPattern;
			while (pattern.startsWith("/")) pattern = pattern.slice(1);
			const directoryOnly = pattern.endsWith("/");
			if (directoryOnly) pattern = pattern.slice(0, -1);
			const matchesDirectory = directoryOnly || pattern.endsWith("*") || pattern.endsWith("?");
			return { directoryOnly, matchesDirectory, regex: patternRegex(pattern) };
		});

	return {
		denies: (rawPath: string, isDirectory = false): boolean => {
			const path = normalizePath(rawPath);
			if (!path || path === SEAFILE_IGNORE_FILE) return false;
			return patterns.some(({ directoryOnly, matchesDirectory, regex }) => {
				if (matchesDirectory) {
					const parts = path.split("/");
					const directoryCount = isDirectory ? parts.length : parts.length - 1;
					for (let length = 1; length <= directoryCount; length++) {
						if (regex.test(parts.slice(0, length).join("/"))) return true;
					}
				}
				if (directoryOnly || isDirectory) return false;
				return regex.test(path);
			});
		}
	};
}

export function createDefaultIgnoreFile(configDir: string, pluginId: string): string {
	return `# Git repositories\n.git/\n*/.git/\n\n# Device-specific Obsidian workspace state\n${configDir}/workspace.json\n${configDir}/workspace-mobile.json\n\n# Seafile Sync plugin installation and device state\n${configDir}/plugins/${pluginId}/\n`;
}
