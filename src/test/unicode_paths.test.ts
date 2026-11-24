import { describe, expect, jest, test } from "@jest/globals";
import type { App, DataAdapter, ListedFiles, Stat } from "obsidian";
import { initConfig } from "../config";
import type Server from "../server";
import { fastList, fastStat } from "../utils";

const narrowName = "Screenshot 2026-11-09 at 1.23.45\u202fPM.png";
const ordinaryName = "Screenshot 2026-11-09 at 1.23.45 PM.png";

function configure(adapter: Partial<DataAdapter>, getAbstractFileByPath: (path: string) => unknown): void {
	initConfig({
		vault: {
			configDir: ".obsidian",
			adapter,
			getAbstractFileByPath
		}
	} as unknown as App, {} as Server, "seafile");
}

describe("literal local filename handling", () => {
	test("enumerates the filesystem instead of a folded Obsidian index name", async () => {
		const list = jest.fn(async (): Promise<ListedFiles> => ({
			files: [`attachments/${narrowName}`],
			folders: []
		}));
		const indexedLookup = jest.fn(() => {
			throw new Error("fastList must not enumerate through the index");
		});
		configure({ list } as Partial<DataAdapter>, indexedLookup);

		await expect(fastList("/attachments/")).resolves.toEqual([narrowName]);
		expect(list).toHaveBeenCalledWith("attachments");
		expect(indexedLookup).not.toHaveBeenCalled();
	});

	test("does not accept an indexed entry whose stored path has different Unicode", async () => {
		const stat = jest.fn(async (): Promise<Stat | null> => null);
		configure({ stat } as Partial<DataAdapter>, () => ({
			path: `attachments/${narrowName}`,
			stat: { type: "file", size: 123, ctime: 1, mtime: 2 }
		}));

		await expect(fastStat(`attachments/${ordinaryName}`)).resolves.toBeNull();
		expect(stat).toHaveBeenCalledWith(`attachments/${ordinaryName}`);
	});
});
