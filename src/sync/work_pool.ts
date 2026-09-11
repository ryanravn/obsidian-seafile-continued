export class SlotPool {
	private active = 0;
	private readonly waiters: Array<(release: () => void) => void> = [];

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Worker pool limit must be a positive integer.");
	}

	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active++;
			return this.createRelease();
		}
		return await new Promise<() => void>(resolve => this.waiters.push(resolve));
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			const waiter = this.waiters.shift();
			if (waiter) {
				this.active++;
				waiter(this.createRelease());
			}
		};
	}
}

export class FailableSlotPool {
	private active = 0;
	private failed = false;
	private failure: unknown;
	private readonly waiters: Array<{ resolve: (release: () => void) => void, reject: (error: unknown) => void }> = [];

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Worker pool limit must be a positive integer.");
	}

	async acquire(): Promise<() => void> {
		if (this.failed) throw this.failure;
		if (this.active < this.limit) {
			this.active++;
			return this.createRelease();
		}
		return await new Promise<() => void>((resolve, reject) => this.waiters.push({ resolve, reject }));
	}

	fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			if (this.failed) return;
			const waiter = this.waiters.shift();
			if (waiter) {
				this.active++;
				waiter.resolve(this.createRelease());
			}
		};
	}
}
