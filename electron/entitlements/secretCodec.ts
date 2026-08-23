import { safeStorage } from "electron";

export interface SecretCodec {
	encrypt(value: string): Promise<string>;
	decrypt(value: string): Promise<string>;
}

type AsyncSafeStorage = typeof safeStorage & {
	isAsyncEncryptionAvailable?: () => Promise<boolean>;
	encryptStringAsync?: (value: string) => Promise<Buffer>;
	decryptStringAsync?: (value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>;
};

export function createElectronSecretCodec(): SecretCodec {
	const storage = safeStorage as AsyncSafeStorage;
	return {
		async encrypt(value) {
			if (storage.encryptStringAsync && (await storage.isAsyncEncryptionAvailable?.())) {
				return (await storage.encryptStringAsync(value)).toString("base64");
			}
			if (!storage.isEncryptionAvailable()) {
				throw new Error("Secure license storage is not available on this device.");
			}
			return storage.encryptString(value).toString("base64");
		},
		async decrypt(value) {
			const encrypted = Buffer.from(value, "base64");
			if (storage.decryptStringAsync && (await storage.isAsyncEncryptionAvailable?.())) {
				return (await storage.decryptStringAsync(encrypted)).result;
			}
			if (!storage.isEncryptionAvailable()) {
				throw new Error("Secure license storage is not available on this device.");
			}
			return storage.decryptString(encrypted);
		},
	};
}
