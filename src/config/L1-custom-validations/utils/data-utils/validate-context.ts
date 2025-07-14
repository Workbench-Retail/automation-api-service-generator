import { BecknContext } from "../../models/beckn-types";
import { validateAsyncContext } from "./async-validations";
import logger from "../logger";
import { RequestProperties, TransactionCache } from "../../types/cache-types";
import { TransactionCacheService } from "../../services/session-service-rewrite";

export async function performContextValidations(
	context: BecknContext,
	apiProperties: RequestProperties
): Promise<{
	valid: boolean;
	error?: string;
}> {
	const transService = new TransactionCacheService();
	let transactionData = await transService.tryLoadTransaction(
		apiProperties.transactionId,
		apiProperties.subscriberUrl
	);
	if (!transactionData) {
		logger.info("Transaction not found, creating new transaction");
		transactionData = await transService.createTransaction(
			transService.createTransactionKey(
				apiProperties.transactionId,
				apiProperties.subscriberUrl
			),
			apiProperties,
			context
		);
	}
	if (apiProperties.difficulty && apiProperties.difficulty.timeValidations) {
		if (
			new Date(context.timestamp).getTime() <=
			new Date(transactionData.latestTimestamp).getTime()
		) {
			return {
				valid: false,
				error: `Invalid timestamp in context should be greater than ${transactionData.latestTimestamp}
                of last ${transactionData.latestAction} action but got ${context.timestamp}`,
			};
		}
	} else {
		logger.info("Time validations are disabled");
	}

	return validateAsyncContext(context, transactionData, apiProperties);
}

export function isValidJSON(input: string): boolean {
	try {
		JSON.parse(input);
		return true; // Input is valid JSON
	} catch (error) {
		return false; // Input is not valid JSON
	}
}
