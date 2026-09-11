import { describe, expect, test } from "@jest/globals";
import { DEFAULT_SETTINGS } from "../settings";
import { describeOnboardingStep, getOnboardingStep } from "../ui/onboarding";

describe("new-device onboarding", () => {
	test("advances through server, account, repository, and initial sync", () => {
		const settings = { ...DEFAULT_SETTINGS };
		expect(getOnboardingStep(settings)).toBe("host");

		settings.host = "https://seafile.example.test";
		expect(getOnboardingStep(settings)).toBe("account");

		settings.authToken = "account-token";
		expect(getOnboardingStep(settings)).toBe("repository");

		settings.repoId = "repo-id";
		settings.repoToken = "repo-token";
		expect(getOnboardingStep(settings)).toBe("sync");

		settings.enableSync = true;
		expect(getOnboardingStep(settings)).toBe("complete");
	});

	test("does not treat a partial repository selection as ready", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://seafile.example.test",
			authToken: "account-token",
			repoId: "repo-id"
		};

		expect(getOnboardingStep(settings)).toBe("repository");
	});

	test("explains that existing local files may be uploaded", () => {
		expect(describeOnboardingStep("sync")).toContain("may be uploaded");
	});
});
