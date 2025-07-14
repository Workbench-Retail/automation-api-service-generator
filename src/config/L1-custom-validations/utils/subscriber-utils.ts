import { BecknContext } from "../models/beckn-types";
import logger from "./logger";

export function computeSubscriberUri(
	context: BecknContext,
	action: string,
	fromMock: boolean
) {
	console.log("computing subscriber uri", action, fromMock);
	if (!context.bap_uri) {
		throw new Error("BAP URI not found in context");
	}
	if (action !== "search" && !context.bpp_uri) {
		throw new Error("BPP URI not found in context");
	}

	const bapUri = context.bap_uri;
	const bppUri = context.bpp_uri ?? "";

	let subUrl = "";
	let partType: "BAP" | "BPP" = "BAP";
	if (fromMock) {
		subUrl = action.startsWith("on_") ? bapUri : bppUri;
		partType = action.startsWith("on_") ? "BAP" : "BPP";
	} else {
		subUrl = action.startsWith("on_") ? bppUri : bapUri;
		partType = action.startsWith("on_") ? "BPP" : "BAP";
	}
	logger.info(`Computed subscriber URI: ${subUrl}`);
	return { subUrl, partType };
}
