import logger from "./logger";
import { createAuthorizationHeader } from "ondc-crypto-sdk-nodejs";
import axios from "axios";
import { config } from "../config/registryGatewayConfig";

const createAuthHeader = async (payload: any) => {
	try {
		const header = await createAuthorizationHeader({
			body: JSON.stringify(payload),
			privateKey: process.env.SIGN_PRIVATE_KEY || "",
			subscriberId: process.env.SUBSCRIBER_ID || "", // Subscriber ID that you get after registering to ONDC Network
			subscriberUniqueKeyId: process.env.UKID || "", // Unique Key Id or uKid that you get after registering to ONDC Network
		});
		return header;
	} catch (error) {
		logger.error("Error while creating Authorization Header", error);
		throw new Error("Error while creating Authorization Header");
	}
};

const fetchSubscriberDetails = (header: string) => {
	const keyId: string[] = extractSignatureKeyId(header);

	if (keyId.length === 0) {
		logger.error("Key ID not found in header");
		return null;
	}

	// Split the matched keyId value by '|' and destructure the parts if they exist
	const [subscriberId, ukId, _] = keyId[0].split("|");

	// Ensure both subscriberID and ukId are present
	return subscriberId && ukId ? { subscriberId, ukId } : null;
};

function extractSignatureKeyId(input: string): string[] {
	// Updated regex to handle keyId values properly
	const keyIdRegex = /keyId=\\"([^\\"]+)\\"/g;
	const matches: string[] = [];
	let match;

	while ((match = keyIdRegex.exec(input)) !== null) {
		matches.push(match[1]);
	}

	return matches;
}

async function getPublicKeys(header: string, payload: any): Promise<string> {
	try {
		const { subscriberId, ukId } = fetchSubscriberDetails(header) || {};
		if (!subscriberId || !ukId) {
			throw new Error("Subscriber ID or UKID not found");
		}
		const response = await performLookup(subscriberId, ukId);
		return response.signing_public_key;
	} catch (error) {
		logger.error("Error while getting public keys");
		throw new Error("Error while getting public keys");
	}
}

async function performLookup(subId: string, ukId: string) {
	const url = `${config.registry.STAGING}lookup`;
	const data = {
		subscriber_id: subId,
		ukId: ukId,
	};
	try {
		const response = await axios.post(url, data, {
			headers: {
				"Content-Type": "application/json",
			},
		});
		return response.data[0];
	} catch (error) {
		logger.error("Error while performing lookup", error);
		throw new Error("Error while performing lookup");
	}
}

export { getPublicKeys, createAuthHeader };
