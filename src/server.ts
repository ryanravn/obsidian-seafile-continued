import { requestUrl, type RequestUrlParam } from "obsidian";
import pRetry from "p-retry";
import pThrottle from "p-throttle";
import pTimeout from "p-timeout";
import type SeafilePlugin from "./main";
import { type SeafileSettings } from "./settings";
import * as utils from "./utils";
import pako from "pako";
import { posix as Path } from "path-browserify";
import { type RepoCrypto } from "./crypto";

export const ZeroFs = "0000000000000000000000000000000000000000";
export type SeafFs = FileSeafFs | DirSeafFs
export type SeafFsResult = [string, SeafFs | null]

export type MODE_FILE = 33188
export type MODE_DIR = 16384
export const MODE_FILE = 33188;
export const MODE_DIR = 16384;

export const TYPE_FILE = 1;
export const TYPE_DIR = 3;

export interface FileSeafFs {
  block_ids: string[]
  size: number
  type: number
  version: number
}

export interface DirSeafFs {
  dirents: SeafDirent[]
  type: number
  version: number
}

export type SeafDirent = DirSeafDirent | FileSeafDirent

export interface DirSeafDirent {
  id: string
  mode: MODE_DIR
  mtime: number // timestamp in seconds!
  name: string
}

export interface FileSeafDirent {
  id: string
  mode: MODE_FILE
  modifier: string
  mtime: number // timestamp in seconds!
  name: string
  size: number
}

export class RequestParam {
	url: string;
	method?: string;
	contentType?: string;
	responseType?: "json" | "binary" | "text";
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	retry?: number;
}

// Normalized response surface returned by the low-level request layer, so the
// requestUrl and fetch code paths expose the same shape. `json()` resolves to
// `unknown`; callers narrow/cast it to the appropriate API response interface.
interface RequestResponse {
	status: number;
	text: () => Promise<string>;
	json: () => Promise<unknown>;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface Commit {
  commit_id: string
  root_id: string
  repo_id: string
  creator_name: string
  creator: string
  description: string
  ctime: number
  parent_id: string
  second_parent_id?: string
  repo_name: string
  repo_desc: string
  repo_category?: string
  device_name: string
  client_version: string
  version: number
  // Encryption metadata. Required for commits to encrypted libraries: when these
  // fields are absent the Seafile server treats the new head commit as plain and
  // flips the library to encrypted=false, corrupting it. `encrypted` is the
  // string "true" (Seafile wire convention), not a boolean. The wrapped block
  // key is named `key` in the commit JSON even though the same value is exposed
  // as `random_key` on /download-info/.
  encrypted?: "true"
  enc_version?: number
  magic?: string
  key?: string
  salt?: string
}
export interface Repo {
  type: string
  repo_id: string
  repo_name: string
  owner_name: string
  owner_email: string
  owner_contact_email: string
  last_modified: string
  modifier_name: string
  modifier_email: string
  modifier_contact_email: string
  size: number
  encrypted: boolean
  permission: string
  starred: boolean
  status: string
  salt: string
}

export interface DirInfo {
  type: "dir" | "file"
  parent_dir: string
  id: string
  name: string
  mtime: number
  permission: "rw"
  modifier_email?: string
  size?: number
  modifier_contact_email?: string
  modifier_name?: string
}

export interface CommitChanges {
  addedFiles: string[]
  removedFiles: string[]
  renamedFiles: string[]
  modifiedFiles: string[]
  addedDirectories: string[]
  removedDirectories: string[]
  renamedDirectories: string[]
}

export class MfaRequiredError extends Error {
	constructor() {
		super("Two-factor authentication token is required.");
	}
}

export interface RepoDownloadInfo {
  token: string
  encrypted: boolean
  enc_version: number
  magic: string
  random_key: string
  salt: string
}

export default class Server {
	public crypto: RepoCrypto | null = null;

	public constructor (private readonly settings: SeafileSettings,
    private readonly plugin: SeafilePlugin
	) {
	}

	private async request (req: RequestUrlParam & RequestParam): Promise<RequestResponse> {
		if(!this.settings.useFetch)
		{
			const response = await pTimeout(requestUrl(req), { milliseconds: 120 * 1000 });
			return {
				status: response.status,
				text: () => Promise.resolve(response.text),
				json: () => Promise.resolve(response.json as unknown),
				arrayBuffer: () => Promise.resolve(response.arrayBuffer)
			};
		}
		else
		{
			// Intentional opt-in alternative to requestUrl, gated by settings.useFetch.
			const response = await window.fetch(req.url, {
				method: req.method,
				headers: req.headers,
				body: req.body,
			});
			return {
				status: response.status,
				text: () => response.text(),
				json: () => response.json() as Promise<unknown>,
				arrayBuffer: () => response.arrayBuffer()
			};
		}
	}

	private readonly requestThrottled = pThrottle({ interval: 100, limit: 5 })((req: RequestUrlParam & RequestParam) => this.request(req));
	private async sendRequest (param: RequestParam): Promise<unknown> {
		const req: RequestUrlParam & RequestParam = { ...param };
		req.throw = false;
		req.retry = req.retry || 1;
		req.method = req.method || "GET";

		const resp = await pRetry(async () => await this.requestThrottled(req), { retries: param.retry });
		const status = resp.status.toString();
		let ret: unknown = null;

		if (req.responseType === "text") {
			ret = await resp.text();
		} else if (req.responseType === "binary") {
			ret = await resp.arrayBuffer();
		} else {
			const json = await resp.json() as { error_msg?: string };
			ret = json;
			if (json.error_msg) { throw new Error(json.error_msg); }
		}

		if (!status.startsWith("2") && !status.startsWith("3")) {
			throw new Error(`HTTP ${status}. Response: ${JSON.stringify(ret)}`);
		}

		return ret;
	}

	async requestSeafHttp (req: RequestParam) {
		if (!req.headers) req.headers = {};
		req.headers["Seafile-Repo-Token"] = this.settings.repoToken;
		req.url = `${this.settings.host}/seafhttp/${req.url}`;

		return await this.sendRequest(req);
	}

	async requestAPIv20 (req: RequestParam) {
		if (!req.headers) req.headers = {};
		req.headers.Authorization = `Token ${this.settings.authToken}`;
		req.url = `${this.settings.host}/api2/${req.url}`;
		return await this.sendRequest(req);
	}

	async requestAPIv21 (req: RequestParam) {
		if (!req.headers) req.headers = {};
		req.headers.Authorization = `Token ${this.settings.authToken}`;
		req.url = `${this.settings.host}/api/v2.1/${req.url}`;
		return await this.sendRequest(req);
	}

	async getAuthToken (account: string, password: string, deviceName: string, deviceId: string, otpToken?: string): Promise<string> {
		const params = new URLSearchParams();
		params.append("username", account);
		params.append("password", password);
		params.append("device_name", deviceName);
		params.append("device_id", deviceId);
		params.append("client_version", "obsidian_plugin");
		params.append("platform", "windows");
		if (otpToken) {
			params.append("otp_token", otpToken);
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/x-www-form-urlencoded"
		};
		if (otpToken) {
			headers["X-Seafile-OTP"] = otpToken;
		}

		const resp = await pTimeout(this.request({
			url: `${this.settings.host}/api2/auth-token/`,
			method: "POST",
			headers,
			body: params.toString(),
			throw: false
		}), { milliseconds: 10 * 1000 });

		if (resp.status != 200) {
			if (resp.status == 400) {
				const data = await resp.json() as { non_field_errors?: string[] };
				const errors: string[] = data.non_field_errors || [];
				const isMfaError = errors.some((e) => {
					const msg = e.toLowerCase();
					return msg.includes("two factor") || msg.includes("otp");
				});
				if (isMfaError) {
					throw new MfaRequiredError();
				}
				throw new Error("Failed to get auth token. Invalid username or password.");
			} else {
				throw new Error(`Failed to get auth token. HTTP ${resp.status}`);
			}
		}

		const data = await resp.json() as { token: string };
		return data.token;
	}

	// Browser-based SSO login (Seafile "client SSO via local browser").
	// Requires CLIENT_SSO_VIA_LOCAL_BROWSER = True on the server. Works with any
	// SSO backend the server is configured for (OIDC, SAML, Shibboleth, ...),
	// because the actual authentication happens in the browser.
	//
	// Creates a one-time login link. The device parameters are forwarded so the
	// server mints a device-bound (v2) token, matching the password login flow.
	async createClientSSOLink (deviceName: string, deviceId: string): Promise<{ link: string; token: string }> {
		const params = new URLSearchParams();
		params.append("platform", "windows");
		params.append("platform_version", "0");
		params.append("device_id", deviceId);
		params.append("device_name", deviceName);
		params.append("client_version", "obsidian_plugin");

		const resp = await this.requestClientSSO(
			`${this.settings.host}/api2/client-sso-link/?${params.toString()}`,
			"POST"
		) as { link?: string };

		if (!resp.link) throw new Error("Server did not return an SSO login link. Is client SSO enabled?");

		// The poll token is the last path segment of /client-sso/<token>/.
		const segments = new URL(resp.link).pathname.split("/").filter(Boolean);
		const token = segments[segments.length - 1];
		if (!token) throw new Error("Could not parse the SSO token from the login link.");

		return { link: resp.link, token };
	}

	// Polls a pending SSO login. Returns the api token once the user has
	// completed login in the browser.
	async pollClientSSOLink (token: string): Promise<{ status: string; username?: string; apiToken?: string }> {
		return await this.requestClientSSO(
			`${this.settings.host}/api2/client-sso-link/${encodeURIComponent(token)}/`,
			"GET"
		) as { status: string; username?: string; apiToken?: string };
	}

	// Low-level request for the client-SSO endpoints. Unlike sendRequest it does
	// not auto-throw on JSON parse failures: a Seafile server without client SSO
	// enabled returns an HTML 404 page for these paths, which would otherwise
	// surface as a confusing "doctype is not valid json" error. Translate the
	// common failure modes into actionable messages instead.
	private async requestClientSSO (url: string, method: string): Promise<unknown> {
		const resp = await this.request({ url, method, throw: false });

		if (resp.status === 404) {
			throw new Error(
				"This Seafile server does not support browser SSO login. "
				+ "Ask the administrator to set CLIENT_SSO_VIA_LOCAL_BROWSER = True in seahub_settings.py."
			);
		}
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`SSO request failed (HTTP ${resp.status}).`);
		}

		try {
			return await resp.json();
		} catch {
			throw new Error(
				"The SSO endpoint returned an unexpected (non-JSON) response. "
				+ "Check that the Host URL is correct and that browser SSO is enabled on the server."
			);
		}
	}

	async getRepoList (): Promise<Repo[]> {
		const resp = await this.sendRequest({
			url: `${this.settings.host}/api/v2.1/repos/`,
			headers: {
				Authorization: `Token ${this.settings.authToken}`
			},
			responseType: "json"
		}) as { repos: Repo[] };

		return resp.repos;
	}

	async getRepoToken (repoId: string): Promise<string> {
		const info = await this.getRepoDownloadInfo(repoId);
		return info.token;
	}

	async getRepoDownloadInfo (repoId: string): Promise<RepoDownloadInfo> {
		const resp = await this.requestAPIv20({ url: `repos/${repoId}/download-info/`, responseType: "json" }) as {
			token: string;
			encrypted?: unknown;
			enc_version?: number;
			magic?: string;
			random_key?: string;
			salt?: string;
		};
		return {
			token: resp.token,
			encrypted: !!resp.encrypted,
			enc_version: resp.enc_version ?? 0,
			magic: resp.magic ?? "",
			random_key: resp.random_key ?? "",
			salt: resp.salt ?? ""
		};
	}

	async getDirInfo (path: string, recursive = false): Promise<DirInfo[]> {
		path = encodeURIComponent(path);
		const resp = await this.requestAPIv20({ url: `repos/${this.settings.repoId}/dir/?p=${path}&recursive=${recursive ? 1 : 0}` });
		return resp as DirInfo[];
	}

	async getFileDownloadLink (remotePath: string): Promise<string> {
		remotePath = encodeURIComponent(remotePath);
		const downloadUrl = await this.requestAPIv20({ url: `repos/${this.settings.repoId}/file/?p=${remotePath}` });
		return downloadUrl as string;
	}

	async getFileContent (remotePath: string): Promise<ArrayBuffer> {
		const fileDownloadLink = await this.getFileDownloadLink(remotePath);
		const downloadResp = await this.request({ url: fileDownloadLink, method: "GET", responseType: "binary", throw: false });
		return downloadResp.arrayBuffer();
	}

	async renameFile (oldPath: string, newName: string) {
		oldPath = encodeURIComponent(oldPath);
		newName = encodeURIComponent(newName);
		const resp = await this.requestAPIv20(
			{
				url: `repos/${this.settings.repoId}/file/?p=${oldPath}`,
				method: "POST",
				body: `operation=rename&newname=${newName}`,
				contentType: "application/x-www-form-urlencoded"
			});
		return resp;
	}

	async renameDir (oldPath: string, newName: string) {
		oldPath = encodeURIComponent(oldPath);
		newName = encodeURIComponent(newName);
		const resp = await this.requestAPIv20({
			url: `repos/${this.settings.repoId}/dir/?p=${oldPath}`,
			method: "POST",
			body: `operation=rename&newname=${newName}`,
			contentType: "application/x-www-form-urlencoded"
		});
		return resp;
	}

	async batchMove (srcParentDir: string, srcDirents: string[], dstParentDir: string) {
		await this.requestAPIv21({
			url: "repos/sync-batch-move-item/",
			method: "POST",
			body: JSON.stringify({
				src_repo_id: this.settings.repoId,
				src_parent_dir: srcParentDir,
				src_dirents: srcDirents,
				dst_repo_id: this.settings.repoId,
				dst_parent_dir: dstParentDir
			}),
			contentType: "application/json"
		});
	}

	async dirExists (path: string): Promise<boolean> {
		try {
			const dirInfo = await this.getDirInfo(path, false);
			return !!dirInfo;
		} catch {
			return false;
		}
	}

	async makeDir (path: string, checkExists = true) {
		if (!path.startsWith("/")) {
			throw new Error("Invalid path. Must start with a slash.");
		}

		if (path == "/") { return; }

		if (checkExists && await this.dirExists(path)) {
			return;
		}

		const baseDir = Path.dirname(path);
		if (!(await this.dirExists(baseDir))) {
			await this.makeDir(baseDir, false);
		}

		path = encodeURIComponent(path);

		const resp = await this.requestAPIv20(
			{
				url: `repos/${this.settings.repoId}/dir/?p=${path}`,
				method: "POST",
				body: "operation=mkdir",
				contentType: "application/x-www-form-urlencoded"
			});
		return resp;
	}

	public async uploadFile (remotePath: string, content: ArrayBuffer, exists: boolean) {
		const baseDir = Path.dirname(remotePath);
		const fileName = Path.basename(remotePath);

		const mode = exists ? "update" : "upload";

		let uploadLink: unknown = {};
		try {
			uploadLink = await this.requestAPIv20({
				url: `repos/${this.settings.repoId}/${mode}-link/?p=${baseDir}`,
				method: "GET"
			});

			try {
				new URL(uploadLink as string);
			}
			catch {
				throw new Error("Invalid upload link: " + JSON.stringify(uploadLink));
			}
		} catch (e) {
			throw new Error("Failed to get upload link. " + (e as Error).message);
		}

		const formData = new utils.FormData();
		formData.append("file", content, fileName);
		if (mode == "update") {
			formData.append("target_file", Path.join(baseDir, fileName));
		} else if (mode == "upload") {
			formData.append("parent_dir", baseDir);
			formData.append("replace", "1");
		}

		const response = await this.request({
			url: (uploadLink as string) + "?ret-json=1",
			method: "POST",
			headers: {
				Authorization: `Token ${this.settings.authToken}`,
				"Content-Type": formData.getContentType()
			},
			body: await formData.getArrayBuffer(),
			throw: false
		});
		if (response.status != 200) {
			throw new Error("Upload error. " + String(response.text));
		}
	}

	async getHeadCommitId (): Promise<string> {
		const resp = await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/commit/HEAD` }) as { head_commit_id: string };
		return resp.head_commit_id;
	}

	getCommitInfo = utils.memoizeWithLimit(async (commit: string) => {
		const resp = await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/commit/${commit}` });
		return resp as Commit;
	}, 1000);

	async getCommitRoot (commit: string): Promise<DirSeafDirent> {
		const commitInfo = await this.getCommitInfo(commit);
		// const rootFs = await this.getFs(commitInfo.root_id);
		return {
			id: commitInfo.root_id,
			mode: MODE_DIR,
			mtime: commitInfo.ctime,
			name: ""
		};
	}

	async createCommit (root_id: string, description: string, parent_id: string, ctime?: number): Promise<Commit> {
		if (!ctime) ctime = Math.floor(Date.now() / 1000);

		const repoId = this.settings.repoId;
		const commit: Commit = {
			commit_id: "",
			root_id,
			repo_id: repoId,
			creator_name: this.settings.account,
			creator: this.settings.deviceId,
			description,
			ctime,
			parent_id,
			repo_name: this.settings.repoName,
			repo_desc: "",
			device_name: this.settings.deviceName,
			client_version: `obsidian-seafile_${this.plugin.manifest.version}`,
			version: 1
		};

		if (this.settings.encrypted) {
			commit.encrypted = "true";
			commit.enc_version = this.settings.encVersion;
			commit.magic = this.settings.repoMagic;
			commit.key = this.settings.randomKey;
			if (this.settings.repoSalt) {
				commit.salt = this.settings.repoSalt;
			}
		}

		const commit_id = await utils.computeCommitId(commit);
		commit.commit_id = commit_id;

		return commit;
	}

	describeCommit (changes: CommitChanges): string {
		let summary = "";

		// Helper function to format messages
		const formatChange = (count: number, entity: string, isDirectory: boolean = false) => {
			const entityStr = isDirectory ? "directory " : "";
			if (count === 1) {
				return `${entityStr}"${entity}".\n`;
			} else {
				return `${entityStr}"${entity}" and ${count - 1} more ${isDirectory ? "directories" : "files"}.\n`;
			}
		};

		if (changes.addedFiles.length > 0) {
			summary += "Added " + formatChange(changes.addedFiles.length, changes.addedFiles[0]);
		}
		if (changes.modifiedFiles.length > 0) {
			summary += "Modified " + formatChange(changes.modifiedFiles.length, changes.modifiedFiles[0]);
		}
		if (changes.removedFiles.length > 0) {
			summary += "Deleted " + formatChange(changes.removedFiles.length, changes.removedFiles[0]);
		}
		if (changes.renamedFiles.length > 0) {
			summary += "Renamed " + formatChange(changes.renamedFiles.length, changes.renamedFiles[0]);
		}
		if (changes.addedDirectories.length > 0) {
			summary += "Added " + formatChange(changes.addedDirectories.length, changes.addedDirectories[0], true);
		}
		if (changes.removedDirectories.length > 0) {
			summary += "Removed " + formatChange(changes.removedDirectories.length, changes.removedDirectories[0], true);
		}
		if (changes.renamedDirectories.length > 0) {
			summary += "Renamed " + formatChange(changes.renamedDirectories.length, changes.renamedDirectories[0], true);
		}

		return summary.trim();
	}

	async uploadCommit (commit: Commit) {
		await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/commit/${commit.commit_id}`, method: "PUT", body: JSON.stringify(commit), retry: 0, responseType: "text" });
	}

	async setHeadCommit (commit_id: string): Promise<void> {
		await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/commit/HEAD/?head=${commit_id}`, method: "PUT", retry: 0, responseType: "text" });
	}

	async revertToCommit (commit_id: string): Promise<void> {
		await this.requestAPIv21({ url: `repos/${this.settings.repoId}/commits/${commit_id}/revert/`, method: "POST" });
	}

	async getPackFs (fsList: string[]): Promise<Map<string, SeafFsResult>> {
		const result = new Map<string, SeafFsResult>();

		fsList = fsList.filter(id => {
			if (id == ZeroFs) {
				result.set(id, [ZeroFs, null]);
				return false;
			}
			return true;
		});

		if (fsList.length == 0) return result;

		let data = await this.requestSeafHttp({
			url: `repo/${this.settings.repoId}/pack-fs/`,
			method: "POST",
			body: JSON.stringify(fsList),
			responseType: "binary"
		}) as ArrayBuffer;

		const utf8Decoder = new TextDecoder("utf-8");
		while (data.byteLength > 0) {
			const id = utf8Decoder.decode(data.slice(0, 40));
			const size = new DataView(data.slice(40, 44)).getUint32(0, false);
			const content: ArrayBuffer = data.slice(44, 44 + size);
			const decompressed = pako.inflate(content);
			const text = utf8Decoder.decode(decompressed);
			const fs = JSON.parse(text) as SeafFs;
			result.set(id, [id, fs]);
			data = data.slice(44 + size);
		}
		return result;
	}

	getFs = utils.memoizeWithLimit<[fs: string], SeafFsResult>(
		utils.packRequest<string, SeafFsResult>((fsList: string[]) => this.getPackFs(fsList), 10, 200, 100)
		, 1000);

	async sendPackFs (fsList: SeafFsResult[]): Promise<Map<SeafFsResult, boolean>> {
		const result = new Map<SeafFsResult, boolean>();

		// Prepare fs data
		const utf8Encoder = new TextEncoder();
		let data = new Uint8Array();
		for (const task of fsList) {
			const [fsId, fs] = task;
			if (!fs) {
				result.set(task, false);
			} else {
				result.set(task, true);
				const fsJson = utils.stringifySeafFs(fs);
				const compressed = pako.deflate(fsJson);
				const idData = utf8Encoder.encode(fsId);
				const sizeBuffer = new ArrayBuffer(4);
				new DataView(sizeBuffer).setUint32(0, compressed.byteLength);
				const combinedData = new Uint8Array(idData.byteLength + sizeBuffer.byteLength + compressed.byteLength);
				combinedData.set(new Uint8Array(idData), 0);
				combinedData.set(new Uint8Array(sizeBuffer), idData.byteLength);
				combinedData.set(new Uint8Array(compressed), idData.byteLength + sizeBuffer.byteLength);
				data = utils.concatTypedArrays(data, combinedData);
			}
		}

		// Send fs data
		const resp = await pRetry(async () =>
			await this.request({
				url: `${this.settings.host}/seafhttp/repo/${this.settings.repoId}/recv-fs/`,
				method: "POST",
				headers: {
					"Seafile-Repo-Token": this.settings.repoToken
				},
				body: data.buffer,
				throw: false
			}),
		{ retries: 0 });

		if (resp.status != 200) {
			throw new Error(`Failed to send pack fs: HTTP ${resp.status}`);
		}

		return result;
	}

	sendFs = utils.packRequest<[string, SeafFs], void>(
		(fsList: [string, SeafFs][]) => this.sendPackFs(fsList) as unknown as Promise<Map<[string, SeafFs], void>>,
		1, 300, 1000);

	// check if the fs are in the server
	async checkFsList (fsList: string[]): Promise<Map<string, boolean>> {
		const result = new Map<string, boolean>(fsList.map((fsId: string) => [fsId, false]));
		const resp = await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/check-fs/`, method: "POST", body: JSON.stringify(fsList), retry: 0 }) as string[];
		// resp is an array of not found fs
		resp.forEach((fsId: string) => result.set(fsId, true));
		return result;
	}

	checkFs = utils.packRequest<string, boolean>((fsList: string[]) => this.checkFsList(fsList), 1, 300, 1000);

	async getBlock (blockId: string): Promise<ArrayBuffer> {
		const resp = await this.requestSeafHttp(
			{
				url: `repo/${this.settings.repoId}/block/${blockId}`,
				responseType: "binary",
				retry: 0
			}) as ArrayBuffer;
		if (this.crypto) {
			return await this.crypto.decryptBlock(resp);
		}
		return resp;
	}

	async sendBlock (id: string, data: ArrayBuffer): Promise<void> {
		const needUpload = await this.checkBlock(id);
		if (needUpload) {
			await this.uploadBlock(id, data);
		}
	}

	// Upload a block already known to be absent. Callers that have a complete
	// file manifest can batch check all block IDs and avoid one extra round trip
	// per block by using this method directly.
	async uploadBlock (id: string, data: ArrayBuffer): Promise<void> {
		await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/block/${id}`, method: "PUT", body: data, retry: 0, responseType: "text" });
	}

	// check if the blocks are in the server
	// returns a map of block indicating whether it needs to be uploaded
	async checkBlocksList (blocksList: string[]): Promise<Map<string, boolean>> {
		const map = new Map<string, boolean>();
		for (const block of blocksList) { map.set(block, false); }

		const resp = await this.requestSeafHttp({ url: `repo/${this.settings.repoId}/check-blocks/`, method: "POST", body: JSON.stringify(blocksList), retry: 0 }) as string[];
		// resp is an array of not found blocks

		for (const block of resp) { map.set(block, true); }
		return map;
	}

	checkBlock = utils.packRequest<string, boolean>((blocksList: string[]) => this.checkBlocksList(blocksList), 1, 300, 1000);
}
