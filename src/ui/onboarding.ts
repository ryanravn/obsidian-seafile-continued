import type { SeafileSettings } from "../settings";

export type OnboardingStep = "host" | "account" | "repository" | "sync" | "complete";

export function getOnboardingStep(settings: SeafileSettings): OnboardingStep {
	if (!settings.host) return "host";
	if (!settings.authToken) return "account";
	if (!settings.repoId || !settings.repoToken) return "repository";
	if (!settings.enableSync) return "sync";
	return "complete";
}

export function describeOnboardingStep(step: OnboardingStep): string {
	switch (step) {
	case "host":
		return "Step 1 of 4 — Enter your Seafile server URL.";
	case "account":
		return "Step 2 of 4 — Sign in to your Seafile server.";
	case "repository":
		return "Step 3 of 4 — Choose the existing remote library to synchronize with this vault.";
	case "sync":
		return "Step 4 of 4 — Start the initial sync. Remote files will be downloaded; existing local files are merged and may be uploaded.";
	case "complete":
		return "Setup complete.";
	}
}
