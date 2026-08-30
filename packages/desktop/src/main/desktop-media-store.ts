import { createHash } from "node:crypto";

const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_MEDIA_ITEMS = 256;

export interface DesktopMediaAsset {
	data: Uint8Array;
	mimeType: string;
}

export class DesktopMediaStore {
	private readonly assets = new Map<string, DesktopMediaAsset>();
	private totalBytes = 0;

	registerBase64(data: string, mimeType: string): string | undefined {
		const decoded = Buffer.from(data, "base64");
		if (decoded.byteLength === 0) return undefined;
		const id = createHash("sha256").update(mimeType).update("\0").update(decoded).digest("hex");
		const existing = this.assets.get(id);
		if (existing) {
			this.assets.delete(id);
			this.assets.set(id, existing);
			return `prime-media://attachment/${id}`;
		}
		this.assets.set(id, { data: new Uint8Array(decoded), mimeType });
		this.totalBytes += decoded.byteLength;
		this.evict();
		return this.assets.has(id) ? `prime-media://attachment/${id}` : undefined;
	}

	get(id: string): DesktopMediaAsset | undefined {
		const asset = this.assets.get(id);
		if (!asset) return undefined;
		this.assets.delete(id);
		this.assets.set(id, asset);
		return asset;
	}

	clear(): void {
		this.assets.clear();
		this.totalBytes = 0;
	}

	private evict(): void {
		while (this.assets.size > MAX_MEDIA_ITEMS || this.totalBytes > MAX_MEDIA_BYTES) {
			const oldestId = this.assets.keys().next().value;
			if (!oldestId) return;
			const asset = this.assets.get(oldestId);
			this.assets.delete(oldestId);
			this.totalBytes -= asset?.data.byteLength ?? 0;
		}
	}
}
