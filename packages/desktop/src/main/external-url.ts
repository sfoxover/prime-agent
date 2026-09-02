const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(value: string): boolean {
	try {
		return EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
	} catch {
		return false;
	}
}
