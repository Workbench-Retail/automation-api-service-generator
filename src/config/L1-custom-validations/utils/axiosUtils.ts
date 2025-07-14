import logger from "./logger";

export function getAxiosErrorMessage(error: any) {
	logger.debug(JSON.stringify(error, null, 2));
	if (error.response) {
		// Server responded with a status code outside the 2xx range
		return (
			error.response.data?.message ||
			error.response.statusText ||
			"Unknown error from server"
		);
	} else if (error.request) {
		// No response was received
		return "No response received from server";
	} else {
		// Error occurred while setting up the request
		return error.message || "An unknown error occurred";
	}
}

export function axiosToCurl(config: any) {
	let curl = `curl -X ${config.method.toUpperCase()} '${config.url}'`;

	// Add headers
	const headers = config.headers || {};
	for (const [key, value] of Object.entries(headers)) {
		curl += ` -H '${key}: ${value}'`;
	}

	// Add data if available
	if (config.data) {
		const dataString =
			typeof config.data === "object"
				? JSON.stringify(config.data)
				: config.data;
		curl += ` -d '${dataString}'`;
	}

	console.log(curl);
}
