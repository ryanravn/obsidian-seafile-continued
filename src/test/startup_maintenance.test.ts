import { describe, expect, jest, test } from "@jest/globals";
import { attemptStartupMaintenance } from "../startup";

describe("startup maintenance", () => {
	test("reports a maintenance failure without rejecting plugin startup", async () => {
		const onFailure = jest.fn();

		await expect(attemptStartupMaintenance(
			"Managed ignore maintenance",
			async () => { throw new Error("read-only vault"); },
			onFailure
		)).resolves.toBe(false);
		expect(onFailure).toHaveBeenCalledWith({
			operation: "Managed ignore maintenance",
			error: expect.objectContaining({ message: "read-only vault" })
		});
	});

	test("does not report successful maintenance", async () => {
		const onFailure = jest.fn();

		await expect(attemptStartupMaintenance("Runtime ignore maintenance", async () => {}, onFailure)).resolves.toBe(true);
		expect(onFailure).not.toHaveBeenCalled();
	});
});
