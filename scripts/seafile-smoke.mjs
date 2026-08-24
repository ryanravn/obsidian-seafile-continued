#!/usr/bin/env node

import process from "node:process";

const host = (process.env.SEAFILE_URL ?? "").replace(/\/+$/, "");
const accountToken = process.env.SEAFILE_TOKEN ?? "";
const repoId = process.env.SEAFILE_REPO_ID ?? "";
const repoToken = process.env.SEAFILE_REPO_TOKEN ?? "";

if (!host || !accountToken || !repoId || !repoToken) {
	console.error("Set SEAFILE_URL, SEAFILE_TOKEN, SEAFILE_REPO_ID, and SEAFILE_REPO_TOKEN.");
	process.exitCode = 1;
} else {
	const repositories = await request(`${host}/api/v2.1/repos/`, { Authorization: `Token ${accountToken}` });
	if (!Array.isArray(repositories.repos) || !repositories.repos.some(repo => repo.repo_id === repoId)) {
		throw new Error("The configured repository was not returned by /api/v2.1/repos/.");
	}
	const head = await request(`${host}/seafhttp/repo/${encodeURIComponent(repoId)}/commit/HEAD`, {
		"Seafile-Repo-Token": repoToken
	});
	if (typeof head.head_commit_id !== "string" || !head.head_commit_id) throw new Error("Seafile did not return HEAD.");
	console.log(`Seafile read-only smoke test passed at commit ${head.head_commit_id}.`);
}

async function request(url, headers) {
	const response = await fetch(url, { headers });
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}
