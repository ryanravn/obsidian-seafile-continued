import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type SeafilePlugin from "src/main";
import { debug } from "src/utils";
import { server } from "src/config";
import { getPasswordStore } from "src/password_store";
import { SEAFILE_IGNORE_FILE } from "src/ignore";
import Dialog from "./dialog_modal";
import LoginModal from "./login_modal";
import PasswordModal from "./password_modal";
import RepoModal from "./repo_modal";
import TokenLoginModal from "./token_login_modal";
import { resolveNotificationUrl, type NotificationStatus } from "src/notification";
import type { SyncStatus } from "src/sync/controller";
import type { HistoryGroupingMinutes, SyncStatusTextMode } from "src/settings";
import { formatSyncActivity } from "./sync_progress";
import { describeOnboardingStep, getOnboardingStep } from "./onboarding";

export class SeafileSettingTab extends PluginSettingTab {
	constructor(public app: App, private readonly plugin: SeafilePlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const repositoryUnavailable = this.plugin.sync.status.type === "stop" && this.plugin.sync.status.message === "repository-unavailable";
		const onboardingStep = getOnboardingStep(settings);

		return [
			{
				name: "Initialize from remote",
				desc: describeOnboardingStep(onboardingStep),
				aliases: ["setup", "onboarding", "new device", "existing vault"],
				visible: () => getOnboardingStep(this.plugin.settings) !== "complete",
				render: setting => {
					if (onboardingStep === "host") {
						let hostValue = settings.host;
						setting.addText(text => text
							.setPlaceholder("https://example.com")
							.setValue(settings.host)
							.onChange(value => { hostValue = value; }))
							.addButton(button => button
								.setButtonText("Save server")
								.setCta()
								.onClick(async () => { await this.saveHost(hostValue); }));
						return;
					}

					if (onboardingStep === "account") {
						setting.addButton(button => button
							.setButtonText("Log in")
							.setCta()
							.onClick(() => { this.openLogin(false); }))
							.addButton(button => button
								.setButtonText("Use API token")
								.onClick(() => { this.openLogin(true); }));
						return;
					}

					if (onboardingStep === "repository") {
						setting.addButton(button => button
							.setButtonText("Choose remote library")
							.setCta()
							.onClick(() => { void this.chooseRepository(); }));
						return;
					}

					if (onboardingStep === "sync") {
						setting.addButton(button => button
							.setButtonText("Start initial sync")
							.setCta()
							.onClick(async () => {
								button.setDisabled(true);
								try {
									await this.plugin.enableSync();
									new Notice("Initial synchronization started");
									this.update();
								} catch (error) {
									new Notice("Failed to start initial sync: " + (error as Error).message);
									debug.error(error);
								} finally {
									button.setDisabled(false);
								}
							}));
					}
				}
			},
			{
				name: "Host",
				desc: "Seafile server URL.",
				aliases: ["server", "URL"],
				render: setting => {
					let hostValue = settings.host;
					setting.addText(text => text
						.setPlaceholder("https://example.com")
						.setValue(settings.host)
						.onChange(value => { hostValue = value; }))
						.addButton(button => button
							.setButtonText("Save")
							.onClick(async () => { await this.saveHost(hostValue); }));
				}
			},
			{
				name: "Account",
				desc: settings.account || "Not logged in.",
				aliases: ["login", "logout", "API token", "SSO"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText(settings.account ? "Log out" : "Log in")
						.onClick(async () => {
							if (!settings.account) {
								if (!settings.host) {
									new Notice("Save the Seafile host first.");
									return;
								}
								this.openLogin(false);
								return;
							}

							const result = await this.askClearVault("To log out, you need to clear your vault first.\n\n");
							if (!result) return;
							const oldRepoId = settings.repoId;
							settings.account = "";
							settings.authToken = "";
							settings.deviceName = "";
							settings.deviceId = "";
							this.clearRepositorySettings();
							if (oldRepoId) await getPasswordStore(this.app).clear(oldRepoId);
							await this.plugin.saveSettings();
							this.update();
						}))
						.addButton(button => button
							.setButtonText("Use API token")
							.setDisabled(!!settings.account)
							.onClick(() => {
								if (!settings.host) {
									new Notice("Save the Seafile host first.");
									return;
								}
								this.openLogin(true);
							}));
				}
			},
			{
				name: "Repository",
				desc: repositoryUnavailable
					? `${settings.repoName || "Configured repository"} is unavailable. Choose a replacement without deleting local files.`
					: settings.repoName
						? `${settings.repoName}${settings.repoPermission && settings.repoPermission !== "rw" ? ` (read only: ${settings.repoPermission})` : ""}`
						: "Choose a repository to sync.",
				aliases: ["library", "remote repository"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText(repositoryUnavailable ? "Choose replacement" : "Choose")
						.onClick(async () => { await this.chooseRepository(); }));
				}
			},
			{
				name: "Saved password",
				desc: "Encrypted-repository password stored on this device.",
				aliases: ["forget password", "keychain"],
				visible: () => settings.encrypted && !!settings.repoId,
				render: setting => {
					const store = getPasswordStore(this.app);
					setting.setDesc("Checking…");
					setting.addButton(button => {
						button.setButtonText("Forget").setDisabled(true);
						button.onClick(async () => {
							button.setDisabled(true);
							await store.clear(settings.repoId);
							setting.setDesc("No password saved on this device.");
							new Notice("Saved password cleared");
						});
						void store.load(settings.repoId).then(stored => {
							setting.setDesc(stored ? `Saved. ${store.description}` : "No password saved on this device.");
							button.setDisabled(!stored);
						});
					});
				}
			},
			{
				name: "Sync status",
				desc: this.describeSyncStatus(this.plugin.sync.status),
				aliases: ["enable sync", "disable sync"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText(settings.enableSync ? "Disable" : "Enable")
						.onClick(async () => {
							button.setDisabled(true);
							try {
								if (settings.enableSync) {
									await this.plugin.disableSync();
									new Notice("Sync disabled");
								} else if (this.plugin.checkSyncReady()) {
									await this.plugin.enableSync();
									new Notice("Sync enabled");
								} else if (!settings.authToken) {
									new Notice("Log in first before enabling sync");
								} else if (!settings.repoToken) {
									new Notice("Choose a repository first before enabling sync");
								} else {
									new Notice("Sync is not ready");
								}
							} catch (error) {
								new Notice("Failed to change sync state: " + (error as Error).message);
								debug.error(error);
							} finally {
								button.setDisabled(false);
								button.setButtonText(settings.enableSync ? "Disable" : "Enable");
							}
						}));
					return this.plugin.sync.subscribeStatus(status => {
						setting.setDesc(this.describeSyncStatus(status));
					});
				}
			},
			{
				name: "Sidebar status text",
				desc: "Choose when text appears next to the sync button. The complete status is always available on hover.",
				aliases: ["sync progress", "sync button"],
				render: setting => {
					setting.addDropdown(dropdown => dropdown
						.addOption("always", "Always show")
						.addOption("syncing", "Only while syncing")
						.addOption("never", "Never show")
						.setValue(settings.syncStatusTextMode)
						.onChange(async value => {
							settings.syncStatusTextMode = value as SyncStatusTextMode;
							await this.plugin.saveSettings();
							this.plugin.explorerView?.syncStatusChanged(this.plugin.sync.status);
						}));
				}
			},
			{
				name: "Manual sync",
				desc: "Trigger a sync immediately.",
				aliases: ["sync now"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText("Sync now")
						.onClick(async () => {
							button.setDisabled(true);
							try {
								await this.plugin.triggerManualSync();
							} finally {
								button.setDisabled(false);
							}
						}));
				}
			},
			{
				name: "Sync history",
				desc: "Browse grouped activity, per-file versions, deleted files, and whole-vault snapshots.",
				aliases: ["version history", "snapshots", "deleted files", "restore"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText("Open history")
						.setCta()
						.onClick(() => { void this.plugin.openHistoryView("activity"); }));
				}
			},
			{
				name: "Sync issues",
				desc: "Review actionable conflicts, safety stops, recovered downloads, and errors that exhausted automatic retries.",
				aliases: ["conflicts", "errors", "diagnostics"],
				render: setting => {
					const openCount = this.plugin.issues.list().filter(issue => !issue.resolved).length;
					setting.setDesc(`${openCount} open issue${openCount === 1 ? "" : "s"}.`)
						.addButton(button => button.setButtonText("Open").onClick(() => { void this.plugin.openHistoryView("issues"); }));
				}
			},
			{
				name: "History grouping",
				desc: "Visually combine nearby commits from the same author and device without changing Seafile's stored history.",
				aliases: ["commit grouping", "activity sessions"],
				render: setting => {
					setting.addDropdown(dropdown => dropdown
						.addOption("0", "No grouping")
						.addOption("1", "1 minute")
						.addOption("5", "5 minutes")
						.addOption("15", "15 minutes")
						.setValue(String(settings.historyGroupingMinutes))
						.onChange(async value => {
							settings.historyGroupingMinutes = Number(value) as HistoryGroupingMinutes;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Local offline checkpoints",
				desc: "Keep deduplicated Markdown and Canvas checkpoints on this device. They are never synchronized as vault files.",
				aliases: ["offline versions", "local history"],
				render: setting => {
					setting.addToggle(toggle => toggle
						.setValue(settings.localHistoryEnabled)
						.onChange(async value => {
							settings.localHistoryEnabled = value;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Checkpoint interval",
				desc: "Minutes between local recovery points during active editing.",
				aliases: ["offline history frequency"],
				visible: () => settings.localHistoryEnabled,
				render: setting => {
					setting.addText(text => text
						.setPlaceholder("5")
						.setValue(String(settings.localHistoryIntervalMinutes))
						.onChange(async value => {
							const interval = Number(value);
							if (!Number.isFinite(interval) || interval < 1) return;
							settings.localHistoryIntervalMinutes = interval;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Checkpoint retention",
				desc: "Days to keep local recovery points.",
				aliases: ["offline history age"],
				visible: () => settings.localHistoryEnabled,
				render: setting => {
					setting.addText(text => text
						.setPlaceholder("7")
						.setValue(String(settings.localHistoryRetentionDays))
						.onChange(async value => {
							const days = Number(value);
							if (!Number.isFinite(days) || days < 1) return;
							settings.localHistoryRetentionDays = days;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Checkpoint storage limit",
				desc: "Maximum device-local history storage in MiB. Content-identical checkpoints share storage.",
				aliases: ["offline history size"],
				visible: () => settings.localHistoryEnabled,
				render: setting => {
					setting.addText(text => text
						.setPlaceholder("250")
						.setValue(String(Math.round(settings.localHistoryMaxBytes / 1024 / 1024)))
						.onChange(async value => {
							const maxMiB = Number(value);
							if (!Number.isFinite(maxMiB) || maxMiB < 1) return;
							settings.localHistoryMaxBytes = maxMiB * 1024 * 1024;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Local history storage",
				desc: "Checking local checkpoint storage…",
				aliases: ["clear history", "checkpoint size"],
				visible: () => settings.localHistoryEnabled,
				render: setting => {
					void this.plugin.checkpoints.getStorageBytes()
						.then(bytes => { setting.setDesc(`${(bytes / 1024 / 1024).toFixed(1)} MiB used on this device.`); })
						.catch(error => { setting.setDesc(`Could not read local history storage: ${(error as Error).message}`); });
					setting.addButton(button => button.setButtonText("Clear local history").setDestructive().onClick(async () => {
						await this.plugin.checkpoints.clear();
						setting.setDesc("0.0 MiB used on this device.");
						new Notice("Local checkpoint history cleared");
					}));
				}
			},
			{
				name: "Realtime sync",
				desc: this.describeNotificationStatus(this.plugin.notifications.status),
				aliases: ["notifications", "WebSocket", "periodic fallback"],
				render: setting => {
					setting.addToggle(toggle => toggle
						.setValue(settings.enableNotifications)
						.onChange(async value => {
							toggle.setDisabled(true);
							try {
								await this.plugin.setNotificationsEnabled(value);
								setting.setDesc(this.describeNotificationStatus(this.plugin.notifications.status));
							} finally {
								toggle.setDisabled(false);
							}
						}));
					return this.plugin.notifications.subscribeStatus(status => {
						setting.setDesc(this.describeNotificationStatus(status));
					});
				}
			},
			{
				name: "Notification server URL",
				desc: `Leave blank to use ${resolveNotificationUrl(settings.host || "https://example.com", "")}.`,
				aliases: ["realtime server", "WebSocket URL"],
				render: setting => {
					let notificationUrl = settings.notificationUrl;
					setting.addText(text => text
						.setPlaceholder("https://example.com/notification")
						.setValue(settings.notificationUrl)
						.onChange(value => { notificationUrl = value; }))
						.addButton(button => button
							.setButtonText("Save")
							.onClick(async () => {
								try {
									const value = notificationUrl.trim();
									if (value) resolveNotificationUrl(settings.host || value, value);
									await this.plugin.setNotificationUrl(value);
									new Notice("Notification server URL saved");
									this.update();
								} catch (error) {
									new Notice((error as Error).message);
								}
							}));
				}
			},
			{
				name: "Sync interval",
				desc: "Periodic synchronization interval in seconds.",
				aliases: ["polling interval"],
				render: setting => {
					let interval = Math.floor(settings.interval / 1000).toString();
					setting.addText(text => text
						.setPlaceholder("30")
						.setValue(interval)
						.onChange(value => { interval = value; }))
						.addButton(button => button
							.setButtonText("Save")
							.onClick(async () => {
								const seconds = parseInt(interval);
								if (isNaN(seconds) || seconds < 5) {
									new Notice("Sync interval must be at least 5 seconds");
									return;
								}
								settings.interval = seconds * 1000;
								await this.plugin.saveSettings();
								if (this.plugin.sync.status.type === "idle") this.plugin.sync.startSync();
								new Notice("Sync interval saved");
								this.update();
							}));
				}
			},
			{
				name: "Mass-deletion protection",
				desc: "Pause before a sync deletes many files locally or remotely. The default also catches 25% changes once at least 20 files are affected.",
				aliases: ["deletion limit", "safety interlock"],
				render: setting => {
					setting.addToggle(toggle => toggle
						.setValue(settings.deletionProtectionEnabled)
						.onChange(async value => {
							settings.deletionProtectionEnabled = value;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Mass-deletion file threshold",
				desc: "Always request confirmation when at least this many files would be deleted.",
				aliases: ["500 files", "deletion threshold"],
				visible: () => settings.deletionProtectionEnabled,
				render: setting => {
					let value = settings.deletionProtectionFileThreshold.toString();
					setting.addText(text => text.setValue(value).onChange(next => { value = next; }))
						.addButton(button => button.setButtonText("Save").onClick(async () => {
							const threshold = Number.parseInt(value, 10);
							if (!Number.isFinite(threshold) || threshold < 1) {
								new Notice("The deletion threshold must be at least 1.");
								return;
							}
							settings.deletionProtectionFileThreshold = threshold;
							await this.plugin.saveSettings();
							new Notice("Mass-deletion threshold saved");
						}));
				}
			},
			{
				name: "Seafile ignore file",
				desc: `Edit ${SEAFILE_IGNORE_FILE} in the library root. The same rules are used by standard Seafile clients; the plugin creates this file automatically when necessary.`,
				aliases: ["ignore list", "excluded files", "git folder"],
				render: setting => {
					let ignoreContents = "";
					setting.addTextArea(text => {
						text.setPlaceholder("Loading ignore rules…");
						text.inputEl.rows = 12;
						text.onChange(value => { ignoreContents = value; });
						void this.plugin.sync.readIgnoreFile().then(contents => {
							ignoreContents = contents;
							text.setValue(contents);
						}).catch(error => {
							debug.error("Failed to load Seafile ignore file", error);
							new Notice("Failed to load Seafile ignore file: " + (error as Error).message);
						});
					}).addButton(button => button
						.setButtonText("Save")
						.onClick(async () => {
							button.setDisabled(true);
							try {
								await this.plugin.sync.writeIgnoreFile(ignoreContents);
								new Notice(`${SEAFILE_IGNORE_FILE} saved`);
							} catch (error) {
								new Notice("Failed to save Seafile ignore file: " + (error as Error).message);
							} finally {
								button.setDisabled(false);
							}
						}));
				}
			},
			{
				name: "Dev mode",
				desc: "Enable development logging, including sync phase timings and throughput. Restart required.",
				aliases: ["debug logging", "performance metrics"],
				render: setting => {
					setting.addToggle(toggle => toggle
						.setValue(settings.devMode)
						.onChange(async value => {
							settings.devMode = value;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Use fetch",
				desc: "Use fetch instead of the Obsidian request API. Requires CORS on the Seafile server.",
				aliases: ["CORS", "large file transfers"],
				render: setting => {
					setting.addToggle(toggle => toggle
						.setValue(settings.useFetch)
						.onChange(async value => {
							settings.useFetch = value;
							await this.plugin.saveSettings();
						}));
				}
			},
			{
				name: "Verify vault",
				desc: "Compare the vault, local sync index, and current Seafile metadata without changing files.",
				aliases: ["health check", "diagnostics", "repair"],
				render: setting => {
					setting.addButton(button => button.setButtonText("Verify").onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.verifyVault();
						} catch (error) {
							new Notice(`Vault verification failed: ${(error as Error).message}`);
						} finally {
							button.setDisabled(false);
						}
					}));
				}
			},
			{
				name: "Rebuild sync index",
				desc: "Forget only the local Seafile baseline and safely merge the existing vault with the remote library again. Vault files are preserved.",
				aliases: ["resync", "repair sync data", "reset index"],
				render: setting => {
					setting.addButton(button => button.setButtonText("Rebuild").setDestructive().onClick(() => {
						new Dialog(this.app,
							"Rebuild sync index",
							"This removes only the plugin's local synchronization index. Vault files remain in place. The next sync performs a fresh merge and may create conflict copies where local and remote files differ. Continue?",
							async () => {
								try {
									await this.plugin.rebuildSyncIndex();
									new Notice("Sync index rebuilt; a fresh merge has started.");
								} catch (error) {
									new Notice(`Could not rebuild sync index: ${(error as Error).message}`);
								}
							}
						).open();
					}));
				}
			},
			{
				name: "Clear vault",
				desc: "Delete all local files, synchronization data, and local checkpoint history. Try this only when recovering from sync problems.",
				aliases: ["reset sync", "delete local files"],
				render: setting => {
					setting.addButton(button => button
						.setButtonText("Clear")
						.setDestructive()
						.onClick(async () => {
							if (await this.askClearVault()) this.update();
						}));
				}
			}
		];
	}

	private async saveHost(value: string): Promise<void> {
		try {
			const url = new URL(value);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
			this.plugin.settings.host = url.origin;
			await this.plugin.saveSettings();
			this.plugin.refreshNotifications();
			new Notice("Host saved");
			this.update();
		} catch (error) {
			new Notice((error as Error).message);
		}
	}

	private openLogin(useToken: boolean): void {
		if (!this.plugin.settings.host) {
			new Notice("Save the Seafile host first.");
			return;
		}

		const applyLogin = async (account: string, token: string, deviceName: string, deviceId: string): Promise<void> => {
			const settings = this.plugin.settings;
			settings.account = account;
			settings.authToken = token;
			settings.deviceName = deviceName;
			settings.deviceId = deviceId;
			await this.plugin.saveSettings();
			this.update();
		};

		if (useToken) new TokenLoginModal(this.app, applyLogin).open();
		else new LoginModal(this.app, applyLogin).open();
	}

	private async chooseRepository(): Promise<void> {
		const settings = this.plugin.settings;
		if (!settings.authToken) {
			new Notice("Log in first before choosing a repository");
			return;
		}

		const preserveVault = this.plugin.sync.status.type === "stop" && this.plugin.sync.status.message === "repository-unavailable";
		const oldRepoId = settings.repoId;
		if (settings.repoToken && !preserveVault) {
			const result = await this.askClearVault("To change repository, you need to clear your vault first.\n\n");
			if (!result) return;
			this.clearRepositorySettings();
			if (oldRepoId) await getPasswordStore(this.app).clear(oldRepoId);
			await this.plugin.saveSettings();
			this.update();
		}

		new RepoModal(this.app, async ({ repoName, repoId, permission, info }) => {
			const replacingRepository = preserveVault && repoId !== oldRepoId;
			const applyAndStart = async () => {
				if (replacingRepository) {
					await this.plugin.resetSyncForRepositoryChange();
					if (oldRepoId) await getPasswordStore(this.app).clear(oldRepoId);
				}
				settings.repoName = repoName;
				settings.repoId = repoId;
				settings.repoToken = info.token;
				settings.repoPermission = permission;
				settings.encrypted = info.encrypted;
				settings.encVersion = info.enc_version;
				settings.repoSalt = info.salt;
				settings.repoMagic = info.magic;
				settings.randomKey = info.random_key;
				await this.plugin.saveSettings();
				if (settings.enableSync) await this.plugin.enableSync();
				if (replacingRepository) new Notice("Repository changed. Local vault files were preserved.");
				this.update();
			};

			if (!info.encrypted) {
				server.crypto = null;
				await applyAndStart();
				return;
			}
			if (info.enc_version !== 2 && info.enc_version !== 4) {
				new Notice(`Encryption version ${info.enc_version} is not supported. Only v2 and v4 work.`);
				return;
			}
			new PasswordModal(this.app, {
				repoId,
				encVersion: info.enc_version,
				repoSalt: info.salt,
				magic: info.magic,
				randomKey: info.random_key
			}, async (crypto, password, remember) => {
				server.crypto = crypto;
				if (remember) {
					try {
						await getPasswordStore(this.app).save(repoId, password);
					} catch (error) {
						new Notice("Could not save password: " + (error as Error).message);
						debug.error(error);
					}
				}
				await applyAndStart();
			}).open();
		}).open();
	}

	private clearRepositorySettings(): void {
		const settings = this.plugin.settings;
		settings.repoName = "";
		settings.repoId = "";
		settings.repoToken = "";
		settings.repoPermission = "";
		settings.encrypted = false;
		settings.encVersion = 0;
		settings.repoSalt = "";
		settings.repoMagic = "";
		settings.randomKey = "";
		server.crypto = null;
	}

	private describeSyncStatus(status: SyncStatus): string {
		if (!this.plugin.settings.enableSync) return "Disabled";
		if (status.type === "busy") return formatSyncActivity(status);
		if (status.type === "idle" && status.error) return `Retry scheduled: ${status.error}`;
		if (status.type === "idle") return "Enabled and waiting for changes";
		if (status.message === "repository-unavailable") return "Stopped because the configured repository is unavailable. Local files were preserved.";
		if (status.message === "safety") return status.error ?? "Stopped by the mass-deletion safety interlock.";
		if (status.message === "preflight") return status.error ?? "Stopped because a sync preflight check failed.";
		if (status.message === "error") return "Stopped after repeated sync failures";
		return "Enabled, but synchronization is stopped";
	}

	private describeNotificationStatus(status: NotificationStatus): string {
		if (this.plugin.sync.status.type === "stop" && this.plugin.sync.status.message === "repository-unavailable") {
			return "Stopped because the configured repository is unavailable. Local files were preserved.";
		}
		if (!this.plugin.settings.enableNotifications) return "Disabled. Periodic synchronization remains active.";
		if (!this.plugin.settings.enableSync) return "Waiting for synchronization to be enabled.";
		if (status.type === "connected") return "Connected. Remote library updates trigger synchronization immediately.";
		if (status.type === "connecting") return "Connecting to the notification server…";
		if (status.type === "fallback") return `Unavailable. Retrying in ${status.retryInSeconds} seconds; periodic synchronization remains active.`;
		return "Waiting to connect. Periodic synchronization remains active.";
	}

	private async askClearVault(info: string = ""): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			new Dialog(this.app,
				"Clear vault",
				info + "Are you sure you want to remove all local files and data? This action cannot be undone. \n\nThis will not delete any files that are in the ignore list.",
				async () => {
					try {
						await this.plugin.clearVault();
					} catch (error) {
						new Notice(`Failed to clear vault: ${(error as Error).message}`);
						debug.error(error);
					}
					resolve(true);
				},
				async () => {
					resolve(false);
				}
			).open();
		});
	}
}
