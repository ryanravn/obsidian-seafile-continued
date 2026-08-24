export interface StartupMaintenanceFailure {
	operation: string
	error: Error
}

export async function attemptStartupMaintenance(
	operation: string,
	task: () => Promise<void>,
	onFailure: (failure: StartupMaintenanceFailure) => void
): Promise<boolean> {
	try {
		await task();
		return true;
	} catch (error) {
		onFailure({
			operation,
			error: error instanceof Error ? error : new Error(String(error))
		});
		return false;
	}
}
