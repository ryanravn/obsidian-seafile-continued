import { App, arrayBufferToHex, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { server } from "src/config";
import { debug } from "src/utils";
import type { LoginCallback } from "./login_modal";

export default class TokenLoginModal extends Modal {
	private account = "";
	private authToken = "";
	private deviceName = "obsidian-seafile";
	private connectButton: ButtonComponent | null = null;

	constructor(app: App, private readonly callback: LoginCallback) {
		super(app);
	}

	private updateConnectButtonState(): void {
		this.connectButton?.setDisabled(!(this.account.trim() && this.authToken.trim() && this.deviceName.trim()));
	}

	private async connect(): Promise<void> {
		const account = this.account.trim();
		const authToken = this.authToken.trim();
		const deviceName = this.deviceName.trim();
		if (!account || !authToken || !deviceName) return;

		this.connectButton?.setDisabled(true);
		const notice = new Notice("Validating Seafile API token...", 0);
		try {
			await server.validateAuthToken(authToken);
			const deviceIdBuffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(deviceName));
			const deviceId = arrayBufferToHex(deviceIdBuffer);
			await this.callback(account, authToken, deviceName, deviceId);
			new Notice("API token accepted.");
			this.close();
		} catch (error) {
			new Notice("API token login failed: " + (error as Error).message);
			debug.error(error);
		} finally {
			notice.hide();
			this.updateConnectButtonState();
		}
	}

	onOpen(): void {
		this.titleEl.textContent = "Connect with API token";

		new Setting(this.contentEl)
			.setName("Account")
			.setDesc("Your Seafile email or username. This is used to attribute synchronized changes.")
			.addText(text => text
				.setPlaceholder("email@example.com")
				.onChange(value => {
					this.account = value;
					this.updateConnectButtonState();
				}));

		new Setting(this.contentEl)
			.setName("API token")
			.setDesc("Paste an API token from your Seafile account settings.")
			.addText(text => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
				text.setPlaceholder("Token")
					.onChange(value => {
						this.authToken = value;
						this.updateConnectButtonState();
					});
			});

		new Setting(this.contentEl)
			.setName("Device name")
			.setDesc("Shown in Seafile commit metadata.")
			.addText(text => text
				.setValue(this.deviceName)
				.onChange(value => {
					this.deviceName = value;
					this.updateConnectButtonState();
				}));

		new Setting(this.contentEl)
			.addButton(button => {
				this.connectButton = button;
				button.setButtonText("Connect")
					.setDisabled(true)
					.onClick(() => { void this.connect(); });
			})
			.addButton(button => button
				.setButtonText("Cancel")
				.onClick(() => this.close()));
	}

	onClose(): void {
		this.authToken = "";
		this.contentEl.empty();
	}
}
