/** Raw credential bytes, or null when the item is absent or unreadable. */
export declare function readCredential(target: string): Buffer | null

/** Writes the blob, preserving the item's metadata. True only if verified by re-read. */
export declare function writeCredential(target: string, blob: Buffer | Uint8Array): boolean

/** Deletes the item. True when an item was deleted. */
export declare function deleteCredential(target: string): boolean
