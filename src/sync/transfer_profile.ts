export interface TransferProfile {
	filePreparationConcurrency: number
	downloadPrefetch: number
	blockUploadConcurrency: number
	preparedBlockCacheBytes: number
}

const DESKTOP_PROFILE: TransferProfile = {
	filePreparationConcurrency: 4,
	downloadPrefetch: 4,
	blockUploadConcurrency: 4,
	preparedBlockCacheBytes: 32 * 1024 * 1024
};

const MOBILE_PROFILE: TransferProfile = {
	filePreparationConcurrency: 1,
	downloadPrefetch: 2,
	blockUploadConcurrency: 2,
	preparedBlockCacheBytes: 0
};

export function getTransferProfile(isMobile: boolean): TransferProfile {
	return { ...(isMobile ? MOBILE_PROFILE : DESKTOP_PROFILE) };
}
