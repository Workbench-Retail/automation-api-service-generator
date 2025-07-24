import constants from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import { setRedisValue } from "../utils/helper";

export async function search(data: any) {
  const { context, message } = data;
  const result: any = [];
  const txnId: any = context?.transaction_id;

  try {
    await contextChecker(context, result, constants.SEARCH);
  } catch (err: any) {
    return result.push({
      valid: false,
      code: 30004,
      description: "Item not found - The item ID provided in the request was not found.",
    });
  }

  try {
    const intent: any = message?.intent;
    const buyerFFAmount: any = intent?.payment?.["@ondc/org/buyer_app_finder_fee_amount"];
    await setRedisValue(`${txnId}_buyerFFAmount`, buyerFFAmount);
    return result;
  } catch (error: any) {
    console.error(`Error in /${constants.SEARCH}: ${error.stack}`);
    return result.push({
      valid: false,
      code: 40000,
      description: "Business Error - A generic business error.",
    });
  }
}
