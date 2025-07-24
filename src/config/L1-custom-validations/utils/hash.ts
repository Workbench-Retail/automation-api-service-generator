import { createHash } from "crypto";

export function generateHash(input: string): string {
	return createHash("sha256") // Choose hashing algorithm: sha256, sha1, md5, etc.
		.update(input)
		.digest("hex"); // Output as hexadecimal string
}
